export interface ElectronAPI {
  getHistory: () => Promise<import("./history").HistoryRecord[]>
  restoreHistory: (id: string) => Promise<{
    success: boolean
    record?: import("./history").HistoryRecord
    error?: string
  }>
  deleteHistory: (id: string) => Promise<{ success: boolean }>
  // Original methods
  openSubscriptionPortal: (authData: {
    id: string
    email: string
  }) => Promise<{ success: boolean; error?: string }>
  updateContentDimensions: (dimensions: {
    width: number
    height: number
  }) => Promise<void>
  clearStore: () => Promise<{ success: boolean; error?: string }>
  getScreenshots: () => Promise<{
    success: boolean
    previews?: Array<{ path: string; preview: string }> | null
    error?: string
  }>
  deleteScreenshot: (
    path: string
  ) => Promise<{ success: boolean; error?: string }>
  onScreenshotTaken: (
    callback: (data: { path: string; preview: string }) => void
  ) => () => void
  onResetView: (callback: (data?: { session?: import("./chat").ChatSession }) => void) => () => void
  onFocusChatInput: (callback: () => void) => () => void
  onNewChatSession: (callback: () => void) => () => void
  onDeleteLastScreenshot: (callback: () => void) => () => void
  deleteLastScreenshot: () => Promise<{ success: boolean; error?: string }>
  onScrollChat: (callback: (data: { direction: "up" | "down" }) => void) => () => void
  onSolutionStart: (callback: (data?: { questionMode?: "coding" | "iq" }) => void) => () => void
  onDebugStart: (callback: () => void) => () => void
  onDebugSuccess: (callback: (data: any) => void) => () => void
  onSolutionError: (callback: (error: string) => void) => () => void
  onProcessingNoScreenshots: (callback: () => void) => () => void
  onProblemExtracted: (callback: (data: any) => void) => () => void
  onSolutionStream: (callback: (data: {
    content: string
    isThinking: boolean
    done: boolean
  }) => void) => () => void
  onSolutionSuccess: (callback: (data: any) => void) => () => void
  onProcessingStatus: (callback: (data: {
    message: string
    progress: number
    stage?: string
    requestId?: string
  }) => void) => () => void
  onLanguageDetected: (callback: (data: { language: string }) => void) => () => void
  onChatStarted: (callback: (data: {
    sessionId: string
    requestId: string
    userMessage: import("./chat").ChatMessage
  }) => void) => () => void
  onChatStream: (callback: (data: {
    requestId: string
    sessionId: string
    content: string
    done: boolean
  }) => void) => () => void
  onChatContextCompressed: (callback: (data: { sessionId: string; summary: string }) => void) => () => void
  onChatSuccess: (callback: (data: {
    requestId: string
    sessionId: string
    content: string
    session: import("./chat").ChatSession
  }) => void) => () => void
  onChatError: (callback: (data: {
    requestId: string
    sessionId: string
    error: string
  }) => void) => () => void
  onUnauthorized: (callback: () => void) => () => void
  onDebugError: (callback: (error: string) => void) => () => void
  onShowSettings: (callback: () => void) => () => void
  openExternal: (url: string) => void
  minimizeMainWindow: () => Promise<{ success: boolean }>
  closeMainWindow: () => Promise<{ success: boolean }>
  toggleMainWindow: () => Promise<{ success: boolean; error?: string }>
  triggerScreenshot: () => Promise<{ success: boolean; error?: string }>
  triggerProcessScreenshots: (userRequest?: string) => Promise<{ success: boolean; error?: string }>
  getChatSession: (id?: string) => Promise<import("./chat").ChatSession | null>
  newChatSession: (seed?: import("./chat").ChatSessionSeed) => Promise<import("./chat").ChatSession | null>
  selectChatSession: (id: string) => Promise<import("./chat").ChatSession | null>
  listChatSessions: () => Promise<import("./chat").ChatSession[]>
  deleteChatSession: (id: string) => Promise<{
    success: boolean
    session?: import("./chat").ChatSession
  }>
  sendChatMessage: (payload: {
    requestId: string
    sessionId?: string
    text: string
    images?: import("./chat").ChatAttachment[]
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
  }>
  correctVoiceConversation: (conversation: {
    systemTranscript: string
    microphoneTranscript: string
    rawMicrophoneTranscript: string
    removedSegments: number
  }) => Promise<{
    systemTranscript: string
    microphoneTranscript: string
    rawMicrophoneTranscript: string
    removedSegments: number
    corrected: boolean
  }>
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
  onToggleVoiceInput: (callback: () => void) => () => void
  onVoiceStatus: (callback: (data: { source: "microphone" | "system"; state: string; message: string }) => void) => () => void
  onVoicePartial: (callback: (data: { source: "microphone" | "system"; text: string }) => void) => () => void
  onVoiceFinal: (callback: (data: { source: "microphone" | "system"; text: string; fullText: string }) => void) => () => void
  onVoiceContextCleared: (callback: (data: { source: "microphone" | "system" }) => void) => () => void
  onVoiceSubmit: (callback: (data: { requestId: string; text: string }) => void) => () => void
  triggerReset: () => Promise<{ success: boolean; error?: string }>
  triggerMoveLeft: () => Promise<{ success: boolean; error?: string }>
  triggerMoveRight: () => Promise<{ success: boolean; error?: string }>
  triggerMoveUp: () => Promise<{ success: boolean; error?: string }>
  triggerMoveDown: () => Promise<{ success: boolean; error?: string }>
  onSubscriptionUpdated: (callback: () => void) => () => void
  onSubscriptionPortalClosed: (callback: () => void) => () => void
  startUpdate: () => Promise<{ success: boolean; error?: string }>
  installUpdate: () => void
  onUpdateAvailable: (callback: (info: any) => void) => () => void
  onUpdateDownloaded: (callback: (info: any) => void) => () => void

  decrementCredits: () => Promise<void>
  setInitialCredits: (credits: number) => Promise<void>
  onCreditsUpdated: (callback: (credits: number) => void) => () => void
  onOutOfCredits: (callback: () => void) => () => void
  openSettingsPortal: () => Promise<void>
  openInterviewContextFile: () => Promise<{ success: boolean; path?: string; error?: string }>
  setOpacity: (opacity: number) => Promise<{ success: boolean; opacity: number; error?: string }>
  getPlatform: () => string
  
  // New methods for OpenAI integration
  getConfig: () => Promise<{
    questionMode: "coding" | "iq"
    apiKey: string
    apiProvider: "openai" | "openai-compatible" | "gemini" | "anthropic"
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
    apiProvider?: "openai" | "openai-compatible" | "gemini" | "anthropic"
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
  validateApiKey: (apiKey: string) => Promise<{ valid: boolean; error?: string }>
  openLink: (url: string) => void
  onApiKeyInvalid: (callback: () => void) => () => void
  removeListener: (eventName: string, callback: (...args: any[]) => void) => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
    electron: {
      ipcRenderer: {
        on: (channel: string, func: (...args: any[]) => void) => void
        removeListener: (
          channel: string,
          func: (...args: any[]) => void
        ) => void
      }
    }
    __CREDITS__: number
    __LANGUAGE__: string
    __IS_INITIALIZED__: boolean
    __AUTH_TOKEN__?: string | null
  }
}
