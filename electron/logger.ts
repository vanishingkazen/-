/**
 * 统一日志入口（主进程 / 后端）。
 *
 * - 所有日志写入 <日志目录>/main.log，每行都带 runId，可按启动批次排查
 * - 每次启动追加一行到 <日志目录>/startup.log，作为“启动索引”
 * - 主进程 console.* 会被镜像进日志文件，历史代码无需改动
 * - 前端（渲染进程）日志通过 IPC 转发进来，作用域为 renderer:<runId>
 * - electron-log 加载失败或不在 Electron 环境（例如单元测试）时自动降级为仅控制台输出，
 *   日志系统永远不会阻断应用启动
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { app, shell } from "electron"

export type LogLevel = "error" | "warn" | "info" | "verbose" | "debug" | "silly"

export interface LogFunctions {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  verbose: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  silly: (...args: unknown[]) => void
  log: (...args: unknown[]) => void
}

export interface LogInfo {
  runId: string
  appVersion: string
  mode: "development" | "production"
  startedAt: string
  logDirectory: string
  mainLogPath: string
  startupLogPath: string
  fileLevel: string
  consoleLevel: string
  fileTransportEnabled: boolean
}

export interface OpenLogDirectoryResult {
  success: boolean
  path: string
  error?: string
}

const APP_LOG_NAME = "steamgamecode"
const MAIN_LOG_NAME = "main.log"
const STARTUP_LOG_NAME = "startup.log"
const MAX_MAIN_LOG_SIZE = 2 * 1024 * 1024
const MAX_STARTUP_LOG_SIZE = 512 * 1024
const STARTUP_LOG_KEEP_LINES = 200
const MAX_RENDERER_MESSAGE_LENGTH = 8000
const MAX_META_LENGTH = 4000

const startedAt = new Date()
const isDev = !app.isPackaged || process.env.NODE_ENV === "development"
const mode: LogInfo["mode"] = isDev ? "development" : "production"

type ConsoleMethodName = "log" | "info" | "warn" | "error" | "debug"

// 必须在任何 console patch 之前捕获原始方法
const originalConsole: Record<ConsoleMethodName, (...args: unknown[]) => void> = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console)
}

function resolveLogDirectory(): string {
  const override = process.env.STEAMGAMECODE_LOG_DIR?.trim()
  if (override) return path.resolve(override)

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Logs", APP_LOG_NAME)
  }

  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA?.trim() || path.join(os.homedir(), "AppData", "Roaming")
    return path.join(appData, APP_LOG_NAME, "logs")
  }

  const stateHome =
    process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state")
  return path.join(stateHome, APP_LOG_NAME, "logs")
}

function createRunId(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  const random = Math.random().toString(16).slice(2, 6).padEnd(4, "0")
  return `${stamp}-${random}`
}

export const LOG_DIRECTORY = resolveLogDirectory()
export const MAIN_LOG_PATH = path.join(LOG_DIRECTORY, MAIN_LOG_NAME)
export const STARTUP_LOG_PATH = path.join(LOG_DIRECTORY, STARTUP_LOG_NAME)
export const RUN_ID = createRunId(startedAt)

// ---------------------------------------------------------------------------
// electron-log（可选依赖）：加载失败时降级为仅控制台输出
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadElectronLog(): any {
  if (!process.versions?.electron) {
    // 非 Electron 环境（单元测试、脚本）不写真实日志目录
    return undefined
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("electron-log/main")
  } catch (error) {
    originalConsole.error("[logger] electron-log 加载失败，降级为仅控制台输出:", error)
    return undefined
  }
}

const electronLog = loadElectronLog()
const fileTransportEnabled = Boolean(electronLog)

if (electronLog) {
  electronLog.scope.labelPadding = false

  electronLog.transports.file.level = isDev ? "debug" : "info"
  electronLog.transports.file.maxSize = MAX_MAIN_LOG_SIZE
  electronLog.transports.file.format =
    "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}"
  electronLog.transports.file.resolvePathFn = () => MAIN_LOG_PATH

  electronLog.transports.console.level = isDev ? "debug" : "info"
  electronLog.transports.console.format =
    "{h}:{i}:{s}.{ms} [{level}]{scope} {text}"
}

function createFallbackLogger(scope: string): LogFunctions {
  const write = (level: LogLevel, args: unknown[]) => {
    const method: ConsoleMethodName =
      level === "error" ? "error" : level === "warn" ? "warn" : "log"
    originalConsole[method](`[${scope}]`, ...args)
  }

  return {
    error: (...args: unknown[]) => write("error", args),
    warn: (...args: unknown[]) => write("warn", args),
    info: (...args: unknown[]) => write("info", args),
    verbose: (...args: unknown[]) => write("info", args),
    debug: (...args: unknown[]) => write("debug", args),
    silly: (...args: unknown[]) => write("debug", args),
    log: (...args: unknown[]) => write("info", args)
  }
}

function createScopeLogger(scope: string): LogFunctions {
  if (electronLog) return electronLog.scope(scope) as LogFunctions
  return createFallbackLogger(scope)
}

/** 主进程日志，作用域 main:<runId> */
export const mainLog = createScopeLogger(`main:${RUN_ID}`)
/** 渲染进程（前端）日志，作用域 renderer:<runId> */
export const rendererLog = createScopeLogger(`renderer:${RUN_ID}`)

