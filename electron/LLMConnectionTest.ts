import { OpenAI } from "openai"
import Anthropic from "@anthropic-ai/sdk"

export interface LLMConnectionTestRequest {
  id: string
  route: "primary" | "fallback"
  apiProvider: "openai-compatible" | "anthropic"
  baseURL: string
  apiKey: string
  model: string
}

export interface LLMConnectionTestResult {
  success: boolean
  message: string
  elapsedMs: number
  status?: number
  cancelled?: boolean
}

/** Probe only the supplied draft route. Never save settings, use history or fail over. */
export async function testLLMConnection(value: unknown, signal: AbortSignal): Promise<LLMConnectionTestResult> {
  const started = Date.now()
  const result = (success: boolean, message: string, extra: Partial<LLMConnectionTestResult> = {}): LLMConnectionTestResult =>
    ({ success, message, elapsedMs: Date.now() - started, ...extra })
  const input = value as Partial<LLMConnectionTestRequest>
  if (!input || !["openai-compatible", "anthropic"].includes(input.apiProvider || "")) return result(false, "请选择有效的接口协议")
  if (typeof input.apiKey !== "string" || !input.apiKey.trim() || input.apiKey.length > 4096) return result(false, "请填写 API Key")
  if (typeof input.model !== "string" || !input.model.trim() || input.model.length > 256) return result(false, "请填写模型 ID")
  let baseURL = ""
  if (input.apiProvider === "openai-compatible") {
    try {
      if (typeof input.baseURL !== "string" || input.baseURL.length > 2048) throw new Error()
      const url = new URL(input.baseURL.trim())
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error()
      baseURL = url.href.replace(/\/$/, "")
    } catch { return result(false, "请填写有效的 HTTP(S) API 地址") }
  }

  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal.addEventListener("abort", cancel, { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, 20_000)
  try {
    if (signal.aborted) return result(false, "测试已取消", { cancelled: true })
    const prompt = "Reply with OK only."
    let content = ""
    let reasoning = ""
    let finishReason: string | null = null
    if (input.apiProvider === "openai-compatible") {
      const client = new OpenAI({ apiKey: input.apiKey.trim(), baseURL, maxRetries: 0, timeout: 20_000 })
      const deepSeek = new URL(baseURL).hostname.toLowerCase() === "api.deepseek.com"
      const response = await client.chat.completions.create({
        model: input.model.trim(),
        messages: [{ role: "user", content: prompt }],
        max_tokens: 128,
        stream: false,
        ...(deepSeek ? { thinking: { type: "disabled" } } : {})
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, { signal: controller.signal })
      const choice = response.choices?.[0]
      content = choice?.message?.content || ""
      reasoning = (choice?.message as { reasoning_content?: string } | undefined)?.reasoning_content || ""
      finishReason = choice?.finish_reason || null
    } else {
      const client = new Anthropic({ apiKey: input.apiKey.trim(), maxRetries: 0, timeout: 20_000 })
      const response = await client.messages.create({
        model: input.model.trim(), max_tokens: 128,
        messages: [{ role: "user", content: prompt }]
      }, { signal: controller.signal })
      content = response.content.filter((block): block is Anthropic.TextBlock => block.type === "text").map((block) => block.text).join("")
      finishReason = response.stop_reason
    }
    if (signal.aborted) return result(false, "测试已取消", { cancelled: true })
    if (timedOut) return result(false, "测试超时（20 秒），请检查网络或服务状态")
    if (content.trim()) return result(true, "已收到模型文字回复，线路可用")
    if (reasoning.trim() || finishReason === "length" || finishReason === "max_tokens") {
      return result(true, "服务已接受请求，但未在测试输出上限内返回正文；完整回答能力需实际使用确认")
    }
    return result(false, "服务返回空正文，请检查模型与接口兼容性")
  } catch (error: unknown) {
    if (signal.aborted) return result(false, "测试已取消", { cancelled: true })
    if (timedOut) return result(false, "测试超时（20 秒），请检查网络或服务状态")
    // Do not expose SDK error bodies: a gateway may echo the key, URL or headers.
    const record = error as { status?: number; name?: string }
    const status = typeof record?.status === "number" ? record.status : undefined
    const descriptions: Record<number, string> = {
      400: "请求参数或接口格式不兼容，请检查模型与 API 路径",
      401: "认证失败，请检查 API Key",
      402: "服务余额不足",
      403: "访问被拒绝，请检查 Key 权限或地区限制",
      404: "接口或模型不存在，请检查 Base URL 和模型 ID",
      408: "服务响应超时",
      429: "请求受限或配额不足，请稍后再试"
    }
    return result(false, status
      ? descriptions[status] || (status >= 500 ? "服务端暂不可用，请稍后再试" : "服务拒绝了测试请求")
      : /Timeout/.test(record?.name || "") ? "连接超时，请检查网络或服务状态" : "连接失败，请检查网络、证书和 API 地址", { status })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", cancel)
  }
}
