import { app, BrowserWindow } from "electron"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { OpenAI } from "openai"
import Anthropic from "@anthropic-ai/sdk"
import * as axios from "axios"
import { configHelper } from "./ConfigHelper"
import { imageDataUrl, readImageMetadata, resizeImageToPng, type ChatImageMimeType } from "./ChatImageUtils"
import {
  deleteDeepSeekFile,
  fileOwnerFingerprint,
  supportsDeepSeekFilesApi,
  uploadDeepSeekImage,
  type DeepSeekFilesConfig
} from "./DeepSeekFilesApi"
import { loadInterviewContextPrompt } from "./InterviewContextHelper"

export interface ChatAttachment {
  path: string
  preview?: string
  transportPath?: string
  mimeType?: ChatImageMimeType
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

export interface ChatServiceDeps {
  getMainWindow: () => BrowserWindow | null
  onMessageAccepted?: (accepted: {
    sessionId: string
    requestId: string
    acceptedImagePaths: string[]
    persistedImagePaths: string[]
  }) => void
}

type ProviderMessage = { role: "system" | "user" | "assistant"; content: string }

const SYSTEM_PROMPT = "你是一个多轮对话助手，能够处理文本、代码和截图。保持上下文连续，直接回答用户，所有说明和代码注释使用简体中文。"
const IMAGE_TOKEN_ESTIMATE = 1024
const MIN_IMAGE_TEXT_TOKENS = 64
const MAX_STORED_SESSIONS = 50

const LANGUAGE_ALIASES: Record<string, string> = {
  py: "python",
  python3: "python",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  c: "c",
  "c++": "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  "c#": "csharp",
  go: "golang",
  golang: "golang",
  rs: "rust",
  rb: "ruby"
}

const SUPPORTED_LANGUAGES = new Set([
  "python",
  "javascript",
  "typescript",
  "java",
  "cpp",
  "c",
  "csharp",
  "golang",
  "rust",
  "swift",
  "kotlin",
  "ruby",
  "sql",
  "r"
])

function normalizeDetectedLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase().replace(/^\./, "")
  if (!normalized || normalized === "auto" || normalized === "unknown" || normalized === "text") return null
  const language = LANGUAGE_ALIASES[normalized] || normalized
  return SUPPORTED_LANGUAGES.has(language) ? language : null
}

