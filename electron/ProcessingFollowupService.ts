import type { BrowserWindow } from "electron"
import { OpenAI } from "openai"
import Anthropic from "@anthropic-ai/sdk"
import { configHelper, type Config } from "./ConfigHelper"
import { loadInterviewContextPrompt } from "./InterviewContextHelper"
import type { ProblemInfo } from "./contracts"
import type { ProcessingAIClientManager } from "./ProcessingAIClientManager"

type DeepSeekStreamingRequest =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
    thinking?: { type: "enabled" | "disabled" }
    reasoning_effort?: "low" | "medium" | "high" | "max"
  }

type FollowupMessage = { role: "user" | "assistant"; content: string }
type FollowupHistory = Record<"interview" | "problem", FollowupMessage[]>

export interface ProcessingFollowupServiceDeps {
  getMainWindow: () => BrowserWindow | null
  getLanguage: () => Promise<string>
  getProblemInfo: () => ProblemInfo | null
  getCurrentSolutionCode: () => string
  getCurrentBasicCode: () => string
  getMaxOutputTokens: (config: Config) => number
  setActiveController: (controller: AbortController | null) => void
  clearActiveController: (controller: AbortController) => void
}

const isOfficialDeepSeekEndpoint = (baseURL: string): boolean => {
  try {
    return new URL(baseURL).hostname.toLowerCase() === "api.deepseek.com"
  } catch {
    return false
  }
}