/** 创建带 runId 的自定义作用域，例如 createScopedLogger("chat") */
export function createScopedLogger(scope: string): LogFunctions {
  return createScopeLogger(`${scope}:${RUN_ID}`)
}

// ---------------------------------------------------------------------------
// console.* 镜像到日志文件（保留终端输出，且不会递归）
// ---------------------------------------------------------------------------
let consolePatched = false
let writingToLog = false

function fallbackConsole(level: LogLevel, args: unknown[]): void {
  const method: ConsoleMethodName =
    level === "error" ? "error" : level === "warn" ? "warn" : "log"
  originalConsole[method](...args)
}

function writeToMainLog(level: LogLevel, args: unknown[]): void {
  // electron-log 的控制台 transport 使用模块加载时捕获的原始 console，
  // 正常情况下不会再进入这里；万一进入则只打印终端，避免重复与递归。
  if (writingToLog) {
    fallbackConsole(level, args)
    return
  }

  writingToLog = true
  try {
    mainLog[level](...args)
  } catch (error) {
    originalConsole.error("[logger] 写入日志失败:", error, ...args)
  } finally {
    writingToLog = false
  }
}

function patchConsole(): void {
  if (consolePatched) return
  consolePatched = true

  console.log = (...args: unknown[]) => writeToMainLog("info", args)
  console.info = (...args: unknown[]) => writeToMainLog("info", args)
  console.warn = (...args: unknown[]) => writeToMainLog("warn", args)
  console.error = (...args: unknown[]) => writeToMainLog("error", args)
  console.debug = (...args: unknown[]) => writeToMainLog("debug", args)
}

// ---------------------------------------------------------------------------
// 启动索引与启动横幅
// ---------------------------------------------------------------------------
function ensureLogDirectory(): boolean {
  try {
    fs.mkdirSync(LOG_DIRECTORY, { recursive: true })
    return true
  } catch (error) {
    originalConsole.error("[logger] 无法创建日志目录:", LOG_DIRECTORY, error)
    return false
  }
}

