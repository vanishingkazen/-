import type { ChatAttachment, ChatMessage, ChatSession, ChatSessionSeed } from "./chat"
import type { CompanionStatus } from "../../electron/CompanionTypes"

export interface VoiceConversationTurn {
  speaker: "interviewer" | "candidate"
  text: string
  completedAt: number
}

export interface ElectronAPI {
  setCaptureSource: (source: "screen" | "phone") => Promise<{ success: boolean; status?: CompanionStatus; error?: string }>
  getCompanionStatus: () => Promise<CompanionStatus>
  startCompanion: () => Promise<{ success: boolean; status?: CompanionStatus; error?: string }>
  stopCompanion: () => Promise<{ success: boolean; status?: CompanionStatus }>
  refreshCompanionPairing: () => Promise<{ success: boolean; status?: CompanionStatus; error?: string }>
  disconnectCompanionPhone: () => Promise<{ success: boolean; status?: CompanionStatus }>
  onCompanionStatus: (callback: (status: CompanionStatus) => void) => () => void
  onCompanionSessionSelected: (callback: (session: ChatSession) => void) => () => void
  updateContentDimensions: (dimensions: { width: number; height: number }) => Promise<void>
  getScreenshots: () => Promise<unknown>
  deleteScreenshot: (path: string) => Promise<{ success: boolean; error?: string }>
  onScreenshotTaken: (callback: (data: { path: string; preview: string }) => void) => () => void
  onResetView: (callback: (data?: { session?: ChatSession }) => void) => () => void
  onFocusChatInput: (callback: () => void) => () => void
  onNewChatSession: (callback: () => void) => () => void
  onDeleteLastScreenshot: (callback: () => void) => () => void
  onScrollChat: (callback: (data: { direction: "up" | "down" }) => void) => () => void
  onLanguageDetected: (callback: (data: { language: string }) => void) => () => void

  onChatStarted: (callback: (data: {
    sessionId: string
    requestId: string
    userMessage: ChatMessage
    acceptedImagePaths?: string[]
  }) => void) => () => void
  onChatStream: (callback: (data: {
    requestId: string
    sessionId: string
    content: string
    done: boolean
  }) => void) => () => void
  onChatThinking: (callback: (data: {
    requestId: string
    sessionId: string
    reasoningChars: number
  }) => void) => () => void
  onChatContextCompressed: (callback: (data: { sessionId: string; summary: string }) => void) => () => void
  onChatSuccess: (callback: (data: {
    requestId: string
    sessionId: string
    content: string
    session: ChatSession
  }) => void) => () => void
  onChatError: (callback: (data: {
    requestId: string
    sessionId: string
    error: string
  }) => void) => () => void

  minimizeMainWindow: () => Promise<{ success: boolean }>
  closeMainWindow: () => Promise<{ success: boolean }>
  toggleMainWindow: () => Promise<{ success: boolean; error?: string }>
  triggerScreenshot: () => Promise<{ success: boolean; error?: string }>
  getChatSession: (id?: string) => Promise<ChatSession | null>
  getImagePreview: (path: string) => Promise<string>
  newChatSession: (seed?: ChatSessionSeed) => Promise<ChatSession | null>
  selectChatSession: (id: string) => Promise<ChatSession | null>
  listChatSessions: () => Promise<ChatSession[]>
  deleteChatSession: (id: string) => Promise<{ success: boolean; session?: ChatSession }>
  sendChatMessage: (payload: {
    requestId: string
    sessionId?: string
    text: string
    images?: ChatAttachment[]
  }) => Promise<{ success: boolean; content?: string; error?: string }>
  cancelChat: () => Promise<{ success: boolean }>
  writeClipboardText: (text: string) => Promise<{ success: boolean; error?: string }>

