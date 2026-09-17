console.log("Preload script starting...")
import { contextBridge, ipcRenderer } from "electron"
const { shell } = require("electron")

export const PROCESSING_EVENTS = {
  //global states
  UNAUTHORIZED: "procesing-unauthorized",
  NO_SCREENSHOTS: "processing-no-screenshots",
  OUT_OF_CREDITS: "out-of-credits",
  API_KEY_INVALID: "api-key-invalid",

  //states for generating the initial solution
  INITIAL_START: "initial-start",
  PROBLEM_EXTRACTED: "problem-extracted",
  SOLUTION_STREAM: "solution-stream",
  SOLUTION_SUCCESS: "solution-success",
  INITIAL_SOLUTION_ERROR: "solution-error",
  RESET: "reset",

  //states for processing the debugging
  DEBUG_START: "debug-start",
  DEBUG_SUCCESS: "debug-success",
  DEBUG_ERROR: "debug-error"
} as const

// At the top of the file
console.log("Preload script is running")

const electronAPI = {
  getHistory: () => ipcRenderer.invoke("get-history"),
  restoreHistory: (id: string) => ipcRenderer.invoke("restore-history", id),
  deleteHistory: (id: string) => ipcRenderer.invoke("delete-history", id),
  // Original methods
  openSubscriptionPortal: async (authData: { id: string; email: string }) => {
    return ipcRenderer.invoke("open-subscription-portal", authData)
  },
  openSettingsPortal: () => ipcRenderer.invoke("open-settings-portal"),
  openInterviewContextFile: () => ipcRenderer.invoke("open-interview-context-file"),
  setOpacity: (opacity: number) => ipcRenderer.invoke("set-opacity", opacity),
  updateContentDimensions: (dimensions: { width: number; height: number }) =>
    ipcRenderer.invoke("update-content-dimensions", dimensions),
  clearStore: () => ipcRenderer.invoke("clear-store"),
  getScreenshots: () => ipcRenderer.invoke("get-screenshots"),
  deleteScreenshot: (path: string) =>
    ipcRenderer.invoke("delete-screenshot", path),
  minimizeMainWindow: () => ipcRenderer.invoke("minimize-main-window"),
  closeMainWindow: () => ipcRenderer.invoke("close-main-window"),
  toggleMainWindow: async () => {
    console.log("toggleMainWindow called from preload")
    try {
      const result = await ipcRenderer.invoke("toggle-window")
      console.log("toggle-window result:", result)
      return result
    } catch (error) {
      console.error("Error in toggleMainWindow:", error)
      throw error
    }
  },
  // Event listeners
  onScreenshotTaken: (
    callback: (data: { path: string; preview: string }) => void
  ) => {
    const subscription = (_: any, data: { path: string; preview: string }) =>
      callback(data)
    ipcRenderer.on("screenshot-taken", subscription)
    return () => {
      ipcRenderer.removeListener("screenshot-taken", subscription)
    }
  },
  onResetView: (callback: (data?: { session?: unknown }) => void) => {
    const subscription = (_event: unknown, data?: { session?: unknown }) => callback(data)
    ipcRenderer.on("reset-view", subscription)
    return () => {
      ipcRenderer.removeListener("reset-view", subscription)
    }
  },
  onSolutionStart: (callback: (data?: { questionMode?: "coding" | "iq" }) => void) => {
    const subscription = (_event: unknown, data?: { questionMode?: "coding" | "iq" }) => callback(data)
    ipcRenderer.on(PROCESSING_EVENTS.INITIAL_START, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.INITIAL_START, subscription)
    }
  },
  onDebugStart: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.DEBUG_START, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.DEBUG_START, subscription)
    }
  },
  onDebugSuccess: (callback: (data: any) => void) => {
    const subscription = (_event: any, data: any) => callback(data)
    ipcRenderer.on("debug-success", subscription)
    return () => {
      ipcRenderer.removeListener("debug-success", subscription)
    }
  },
  onFocusChatInput: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("focus-chat-input", subscription)
    return () => {
      ipcRenderer.removeListener("focus-chat-input", subscription)
    }
  },
  onNewChatSession: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("new-chat-session", subscription)
    return () => {
      ipcRenderer.removeListener("new-chat-session", subscription)
    }
  },
  onScrollChat: (callback: (data: { direction: "up" | "down" }) => void) => {
    const subscription = (_event: unknown, data: { direction: "up" | "down" }) => callback(data)
    ipcRenderer.on("scroll-chat", subscription)
    return () => {
      ipcRenderer.removeListener("scroll-chat", subscription)
    }
  },
  onDebugError: (callback: (error: string) => void) => {
    const subscription = (_: any, error: string) => callback(error)
    ipcRenderer.on(PROCESSING_EVENTS.DEBUG_ERROR, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.DEBUG_ERROR, subscription)
    }
  },
  onSolutionError: (callback: (error: string) => void) => {
    const subscription = (_: any, error: string) => callback(error)
    ipcRenderer.on(PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR, subscription)
    return () => {
      ipcRenderer.removeListener(
        PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
        subscription
      )
    }
  },
  onProcessingNoScreenshots: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.NO_SCREENSHOTS, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.NO_SCREENSHOTS, subscription)
    }
  },
  onOutOfCredits: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.OUT_OF_CREDITS, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.OUT_OF_CREDITS, subscription)
    }
  },
  onProblemExtracted: (callback: (data: any) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on(PROCESSING_EVENTS.PROBLEM_EXTRACTED, subscription)
    return () => {
      ipcRenderer.removeListener(
        PROCESSING_EVENTS.PROBLEM_EXTRACTED,
        subscription
      )
    }
  },
  onSolutionSuccess: (callback: (data: any) => void) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on(PROCESSING_EVENTS.SOLUTION_SUCCESS, subscription)
    return () => {
      ipcRenderer.removeListener(
        PROCESSING_EVENTS.SOLUTION_SUCCESS,
        subscription
      )
    }
  },
  onSolutionStream: (
    callback: (data: { content: string; isThinking: boolean; done: boolean }) => void
  ) => {
    const subscription = (
      _: any,
      data: { content: string; isThinking: boolean; done: boolean }
    ) => callback(data)
    ipcRenderer.on(PROCESSING_EVENTS.SOLUTION_STREAM, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.SOLUTION_STREAM, subscription)
    }
  },
  onProcessingStatus: (
    callback: (data: {
      message: string
      progress: number
      stage?: string
      requestId?: string
    }) => void
  ) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("processing-status", subscription)
    return () => ipcRenderer.removeListener("processing-status", subscription)
  },
  onLanguageDetected: (callback: (data: { language: string }) => void) => {
    const subscription = (_: any, data: { language: string }) => callback(data)
    ipcRenderer.on("language-detected", subscription)
    return () => ipcRenderer.removeListener("language-detected", subscription)
  },
  onChatStarted: (
    callback: (data: { sessionId: string; requestId: string; userMessage: any }) => void
  ) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("chat-started", subscription)
    return () => ipcRenderer.removeListener("chat-started", subscription)
  },
  onChatStream: (
    callback: (data: { requestId: string; sessionId: string; content: string; done: boolean }) => void
  ) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("chat-stream", subscription)
    return () => ipcRenderer.removeListener("chat-stream", subscription)
  },
  onChatContextCompressed: (
    callback: (data: { sessionId: string; summary: string }) => void
  ) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("chat-context-compressed", subscription)
    return () => ipcRenderer.removeListener("chat-context-compressed", subscription)
  },
  onChatSuccess: (
    callback: (data: { requestId: string; sessionId: string; content: string; session: unknown }) => void
  ) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("chat-success", subscription)
    return () => ipcRenderer.removeListener("chat-success", subscription)
  },
  onChatError: (
    callback: (data: { requestId: string; sessionId: string; error: string }) => void
  ) => {
    const subscription = (_: any, data: any) => callback(data)
    ipcRenderer.on("chat-error", subscription)
    return () => ipcRenderer.removeListener("chat-error", subscription)
  },
  onUnauthorized: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.UNAUTHORIZED, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.UNAUTHORIZED, subscription)
    }
  },
  // External URL handler
  openLink: (url: string) => shell.openExternal(url),
  triggerScreenshot: () => ipcRenderer.invoke("trigger-screenshot"),
  triggerProcessScreenshots: (userRequest = "") =>
    ipcRenderer.invoke("trigger-process-screenshots", userRequest),
  getChatSession: (id?: string) => ipcRenderer.invoke("chat-get-session", id),
  getImagePreview: (path: string) => ipcRenderer.invoke("get-image-preview", path),
  newChatSession: (seed?: unknown) => ipcRenderer.invoke("chat-new-session", seed),
  selectChatSession: (id: string) => ipcRenderer.invoke("chat-select-session", id),
  listChatSessions: () => ipcRenderer.invoke("chat-list-sessions"),
  deleteChatSession: (id: string) => ipcRenderer.invoke("chat-delete-session", id),
  sendChatMessage: (payload: {
    requestId: string
    sessionId?: string
    text: string
    images?: Array<{ path: string; preview?: string }>
  }) => ipcRenderer.invoke("chat-send-message", payload),
  cancelChat: () => ipcRenderer.invoke("chat-cancel"),
  writeClipboardText: (text: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("clipboard-write", text),
  startVoiceRecognition: (source: "microphone" | "system" = "microphone") => ipcRenderer.invoke("voice-start", source),
  sendVoiceAudio: (audio: ArrayBuffer, source: "microphone" | "system" = "microphone") => ipcRenderer.invoke("voice-audio", audio, source),
  stopVoiceRecognition: (source: "microphone" | "system" = "microphone"): Promise<{ success: boolean; transcript?: string }> => ipcRenderer.invoke("voice-stop", source),
  clearVoiceContext: (source?: "microphone" | "system") => ipcRenderer.invoke("voice-clear", source),
  getVoiceConversation: (): Promise<{
    systemTranscript: string;
    microphoneTranscript: string;
    rawMicrophoneTranscript: string;
    removedSegments: number;
  }> => ipcRenderer.invoke("voice-conversation"),
  correctVoiceConversation: (conversation: {
    systemTranscript: string;
    microphoneTranscript: string;
    rawMicrophoneTranscript: string;
    removedSegments: number;
  }): Promise<{
    systemTranscript: string;
    microphoneTranscript: string;
    rawMicrophoneTranscript: string;
    removedSegments: number;
    corrected: boolean;
  }> => ipcRenderer.invoke("voice-correct-conversation", conversation),
  getInterviewContextStatus: (): Promise<{
    enabled: boolean;
    available: boolean;
    path: string;
    characterCount: number;
    error?: string;
  }> => ipcRenderer.invoke("interview-context-status"),
  setInterviewContextEnabled: (enabled: boolean): Promise<{
    success: boolean;
    enabled: boolean;
    available: boolean;
    path: string;
    characterCount: number;
    error?: string;
  }> => ipcRenderer.invoke("interview-context-set-enabled", enabled),
  onToggleVoiceInput: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("toggle-voice-input", subscription)
    return () => ipcRenderer.removeListener("toggle-voice-input", subscription)
  },
  onVoiceStatus: (callback: (data: { source: "microphone" | "system"; state: string; message: string }) => void) => {
    const subscription = (_event: unknown, data: { source: "microphone" | "system"; state: string; message: string }) => callback(data)
    ipcRenderer.on("voice-status", subscription)
    return () => ipcRenderer.removeListener("voice-status", subscription)
  },
  onVoicePartial: (callback: (data: { source: "microphone" | "system"; text: string }) => void) => {
    const subscription = (_event: unknown, data: { source: "microphone" | "system"; text: string }) => callback(data)
    ipcRenderer.on("voice-transcript-partial", subscription)
    return () => ipcRenderer.removeListener("voice-transcript-partial", subscription)
  },
  onVoiceFinal: (callback: (data: { source: "microphone" | "system"; text: string; fullText: string }) => void) => {
    const subscription = (_event: unknown, data: { source: "microphone" | "system"; text: string; fullText: string }) => callback(data)
    ipcRenderer.on("voice-transcript-final", subscription)
    return () => ipcRenderer.removeListener("voice-transcript-final", subscription)
  },
  onVoiceContextCleared: (callback: (data: { source: "microphone" | "system" }) => void) => {
    const subscription = (_event: unknown, data: { source: "microphone" | "system" }) => callback(data)
    ipcRenderer.on("voice-context-cleared", subscription)
    return () => ipcRenderer.removeListener("voice-context-cleared", subscription)
  },
  onVoiceSubmit: (callback: (data: { requestId: string; text: string }) => void) => {
    const subscription = (_event: unknown, data: { requestId: string; text: string }) => callback(data)
    ipcRenderer.on("voice-submit", subscription)
    return () => ipcRenderer.removeListener("voice-submit", subscription)
  },
  triggerReset: () => ipcRenderer.invoke("trigger-reset"),
  triggerMoveLeft: () => ipcRenderer.invoke("trigger-move-left"),
  triggerMoveRight: () => ipcRenderer.invoke("trigger-move-right"),
  triggerMoveUp: () => ipcRenderer.invoke("trigger-move-up"),
  triggerMoveDown: () => ipcRenderer.invoke("trigger-move-down"),
  onSubscriptionUpdated: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("subscription-updated", subscription)
    return () => {
      ipcRenderer.removeListener("subscription-updated", subscription)
    }
  },
  onSubscriptionPortalClosed: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("subscription-portal-closed", subscription)
    return () => {
      ipcRenderer.removeListener("subscription-portal-closed", subscription)
    }
  },
  onReset: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.RESET, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.RESET, subscription)
    }
  },
  startUpdate: () => ipcRenderer.invoke("start-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  onUpdateAvailable: (callback: (info: any) => void) => {
    const subscription = (_: any, info: any) => callback(info)
    ipcRenderer.on("update-available", subscription)
    return () => {
      ipcRenderer.removeListener("update-available", subscription)
    }
  },
  onUpdateDownloaded: (callback: (info: any) => void) => {
    const subscription = (_: any, info: any) => callback(info)
    ipcRenderer.on("update-downloaded", subscription)
    return () => {
      ipcRenderer.removeListener("update-downloaded", subscription)
    }
  },
  decrementCredits: () => ipcRenderer.invoke("decrement-credits"),
  onCreditsUpdated: (callback: (credits: number) => void) => {
    const subscription = (_event: any, credits: number) => callback(credits)
    ipcRenderer.on("credits-updated", subscription)
    return () => {
      ipcRenderer.removeListener("credits-updated", subscription)
    }
  },
  getPlatform: () => process.platform,
  
  // New methods for OpenAI API integration
  getConfig: () => ipcRenderer.invoke("get-config"),
  updateConfig: (config: {
    questionMode?: "coding" | "iq";
    apiKey?: string;
    apiProvider?: "openai" | "openai-compatible" | "gemini" | "anthropic";
    baseURL?: string;
    extractionModel?: string;
    solutionModel?: string;
    debuggingModel?: string;
    maxOutputTokens?: number;
    contextMessageLimit?: number;
    contextWindowTokens?: number;
    language?: string;
    opacity?: number;
    speechApiKey?: string;
    speechWorkspaceId?: string;
    speechRegion?: string;
    speechModel?: string;
    interviewContextEnabled?: boolean;
    interviewContextPath?: string;
  }) =>
    ipcRenderer.invoke("update-config", config),
  onShowSettings: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("show-settings-dialog", subscription)
    return () => {
      ipcRenderer.removeListener("show-settings-dialog", subscription)
    }
  },
  checkApiKey: () => ipcRenderer.invoke("check-api-key"),
  validateApiKey: (apiKey: string) => 
    ipcRenderer.invoke("validate-api-key", apiKey),
  openExternal: (url: string) => 
    ipcRenderer.invoke("openExternal", url),
  onApiKeyInvalid: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.API_KEY_INVALID, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.API_KEY_INVALID, subscription)
    }
  },
  removeListener: (eventName: string, callback: (...args: any[]) => void) => {
    ipcRenderer.removeListener(eventName, callback)
  },
  onDeleteLastScreenshot: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on("delete-last-screenshot", subscription)
    return () => {
      ipcRenderer.removeListener("delete-last-screenshot", subscription)
    }
  },
  deleteLastScreenshot: () => ipcRenderer.invoke("delete-last-screenshot"),
  // 日志：前端日志转发到主进程统一落盘，便于按启动批次排查
  logToMain: (level: string, message: string, meta?: unknown) => {
    void ipcRenderer
      .invoke("log-from-renderer", { level, message, meta })
      .catch(() => undefined)
  },
  getLogInfo: () => ipcRenderer.invoke("get-log-info"),
  openLogDirectory: () => ipcRenderer.invoke("open-log-directory")
}

// Before exposing the API
console.log(
  "About to expose electronAPI with methods:",
  Object.keys(electronAPI)
)

// Expose the API
contextBridge.exposeInMainWorld("electronAPI", electronAPI)

console.log("electronAPI exposed to window")

// Add this focus restoration handler
ipcRenderer.on("restore-focus", () => {
  // Try to focus the active element if it exists
  const activeElement = document.activeElement as HTMLElement
  if (activeElement && typeof activeElement.focus === "function") {
    activeElement.focus()
  }
})

// Remove auth-callback handling - no longer needed