function parseDetectedLanguage(content: string): { content: string; language: string | null } {
  const marker = content.match(/^\s*\[LANGUAGE:\s*([^\]\r\n]+)\]\s*/i)
  if (marker) {
    return {
      content: content.slice(marker[0].length).trimStart(),
      language: normalizeDetectedLanguage(marker[1])
    }
  }

  const fence = content.match(/```\s*([a-zA-Z0-9+#.-]+)\s*\r?\n/)
  return {
    content,
    language: fence ? normalizeDetectedLanguage(fence[1]) : null
  }
}

function visibleResponseContent(content: string): string {
  // During streaming the model may have emitted only a partial language
  // marker. Hide that incomplete metadata instead of showing it to the user.
  if (/^\s*\[LANGUAGE:/i.test(content) && !/^\s*\[LANGUAGE:\s*[^\]\r\n]+\]\s*/i.test(content)) {
    return ""
  }
  return parseDetectedLanguage(content).content
}

function buildSystemPrompt(configLanguage: string, summary: string, additionalPrompt = ""): string {
  const detectedLanguage = normalizeDetectedLanguage(configLanguage)
  const languageContext = detectedLanguage
    ? `当前截图/上下文已识别出的编程语言是：${detectedLanguage}。除非新截图明确显示其他语言，否则沿用该语言。`
    : "如果本轮消息或上下文包含代码截图，请根据截图自动判断编程语言，不要默认使用 Python。"
  const detectionProtocol = "如果本轮或上下文包含代码截图且能确定语言，请在最终回答第一行单独输出 [LANGUAGE: <language>]，language 只能使用 python、javascript、typescript、java、cpp、csharp、golang、rust、swift、kotlin、ruby、sql、r；无法确定或没有代码截图时不要输出该标记。该标记仅供程序解析，不要解释。"
  return [
    SYSTEM_PROMPT,
    additionalPrompt,
    languageContext,
    detectionProtocol,
    summary ? `此前对话摘要：\n${summary}` : ""
  ].filter(Boolean).join("\n\n")
}

function isVoiceInterviewRequest(content: string): boolean {
  return content.includes("面试官（系统音频）") ||
    content.includes("面试者（麦克风）") ||
    content.includes("线上会议双方对话上下文")
}

function safeStorageComponent(value: string): string {
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

class ChatStore {
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

function estimateTokens(messages: Array<{ content: string; images?: ChatAttachment[] }>): number {
  return messages.reduce((total, message) => {
    const ascii = [...message.content].filter((character) => character.charCodeAt(0) < 128).length
    const nonAscii = message.content.length - ascii
    const textTokens = Math.ceil(ascii / 4) + nonAscii
    const imageTokens = (message.images?.length || 0) * IMAGE_TOKEN_ESTIMATE
    return total + textTokens + imageTokens
  }, 0)
}

function truncateToTokenBudget(content: string, tokenBudget: number): string {
  if (estimateTokens([{ content }]) <= tokenBudget) return content
  if (tokenBudget <= 0) return "[内容过长，已截断]"

  let low = 0
  let high = content.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateTokens([{ content: content.slice(0, middle) }]) <= tokenBudget) low = middle
    else high = middle - 1
  }
  const marker = "\n...[内容过长，已截断]...\n"
  if (low <= marker.length) return content.slice(0, low)
  const headLength = Math.max(1, Math.floor((low - marker.length) * 0.7))
  return content.slice(0, headLength) + marker + content.slice(-(low - marker.length - headLength))
}

export class ChatService {
  private readonly store = new ChatStore()
  private readonly deps: ChatServiceDeps
  private abortController: AbortController | null = null

  constructor(deps: ChatServiceDeps) {
    this.deps = deps
    // 会话被保留策略裁掉时回收远端图片文件；本地会话仍可继续使用，
    // 需要时会按 fileId 缺失的逻辑重新上传。
    this.store.onSessionsDropped = (sessions) => {
      for (const session of sessions) {
        void this.deleteRemoteFiles(session, { clearReferences: true }).catch((error) => {
          console.warn("Failed to delete remote chat files:", error)
        })
      }
    }
  }

  public getCurrentSession(): ChatSession {
    return this.store.current()
  }

  public listSessions(): ChatSession[] {
    return this.store.list()
  }

  public createSession(seed: ChatSessionSeed = {}): ChatSession {
    return this.store.create(seed)
  }

  public getSession(id: string): ChatSession | null {
    return this.store.get(id)
  }

  public selectSession(id: string): ChatSession | null {
    if (this.abortController) return null
    return this.store.select(id)
  }

  public deleteSession(id: string): boolean {
    if (this.abortController) return false
    const session = this.store.get(id)
    const success = this.store.delete(id)
    if (success && session) void this.deleteRemoteFiles(session)
    return success
  }

  public resetCurrentSession(): ChatSession {
    return this.store.create()
  }

  public cancel(): void {
    this.abortController?.abort()
  }

  public async sendMessage(
    sessionId: string,
    text: string,
    images: ChatAttachment[],
    requestId: string
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    const mainWindow = this.deps.getMainWindow()
    const session = this.store.get(sessionId)
    if (!mainWindow) return { success: false, error: "主窗口不可用" }
    if (!session) return { success: false, error: "会话不存在" }

    if (typeof requestId !== "string" || !requestId.trim()) {
      return { success: false, error: "请求标识无效" }
    }
    const content = typeof text === "string" ? text.trim() : ""
    const safeImages = Array.isArray(images)
      ? images.filter((image): image is ChatAttachment => Boolean(image && typeof image.path === "string"))
      : []
    if (!content && !safeImages.length) return { success: false, error: "消息不能为空" }
    if (this.abortController) return { success: false, error: "上一条消息仍在处理中，请稍后重试" }

    // A new screenshot starts a fresh detection attempt. Do not let the
    // language detected for a previous screenshot bias this one when the
    // model cannot identify a language in the new image.
    if (safeImages.length) configHelper.updateConfig({ language: "auto" })

    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: "user",
      content: content || "请分析截图并回答。",
      images: this.store.copyAttachments(session.id, "pending-" + requestId, safeImages),
      createdAt: new Date().toISOString(),
      status: "completed"
    }

    session.messages.push(userMessage)
    if (session.title === "新对话") {
      session.title = userMessage.content.split(/\r?\n/).find(Boolean)?.slice(0, 48) || "新对话"
    }
    session.updatedAt = new Date().toISOString()
    this.store.save()

    const controller = new AbortController()
    this.abortController = controller
    try {
      const acceptedImagePaths = safeImages.map((image) => image.path)
      mainWindow.webContents.send("chat-started", {
        sessionId: session.id,
        requestId,
        userMessage,
        acceptedImagePaths
      })
      try {
        this.deps.onMessageAccepted?.({
          sessionId: session.id,
          requestId,
          acceptedImagePaths,
          persistedImagePaths: userMessage.images.map((image) => image.path)
        })
      } catch (error) {
        console.warn("Failed to consume accepted chat attachments:", error)
      }

      await this.compressContextIfNeeded(session, controller.signal)
      const rawResponse = await this.generateReply(session, requestId, controller.signal)
      const parsedResponse = parseDetectedLanguage(rawResponse)
      const response = parsedResponse.content
      if (parsedResponse.language) {
        configHelper.updateConfig({ language: parsedResponse.language })
        mainWindow.webContents.send("language-detected", { language: parsedResponse.language })
      }
      const assistantMessage: ChatMessage = {
        id: requestId,
        role: "assistant",
        content: response,
        images: [],
        createdAt: new Date().toISOString(),
        status: "completed"
      }
      session.messages.push(assistantMessage)
      session.updatedAt = new Date().toISOString()
      this.store.save()
      mainWindow.webContents.send("chat-success", { requestId, sessionId: session.id, content: response, session })
      return { success: true, content: response }
    } catch (error) {
      const message = error instanceof Error ? error.message : "对话请求失败"
      const errorMessage: ChatMessage = {
        id: requestId,
        role: "assistant",
        content: message,
        images: [],
        createdAt: new Date().toISOString(),
        status: "error"
      }
      if (!session.messages.some((item) => item.id === requestId)) {
        session.messages.push(errorMessage)
        session.updatedAt = new Date().toISOString()
        this.store.save()
      }
      mainWindow.webContents.send("chat-error", { requestId, sessionId: session.id, error: message })
      return { success: false, error: message }
    } finally {
      if (this.abortController === controller) this.abortController = null
    }
  }

  private async compressContextIfNeeded(session: ChatSession, signal: AbortSignal): Promise<void> {
    const config = configHelper.loadConfig()
    const systemTokens = estimateTokens([{ content: SYSTEM_PROMPT }, { content: session.summary }])
    const budget = Math.max(0, config.contextWindowTokens - config.maxOutputTokens - systemTokens - 2048)
    const messages = session.messages
    if (messages.length <= config.contextMessageLimit && estimateTokens(messages) <= budget) return

    const keepCount = Math.max(4, Math.min(8, config.contextMessageLimit))
    let splitIndex = Math.max(0, messages.length - keepCount)
    // Anthropic requires the first message in a conversation to use the user role.
    // Move the split left until the retained history starts with a user turn.
    while (splitIndex > 0 && messages[splitIndex]?.role !== "user") {
      splitIndex -= 1
    }
    const older = messages.slice(0, splitIndex)
    const recent = messages.slice(splitIndex)
    if (!older.length) return

    const transcript = [
      session.summary ? `已有摘要：${session.summary}` : "",
      ...older.map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content}${this.describeImagesForSummary(message.images)}`)
    ].filter(Boolean).join("\n\n")

    try {
      const summary = (await this.summarize(transcript, signal)).trim()
      if (!summary) {
        console.warn("Chat context summary was empty; keeping original history")
        return
      }
      const imageReferences = this.buildImageReferenceAppendix(older)
      session.summary = [summary, imageReferences].filter(Boolean).join("\n\n")
      session.messages = recent
      session.updatedAt = new Date().toISOString()
      this.store.save()
      this.deps.getMainWindow()?.webContents.send("chat-context-compressed", {
        sessionId: session.id,
        summary: session.summary
      })
    } catch (error) {
      // Never discard original history when summarization fails or is cancelled.
      if (error instanceof Error && error.name === "AbortError") throw error
      console.warn("Failed to compress chat context; keeping original history:", error)
    }
  }

  private async summarize(transcript: string, signal: AbortSignal): Promise<string> {
    const messages: ProviderMessage[] = [
      { role: "system", content: "请压缩下面的对话，保留用户目标、关键事实、代码约定和未解决问题。只输出摘要，不要回答对话。" },
      { role: "user", content: transcript }
    ]
    return this.completeText(messages, signal)
  }

  private async generateReply(session: ChatSession, requestId: string, signal: AbortSignal): Promise<string> {
    const config = configHelper.loadConfig()
    const latestUserMessage = [...session.messages].reverse().find((message) => message.role === "user")
    const isVoiceInterview = latestUserMessage
      ? isVoiceInterviewRequest(latestUserMessage.content)
      : false
    let voiceInterviewPrompt = ""
    if (isVoiceInterview) {
      voiceInterviewPrompt = `当前是线上会议中的技术面试语音辅助任务。系统音频转写代表面试官，麦克风转写代表面试者。请保持两人的角色和发言顺序，只针对最近尚未解决的核心问题，以面试者第一人称给出可以直接说出口的帮助和回答。不要逐句回应，不要复述原始转写。`
      try {
        const interviewContextPrompt = loadInterviewContextPrompt(
          config.interviewContextEnabled,
          config.interviewContextPath
        )
        if (interviewContextPrompt) {
          voiceInterviewPrompt = [voiceInterviewPrompt, interviewContextPrompt].join("\n\n")
        }
      } catch (error) {
        console.warn("Voice interview context unavailable:", error)
      }
    }
    const system = buildSystemPrompt(config.language, session.summary, voiceInterviewPrompt)
    let historyStart = Math.max(0, session.messages.length - config.contextMessageLimit)
    while (historyStart > 0 && session.messages[historyStart]?.role !== "user") {
      historyStart -= 1
    }
    let history = session.messages.slice(historyStart)
    const historyBudget = Math.max(0, config.contextWindowTokens - config.maxOutputTokens - estimateTokens([{ content: system }]) - 2048)
    if (estimateTokens(history) > historyBudget) {
      history = this.fitHistoryToBudget(history, historyBudget)
    }

    const transportChanged = this.prepareHistoryImageTransports(session, history)
    if (transportChanged) {
      this.syncHistoryAttachments(session, history)
      this.store.save()
    }

    if (config.apiProvider === "openai" || config.apiProvider === "openai-compatible") {
      const openaiMessages = await this.buildOpenAIMessages(session, history, system, config, signal)
      this.syncHistoryAttachments(session, history)
      this.store.save()
      const client = new OpenAI({
        apiKey: config.apiKey,
        ...(config.apiProvider === "openai-compatible" && config.baseURL ? { baseURL: config.baseURL.replace(/\/$/, "") } : {}),
        timeout: 180000,
        maxRetries: 0
      })
      const useStreaming = config.streamingEnabled && config.apiProvider === "openai-compatible"
      if (useStreaming) {
        const stream = await client.chat.completions.create({
          model: config.extractionModel,
          messages: openaiMessages,
          max_tokens: config.maxOutputTokens,
          temperature: 0.2,
          stream: true
        }, { signal })
        let result = ""
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content || ""
          if (!delta) continue
          result += delta
          this.deps.getMainWindow()?.webContents.send("chat-stream", {
            requestId,
            sessionId: session.id,
            content: visibleResponseContent(result),
            done: false
          })
        }
        return result
      }
      const response = await client.chat.completions.create({
        model: config.extractionModel,
        messages: openaiMessages,
        max_tokens: config.maxOutputTokens,
        temperature: 0.2
      }, { signal })
      const result = response.choices[0]?.message?.content || ""
      this.emitFinalDelta(requestId, session.id, result)
      return result
    }

    if (config.apiProvider === "gemini") {
      const parts: Array<Record<string, unknown>> = [{ text: system }]
      for (const message of history) {
        parts.push({ text: `${message.role === "user" ? "用户" : "助手"}：${message.content}` })
        for (const image of message.images) {
          const payloadPath = image.transportPath || image.path
          const url = imageDataUrl(payloadPath, image.mimeType)
          if (!url) continue
          parts.push({ inlineData: { mimeType: image.mimeType || "image/png", data: url.split(",")[1] || "" } })
        }
      }
      const response = await axios.default.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${config.extractionModel}:generateContent?key=${config.apiKey}`,
        { contents: [{ role: "user", parts }], generationConfig: { temperature: 0.2, maxOutputTokens: config.maxOutputTokens } },
        { signal }
      )
      const result = response.data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("") || ""
      this.emitFinalDelta(requestId, session.id, result)
      return result
    }

    const client = new Anthropic({ apiKey: config.apiKey })
    const response = await client.messages.create({
      model: config.extractionModel,
      max_tokens: config.maxOutputTokens,
      temperature: 0.2,
      system,
      messages: history.map((message) => ({
        role: message.role,
        content: [
          { type: "text" as const, text: message.content },
          ...message.images.flatMap((image) => {
            const payloadPath = image.transportPath || image.path
            const url = imageDataUrl(payloadPath, image.mimeType)
            if (!url) return []
            return [{
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: image.mimeType || "image/png",
                data: url.split(",")[1] || ""
              }
            }]
          })
        ]
      }))
    }, { signal })
    const result = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")
    this.emitFinalDelta(requestId, session.id, result)
    return result
  }

  private prepareHistoryImageTransports(session: ChatSession, history: ChatMessage[]): boolean {
    let changed = false
    for (const message of history) {
      for (let index = 0; index < message.images.length; index += 1) {
        const current = message.images[index]
        const prepared = this.prepareTransportAttachment(session.id, message.id, index, current)
        if (prepared !== current) {
          message.images[index] = prepared
          changed = true
        }
      }
    }
    return changed
  }

  private prepareTransportAttachment(
    sessionId: string,
    messageId: string,
    imageIndex: number,
    image: ChatAttachment
  ): ChatAttachment {
    if (!fs.existsSync(image.path)) return image
    if (image.transportPath && fs.existsSync(image.transportPath)) return image
    try {
      const metadata = readImageMetadata(image.path)
      const targetPath = path.join(
        this.store.getAttachmentDirectory(sessionId),
        `${safeStorageComponent(messageId)}-${imageIndex}-transport.png`
      )
      const prepared = resizeImageToPng(image.path, targetPath, metadata)
      if (!prepared) {
        return {
          ...image,
          mimeType: metadata.mimeType,
          ...(metadata.width ? { width: metadata.width } : {}),
          ...(metadata.height ? { height: metadata.height } : {})
        }
      }
      return {
        ...image,
        ...(prepared.path !== image.path ? { transportPath: prepared.path } : {}),
        mimeType: prepared.mimeType,
        ...(prepared.width ? { width: prepared.width } : {}),
        ...(prepared.height ? { height: prepared.height } : {})
      }
    } catch (error) {
      console.warn("Failed to prepare chat image for transport:", error)
      return {
        ...image,
        mimeType: image.mimeType || this.safeImageMimeType(image.path)
      }
    }
  }

  private safeImageMimeType(filePath: string): ChatImageMimeType {
    try {
      return readImageMetadata(filePath).mimeType
    } catch {
      return "image/png"
    }
  }

  private async buildOpenAIMessages(
    session: ChatSession,
    history: ChatMessage[],
    system: string,
    config: ReturnType<typeof configHelper.loadConfig>,
    signal: AbortSignal
  ): Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: "system", content: system }]
    const filesConfig: DeepSeekFilesConfig = {
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      provider: config.apiProvider
    }
    const canUseFilesApi = supportsDeepSeekFilesApi(filesConfig)
    const ownerHash = canUseFilesApi ? fileOwnerFingerprint(filesConfig) : ""

    for (const message of history) {
      if (message.role === "assistant") {
        messages.push({ role: "assistant", content: message.content })
        continue
      }

      const parts: Array<Record<string, unknown>> = [{ type: "text", text: message.content }]
      const imageParts = await Promise.all(message.images.map(async (originalImage, index) => {
        let image = originalImage
        if (canUseFilesApi) {
          if (!image.fileId || image.fileOwnerHash !== ownerHash) {
            try {
              image = this.prepareTransportAttachment(session.id, message.id, index, image)
              const uploaded = await uploadDeepSeekImage(
                filesConfig,
                image.transportPath || image.path,
                signal
              )
              image = { ...image, fileId: uploaded.id, fileOwnerHash: ownerHash }
              message.images[index] = image
            } catch (error) {
              if (error instanceof Error && error.name === "AbortError") throw error
              console.warn("DeepSeek Files API upload failed; falling back to inline Base64:", error)
            }
          }
          if (image.fileId && image.fileOwnerHash === ownerHash) {
            return { type: "file", file_id: image.fileId } as Record<string, unknown>
          }
        }

        image = this.prepareTransportAttachment(session.id, message.id, index, image)
        message.images[index] = image
        const payloadPath = image.transportPath || image.path
        const url = imageDataUrl(payloadPath, image.mimeType)
        if (!url) return null
        return {
          type: "image_url",
          image_url: {
            url,
            detail: "original"
          }
        }
      }))
      for (const imagePart of imageParts) {
        if (imagePart) parts.push(imagePart)
      }

      messages.push({
        role: "user",
        content: parts.length === 1
          ? message.content
          : parts as unknown as OpenAI.Chat.Completions.ChatCompletionContentPart[]
      })
    }
    return messages
  }

  private syncHistoryAttachments(session: ChatSession, history: ChatMessage[]): void {
    const byId = new Map(history.map((message) => [message.id, message]))
    for (const message of session.messages) {
      const updated = byId.get(message.id)
      if (updated) message.images = updated.images
    }
  }

  private describeImagesForSummary(images: ChatAttachment[]): string {
    if (!images.length) return ""
    const references = images.map((image) => {
      if (image.imageSummary) return image.imageSummary
      if (image.fileId) return `file_id=${image.fileId}`
      return `本地附件=${path.basename(image.path)}`
    })
    return ` [图片引用：${references.join("；")}]`
  }

  private buildImageReferenceAppendix(messages: ChatMessage[]): string {
    const lines: string[] = []
    const seen = new Set<string>()
    for (const message of messages) {
      for (const image of message.images) {
        const reference = image.imageSummary
          ? image.imageSummary
          : image.fileId
            ? `file_id=${image.fileId}`
            : `本地附件=${path.basename(image.path)}`
        const key = `${reference}|${message.content.slice(0, 80)}`
        if (seen.has(key)) continue
        seen.add(key)
        lines.push(`- ${reference}；关联内容：${message.content.slice(0, 160) || "无"}`)
      }
    }
    return lines.length ? `历史图片引用：\n${lines.join("\n")}` : ""
  }

  private fitHistoryToBudget(messages: ChatMessage[], budget: number): ChatMessage[] {
    const history = messages.map((message) => ({ ...message, images: [...message.images] }))
    while (history.length > 1 && estimateTokens(history) > budget) history.shift()
    if (!history.length) return history
    if (estimateTokens(history) <= budget) return history

    const last = history[history.length - 1]
    const imageTokens = last.images.length * IMAGE_TOKEN_ESTIMATE
    if (last.images.length && imageTokens + MIN_IMAGE_TEXT_TOKENS > budget) {
      throw new Error("当前上下文预算不足以发送全部截图，请提高上下文窗口或降低最大输出长度")
    }
    if (budget <= 0) {
      throw new Error("当前上下文预算不足，请提高上下文窗口或降低最大输出长度")
    }

    const textBudget = Math.max(0, budget - imageTokens)
    history[history.length - 1] = {
      ...last,
      content: truncateToTokenBudget(last.content, textBudget)
    }
    if (estimateTokens(history) > budget) {
      throw new Error("当前上下文预算不足，请提高上下文窗口或降低最大输出长度")
    }
    return history
  }

  private async completeText(messages: ProviderMessage[], signal: AbortSignal): Promise<string> {
    const config = configHelper.loadConfig()
    if (config.apiProvider === "openai" || config.apiProvider === "openai-compatible") {
      const client = new OpenAI({
        apiKey: config.apiKey,
        ...(config.apiProvider === "openai-compatible" && config.baseURL ? { baseURL: config.baseURL.replace(/\/$/, "") } : {}),
        timeout: 180000,
        maxRetries: 0
      })
      const response = await client.chat.completions.create({
        model: config.solutionModel || config.extractionModel,
        messages,
        max_tokens: config.maxOutputTokens,
        temperature: 0.1
      }, { signal })
      return response.choices[0]?.message?.content || ""
    }
    if (config.apiProvider === "gemini") {
      const prompt = messages.map((message) => `${message.role}: ${message.content}`).join("\n\n")
      const response = await axios.default.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${config.solutionModel || config.extractionModel}:generateContent?key=${config.apiKey}`,
        { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, maxOutputTokens: config.maxOutputTokens } },
        { signal }
      )
      return response.data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("") || ""
    }
    const client = new Anthropic({ apiKey: config.apiKey })
    const response = await client.messages.create({
      model: config.solutionModel || config.extractionModel,
      max_tokens: config.maxOutputTokens,
      temperature: 0.1,
      messages: messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role as "user" | "assistant", content: message.content })),
      system: messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n")
    }, { signal })
    return response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")
  }

  private async deleteRemoteFiles(
    session: ChatSession,
    options: { clearReferences?: boolean } = {}
  ): Promise<void> {
    const config = configHelper.loadConfig()
    const filesConfig: DeepSeekFilesConfig = {
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      provider: config.apiProvider
    }
    if (!supportsDeepSeekFilesApi(filesConfig)) return

    const ownerHash = fileOwnerFingerprint(filesConfig)
    const fileIds = new Set<string>()
    for (const message of session.messages) {
      message.images = message.images.map((image) => {
        if (!image.fileId || image.fileOwnerHash !== ownerHash) return image
        fileIds.add(image.fileId)
        if (!options.clearReferences) return image
        const cleared: ChatAttachment = { ...image }
        delete cleared.fileId
        delete cleared.fileOwnerHash
        return cleared
      })
    }

    await Promise.allSettled([...fileIds].map(async (fileId) => {
      try {
        await deleteDeepSeekFile(filesConfig, fileId)
      } catch (error) {
        console.warn(`Failed to delete DeepSeek file ${fileId}:`, error)
      }
    }))
  }

  private emitFinalDelta(requestId: string, sessionId: string, content: string): void {
    this.deps.getMainWindow()?.webContents.send("chat-stream", {
      requestId,
      sessionId,
      content: visibleResponseContent(content),
      done: true
    })
  }

}
