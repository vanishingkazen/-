// ipcHandlers.ts

import { clipboard, ipcMain, shell } from "electron"
import { IIpcHandlerDeps } from "./main"
import { configHelper } from "./ConfigHelper"
import { historyHelper } from "./HistoryHelper"
import type { VoiceSource } from "./VoiceRecognitionHelper"
import { ensureInterviewContextFile, getInterviewContextStatus } from "./InterviewContextHelper"
import type { ChatSessionSeed } from "./ChatService"

export function initializeIpcHandlers(deps: IIpcHandlerDeps): void {
  console.log("Initializing IPC handlers")

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
      removedSegments: 0
    }
  })
  ipcMain.handle("voice-correct-conversation", async (_event, conversation) => {
    return deps.processingHelper?.correctVoiceConversation(conversation) || {
      ...conversation,
      corrected: false
    }
  })

  // Solution history is local-only. Text remains until manually deleted;
  // screenshots are automatically removed after three days.
  ipcMain.handle("get-history", () => historyHelper.list())

  ipcMain.handle("restore-history", (_event, id: string) => {
    const record = historyHelper.get(id)
    if (!record) return { success: false, error: "History record not found" }
    deps.setProblemInfo(record.problem)
    deps.processingHelper?.setCurrentBasicCode(record.solution?.basic_code)
    deps.processingHelper?.setCurrentSolutionCode(record.solution?.code)
    deps.setView("solutions")
    return { success: true, record }
  })

  ipcMain.handle("delete-history", (_event, id: string) => ({
    success: historyHelper.delete(id)
  }))
  
  ipcMain.handle("validate-api-key", async (_event, apiKey) => {
    // First check the format
    if (!configHelper.isValidApiKeyFormat(apiKey)) {
      return { 
        valid: false, 
        error: "Invalid API key format. OpenAI API keys start with 'sk-'" 
      };
    }
    
    // Then test the API key with OpenAI
    const result = await configHelper.testApiKey(apiKey);
    return result;
  })

  // Credits handlers
  ipcMain.handle("set-initial-credits", async (_event, credits: number) => {
    const mainWindow = deps.getMainWindow()
    if (!mainWindow) return

    try {
      // Set the credits in a way that ensures atomicity
      await mainWindow.webContents.executeJavaScript(
        `window.__CREDITS__ = ${credits}`
      )
      mainWindow.webContents.send("credits-updated", credits)
    } catch (error) {
      console.error("Error setting initial credits:", error)
      throw error
    }
  })

  ipcMain.handle("decrement-credits", async () => {
    const mainWindow = deps.getMainWindow()
    if (!mainWindow) return

    try {
      const currentCredits = await mainWindow.webContents.executeJavaScript(
        "window.__CREDITS__"
      )
      if (currentCredits > 0) {
        const newCredits = currentCredits - 1
        await mainWindow.webContents.executeJavaScript(
          `window.__CREDITS__ = ${newCredits}`
        )
        mainWindow.webContents.send("credits-updated", newCredits)
      }
    } catch (error) {
      console.error("Error decrementing credits:", error)
    }
  })

  // Screenshot queue handlers
  ipcMain.handle("get-screenshot-queue", () => {
    return deps.getScreenshotQueue()
  })

  ipcMain.handle("get-extra-screenshot-queue", () => {
    return deps.getExtraScreenshotQueue()
  })

  ipcMain.handle("delete-screenshot", async (event, path: string) => {
    return deps.deleteScreenshot(path)
  })

  ipcMain.handle("get-image-preview", async (event, path: string) => {
    return deps.getImagePreview(path)
  })

  // Screenshot processing handlers
  ipcMain.handle("process-screenshots", async (_event, userRequest = "") => {
    // Check for API key before processing
    if (!configHelper.hasApiKey()) {
      const mainWindow = deps.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send(deps.PROCESSING_EVENTS.API_KEY_INVALID);
      }
      return;
    }
    
    await deps.processingHelper?.processScreenshots(userRequest)
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

  ipcMain.handle(
    "set-window-dimensions",
    (event, width: number, height: number) => {
      deps.setWindowDimensions(width, height)
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

  ipcMain.handle("take-screenshot", async () => {
    try {
      const screenshotPath = await deps.takeScreenshot()
      const preview = await deps.getImagePreview(screenshotPath)
      return { path: screenshotPath, preview }
    } catch (error) {
      console.error("Error taking screenshot:", error)
      return { error: "Failed to take screenshot" }
    }
  })

  // Auth-related handlers removed

  ipcMain.handle("open-external-url", (event, url: string) => {
    shell.openExternal(url)
  })
  
  // Open external URL handler
  ipcMain.handle("openLink", (event, url: string) => {
    try {
      console.log(`Opening external URL: ${url}`);
      shell.openExternal(url);
      return { success: true };
    } catch (error) {
      console.error(`Error opening URL ${url}:`, error);
      return { success: false, error: `Failed to open URL: ${error}` };
    }
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

  ipcMain.handle("reset-queues", async () => {
    try {
      deps.clearQueues()
      return { success: true }
    } catch (error) {
      console.error("Error resetting queues:", error)
      return { error: "Failed to reset queues" }
    }
  })

  // Process screenshot handlers
  ipcMain.handle("trigger-process-screenshots", async (_event, userRequest = "") => {
    try {
      const screenshotQueue = deps.getView() === "queue"
        ? deps.getScreenshotQueue()
        : deps.getExtraScreenshotQueue()
      if (!screenshotQueue.length) {
        return { success: false, error: "没有可提交的截图" }
      }

      // Check for API key before processing
      if (!configHelper.hasApiKey()) {
        const mainWindow = deps.getMainWindow();
        if (mainWindow) {
          mainWindow.webContents.send(deps.PROCESSING_EVENTS.API_KEY_INVALID);
        }
        return { success: false, error: "API key required" };
      }
      
      await deps.processingHelper?.processScreenshots(userRequest)
      return { success: true }
    } catch (error) {
      console.error("Error processing screenshots:", error)
      return { error: "Failed to process screenshots" }
    }
  })

  ipcMain.handle("chat-get-session", (_event, id?: string) => {
    if (!deps.chatService) return null
    return id ? deps.chatService.getSession(id) : deps.chatService.getCurrentSession()
  })

  ipcMain.handle("chat-new-session", (_event, seed?: ChatSessionSeed) => {
    return deps.chatService?.createSession(seed) || null
  })

  ipcMain.handle("chat-select-session", (_event, id: string) => {
    return deps.chatService?.selectSession(id) || null
  })
  ipcMain.handle("chat-list-sessions", () => {
    return deps.chatService?.listSessions() || []
  })

  ipcMain.handle("chat-delete-session", (_event, id: string) => {
    if (!id || !deps.chatService) return { success: false }
    const wasCurrent = deps.chatService.getCurrentSession().id === id
    const success = deps.chatService.deleteSession(id)
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
        // Send reset events in sequence
        mainWindow.webContents.send("reset-view", { session: resetSession })
        mainWindow.webContents.send("reset")
      }

      return { success: true }
    } catch (error) {
      console.error("Error triggering reset:", error)
      return { error: "Failed to trigger reset" }
    }
  })

  // Window movement handlers
  ipcMain.handle("trigger-move-left", () => {
    try {
      deps.moveWindowLeft()
      return { success: true }
    } catch (error) {
      console.error("Error moving window left:", error)
      return { error: "Failed to move window left" }
    }
  })

  ipcMain.handle("trigger-move-right", () => {
    try {
      deps.moveWindowRight()
      return { success: true }
    } catch (error) {
      console.error("Error moving window right:", error)
      return { error: "Failed to move window right" }
    }
  })

  ipcMain.handle("trigger-move-up", () => {
    try {
      deps.moveWindowUp()
      return { success: true }
    } catch (error) {
      console.error("Error moving window up:", error)
      return { error: "Failed to move window up" }
    }
  })

  ipcMain.handle("trigger-move-down", () => {
    try {
      deps.moveWindowDown()
      return { success: true }
    } catch (error) {
      console.error("Error moving window down:", error)
      return { error: "Failed to move window down" }
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
      
      // Notify the renderer about the change
      const mainWindow = deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("screenshot-deleted", { path: lastScreenshot })
      }
      
      return result
    } catch (error) {
      console.error("Error deleting last screenshot:", error)
      return { success: false, error: "Failed to delete last screenshot" }
    }
  })
}
