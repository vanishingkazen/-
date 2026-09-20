import { app } from "electron"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { ChatAttachment, ChatMessage, ChatSession, ChatSessionSeed } from "./ChatTypes"

const MAX_STORED_SESSIONS = 50

export function safeStorageComponent(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, "_") || "session"
}

function normalizeAttachment(raw: unknown): ChatAttachment | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Partial<ChatAttachment>
  if (typeof value.path !== "string" || !value.path) return null
  return {
    path: value.path,
    ...(typeof value.preview === "string" ? { preview: value.preview } : {}),
    ...(typeof value.transportPath === "string" ? { transportPath: value.transportPath } : {}),
    ...(value.mimeType === "image/png" || value.mimeType === "image/jpeg" || value.mimeType === "image/gif" || value.mimeType === "image/webp" ? { mimeType: value.mimeType } : {}),
    ...(Number.isFinite(value.width) ? { width: value.width } : {}),
    ...(Number.isFinite(value.height) ? { height: value.height } : {}),
    ...(typeof value.fileId === "string" && value.fileId ? { fileId: value.fileId } : {}),
    ...(typeof value.fileOwnerHash === "string" && value.fileOwnerHash ? { fileOwnerHash: value.fileOwnerHash } : {}),
    ...(typeof value.imageSummary === "string" ? { imageSummary: value.imageSummary } : {})
  }
}

function normalizeMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Partial<ChatMessage>
  if (value.role !== "user" && value.role !== "assistant") return null
  if (typeof value.content !== "string") return null
  const images = Array.isArray(value.images)
    ? value.images.map(normalizeAttachment).filter((image): image is ChatAttachment => Boolean(image))
    : []
  return {
    id: typeof value.id === "string" && value.id ? value.id : randomUUID(),
    role: value.role,
    content: value.content,
    images,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    status: value.status === "streaming" || value.status === "error" ? value.status : "completed"
  }
}

export class ChatStore {
  private readonly filePath: string
  private sessions: ChatSession[] = []
  private currentSessionId = ""
  /** 会话被保留上限裁掉时的回调（用于回收远端图片文件） */
  public onSessionsDropped: ((sessions: ChatSession[]) => void) | null = null
  private readonly droppedSessionIds = new Set<string>()

  constructor() {
    const directory = path.join(app.getPath("appData"), "steamgamecode")
    this.filePath = path.join(directory, "chat-sessions.json")
    this.load()
  }

  public current(): ChatSession {
    if (!this.sessions.length) return this.create()
    const existing = this.get(this.currentSessionId)
    if (existing) return existing
    this.currentSessionId = this.sessions[0].id
    return this.sessions[0]
  }

  public create(seed: ChatSessionSeed = {}): ChatSession {
    const safeSeed = seed && typeof seed === "object" ? seed : {}
    const now = new Date().toISOString()
    const rawMessages = Array.isArray(safeSeed.messages)
      ? safeSeed.messages.map(normalizeMessage).filter((message): message is ChatMessage => Boolean(message))
      : []
    const session: ChatSession = {
      id: randomUUID(),
      title: typeof safeSeed.title === "string" ? safeSeed.title.trim() || "新对话" : "新对话",
      summary: typeof safeSeed.summary === "string" ? safeSeed.summary : "",
      messages: [],
      createdAt: now,
      updatedAt: now
    }
    session.messages = rawMessages.map((message, index) => ({
      ...message,
      images: this.copyAttachments(session.id, `${message.id}-${index}`, message.images)
    }))
    this.sessions.unshift(session)
    this.currentSessionId = session.id
    this.save()
    return session
  }

  public get(id: string): ChatSession | null {
    return this.sessions.find((item) => item.id === id) || null
  }

  public select(id: string): ChatSession | null {
    const session = this.get(id)
    if (!session) return null
    this.currentSessionId = id
    this.save()
    return session
  }

  public list(): ChatSession[] {
    return [...this.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  public save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const ordered = this.list()
      const current = this.get(this.currentSessionId)
      const sessions = ordered.slice(0, MAX_STORED_SESSIONS)
      // The selected session is part of the user's active context and must not
      // disappear merely because an older session crossed the retention limit.
      if (current && !sessions.some((item) => item.id === current.id)) {
        sessions.pop()
        sessions.push(current)
      }
      const persistedSessions = sessions.map((session) => ({
        ...session,
        messages: session.messages.map((message) => ({
          ...message,
          images: message.images.map((image) => {
            const persistedImage = { ...image }
            delete persistedImage.preview
            return persistedImage
          })
        }))
      }))
      const payload = JSON.stringify({ version: 1, currentSessionId: this.currentSessionId, sessions: persistedSessions }, null, 2)
      const tempPath = this.filePath + ".tmp"
      fs.writeFileSync(tempPath, payload, "utf8")
      fs.renameSync(tempPath, this.filePath)
      this.dropSessionsOutsideRetention(sessions)
    } catch (error) {
      console.error("Failed to save chat sessions:", error)
    }
  }

