export interface ChatAttachment {
  path: string
  preview?: string
  transportPath?: string
  mimeType?: "image/png" | "image/jpeg" | "image/gif" | "image/webp"
  width?: number
  height?: number
  fileId?: string
  fileOwnerHash?: string
  imageSummary?: string
}

export interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  images: ChatAttachment[]
  createdAt: string
  status: "completed" | "streaming" | "error"
}

export interface ChatSessionSeed {
  title?: string
  summary?: string
  messages?: ChatMessage[]
}

export interface ChatSession {
  id: string
  title: string
  summary: string
  messages: ChatMessage[]
  createdAt: string
  updatedAt: string
}
