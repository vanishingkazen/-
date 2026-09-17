/**
 * 前端（渲染进程）日志。
 *
 * - 通过 preload 暴露的 window.electronAPI.logToMain 转发给主进程统一落盘
 * - 与主进程共用同一个 runId，前后端日志可以按启动批次对齐
 * - 前端 console.* 由主进程的 console-message 事件自动捕获，这里只补充结构化事件
 */

export type RendererLogLevel = "error" | "warn" | "info" | "debug"

export interface RendererLogInfo {
  runId: string
  appVersion: string
  mode: "development" | "production"
  startedAt: string
  logDirectory: string
  mainLogPath: string
  startupLogPath: string
  fileLevel: string
  consoleLevel: string
}

function bridge() {
  if (typeof window === "undefined") return undefined
  return window.electronAPI
}

function send(level: RendererLogLevel, message: string, meta?: unknown): void {
  try {
    bridge()?.logToMain?.(level, message, meta)
  } catch {
    // 日志失败不影响业务
  }
}

export const rendererLog = {
  error: (message: string, meta?: unknown) => send("error", message, meta),
  warn: (message: string, meta?: unknown) => send("warn", message, meta),
  info: (message: string, meta?: unknown) => send("info", message, meta),
  debug: (message: string, meta?: unknown) => send("debug", message, meta)
}

let started = false
let mounted = false

async function logRendererStartup(): Promise<void> {
  let info: RendererLogInfo | undefined
  try {
    info = await bridge()?.getLogInfo?.()
  } catch {
    info = undefined
  }

  rendererLog.info("前端启动", {
    runId: info?.runId,
    appVersion: info?.appVersion,
    mode: info?.mode,
    url: window.location.href,
    userAgent: navigator.userAgent,
    language: navigator.language,
    viewport: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio || 1}`,
    screen: `${window.screen?.width ?? 0}x${window.screen?.height ?? 0}`,
    logPath: info?.mainLogPath,
    time: new Date().toISOString()
  })
}

/** 在渲染入口尽早调用：记录启动信息并捕获未处理错误 */
export function startRendererLogging(): void {
  if (started || typeof window === "undefined") return
  started = true

  window.addEventListener("error", (event) => {
    rendererLog.error("前端未捕获错误", {
      message: event.message,
      source: `${event.filename || "unknown"}:${event.lineno}:${event.colno}`,
      stack: event.error instanceof Error ? event.error.stack : undefined
    })
  })

  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason
    rendererLog.error("前端未处理的 Promise 拒绝", {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined
    })
  })

  window.addEventListener("pagehide", () => {
    rendererLog.info("前端页面卸载", { url: window.location.href })
  })

  void logRendererStartup()
}

/** React 挂载完成后记录一次，用于确认前端已经渲染成功 */
export function logRendererMounted(detail?: Record<string, unknown>): void {
  if (mounted) return
  mounted = true
  rendererLog.info("前端已挂载", {
    url: window.location.href,
    ...detail
  })
}

export async function openLogDirectory(): Promise<{
  success: boolean
  path?: string
  error?: string
}> {
  try {
    const api = bridge()
    if (!api?.openLogDirectory) {
      return { success: false, error: "当前环境不支持打开日志目录" }
    }
    return await api.openLogDirectory()
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