  public delete(id: string): boolean {
    const before = this.sessions.length
    this.sessions = this.sessions.filter((item) => item.id !== id)
    if (this.sessions.length === before) return false
    if (this.currentSessionId === id) this.currentSessionId = this.list()[0]?.id || ""
    this.removeAttachmentDirectory(id)
    this.save()
    return true
  }

  private removeAttachmentDirectory(id: string): void {
    try {
      fs.rmSync(path.join(path.dirname(this.filePath), "chat-attachments", safeStorageComponent(id)), { recursive: true, force: true })
    } catch (error) {
      console.warn("Failed to delete chat attachments:", error)
    }
  }

  /**
   * 超出保留上限的会话不再写盘，远端文件需要回收；本地会话仍然保留在内存中，
   * 用户重新选中它时会再次写回，并按需重新上传图片。
   */
  private dropSessionsOutsideRetention(persisted: ChatSession[]): void {
    const kept = new Set(persisted.map((session) => session.id))
    for (const id of [...this.droppedSessionIds]) {
      if (kept.has(id)) this.droppedSessionIds.delete(id)
    }

    const dropped = this.sessions.filter((session) => !kept.has(session.id) && !this.droppedSessionIds.has(session.id))
    if (!dropped.length) return
    for (const session of dropped) this.droppedSessionIds.add(session.id)

    if (this.onSessionsDropped) {
      try {
        this.onSessionsDropped(dropped)
      } catch (error) {
        console.warn("Failed to handle dropped chat sessions:", error)
      }
    }
  }

  /**
   * 清理已经不在会话列表里的附件目录（保留上限裁掉或历史遗留），
   * 避免截图文件长期占用磁盘。只会在会话文件解析成功时执行。
   */
  private removeOrphanAttachmentDirectories(): void {
    const root = path.join(path.dirname(this.filePath), "chat-attachments")
    if (!fs.existsSync(root)) return

    const kept = new Set(this.sessions.map((session) => safeStorageComponent(session.id)))
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || kept.has(entry.name)) continue
        fs.rmSync(path.join(root, entry.name), { recursive: true, force: true })
      }
    } catch (error) {
      console.warn("Failed to clean orphan chat attachments:", error)
    }
  }

  public getAttachmentDirectory(sessionId: string): string {
    return path.join(path.dirname(this.filePath), "chat-attachments", safeStorageComponent(sessionId))
  }

  public copyAttachments(sessionId: string, messageId: string, images: ChatAttachment[]): ChatAttachment[] {
    const directory = this.getAttachmentDirectory(sessionId)
    return images.map((image, index) => {
      try {
        if (!image?.path || !fs.existsSync(image.path)) return image
        fs.mkdirSync(directory, { recursive: true })
        const extension = path.extname(image.path).match(/^\.[a-z0-9]{1,8}$/i)?.[0] || ".png"
        const safeMessageId = safeStorageComponent(messageId)
        const target = path.join(directory, `${safeMessageId}-${index}${extension}`)
        fs.copyFileSync(image.path, target)
        return { ...image, path: target }
      } catch (error) {
        console.warn("Failed to persist chat attachment:", error)
        return image
      }
    })
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"))
      const rawSessions = Array.isArray(parsed) ? parsed : parsed?.sessions
      if (!Array.isArray(rawSessions)) return
      this.sessions = rawSessions.flatMap((item): ChatSession[] => {
        if (!item || typeof item !== "object") return []
        const value = item as Partial<ChatSession>
        if (typeof value.id !== "string" || !value.id || !Array.isArray(value.messages)) return []
        return [{
          id: value.id,
          title: typeof value.title === "string" && value.title.trim() ? value.title : "新对话",
          summary: typeof value.summary === "string" ? value.summary : "",
          messages: value.messages.map(normalizeMessage).filter((message): message is ChatMessage => Boolean(message)),
          createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
          updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString()
        }]
      })
      const persistedCurrentId = !Array.isArray(parsed) && typeof parsed.currentSessionId === "string"
        ? parsed.currentSessionId
        : ""
      this.currentSessionId = this.get(persistedCurrentId)?.id || this.list()[0]?.id || ""
      this.removeOrphanAttachmentDirectories()
    } catch {
      this.sessions = []
      this.currentSessionId = ""
    }
  }
}