  startVoiceRecognition: (source?: "microphone" | "system") => Promise<{ success: boolean; error?: string }>
  sendVoiceAudio: (audio: ArrayBuffer, source?: "microphone" | "system") => Promise<{ success: boolean }>
  stopVoiceRecognition: (source?: "microphone" | "system") => Promise<{ success: boolean; transcript?: string }>
  clearVoiceContext: (source?: "microphone" | "system") => Promise<{ success: boolean }>
  getVoiceConversation: () => Promise<{
    systemTranscript: string
    microphoneTranscript: string
    rawMicrophoneTranscript: string
    removedSegments: number
    turns: VoiceConversationTurn[]
  }>
  correctVoiceConversation: (conversation: {
    systemTranscript: string
    microphoneTranscript: string
    rawMicrophoneTranscript: string
    removedSegments: number
    turns: VoiceConversationTurn[]
  }) => Promise<{
    systemTranscript: string
    microphoneTranscript: string
    rawMicrophoneTranscript: string
    removedSegments: number
    turns: VoiceConversationTurn[]
    corrected: boolean
  }>
  onVoiceStatus: (callback: (data: {
    source: "microphone" | "system"
    state: string
    message: string
  }) => void) => () => void
  onVoicePartial: (callback: (data: { source: "microphone" | "system"; text: string }) => void) => () => void
  onVoiceFinal: (callback: (data: {
    source: "microphone" | "system"
    text: string
    fullText: string
    completedAt: number
  }) => void) => () => void
  onVoiceContextCleared: (callback: (data: { source: "microphone" | "system" }) => void) => () => void

  getInterviewContextStatus: () => Promise<{
    enabled: boolean
    available: boolean
    path: string
    characterCount: number
    error?: string
  }>
  setInterviewContextEnabled: (enabled: boolean) => Promise<{
    success: boolean
    enabled: boolean
    available: boolean
    path: string
    characterCount: number
    error?: string
  }>
  openInterviewContextFile: () => Promise<{ success: boolean; path?: string; error?: string }>

  openSettingsPortal: () => Promise<{ success: boolean; error?: string }>
  setOpacity: (opacity: number) => Promise<{ success: boolean; opacity: number; error?: string }>
  getPlatform: () => string
  getConfig: () => Promise<{
    questionMode: "coding" | "iq"
    apiKey: string
    apiProvider: "openai-compatible" | "anthropic"
    baseURL: string
    extractionModel: string
    solutionApiKey: string
    solutionBaseURL: string
    solutionModel: string
    debuggingModel: string
    streamingEnabled: boolean
    maxOutputTokens: number
    contextMessageLimit: number
    contextWindowTokens: number
    speechApiKey: string
    speechWorkspaceId: string
    speechRegion: string
    speechModel: string
    language: string
    opacity: number
    interviewContextEnabled: boolean
    interviewContextPath: string
  }>
  updateConfig: (config: {
    questionMode?: "coding" | "iq"
    apiKey?: string
    apiProvider?: "openai-compatible" | "anthropic"
    baseURL?: string
    extractionModel?: string
    solutionApiKey?: string
    solutionBaseURL?: string
    solutionModel?: string
    debuggingModel?: string
    streamingEnabled?: boolean
    maxOutputTokens?: number
    contextMessageLimit?: number
    contextWindowTokens?: number
    speechApiKey?: string
    speechWorkspaceId?: string
    speechRegion?: string
    speechModel?: string
    language?: string
    opacity?: number
    interviewContextEnabled?: boolean
    interviewContextPath?: string
  }) => Promise<boolean>
  checkApiKey: () => Promise<boolean>
  onShowSettings: (callback: () => void) => () => void
  onApiKeyInvalid: (callback: () => void) => () => void
  openLink: (url: string) => void

  triggerReset: () => Promise<{ success: boolean; error?: string }>
  startUpdate: () => Promise<{ success: boolean; error?: string }>
  installUpdate: () => Promise<{ success: boolean; error?: string }>
  onUpdateAvailable: (callback: (info: unknown) => void) => () => void
  onUpdateDownloaded: (callback: (info: unknown) => void) => () => void

  deleteLastScreenshot: () => Promise<{ success: boolean; error?: string }>
  logToMain: (level: "error" | "warn" | "info" | "debug", message: string, meta?: unknown) => void
  getLogInfo: () => Promise<{
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
  }>
  openLogDirectory: () => Promise<{ success: boolean; path?: string; error?: string }>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
    __LANGUAGE__: string
    __IS_INITIALIZED__: boolean
    __AUTH_TOKEN__?: string | null
  }
}
