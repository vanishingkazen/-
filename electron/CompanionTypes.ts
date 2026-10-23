export interface CompanionStatus {
  captureSource?: "screen" | "phone"
  cameraReady?: boolean
  running: boolean
  connected: boolean
  paired?: boolean
  addresses: Array<{ label: string; url: string }>
  pairingUrls?: Array<{ label: string; url: string }>
  pairingExpiresAt?: number
  error?: string
}

export interface CompanionImage {
  id: string
  url: string
  mimeType?: string
  width?: number
  height?: number
}

export interface CompanionMessage {
  id: string
  role: "user" | "assistant"
  content: string
  createdAt: string
  status: "completed" | "streaming" | "error"
  images: CompanionImage[]
}

export interface CompanionSessionSummary {
  id: string
  title: string
  updatedAt: string
}

export interface CompanionVoiceSource {
  state: string
  message: string
  transcript: string
  partialTranscript: string
}

export interface CompanionSnapshot {
  busy: boolean
  currentSessionId: string
  sessions: CompanionSessionSummary[]
  session: {
    id: string
    title: string
    messages: CompanionMessage[]
  }
  pendingScreenshots: CompanionImage[]
  voice: {
    system: CompanionVoiceSource
    microphone: CompanionVoiceSource
  }
}
