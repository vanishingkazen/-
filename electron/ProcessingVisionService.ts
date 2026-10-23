import { ChatProvider } from "./ChatProvider"
import type { BrowserWindow } from "electron"
import Anthropic from "@anthropic-ai/sdk"
import { configHelper, type Config } from "./ConfigHelper"
import type { ProcessingAIClientManager } from "./ProcessingAIClientManager"
import { withApiCall } from "./ApiTelemetry"

export interface VisionScreenshot {
  path: string
  data: string
}

export interface VisionSolveResult {
  success: boolean
  data?: string
  language?: string
  error?: string
}

export interface ProcessingVisionServiceDeps {
  getMainWindow: () => BrowserWindow | null
  getMaxOutputTokens: (config: Config) => number
}

const normalizeDetectedLanguage = (value: string): string | null => {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "")
  const aliases: Record<string, string> = {
    py: "python",
    python: "python",
    js: "javascript",
    javascript: "javascript",
    ts: "typescript",
    typescript: "typescript",
    java: "java",
    cpp: "cpp",
    "c++": "cpp",
    cplusplus: "cpp",
    c: "cpp",
    "c#": "csharp",
    csharp: "csharp",
    cs: "csharp",
    go: "golang",
    golang: "golang",
    rust: "rust",
    swift: "swift",
    kotlin: "kotlin",
    ruby: "ruby",
    sql: "sql",
    r: "r"
  }
  return aliases[normalized] || null
}

const parseDetectedLanguage = (answer: string): { language: string | null; content: string } => {
  const marker = answer.match(/^\s*\[LANGUAGE\s*:\s*([^\]\n]+)\]\s*/i)
  if (marker) {
    return {
      language: normalizeDetectedLanguage(marker[1]),
      content: answer.slice(marker[0].length).trim()
    }
  }
  const fence = answer.match(/```\s*([a-zA-Z+#.-]+)/)
  return {
    language: fence ? normalizeDetectedLanguage(fence[1]) : null,
    content: answer.trim()
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function errorMessageFrom(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export class ProcessingVisionService {
  constructor(
    private readonly clients: ProcessingAIClientManager,
    private readonly deps: ProcessingVisionServiceDeps
  ) {}

  public async solve(
    screenshots: VisionScreenshot[],
    signal: AbortSignal,
    userRequest = ""
  ): Promise<VisionSolveResult> {
    const config = configHelper.loadConfig()
    const mainWindow = this.deps.getMainWindow()
    const imageDataList = screenshots.map((screenshot) => screenshot.data)
    const prompt = `分析截图中的题目信息，自动识别截图中的编程语言。请在最终回答第一行单独输出 [LANGUAGE: <language>]，language 只能使用 python、javascript、typescript、java、cpp、csharp、golang、rust、swift、kotlin、ruby、sql、r；如果不是编程题则输出 [LANGUAGE: auto]。从第二行开始再输出正常解题内容，不要解释这个标记。${userRequest.trim() ? `\n\n用户补充要求：${userRequest.trim()}` : ""}`

    mainWindow?.webContents.send("processing-status", {
      message: "正在使用视觉模型直接解题...",
      progress: 35
    })

    try {
      let answer = ""

      if (config.fallbackEnabled) {
        const messages = [{ role: "user" as const, content: [
          { type: "text" as const, text: prompt },
          ...imageDataList.map((data) => ({ type: "image_url" as const, image_url: { url: "data:image/png;base64," + data } }))
        ] }];
        const result = await new ChatProvider().generateReply({
          config: { ...config, streamingEnabled: false, maxOutputTokens: this.deps.getMaxOutputTokens(config) },
          system: "", history: [], openaiMessages: messages, signal, kind: "vision",
          onFallback: () => mainWindow?.webContents.send("processing-status", { message: "主线路暂不可用，正在使用备用线路…", progress: 40 })
        });
        answer = result.content;
      } else if (config.apiProvider === "openai-compatible") {
        if (!this.clients.openaiClient) throw new Error("视觉模型客户端尚未初始化")
        const model = config.extractionModel || "gpt-4o"
        const response = await withApiCall(
          {
            kind: "vision",
            provider: config.apiProvider,
            model,
            baseURL: config.baseURL,
            stream: false,
            maxTokens: this.deps.getMaxOutputTokens(config),
            temperature: 0.1,
            messageCount: 1,
            imageCount: imageDataList.length
          },
          async () =>
            this.clients.openaiClient!.chat.completions.create(
              {
                model,
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "text", text: prompt },
                      ...imageDataList.map((data) => ({
                        type: "image_url" as const,
                        image_url: { url: `data:image/png;base64,${data}` }
                      }))
                    ]
                  }
                ],
                max_tokens: this.deps.getMaxOutputTokens(config),
                temperature: 0.1
              },
              { signal }
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
        answer = response.choices[0]?.message?.content?.trim() || ""
      } else if (config.apiProvider === "anthropic") {
        if (!this.clients.anthropicClient) throw new Error("Anthropic API Key 尚未配置")
        const model = config.extractionModel || "claude-3-7-sonnet-20250219"
        const response = await withApiCall(
          {
            kind: "vision",
            provider: config.apiProvider,
            model,
            stream: false,
            maxTokens: this.deps.getMaxOutputTokens(config),
            temperature: 0.1,
            messageCount: 1,
            imageCount: imageDataList.length
          },
          async () =>
            this.clients.anthropicClient!.messages.create(
              {
                model,
                max_tokens: this.deps.getMaxOutputTokens(config),
                temperature: 0.1,
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "text", text: prompt },
                      ...imageDataList.map((data) => ({
                        type: "image" as const,
                        source: {
                          type: "base64" as const,
                          media_type: "image/png" as const,
                          data
                        }
                      }))
                    ]
                  }
                ]
              },
              { signal }
            ),
          (response) => ({
            content: response.content
              .filter((block): block is Anthropic.TextBlock => block.type === "text")
              .map((block) => block.text)
              .join("\n"),
            finishReason: (response as { stop_reason?: string | null }).stop_reason ?? null,
            usage: (response as { usage?: unknown }).usage
          })
        )
        answer = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim()
      }

      if (!answer) throw new Error("视觉模型没有返回解答内容")
      const parsed = parseDetectedLanguage(answer)
      return { success: true, data: parsed.content, language: parsed.language || undefined }
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return { success: false, error: "视觉模型解题已取消" }
      }
      console.error("Direct visual solving failed:", error)
      return {
        success: false,
        error: errorMessageFrom(error, "视觉模型直接解题失败，请检查截图和模型配置")
      }
    }
  }
}