function rotateStartupLogIfNeeded(): void {
  try {
    if (fs.statSync(STARTUP_LOG_PATH).size <= MAX_STARTUP_LOG_SIZE) return
    const lines = fs
      .readFileSync(STARTUP_LOG_PATH, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
    fs.writeFileSync(
      STARTUP_LOG_PATH,
      `${lines.slice(-STARTUP_LOG_KEEP_LINES).join(os.EOL)}${os.EOL}`,
      "utf8"
    )
  } catch {
    // 启动索引损坏不影响应用运行
  }
}

function readAppVersion(): string {
  try {
    return typeof app.getVersion === "function" ? app.getVersion() : "unknown"
  } catch {
    return "unknown"
  }
}

function appendStartupRecord(): void {
  try {
    rotateStartupLogIfNeeded()
    const record = [
      `[${startedAt.toISOString()}]`,
      `run=${RUN_ID}`,
      `version=${readAppVersion()}`,
      `mode=${mode}`,
      `pid=${process.pid}`,
      `electron=${process.versions?.electron ?? "unknown"}`,
      `platform=${process.platform}-${process.arch}`,
      `exe=${process.execPath}`
    ].join(" ")
    fs.appendFileSync(STARTUP_LOG_PATH, `${record}${os.EOL}`, "utf8")
  } catch (error) {
    mainLog.warn("写入启动索引失败:", error)
  }
}

function logStartupBanner(): void {
  const separator = "=".repeat(78)
  mainLog.info(separator)
  mainLog.info(
    `steamgamecode 启动 run=${RUN_ID} version=${readAppVersion()} mode=${mode}`
  )
  mainLog.info(
    `进程信息 pid=${process.pid} packaged=${Boolean(app.isPackaged)} ` +
      `electron=${process.versions?.electron ?? "unknown"} ` +
      `chrome=${process.versions?.chrome ?? "unknown"} ` +
      `node=${process.versions?.node ?? "unknown"}`
  )
  mainLog.info(
    `系统信息 platform=${process.platform} arch=${process.arch} os=${os.type()} ${os.release()}`
  )
  mainLog.info(`启动时间 ${startedAt.toISOString()}`)
  mainLog.info(`日志文件 ${fileTransportEnabled ? MAIN_LOG_PATH : "（未启用文件日志）"}`)
  mainLog.info(`启动索引 ${fileTransportEnabled ? STARTUP_LOG_PATH : "（未启用文件日志）"}`)
  mainLog.info(`工作目录 ${process.cwd()}`)
  mainLog.info(`启动参数 ${JSON.stringify(process.argv)}`)
  mainLog.info(separator)
}

// ---------------------------------------------------------------------------
// 渲染进程（前端）日志
// ---------------------------------------------------------------------------
const LEVEL_ALIASES: Record<string, LogLevel> = {
  error: "error",
  warn: "warn",
  warning: "warn",
  info: "info",
  log: "info",
  verbose: "verbose",
  debug: "debug",
  trace: "debug",
  silly: "silly"
}

function normalizeLevel(level: unknown): LogLevel {
  if (typeof level === "string") {
    const normalized = LEVEL_ALIASES[level.toLowerCase()]
    if (normalized) return normalized
  }
  return "info"
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}…(已截断 ${value.length - maxLength} 字符)`
}

function stringify(value: unknown, maxLength: number): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return truncate(value, maxLength)
  if (value instanceof Error) {
    return truncate(value.stack || value.message, maxLength)
  }
  try {
    return truncate(JSON.stringify(value), maxLength)
  } catch {
    return truncate(String(value), maxLength)
  }
}

/** 渲染进程通过 IPC 转发过来的日志 */
export function logFromRenderer(
  level: unknown,
  message: unknown,
  meta?: unknown
): void {
  try {
    const text =
      typeof message === "string"
        ? truncate(message, MAX_RENDERER_MESSAGE_LENGTH)
        : stringify(message, MAX_RENDERER_MESSAGE_LENGTH)
    const detail = stringify(meta, MAX_META_LENGTH)
    const line = detail ? `${text} ${detail}` : text
    if (!line.trim()) return
    rendererLog[normalizeLevel(level)](line)
  } catch {
    // 日志失败不影响主流程
  }
}

/** 渲染进程 console.* 输出（webContents console-message 事件） */
export function logFromRendererConsole(
  level: number,
  message: string,
  source?: string
): void {
  try {
    const mapped: LogLevel =
      level >= 3 ? "error" : level === 2 ? "warn" : level === 1 ? "info" : "debug"
    const text = source ? `${message} (${source})` : message
    if (!text.trim()) return
    rendererLog[mapped](truncate(text, MAX_RENDERER_MESSAGE_LENGTH))
  } catch {
    // 日志失败不影响主流程
  }
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------
let initialized = false

/** 在主进程最早的位置调用，越早调用越不会丢启动日志 */
export function initializeMainLogging(): LogInfo {
  if (initialized) return getLogInfo()
  initialized = true

  ensureLogDirectory()
  patchConsole()
  logStartupBanner()
  appendStartupRecord()

  if (electronLog) {
    try {
      // 记录 Electron 事件：渲染进程崩溃、页面加载失败、preload 报错、证书错误等
      electronLog.eventLogger.startLogging({ scope: `event:${RUN_ID}` })
    } catch (error) {
      mainLog.warn("注册 Electron 事件日志失败:", error)
    }
  }

  process.on("uncaughtException", (error) => {
    try {
      mainLog.error("主进程未捕获异常:", error)
    } catch {
      /* ignore */
    }
  })

  process.on("unhandledRejection", (reason) => {
    try {
      mainLog.error("主进程未处理的 Promise 拒绝:", reason)
    } catch {
      /* ignore */
    }
  })

  return getLogInfo()
}

export function getLogInfo(): LogInfo {
  return {
    runId: RUN_ID,
    appVersion: readAppVersion(),
    mode,
    startedAt: startedAt.toISOString(),
    logDirectory: LOG_DIRECTORY,
    mainLogPath: MAIN_LOG_PATH,
    startupLogPath: STARTUP_LOG_PATH,
    fileLevel: fileTransportEnabled
      ? String(electronLog.transports.file.level)
      : "console",
    consoleLevel: fileTransportEnabled
      ? String(electronLog.transports.console.level)
      : "console",
    fileTransportEnabled
  }
}

export function logShutdown(reason: string): void {
  try {
    mainLog.info(
      `应用退出 reason=${reason} 运行时长=${Date.now() - startedAt.getTime()}ms`
    )
  } catch {
    /* ignore */
  }
}

export async function openLogDirectory(): Promise<OpenLogDirectoryResult> {
  try {
    fs.mkdirSync(LOG_DIRECTORY, { recursive: true })
    const error = await shell.openPath(LOG_DIRECTORY)
    return error
      ? { success: false, path: LOG_DIRECTORY, error }
      : { success: true, path: LOG_DIRECTORY }
  } catch (error) {
    return {
      success: false,
      path: LOG_DIRECTORY,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