const isDeepSeekStreaming = (
  config: { streamingEnabled?: boolean },
  baseURL: string
): boolean => config.streamingEnabled !== false && isOfficialDeepSeekEndpoint(baseURL)

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function errorMessageFrom(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export class ProcessingFollowupService {
  private chatHistories: FollowupHistory = { interview: [], problem: [] }

  constructor(
    private readonly clients: ProcessingAIClientManager,
    private readonly deps: ProcessingFollowupServiceDeps
  ) {}

  private get openaiClient(): OpenAI | null {
    return this.clients.openaiClient
  }

  private get solutionOpenAIClient(): OpenAI | null {
    return this.clients.solutionOpenAIClient
  }

  private get anthropicClient(): Anthropic | null {
    return this.clients.anthropicClient
  }

  private get currentSolutionCode(): string {
    return this.deps.getCurrentSolutionCode()
  }

  private get currentBasicCode(): string {
    return this.deps.getCurrentBasicCode()
  }

  private getLanguage(): Promise<string> {
    return this.deps.getLanguage()
  }

  private getMaxOutputTokens(config: Config): number {
    return this.deps.getMaxOutputTokens(config)
  }

  public resetHistory(): void {
    this.chatHistories = { interview: [], problem: [] }
  }

  public async process(
    requestId: string,
    message: string
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    const mainWindow = this.deps.getMainWindow()
    const content = message.trim()
    if (!mainWindow || !content) {
      return { success: false, error: "消息不能为空" }
    }

    const config = configHelper.loadConfig()
    const language = await this.getLanguage()
    const problemInfo = this.deps.getProblemInfo()
    const controller = new AbortController()
    this.deps.setActiveController(controller)
    let interviewContextPrompt = ""
    try {
      interviewContextPrompt = loadInterviewContextPrompt(
        config.interviewContextEnabled,
        config.interviewContextPath
      )
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "面试上下文不可用"
      }
    }
    const isVoiceInterviewRequest =
      content.includes("面试官：") ||
      content.includes("面试者：") ||
      content.includes("面试官（系统音频）") ||
      content.includes("面试者（麦克风）") ||
      content.includes("面试现场可以直接说出口")
    const voiceInterviewStylePrompt = isVoiceInterviewRequest
      ? `这是线上会议双声道实时面试语音回答：面试官来自系统音频，是提问方；面试者来自麦克风，是回答方，我们需要以面试者的身份作答。输出必须像面试者现场直接开口说话：
- 两个声道的转写可能包含寒暄、口头禅、重复、插话、没说完的半句话和识别错字，但不要交换面试官和面试者的归属。
- 不要逐句回应，也不要把每句话都当成问题。先结合整段对话，挖掘面试官最近真正向面试者提出、且尚未解决的核心问题；面试者已经说过的话主要作为理解追问和补充回答的上下文。
- 忽略与核心问题无关的杂音和交流。如果问题被停顿或插话拆开，要在理解后合并；“为什么”“具体呢”“然后呢”等短追问要结合前文还原含义。
- 如果没有识别出面试官的明确问题，但面试者明确向 AI 提问，则回答面试者最后提出的问题。除非整段内容确实无法识别出任何问题，否则不要反问用户，也不要复述原始转写。
- 使用大白话，先给结论，再用一个简单例子或关键点说明。
- 若面试背景资料中存在与问题相关的真实项目经历，优先用面试者的第一人称结合项目回答，例如“在我们 PandoraQ 项目里……”，把通用原理落到项目做法上；资料未提供的信息不得编造。
- 默认只输出一个短段落，3～6句话，约20～40秒可以说完。
- 禁止 Markdown 标题、加粗、编号、项目符号、ASCII 图和长篇教程。
- 不要以“好的”“当然”“我分几层讲”开头，不主动解释英文全称。
- 只有用户明确要求详细展开、完整方案或代码时才增加篇幅。`
      : ""
    const chatSystemPrompt = [
      "你是编程解题与技术面试对话助手。保持上下文连续，优先回答用户最后一个问题；所有解释和代码注释使用简体中文。",
      voiceInterviewStylePrompt,
      interviewContextPrompt
    ].filter(Boolean).join("\n\n")

    const contextPrompt = `当前编程语言：${language}

当前题目：
${problemInfo?.problem_statement || "当前没有从截图中识别出的题目，请直接回答用户的问题。"}

当前参考代码：
${this.currentSolutionCode || this.currentBasicCode || "当前没有已生成的代码。"}

用户的新消息：
${content}

请结合当前题目、已有代码和对话上下文回答。若用户要求修改代码，请返回可直接使用的完整代码；若只是提问，请直接解释，不要机械重复整套题解。所有说明和代码注释使用简体中文。`

    const historyMode = config.interviewContextEnabled ? "interview" : "problem"
    const modeHistory = this.chatHistories[historyMode]
    const contextMessageLimit = Math.min(
      100,
      Math.max(4, Math.floor(Number(config.contextMessageLimit) || 30))
    )
    const priorMessages = modeHistory.slice(-contextMessageLimit)
    mainWindow.webContents.send("processing-status", {
      stage: "followup",
      requestId,
      message: "正在连接解答模型...",
      progress: 10
    })

    try {
      let responseContent = ""

      if (this.solutionOpenAIClient || config.apiProvider === "openai-compatible") {

        const client = this.solutionOpenAIClient || this.openaiClient
        if (!client) throw new Error("解答模型尚未配置")

        const chatEndpoint = this.solutionOpenAIClient
          ? config.solutionBaseURL
          : config.baseURL
        const useStreaming = isDeepSeekStreaming(config, chatEndpoint)
        const thinkingOptions = isOfficialDeepSeekEndpoint(chatEndpoint)
          ? { thinking: { type: "enabled" as const }, reasoning_effort: "low" as const }
          : {}
        const chatMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
          { role: "system", content: chatSystemPrompt },
          ...priorMessages,
          { role: "user", content: contextPrompt }
        ]
        const chatParams = {
            model: config.solutionModel || "gpt-4o",
            messages: chatMessages,
            temperature: 0.2,
            max_tokens: this.getMaxOutputTokens(config),
            ...thinkingOptions
          }

        if (useStreaming) {
          const chatRequest: DeepSeekStreamingRequest = {
            ...chatParams,
            stream: true
          }
          const stream = await client.chat.completions.create(
            chatRequest,
            { signal: controller.signal }
          )

          mainWindow.webContents.send("processing-status", {
            stage: "followup",
            requestId,
            message: "已连接，正在接收回答...",
            progress: 40
          })

          let lastUpdate = 0
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta as
              | { content?: string | null }
              | undefined
            if (delta?.content) responseContent += delta.content

            const now = Date.now()
            if (now - lastUpdate >= 50 && responseContent) {
              mainWindow.webContents.send("chat-stream", {
                requestId,
                content: responseContent,
                done: false
              })
              lastUpdate = now
            }
          }
        } else {
          const response = await client.chat.completions.create(
            { ...chatParams } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
            { signal: controller.signal }
          )
          responseContent = response.choices[0]?.message?.content?.trim() || ""
        }
      } else if (config.apiProvider === "anthropic") {
        if (!this.anthropicClient) throw new Error("Anthropic API key 尚未配置")
        const response = await this.anthropicClient.messages.create({
          model: config.solutionModel || "claude-3-7-sonnet-20250219",
          max_tokens: this.getMaxOutputTokens(config),
          temperature: 0.2,
          system:
            chatSystemPrompt,
          messages: [
            ...priorMessages.map((item) => ({
              role: item.role,
              content: item.content
            })),
            { role: "user" as const, content: contextPrompt }
          ]
        })
        responseContent =
          response.content[0]?.type === "text" ? response.content[0].text : ""
      }

      if (!responseContent.trim()) throw new Error("模型没有返回正文")

      modeHistory.push(
        { role: "user", content },
        { role: "assistant", content: responseContent }
      )
      this.chatHistories[historyMode] = modeHistory.slice(-contextMessageLimit)

      mainWindow.webContents.send("chat-stream", {
        requestId,
        content: responseContent,
        done: true
      })
      mainWindow.webContents.send("chat-success", {
        requestId,
        content: responseContent
      })
      return { success: true, content: responseContent }
    } catch (error: unknown) {
      const errorMessage =
        isAbortError(error) ? "请求已停止" : errorMessageFrom(error, "对话请求失败")
      mainWindow.webContents.send("chat-error", { requestId, error: errorMessage })
      return { success: false, error: errorMessage }
    } finally {
      this.deps.clearActiveController(controller)
    }
  }

}
