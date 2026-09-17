export interface ChatAttachment {
  path: string
  preview?: string
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
