// ipcHandlers.ts

import { BrowserWindow, clipboard, ipcMain, shell, type WebContents } from "electron"
import type { IIpcHandlerDeps } from "./contracts"
import { configHelper } from "./ConfigHelper"
import type { VoiceSource } from "./VoiceRecognitionHelper"
import { ensureInterviewContextFile, getInterviewContextStatus } from "./InterviewContextHelper"
import type { ChatSessionSeed } from "./ChatService"
import type { CompanionStatus } from "./CompanionTypes"
import { getLogInfo, logFromRenderer, openLogDirectory } from "./logger"

/** 只接受本应用窗口发来的日志，避免其它渲染进程写入日志文件 */
function isTrustedLogSender(sender: WebContents): boolean {
  try {
    return BrowserWindow.fromWebContents(sender) !== null
  } catch {
    return false
  }
}

export function initializeIpcHandlers(deps: IIpcHandlerDeps): void {
  console.log("Initializing IPC handlers")

  // 日志：前端转发、日志信息与日志目录
  ipcMain.handle("log-from-renderer", (event, payload) => {
    if (!isTrustedLogSender(event.sender)) return
    const data = payload && typeof payload === "object" ? payload : {}
    logFromRenderer(data.level, data.message, data.meta)
    return { success: true }
  })

  ipcMain.handle("get-log-info", () => getLogInfo())

  ipcMain.handle("open-log-directory", () => openLogDirectory())

  ipcMain.handle("companion-get-status", () => deps.companionServer?.getStatus() || {
    running: false,
    connected: false,
    addresses: []
  } satisfies CompanionStatus)
  ipcMain.handle("companion-start", async () => {
    try {
      return { success: true, status: await deps.companionServer?.start() }
    } catch (error) {
      return {
        success: false,
        status: deps.companionServer?.getStatus(),
        error: error instanceof Error ? error.message : "无法启动手机伴随服务"
      }
    }
  })
  ipcMain.handle("companion-stop", async () => ({
    success: true,
    status: await deps.companionServer?.stop()
  }))
  ipcMain.handle("companion-refresh-pairing", () => {
    try {
      return { success: true, status: deps.companionServer?.refreshPairing() }
    } catch (error) {
      return {
        success: false,
        status: deps.companionServer?.getStatus(),
        error: error instanceof Error ? error.message : "无法刷新配对码"
      }
    }
  })
  ipcMain.handle("companion-disconnect-phone", () => ({
    success: true,
    status: deps.companionServer?.disconnectPhone()
  }))

  // Configuration handlers
  ipcMain.handle("get-config", () => {
    return configHelper.loadConfig();
  })

  ipcMain.handle("update-config", (_event, updates) => {
    const newConfig = configHelper.updateConfig(updates)

    if (typeof updates?.opacity === "number") {
      const mainWindow = deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setOpacity(newConfig.opacity)
      }
    }

    return newConfig
  })

  ipcMain.handle("set-opacity", (_event, opacity: unknown) => {
    const numericOpacity = typeof opacity === "number" && Number.isFinite(opacity)
      ? opacity
      : 1
    const value = Math.min(1, Math.max(0.1, numericOpacity))
    const mainWindow = deps.getMainWindow()

    if (!mainWindow || mainWindow.isDestroyed()) {
      return { success: false, opacity: value, error: "Main window not available" }
    }

    mainWindow.setOpacity(value)
    return { success: true, opacity: value }
  })

  ipcMain.handle("interview-context-status", () => {
    const config = configHelper.loadConfig()
    const interviewContextPath = ensureInterviewContextFile(config.interviewContextPath)
    if (config.interviewContextPath !== interviewContextPath) {
      configHelper.updateConfig({ interviewContextPath })
    }
    return getInterviewContextStatus(
      config.interviewContextEnabled,
      interviewContextPath
    )
  })

  ipcMain.handle("interview-context-set-enabled", (_event, enabled: boolean) => {
    const config = configHelper.loadConfig()
    const interviewContextPath = ensureInterviewContextFile(config.interviewContextPath)
    const status = getInterviewContextStatus(Boolean(enabled), interviewContextPath)
    if (config.interviewContextPath !== interviewContextPath) {
      configHelper.updateConfig({ interviewContextPath })
    }
    if (enabled && !status.available) {
      return { ...status, success: false }
    }
    configHelper.updateConfig({ interviewContextEnabled: Boolean(enabled) })
    return { ...status, enabled: Boolean(enabled), success: true }
  })

  ipcMain.handle("open-interview-context-file", async () => {
    try {
      const config = configHelper.loadConfig()
      const interviewContextPath = ensureInterviewContextFile(config.interviewContextPath)
      if (config.interviewContextPath !== interviewContextPath) {
        configHelper.updateConfig({ interviewContextPath })
      }
      const error = await shell.openPath(interviewContextPath)
      return error
        ? { success: false, path: interviewContextPath, error }
        : { success: true, path: interviewContextPath }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "无法打开面试上下文文件"
      }
    }
  })

  ipcMain.handle("check-api-key", () => {
    return configHelper.hasApiKey();
  })

  ipcMain.handle("clipboard-write", (_event, text: unknown) => {
    if (typeof text !== "string") {
      return { success: false, error: "复制内容无效" }
    }
    clipboard.writeText(text)
    return { success: true }
  })

  const voiceSource = (source: unknown): VoiceSource =>
    source === "system" ? "system" : "microphone"

  ipcMain.handle("voice-start", async (_event, source?: VoiceSource) => {
    const selectedSource = voiceSource(source)
    return deps.voiceRecognitionHelper?.start(selectedSource)
  })
  ipcMain.handle("voice-audio", (_event, audio: ArrayBuffer | Uint8Array, source?: VoiceSource) => {
    const selectedSource = voiceSource(source)
    return deps.voiceRecognitionHelper?.appendAudio(audio, selectedSource)
  })
  ipcMain.handle("voice-stop", async (_event, source?: VoiceSource) => {
    const selectedSource = voiceSource(source)
    return deps.voiceRecognitionHelper?.stop(selectedSource)
  })
  ipcMain.handle("voice-clear", (_event, source?: VoiceSource) => {
    deps.voiceRecognitionHelper?.clearTranscript(source ? voiceSource(source) : undefined)
    return { success: true }
  })
  ipcMain.handle("voice-conversation", () => {
    return deps.voiceRecognitionHelper?.getConversationTranscript() || {
      systemTranscript: "",
      microphoneTranscript: "",
      rawMicrophoneTranscript: "",
      removedSegments: 0,
      turns: []
    }
  })
  ipcMain.handle("voice-correct-conversation", async (_event, conversation) => {
    return deps.processingHelper?.correctVoiceConversation(conversation) || {
      ...conversation,
      corrected: false
    }
  })

  ipcMain.handle("delete-screenshot", async (event, path: string) => {
    return deps.deleteScreenshot(path)
  })

  ipcMain.handle("get-image-preview", async (event, path: string) => {
    return deps.getImagePreview(path)
  })

  // Window dimension handlers
  ipcMain.handle(
    "update-content-dimensions",
    async (event, { width, height }: { width: number; height: number }) => {
      if (width && height) {
        deps.setWindowDimensions(width, height)
      }
    }
  )

  // Screenshot management handlers
  ipcMain.handle("get-screenshots", async () => {
    try {
      let previews = []
      const currentView = deps.getView()

      if (currentView === "queue") {
        const queue = deps.getScreenshotQueue()
        previews = await Promise.all(
          queue.map(async (path) => ({
            path,
            preview: await deps.getImagePreview(path)
          }))
        )
      } else {
        const extraQueue = deps.getExtraScreenshotQueue()
        previews = await Promise.all(
          extraQueue.map(async (path) => ({
            path,
            preview: await deps.getImagePreview(path)
          }))
        )
      }

      return previews
    } catch (error) {
      console.error("Error getting screenshots:", error)
      throw error
    }
  })

  // Screenshot trigger handlers
  ipcMain.handle("trigger-screenshot", async () => {
    const mainWindow = deps.getMainWindow()
    if (mainWindow) {
      try {
        const screenshotPath = await deps.takeScreenshot()
        const preview = await deps.getImagePreview(screenshotPath)
        mainWindow.webContents.send("screenshot-taken", {
          path: screenshotPath,
          preview
        })
        return { success: true }
      } catch (error) {
        console.error("Error triggering screenshot:", error)
        return { error: "Failed to trigger screenshot" }
      }
    }
    return { error: "No main window available" }
  })
  
  // Settings portal handler
  ipcMain.handle("open-settings-portal", () => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send("show-settings-dialog");
      return { success: true };
    }
    return { success: false, error: "Main window not available" };
  })

  // Window management handlers
  ipcMain.handle("toggle-window", () => {
    try {
      deps.toggleMainWindow()
      return { success: true }
    } catch (error) {
      console.error("Error toggling window:", error)
      return { error: "Failed to toggle window" }
    }
  })

  ipcMain.handle("minimize-main-window", () => {
    const mainWindow = deps.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false }
    mainWindow.minimize()
    return { success: true }
  })

  ipcMain.handle("close-main-window", () => {
    const mainWindow = deps.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false }
    mainWindow.close()
    return { success: true }
  })

  ipcMain.handle("chat-get-session", (_event, id?: string) => {
    if (!deps.chatService) return null
    return id ? deps.chatService.getSession(id) : deps.chatService.getCurrentSession()
  })

  ipcMain.handle("chat-new-session", (_event, seed?: ChatSessionSeed) => {
    const session = deps.chatService?.createSession(seed) || null
    if (session) deps.companionServer?.publish("refresh")
    return session
  })

  ipcMain.handle("chat-select-session", (_event, id: string) => {
    const session = deps.chatService?.selectSession(id) || null
    if (session) deps.companionServer?.publish("refresh")
    return session
  })
  ipcMain.handle("chat-list-sessions", () => {
    return deps.chatService?.listSessions() || []
  })

  ipcMain.handle("chat-delete-session", (_event, id: string) => {
    if (!id || !deps.chatService) return { success: false }
    const wasCurrent = deps.chatService.getCurrentSession().id === id
    const success = deps.chatService.deleteSession(id)
    if (success) deps.companionServer?.publish("refresh")
    return {
      success,
      ...(success && wasCurrent ? { session: deps.chatService.getCurrentSession() } : {})
    }
  })

  ipcMain.handle(
    "chat-send-message",
    async (_event, payload: {
      requestId: string
      sessionId?: string
      text: string
      images?: Array<{ path: string; preview?: string }>
    }) => {
      if (!configHelper.hasApiKey()) {
        return { success: false, error: "API key required" }
      }
      if (!payload || typeof payload !== "object") {
        return { success: false, error: "请求参数无效" }
      }
      if (typeof payload.requestId !== "string" || !payload.requestId.trim()) {
        return { success: false, error: "请求标识无效" }
      }
      if (!deps.chatService) {
        return { success: false, error: "Chat service unavailable" }
      }
      const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim()
        ? payload.sessionId
        : deps.chatService.getCurrentSession().id
      const text = typeof payload.text === "string" ? payload.text : ""
      const images = Array.isArray(payload.images) ? payload.images : []
      return deps.chatService.sendMessage(
        sessionId,
        text,
        images,
        payload.requestId
      )
    }
  )

  ipcMain.handle("chat-cancel", () => {
    deps.chatService?.cancel()
    return { success: true }
  })

  // Reset handlers
  ipcMain.handle("trigger-reset", () => {
    try {
      // First cancel any ongoing requests
      deps.processingHelper?.cancelOngoingRequests()
      deps.processingHelper?.setCurrentBasicCode("")
      deps.chatService?.cancel()
      const resetSession = deps.chatService?.resetCurrentSession()

      // Clear all queues immediately
      deps.clearQueues()

      // Reset view to queue
      deps.setView("queue")

      // Get main window and send reset events
      const mainWindow = deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("reset-view", { session: resetSession })
      }

      return { success: true }
    } catch (error) {
      console.error("Error triggering reset:", error)
      return { error: "Failed to trigger reset" }
    }
  })
  
  // Delete last screenshot handler
  ipcMain.handle("delete-last-screenshot", async () => {
    try {
      const queue = deps.getView() === "queue" 
        ? deps.getScreenshotQueue() 
        : deps.getExtraScreenshotQueue()
      
      if (queue.length === 0) {
        return { success: false, error: "No screenshots to delete" }
      }
      
      // Get the last screenshot in the queue
      const lastScreenshot = queue[queue.length - 1]
      
      // Delete it
      const result = await deps.deleteScreenshot(lastScreenshot)
      
      return result
    } catch (error) {
      console.error("Error deleting last screenshot:", error)
      return { success: false, error: "Failed to delete last screenshot" }
    }
  })
}
