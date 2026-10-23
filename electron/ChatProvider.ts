import { OpenAI } from "openai"
import Anthropic from "@anthropic-ai/sdk"
import { imageDataUrl } from "./ChatImageUtils"
import { withApiCall } from "./ApiTelemetry"
import type { Config } from "./ConfigHelper"
import type { ChatMessage } from "./ChatTypes"
import { emptyLLMReply, withLLMFallback } from "./LLMFallback"

export type ProviderMessage = {
  role: "system" | "user" | "assistant"
  content: string
}

export interface ChatReplyRequest {
  config: Config
  system: string
  history: ChatMessage[]
  openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  prepareOpenAIMessages?: (config: Config, signal: AbortSignal) => Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]>
  signal: AbortSignal
  onStream?: (content: string) => void
  /** 思考进度回调（推理模型），参数为已思考的字符数 */
  onReasoning?: (reasoningChars: number) => void
  /** 遥测场景标签，缺省为 chat */
  kind?: string
  onFallback?: () => void
}

export interface ChatReplyResult {
  content: string
  streamed: boolean
}

/** 思考进度的最小回报间隔，避免每个 chunk 都触发一次 IPC。 */
const REASONING_NOTICE_INTERVAL_MS = 300

/**
 * 生成空回复时的用户可读错误。推理模型的 max_tokens 同时覆盖思维链和正文，
 * 思考一旦吃满预算，正文就会为空且 finish_reason=length。
 */
function describeEmptyReply(finishReason: string | null, reasoningChars: number): string {
  const thinking = reasoningChars > 0 ? `，模型已思考约 ${reasoningChars} 字` : ""
  if (finishReason === "length") {
    return `模型思考过长，输出预算被思考占满，正文被截断${thinking}（finish_reason=length）。请在设置中提高「最大输出长度」，或改用非推理模型后重试。`
  }
  return `模型没有返回正文内容${thinking}（finish_reason=${finishReason || "unknown"}）。请重试，或检查模型配置。`
}

/** DeepSeek 等推理模型会在增量里额外返回 reasoning_content */
type ReasoningDelta = {
  content?: string | null
  reasoning_content?: string | null
}

/** 官方 DeepSeek 接口支持 stream_options.include_usage，可在流末拿到 usage */
function isOfficialDeepSeekEndpoint(baseURL?: string): boolean {
  try {
    return new URL(String(baseURL || "")).hostname.toLowerCase() === "api.deepseek.com"
  } catch {
    return false
  }
}

function readReasoningContent(message: unknown): string {
  const record = message as { reasoning_content?: unknown } | undefined
  return typeof record?.reasoning_content === "string" ? record.reasoning_content : ""
}

function countImageParts(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): number {
  let count = 0
  for (const message of messages || []) {
    const content = (message as { content?: unknown })?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const type = (part as { type?: string })?.type
      if (type === "image_url" || type === "image" || type === "file") count += 1
    }
  }
  return count
}

function describeOpenAIChoice(choice: unknown): {
  content: string
  reasoningContent: string
  finishReason: string | null
} {
  const record = choice as { message?: unknown; finish_reason?: string | null } | undefined
  const content = (record?.message as { content?: unknown } | undefined)?.content
  return {
    content: typeof content === "string" ? content : "",
    reasoningContent: readReasoningContent(record?.message),
    finishReason: record?.finish_reason ?? null
  }
}

