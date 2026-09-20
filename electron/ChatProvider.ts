import { OpenAI } from "openai"
import Anthropic from "@anthropic-ai/sdk"
import { imageDataUrl } from "./ChatImageUtils"
import type { Config } from "./ConfigHelper"
import type { ChatMessage } from "./ChatTypes"

export type ProviderMessage = {
  role: "system" | "user" | "assistant"
  content: string
}

export interface ChatReplyRequest {
  config: Config
  system: string
  history: ChatMessage[]
  openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  signal: AbortSignal
  onStream?: (content: string) => void
}

export interface ChatReplyResult {
  content: string
  streamed: boolean
}

export class ChatProvider {
  public async completeText(
    config: Config,
    messages: ProviderMessage[],
    signal: AbortSignal
  ): Promise<string> {
    if (config.apiProvider === "openai-compatible") {
      const client = this.createOpenAIClient(config)
      const response = await client.chat.completions.create({
        model: config.solutionModel || config.extractionModel,
        messages,
        max_tokens: config.maxOutputTokens,
        temperature: 0.1
      }, { signal })
      return response.choices[0]?.message?.content || ""
    }

    const client = this.createAnthropicClient(config)
    const response = await client.messages.create({
      model: config.solutionModel || config.extractionModel,
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
    }, { signal })
    return response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
  }

  public async generateReply(request: ChatReplyRequest): Promise<ChatReplyResult> {
    if (request.config.apiProvider === "openai-compatible") {
      return this.generateOpenAIReply(request)
    }
    return this.generateAnthropicReply(request)
  }

  private async generateOpenAIReply(request: ChatReplyRequest): Promise<ChatReplyResult> {
    const client = this.createOpenAIClient(request.config)
    if (request.config.streamingEnabled) {
      const stream = await client.chat.completions.create({
        model: request.config.extractionModel,
        messages: request.openaiMessages,
        max_tokens: request.config.maxOutputTokens,
        temperature: 0.2,
        stream: true
      }, { signal: request.signal })
      let result = ""
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content || ""
        if (!delta) continue
        result += delta
        request.onStream?.(result)
      }
      return { content: result, streamed: true }
    }

    const response = await client.chat.completions.create({
      model: request.config.extractionModel,
      messages: request.openaiMessages,
      max_tokens: request.config.maxOutputTokens,
      temperature: 0.2
    }, { signal: request.signal })
    return {
      content: response.choices[0]?.message?.content || "",
      streamed: false
    }
  }

  private async generateAnthropicReply(request: ChatReplyRequest): Promise<ChatReplyResult> {
    const client = this.createAnthropicClient(request.config)
    const response = await client.messages.create({
      model: request.config.extractionModel,
      max_tokens: request.config.maxOutputTokens,
      temperature: 0.2,
      system: request.system,
      messages: request.history.map((message) => ({
        role: message.role,
        content: [
          { type: "text" as const, text: message.content },
          ...message.images.flatMap((image) => {
            const payloadPath = image.transportPath || image.path
            const url = imageDataUrl(payloadPath, image.mimeType)
            if (!url) return []
            return [{
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: image.mimeType || "image/png",
                data: url.split(",")[1] || ""
              }
            }]
          })
        ]
      }))
    }, { signal: request.signal })

    return {
      content: response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
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

  private createAnthropicClient(config: Config): Anthropic {
    return new Anthropic({
      apiKey: config.apiKey,
      timeout: 180000,
      maxRetries: 0
    })
  }
}
