console.log("Preload script starting...")
import { contextBridge, ipcRenderer, shell, type IpcRendererEvent } from "electron"

type ScreenshotTakenPayload = { path: string; preview: string }
type LanguageDetectedPayload = { language: string }
type ChatStartedPayload = {
  sessionId: string
  requestId: string
  userMessage: unknown
  acceptedImagePaths?: string[]
}
type ChatStreamPayload = { requestId: string; sessionId: string; content: string; done: boolean }
type ChatThinkingPayload = { requestId: string; sessionId: string; reasoningChars: number }
type ChatContextCompressedPayload = { sessionId: string; summary: string }
type ChatSuccessPayload = { requestId: string; sessionId: string; content: string; session: unknown }
type ChatErrorPayload = { requestId: string; sessionId: string; error: string }

const PROCESSING_EVENTS = {
  API_KEY_INVALID: "api-key-invalid"
} as const

// At the top of the file
console.log("Preload script is running")

const electronAPI = {



  // Original methods

  openSettingsPortal: () => ipcRenderer.invoke("open-settings-portal"),
  openInterviewContextFile: () => ipcRenderer.invoke("open-interview-context-file"),
  setOpacity: (opacity: number) => ipcRenderer.invoke("set-opacity", opacity),
  updateContentDimensions: (dimensions: { width: number; height: number }) =>
    ipcRenderer.invoke("update-content-dimensions", dimensions),

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
  onScreenshotTaken: (callback: (data: ScreenshotTakenPayload) => void) => {
    const subscription = (_event: IpcRendererEvent, data: ScreenshotTakenPayload) =>
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
  onCompanionStatus: (callback: (status: unknown) => void) => {
    const subscription = (_event: IpcRendererEvent, status: unknown) => callback(status)
    ipcRenderer.on("companion-status", subscription)
    return () => ipcRenderer.removeListener("companion-status", subscription)
  },
  onCompanionSessionSelected: (callback: (session: unknown) => void) => {
    const subscription = (_event: IpcRendererEvent, selected: unknown) => callback(selected)
    ipcRenderer.on("companion-session-selected", subscription)
    return () => ipcRenderer.removeListener("companion-session-selected", subscription)
  },
  setCaptureSource: (source: "screen" | "phone") => ipcRenderer.invoke("companion-set-capture-source", source),
  getCompanionStatus: () => ipcRenderer.invoke("companion-get-status"),
  startCompanion: () => ipcRenderer.invoke("companion-start"),
  stopCompanion: () => ipcRenderer.invoke("companion-stop"),
  refreshCompanionPairing: () => ipcRenderer.invoke("companion-refresh-pairing"),
  disconnectCompanionPhone: () => ipcRenderer.invoke("companion-disconnect-phone"),



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








  onLanguageDetected: (callback: (data: LanguageDetectedPayload) => void) => {
    const subscription = (_event: IpcRendererEvent, data: LanguageDetectedPayload) => callback(data)
    ipcRenderer.on("language-detected", subscription)
    return () => ipcRenderer.removeListener("language-detected", subscription)
  },
  onChatStarted: (callback: (data: ChatStartedPayload) => void) => {
    const subscription = (_event: IpcRendererEvent, data: ChatStartedPayload) => callback(data)
    ipcRenderer.on("chat-started", subscription)
    return () => ipcRenderer.removeListener("chat-started", subscription)
  },
  onChatStream: (callback: (data: ChatStreamPayload) => void) => {
    const subscription = (_event: IpcRendererEvent, data: ChatStreamPayload) => callback(data)
    ipcRenderer.on("chat-stream", subscription)
    return () => ipcRenderer.removeListener("chat-stream", subscription)
  },
  onChatThinking: (callback: (data: ChatThinkingPayload) => void) => {
    const subscription = (_event: IpcRendererEvent, data: ChatThinkingPayload) => callback(data)
    ipcRenderer.on("chat-thinking", subscription)
    return () => ipcRenderer.removeListener("chat-thinking", subscription)
  },
  onChatContextCompressed: (callback: (data: ChatContextCompressedPayload) => void) => {
    const subscription = (_event: IpcRendererEvent, data: ChatContextCompressedPayload) => callback(data)
    ipcRenderer.on("chat-context-compressed", subscription)
    return () => ipcRenderer.removeListener("chat-context-compressed", subscription)
  },
  onChatSuccess: (callback: (data: ChatSuccessPayload) => void) => {
    const subscription = (_event: IpcRendererEvent, data: ChatSuccessPayload) => callback(data)
    ipcRenderer.on("chat-success", subscription)
    return () => ipcRenderer.removeListener("chat-success", subscription)
  },
  onChatError: (callback: (data: ChatErrorPayload) => void) => {
    const subscription = (_event: IpcRendererEvent, data: ChatErrorPayload) => callback(data)
    ipcRenderer.on("chat-error", subscription)
    return () => ipcRenderer.removeListener("chat-error", subscription)
  },

  // External URL handler
  openLink: (url: string) => shell.openExternal(url),
  triggerScreenshot: () => ipcRenderer.invoke("trigger-screenshot"),

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
    turns: Array<{ speaker: "interviewer" | "candidate"; text: string; completedAt: number }>;
  }> => ipcRenderer.invoke("voice-conversation"),
  correctVoiceConversation: (conversation: {
    systemTranscript: string;
    microphoneTranscript: string;
    rawMicrophoneTranscript: string;
    removedSegments: number;
    turns: Array<{ speaker: "interviewer" | "candidate"; text: string; completedAt: number }>;
  }): Promise<{
    systemTranscript: string;
    microphoneTranscript: string;
    rawMicrophoneTranscript: string;
    removedSegments: number;
    turns: Array<{ speaker: "interviewer" | "candidate"; text: string; completedAt: number }>;
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
  onVoiceFinal: (callback: (data: { source: "microphone" | "system"; text: string; fullText: string; completedAt: number }) => void) => {
    const subscription = (_event: unknown, data: { source: "microphone" | "system"; text: string; fullText: string; completedAt: number }) => callback(data)
    ipcRenderer.on("voice-transcript-final", subscription)
    return () => ipcRenderer.removeListener("voice-transcript-final", subscription)
  },
  onVoiceContextCleared: (callback: (data: { source: "microphone" | "system" }) => void) => {
    const subscription = (_event: unknown, data: { source: "microphone" | "system" }) => callback(data)
    ipcRenderer.on("voice-context-cleared", subscription)
    return () => ipcRenderer.removeListener("voice-context-cleared", subscription)
  },
  triggerReset: () => ipcRenderer.invoke("trigger-reset"),







  startUpdate: () => ipcRenderer.invoke("start-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  onUpdateAvailable: (callback: (info: unknown) => void) => {
    const subscription = (_event: IpcRendererEvent, info: unknown) => callback(info)
    ipcRenderer.on("update-available", subscription)
    return () => {
      ipcRenderer.removeListener("update-available", subscription)
    }
  },
  onUpdateDownloaded: (callback: (info: unknown) => void) => {
    const subscription = (_event: IpcRendererEvent, info: unknown) => callback(info)
    ipcRenderer.on("update-downloaded", subscription)
    return () => {
      ipcRenderer.removeListener("update-downloaded", subscription)
    }
  },


  getPlatform: () => process.platform,

  // New methods for OpenAI API integration
  getConfig: () => ipcRenderer.invoke("get-config"),
  updateConfig: (config: {
    questionMode?: "coding" | "iq";
    apiKey?: string;
    apiProvider?: "openai-compatible" | "anthropic";
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


  onApiKeyInvalid: (callback: () => void) => {
    const subscription = () => callback()
    ipcRenderer.on(PROCESSING_EVENTS.API_KEY_INVALID, subscription)
    return () => {
      ipcRenderer.removeListener(PROCESSING_EVENTS.API_KEY_INVALID, subscription)
    }
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