function describeAnthropicResponse(response: unknown): {
  content: string
  finishReason: string | null
  usage: unknown
} {
  const record = response as
    | {
        content?: Array<{ type?: string; text?: string }>
        stop_reason?: string | null
        usage?: unknown
      }
    | undefined
  const content = (record?.content || [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("\n")
  return {
    content,
    finishReason: record?.stop_reason ?? null,
    usage: record?.usage
  }
}

export class ChatProvider {
  public async completeText(
    config: Config,
    messages: ProviderMessage[],
    signal: AbortSignal,
    options: { kind?: string; label?: string } = {}
  ): Promise<string> {
    return withLLMFallback(config, signal, async (route, attemptSignal) => {
      const text = await this.completeTextOnce(route, messages, attemptSignal, options)
      if (!text.trim()) throw emptyLLMReply("模型没有返回正文")
      return text
    })
  }

  private async completeTextOnce(
    config: Config,
    messages: ProviderMessage[],
    signal: AbortSignal,
    options: { kind?: string; label?: string } = {}
  ): Promise<string> {
    const kind = options.kind || "complete-text"
    const notes = options.label ? { label: options.label } : undefined

    if (config.apiProvider === "openai-compatible") {
      const model = config.solutionModel || config.extractionModel
      const response = await withApiCall(
        {
          kind,
          provider: config.apiProvider,
          model,
          baseURL: config.baseURL,
          stream: false,
          maxTokens: config.maxOutputTokens,
          temperature: 0.1,
          messageCount: messages.length,
          notes
        },
        async () =>
          this.createOpenAIClient(config).chat.completions.create(
            {
              model,
              messages,
              max_tokens: config.maxOutputTokens,
              temperature: 0.1
            },
            { signal }
          ),
        (response) => {
          const choice = describeOpenAIChoice(response.choices?.[0])
          return {
            content: choice.content,
            reasoningContent: choice.reasoningContent,
            finishReason: choice.finishReason,
            usage: (response as { usage?: unknown }).usage
          }
        }
      )
      return response.choices[0]?.message?.content || ""
    }

    const model = config.solutionModel || config.extractionModel
    const response = await withApiCall(
      {
        kind,
        provider: config.apiProvider,
        model,
        stream: false,
        maxTokens: config.maxOutputTokens,
        temperature: 0.1,
        messageCount: messages.length,
        notes
      },
      async () =>
        this.createAnthropicClient(config).messages.create(
          {
            model,
            max_tokens: config.maxOutputTokens,
            temperature: 0.1,
            messages: messages
              .filter((message) => message.role !== "system")
              .map((message) => ({
                role: message.role as "user" | "assistant",
                content: message.content
              })),
            system: messages
              .filter((message) => message.role === "system")
              .map((message) => message.content)
              .join("\n\n")
          },
          { signal }
        ),
      (response) => describeAnthropicResponse(response)
    )
    return response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
  }

  public async generateReply(request: ChatReplyRequest): Promise<ChatReplyResult> {
    let emittedContent = false
    return withLLMFallback(request.config, request.signal, async (config, signal) => {
      const attempt: ChatReplyRequest = {
        ...request, config, signal,
        openaiMessages: config.apiProvider === "openai-compatible" && request.prepareOpenAIMessages
          ? await request.prepareOpenAIMessages(config, signal) : request.openaiMessages,
        onStream: (content) => {
          if (signal.aborted) return
          if (content) emittedContent = true
          request.onStream?.(content)
        },
        onReasoning: (count) => { if (!signal.aborted) request.onReasoning?.(count) }
      }
      const reply = config.apiProvider === "openai-compatible"
        ? await this.generateOpenAIReply(attempt) : await this.generateAnthropicReply(attempt)
      if (!reply.content.trim()) throw emptyLLMReply("模型没有返回正文")
      return reply
    }, { canSwitch: () => !emittedContent, onFallback: request.onFallback })
  }

  private async generateOpenAIReply(request: ChatReplyRequest): Promise<ChatReplyResult> {
    const client = this.createOpenAIClient(request.config)
    const requestInfo = {
      kind: request.kind || "chat",
      provider: request.config.apiProvider,
      model: request.config.extractionModel,
      baseURL: request.config.baseURL,
      stream: Boolean(request.config.streamingEnabled),
      maxTokens: request.config.maxOutputTokens,
      temperature: 0.2,
      messageCount: request.openaiMessages.length,
      imageCount: countImageParts(request.openaiMessages)
    }

    if (request.config.streamingEnabled) {
      // DeepSeek 需要显式开启 include_usage，否则流式响应不带 usage，
      // 事后无法判断 reasoning_tokens 是否吃光了 max_tokens。
      const useUsageOption = isOfficialDeepSeekEndpoint(request.config.baseURL)
      const streamingPayload = {
        model: request.config.extractionModel,
        messages: request.openaiMessages,
        max_tokens: request.config.maxOutputTokens,
        temperature: 0.2,
        stream: true as const
      }

      const tracked = await withApiCall(
        requestInfo,
        async (tracker) => {
          let stream
          try {
            stream = await client.chat.completions.create(
              useUsageOption ? { ...streamingPayload, stream_options: { include_usage: true } } : streamingPayload,
              { signal: request.signal }
            )
          } catch (error) {
            // 少数兼容网关不认 stream_options，降级重试以免中断对话
            const message = error instanceof Error ? error.message : String(error)
            if (!useUsageOption || !/stream_options/i.test(message)) throw error
            console.warn("[api] 服务端不支持 stream_options.include_usage，已降级重试:", message)
            stream = await client.chat.completions.create(streamingPayload, { signal: request.signal })
          }

          let result = ""
          let finishReason: string | null = null
          let reasoningChars = 0
          let lastReasoningNotice = 0
          let usage: unknown

          for await (const chunk of stream) {
            const choice = chunk.choices?.[0]
            if (choice?.finish_reason) finishReason = choice.finish_reason
            const chunkUsage = (chunk as { usage?: unknown }).usage
            if (chunkUsage) usage = chunkUsage

            const delta = choice?.delta as ReasoningDelta | undefined
            const reasoningDelta =
              typeof delta?.reasoning_content === "string" ? delta.reasoning_content : ""
            const contentDelta = typeof delta?.content === "string" ? delta.content : ""

            if (reasoningDelta || contentDelta) {
              tracker.noteStreamChunk({
                content: contentDelta,
                reasoningContent: reasoningDelta,
                finishReason: choice?.finish_reason ?? null
              })
            }

            // 推理模型会把思维链放在 reasoning_content 里。这一步只统计进度，
            // 用于让界面知道模型仍在工作，避免长时间静默看起来像卡死。
            if (reasoningDelta) {
              if (!result) {
                reasoningChars += reasoningDelta.length
                const now = Date.now()
                if (now - lastReasoningNotice >= REASONING_NOTICE_INTERVAL_MS) {
                  lastReasoningNotice = now
                  request.onReasoning?.(reasoningChars)
                }
              }
            }

            if (!contentDelta) continue
            result += contentDelta
            request.onStream?.(result)
          }

          // 部分 SDK/网关在取消时会让流式迭代静默结束而不是抛错，
          // 这里显式补一次取消判定，避免把「用户取消」误报成「模型没有返回正文」。
          if (request.signal.aborted) {
            const abortError = new Error("对话请求已取消")
            abortError.name = "AbortError"
            throw abortError
          }

          return { result, finishReason, reasoningChars, usage }
        },
        // reasoning 字符数由 tracker 在流式过程中累计，无需重复传递
        (tracked) => ({
          content: tracked.result,
          finishReason: tracked.finishReason,
          usage: tracked.usage
        })
      )

      if (!tracked.result.trim()) {
        request.onReasoning?.(tracked.reasoningChars)
        throw emptyLLMReply(describeEmptyReply(tracked.finishReason, tracked.reasoningChars))
      }
      return { content: tracked.result, streamed: true }
    }

    const response = await withApiCall(
      requestInfo,
      async () =>
        client.chat.completions.create(
          {
            model: request.config.extractionModel,
            messages: request.openaiMessages,
            max_tokens: request.config.maxOutputTokens,
            temperature: 0.2
          },
          { signal: request.signal }
        ),
      (response) => {
        const choice = describeOpenAIChoice(response.choices?.[0])
        return {
          content: choice.content,
          reasoningContent: choice.reasoningContent,
          finishReason: choice.finishReason,
          usage: (response as { usage?: unknown }).usage
        }
      }
    )

    const content = response.choices[0]?.message?.content || ""
    if (!content.trim()) {
      throw emptyLLMReply(
        describeEmptyReply(response.choices[0]?.finish_reason ?? null, 0)
      )
    }
    return { content, streamed: false }
  }

  private async generateAnthropicReply(request: ChatReplyRequest): Promise<ChatReplyResult> {
    const response = await withApiCall(
      {
        kind: request.kind || "chat",
        provider: request.config.apiProvider,
        model: request.config.extractionModel,
        stream: false,
        maxTokens: request.config.maxOutputTokens,
        temperature: 0.2,
        messageCount: request.history.length
      },
      async () =>
        this.createAnthropicClient(request.config).messages.create(
          {
            model: request.config.extractionModel,
            max_tokens: request.config.maxOutputTokens,
            temperature: 0.2,
            system: request.system,
            messages: request.history.length ? request.history.map((message) => ({
              role: message.role,
              content: [
                { type: "text" as const, text: message.content },
                ...message.images.flatMap((image) => {
                  const payloadPath = image.transportPath || image.path
                  const url = imageDataUrl(payloadPath, image.mimeType)
                  if (!url) return []
                  return [
                    {
                      type: "image" as const,
                      source: {
                        type: "base64" as const,
                        media_type: image.mimeType || "image/png",
                        data: url.split(",")[1] || ""
                      }
                    }
                  ]
                })
              ]
            })) : this.anthropicMessages(request.openaiMessages)
          },
          { signal: request.signal }
        ),
      (response) => describeAnthropicResponse(response)
    )

    return {
      content: describeAnthropicResponse(response).content,
      streamed: false
    }
  }

  private createOpenAIClient(config: Config): OpenAI {
    return new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL.replace(/\/$/, "") } : {}),
      timeout: 180000,
      maxRetries: 0
    })
  }

  private anthropicMessages(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): Anthropic.MessageParam[] {
    return messages.filter((message) => message.role === "user" || message.role === "assistant").map((message) => {
      const content: Anthropic.ContentBlockParam[] = []
      if (typeof message.content === "string") content.push({ type: "text", text: message.content })
      else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "text") content.push({ type: "text", text: part.text })
          else if (part.type === "image_url") {
            const match = part.image_url.url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s)
            if (!match) throw new Error("备用 Anthropic 线路需要本地图片数据")
            content.push({ type: "image", source: { type: "base64", media_type: match[1] as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: match[2] } })
          } else throw new Error("当前消息格式无法转换为 Anthropic 输入，请使用兼容的备用线路")
        }
      }
      return { role: message.role as "user" | "assistant", content }
    })
  }

  private createAnthropicClient(config: Config): Anthropic {
    return new Anthropic({
      apiKey: config.apiKey,
      timeout: 180000,
      maxRetries: 0
    })
  }
}
