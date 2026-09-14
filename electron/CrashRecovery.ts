import { app, BrowserWindow, dialog, type WebContents } from "electron"
import fs from "node:fs"
import path from "node:path"

const RESTART_WINDOW_MS = 5 * 60 * 1000
const MAX_RESTARTS = 3
const RENDERER_WINDOW_MS = 2 * 60 * 1000
const MAX_RENDERER_RELOADS = 3
const RENDERER_RELOAD_DELAY_MS = 750

let shuttingDown = false
let restartScheduled = false
const rendererReloadTimes = new Map<number, number[]>()

function recoveryDirectory(): string {
  return path.join(app.getPath("appData"), "steamgamecode")
}

function restartStatePath(): string {
  return path.join(recoveryDirectory(), "crash-restarts.json")
}

function crashLogPath(): string {
  return path.join(recoveryDirectory(), "crash-recovery.log")
}

function ensureRecoveryDirectory(): void {
  fs.mkdirSync(recoveryDirectory(), { recursive: true })
}

function readRestartTimes(): number[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(restartStatePath(), "utf8"))
    return Array.isArray(parsed)
      ? parsed.filter((value): value is number => typeof value === "number")
      : []
  } catch {
    return []
  }
}

function pruneRestartTimes(times: number[], now = Date.now()): number[] {
  return times.filter((timestamp) => now - timestamp < RESTART_WINDOW_MS)
}

function writeRestartTimes(times: number[]): void {
  try {
    ensureRecoveryDirectory()
    fs.writeFileSync(restartStatePath(), JSON.stringify(times.slice(-20), null, 2), "utf8")
  } catch (error) {
    console.error("Failed to persist crash restart state:", error)
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function appendCrashLog(reason: string, error?: unknown): void {
  const detail = error === undefined ? "" : `\n${formatError(error)}`
  const entry = `[${new Date().toISOString()}] ${reason}${detail}\n`
  try {
    ensureRecoveryDirectory()
    fs.appendFileSync(crashLogPath(), entry, "utf8")
  } catch (logError) {
    console.error("Failed to write crash recovery log:", logError)
  }
  console.error(entry.trim())
}

function showRestartLimitMessage(): void {
  if (!app.isReady()) return
  try {
    dialog.showErrorBox(
      "steamgamecode 已停止自动重启",
      "应用在短时间内连续发生多次崩溃。为防止无限重启，自动恢复已暂停。\n\n请检查崩溃日志后手动启动应用：\n" + crashLogPath()
    )
  } catch (error) {
    console.error("Failed to show restart-limit dialog:", error)
  }
}

export function requestAppRestart(reason: string, error?: unknown): void {
  if (shuttingDown || restartScheduled) return
  restartScheduled = true
  appendCrashLog(reason, error)

  const now = Date.now()
  const restartTimes = pruneRestartTimes(readRestartTimes(), now)
  if (restartTimes.length >= MAX_RESTARTS) {
    showRestartLimitMessage()
    app.exit(1)
    return
  }

  restartTimes.push(now)
  writeRestartTimes(restartTimes)
  const delayMs = Math.min(500 * 2 ** restartTimes.length, 4000)
  console.warn(`Restarting steamgamecode in ${delayMs}ms (${restartTimes.length}/${MAX_RESTARTS})`)

  setTimeout(() => {
    try {
      app.relaunch()
      app.exit(1)
    } catch (relaunchError) {
      appendCrashLog("relaunch-failed", relaunchError)
      app.exit(1)
    }
  }, delayMs)
}

function reloadRenderer(contents: WebContents): void {
  const now = Date.now()
  const recent = (rendererReloadTimes.get(contents.id) || []).filter(
    (timestamp) => now - timestamp < RENDERER_WINDOW_MS
  )

  if (recent.length >= MAX_RENDERER_RELOADS) {
    requestAppRestart("renderer-crash-loop", `webContents id=${contents.id}`)
    return
  }

  recent.push(now)
  rendererReloadTimes.set(contents.id, recent)
  console.warn(
    `Renderer process gone; reloading webContents ${contents.id} (${recent.length}/${MAX_RENDERER_RELOADS})`
  )

  setTimeout(() => {
    if (shuttingDown) return
    if (!contents.isDestroyed()) {
      contents.reload()
      return
    }

    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isDestroyed()) {
      window.reload()
      return
    }

    requestAppRestart("renderer-window-unavailable")
  }, RENDERER_RELOAD_DELAY_MS)
}

export function installCrashRecovery(): void {
  process.on("uncaughtException", (error) => {
    requestAppRestart("uncaughtException", error)
  })

  process.on("unhandledRejection", (error) => {
    requestAppRestart("unhandledRejection", error)
  })

  app.on("render-process-gone", (_event, contents, details) => {
    if (contents.getType() !== "window") return
    if (details.reason === "clean-exit" || shuttingDown) return
    appendCrashLog(
      "render-process-gone",
      `reason=${details.reason} exitCode=${details.exitCode} webContents=${contents.id}`
    )
    reloadRenderer(contents)
  })

  app.on("before-quit", () => {
    shuttingDown = true
  })
}
