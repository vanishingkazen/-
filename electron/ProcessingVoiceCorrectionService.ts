import { OpenAI } from "openai"
import type { VoiceConversationTranscript, VoiceConversationTurn } from "./VoiceRecognitionHelper"
import { configHelper } from "./ConfigHelper"
import { loadInterviewAsrEnhancement } from "./InterviewContextHelper"
import type { ProcessingAIClientManager } from "./ProcessingAIClientManager"
import { withApiCall } from "./ApiTelemetry"

type QwenCorrectionRequest =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
    chat_template_kwargs?: { enable_thinking: boolean }
  }

export class ProcessingVoiceCorrectionService {
  constructor(private readonly clients: ProcessingAIClientManager) {}

  private get openaiClient(): OpenAI | null {
    return this.clients.openaiClient
  }

  private initializeAIClient(): void {
    this.clients.initialize()
  }

  public async correct(
    conversation: VoiceConversationTranscript
  ): Promise<VoiceConversationTranscript & { corrected: boolean }> {
    const original = { ...conversation, corrected: false }
    const turns = Array.isArray(conversation.turns) ? conversation.turns : []
    if (
      !turns.length &&
      !conversation.systemTranscript.trim() &&
      !conversation.microphoneTranscript.trim()
    ) {
      return original
    }

    const config = configHelper.loadConfig()
    if (!this.openaiClient) this.initializeAIClient()
    if (!this.openaiClient) return original

    const enhancement = loadInterviewAsrEnhancement(
      config.interviewContextEnabled,
      config.interviewContextPath
    )
    const correctionPrompt = turns.length
      ? `请校正下面的线上会议实时语音识别对话。

规则：
- 只修正同音错字、中英文技术术语、大小写、标点和明显错误断句。
- 必须保持原意、角色、发言顺序和提问内容，禁止回答问题，禁止补充原文没有的信息。
- speaker 为 interviewer 的是面试官，speaker 为 candidate 的是面试者。不得交换或合并角色。
- 只返回严格 JSON：{"turns":[{"index":0,"text":"校正后的文本"}]}，index 必须与输入一致，不得增删轮次。
${enhancement.contextText ? `- 领域术语参考：${enhancement.contextText}` : "- 场景是 Agent 工程师技术面试，注意常见中英文技术术语。"}

原始识别：
${JSON.stringify({
  turns: turns.map((turn: VoiceConversationTurn, index: number) => ({
    index,
    speaker: turn.speaker,
    text: turn.text
  }))
})}`
      : `请校正下面的实时语音识别文本。

规则：
- 只修正同音错字、中英文技术术语、大小写、标点和明显错误断句。
- 必须保持原意、角色和提问内容，禁止回答问题，禁止补充原文没有的信息。
- 这是双声道面试录音：面试官来自系统音频，面试者来自麦克风。保持角色归属，只校正文本，不要交换或合并角色。
- 只返回严格 JSON：{"systemTranscript":"...","microphoneTranscript":"..."}。
${enhancement.contextText ? `- 领域术语参考：${enhancement.contextText}` : "- 场景是 Agent 工程师技术面试，注意常见中英文技术术语。"}

原始识别：
${JSON.stringify({
  systemTranscript: conversation.systemTranscript,
  microphoneTranscript: conversation.microphoneTranscript
})}`

    try {
      const correctionRequest: QwenCorrectionRequest = {
          model: config.extractionModel || "gpt-4o",
          messages: [
            {
              role: "system",
              content: "你是低延迟 ASR 文本校正器。只校正识别错误并返回 JSON，不回答对话中的问题。"
            },
            { role: "user", content: correctionPrompt }
          ],
          temperature: 0,
          max_tokens: config.apiProvider === "openai-compatible" ? 2048 : 1200,
          ...(config.apiProvider === "openai-compatible"
            ? { chat_template_kwargs: { enable_thinking: false } }
            : {})
        }
      const response = await withApiCall(
        {
          kind: "voice-correction",
          provider: config.apiProvider,
          model: correctionRequest.model,
          baseURL: config.baseURL,
          stream: false,
          maxTokens: correctionRequest.max_tokens as number | undefined,
          temperature: correctionRequest.temperature as number | undefined,
          messageCount: Array.isArray(correctionRequest.messages) ? correctionRequest.messages.length : undefined
        },
        async () =>
          this.openaiClient!.chat.completions.create(
            correctionRequest,
            { signal: AbortSignal.timeout(10_000) }
          ),
        (response) => {
          const message = response.choices?.[0]?.message as
            | { content?: string | null; reasoning_content?: string | null }
            | undefined
          return {
            content: message?.content || "",
            reasoningContent: message?.reasoning_content || "",
            finishReason: response.choices?.[0]?.finish_reason ?? null,
            usage: (response as { usage?: unknown }).usage
          }
        }
      )
      const raw = response.choices[0]?.message?.content
      if (!raw?.trim()) return original
      const parsed = JSON.parse(raw.replace(/```json|```/gi, "").trim()) as {
        systemTranscript?: unknown
        microphoneTranscript?: unknown
        turns?: Array<{ index?: unknown; text?: unknown }>
      }
      if (turns.length) {
        const correctedTurns = turns.map((turn, index) => {
          const corrected = parsed.turns?.find((item) => item.index === index)
          return {
            ...turn,
            text: typeof corrected?.text === "string" && corrected.text.trim()
              ? corrected.text.trim()
              : turn.text
          }
        })
        return {
          ...conversation,
          systemTranscript: correctedTurns
            .filter((turn) => turn.speaker === "interviewer")
            .map((turn) => turn.text)
            .join("\n")
            .trim(),
          microphoneTranscript: correctedTurns
            .filter((turn) => turn.speaker === "candidate")
            .map((turn) => turn.text)
            .join("\n")
            .trim(),
          turns: correctedTurns,
          corrected: true
        }
      }
      return {
        ...conversation,
        systemTranscript: typeof parsed.systemTranscript === "string"
          ? parsed.systemTranscript.trim()
          : conversation.systemTranscript,
        microphoneTranscript: typeof parsed.microphoneTranscript === "string"
          ? parsed.microphoneTranscript.trim()
          : conversation.microphoneTranscript,
        corrected: true
      }
    } catch (error) {
      console.warn("Voice transcript correction skipped:", error)
      return original
    }
  }

}
