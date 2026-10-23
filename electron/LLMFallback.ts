import type { Config } from "./ConfigHelper"

export function fallbackConfig(config: Config): Config | null {
  if (!config.fallbackEnabled || !config.fallbackApiKey?.trim() || !config.fallbackModel?.trim()) return null
  if (config.fallbackApiProvider !== "openai-compatible" && config.fallbackApiProvider !== "anthropic") return null
  if (config.fallbackApiProvider === "openai-compatible" && !config.fallbackBaseURL?.trim()) return null
  return {
    ...config,
    fallbackEnabled: false,
    apiProvider: config.fallbackApiProvider,
    apiKey: config.fallbackApiKey.trim(),
    baseURL: config.fallbackApiProvider === "anthropic" ? "" : config.fallbackBaseURL.trim(),
    extractionModel: config.fallbackModel.trim(),
    solutionModel: config.fallbackModel.trim(),
    debuggingModel: config.fallbackModel.trim(),
    solutionApiKey: "",
    solutionBaseURL: ""
  }
}

export function canFailover(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false
  const record = error as { status?: number; name?: string; code?: string; message?: string }
  if (record?.name === "AbortError" || record?.name === "APIUserAbortError") return false
  const status = Number(record?.status)
  return [401, 402, 403, 404, 408, 429].includes(status) || status >= 500
    || /^(APIConnectionError|APIConnectionTimeoutError|TimeoutError|LLMEmptyReplyError)$/.test(record?.name || "")
    || /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET)$/.test(record?.code || "")
}

export function emptyLLMReply(message: string): Error {
  const error = new Error(message)
  error.name = "LLMEmptyReplyError"
  return error
}

/** Each request gets one primary attempt and at most one backup attempt. */
export async function withLLMFallback<T>(
  config: Config,
  signal: AbortSignal,
  operation: (route: Config, attemptSignal: AbortSignal) => Promise<T>,
  options: { canSwitch?: () => boolean; onFallback?: () => void } = {}
): Promise<T> {
  const run = async (route: Config): Promise<T> => {
    signal.throwIfAborted()
    const controller = new AbortController()
    const cancel = () => controller.abort(signal.reason)
    signal.addEventListener("abort", cancel, { once: true })
    const timeout = new Error("模型线路响应超时")
    timeout.name = "TimeoutError"
    const timeoutMs = Math.max(15, Math.min(180, route.llmTimeoutSeconds || 90)) * 1000
    let timer: ReturnType<typeof setTimeout> | undefined
    const interrupted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })
      timer = setTimeout(() => controller.abort(timeout), timeoutMs)
    })
    try {
      const result = await Promise.race([operation(route, controller.signal), interrupted])
      signal.throwIfAborted()
      return result
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", cancel)
    }
  }

  try { return await run(config) } catch (primaryError) {
    const backup = fallbackConfig(config)
    if (!backup || !canFailover(primaryError, signal) || options.canSwitch?.() === false) throw primaryError
    // Avoid logging SDK error objects, which may contain request headers or keys.
    console.warn("[llm] Primary route unavailable; trying configured backup", { provider: backup.apiProvider, model: backup.extractionModel })
    options.onFallback?.()
    try { return await run(backup) } catch (backupError) {
      if (signal.aborted) throw backupError
      const describe = (cause: unknown): string => {
        const record = cause as { status?: number; name?: string }
        if (record?.status) return "HTTP " + record.status
        if (/Timeout/.test(record?.name || "")) return "超时"
        if (record?.name === "LLMEmptyReplyError") return "正文为空"
        return "请求失败"
      }
      const error = new Error("主线路（" + describe(primaryError) + "）和备用线路（" + describe(backupError) + "）均未完成请求，请检查服务状态、余额及模型配置。")
      error.name = "LLMRoutesUnavailableError"
      throw error
    }
  }
}
