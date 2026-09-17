import { app, BrowserWindow } from "electron"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { OpenAI } from "openai"
import Anthropic from "@anthropic-ai/sdk"
import * as axios from "axios"
import { configHelper } from "./ConfigHelper"

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

export interface ChatServiceDeps {
  getMainWindow: () => BrowserWindow | null
}

type ProviderMessage = { role: "system" | "user" | "assistant"; content: string }

const SYSTEM_PROMPT = "你是一个多轮对话助手，能够处理文本、代码和截图。保持上下文连续，直接回答用户，所有说明和代码注释使用简体中文。"

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

function buildSystemPrompt(configLanguage: string, summary: string): string {
  const detectedLanguage = normalizeDetectedLanguage(configLanguage)
  const languageContext = detectedLanguage
    ? `当前截图/上下文已识别出的编程语言是：${detectedLanguage}。除非新截图明确显示其他语言，否则沿用该语言。`
    : "如果本轮消息或上下文包含代码截图，请根据截图自动判断编程语言，不要默认使用 Python。"
  const detectionProtocol = "如果本轮或上下文包含代码截图且能确定语言，请在最终回答第一行单独输出 [LANGUAGE: <language>]，language 只能使用 python、javascript、typescript、java、cpp、csharp、golang、rust、swift、kotlin、ruby、sql、r；无法确定或没有代码截图时不要输出该标记。该标记仅供程序解析，不要解释。"
  return [SYSTEM_PROMPT, languageContext, detectionProtocol, summary ? `此前对话摘要：\n${summary}` : ""].filter(Boolean).join("\n\n")
}

function safeStorageComponent(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, "_") || "session"
}

function normalizeMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Partial<ChatMessage>
  if (value.role !== "user" && value.role !== "assistant") return null
  if (typeof value.content !== "string") return null
  const images = Array.isArray(value.images)
    ? value.images.filter((image): image is ChatAttachment => Boolean(image && typeof image.path === "string"))
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
      const sessions = ordered.slice(0, 50)
      // The selected session is part of the user's active context and must not
      // disappear merely because an older session crossed the retention limit.
      if (current && !sessions.some((item) => item.id === current.id)) {
        sessions.pop()
        sessions.push(current)
      }
      const payload = JSON.stringify({ version: 1, currentSessionId: this.currentSessionId, sessions }, null, 2)
      const tempPath = this.filePath + ".tmp"
      fs.writeFileSync(tempPath, payload, "utf8")
      fs.renameSync(tempPath, this.filePath)
    } catch (error) {
      console.error("Failed to save chat sessions:", error)
    }
  }

  public delete(id: string): boolean {
    const before = this.sessions.length
    this.sessions = this.sessions.filter((item) => item.id !== id)
    if (this.sessions.length === before) return false
    if (this.currentSessionId === id) this.currentSessionId = this.list()[0]?.id || ""
    try {
      fs.rmSync(path.join(path.dirname(this.filePath), "chat-attachments", safeStorageComponent(id)), { recursive: true, force: true })
    } catch (error) {
      console.warn("Failed to delete chat attachments:", error)
    }
    this.save()
    return true
  }

  public copyAttachments(sessionId: string, messageId: string, images: ChatAttachment[]): ChatAttachment[] {
    const directory = path.join(path.dirname(this.filePath), "chat-attachments", safeStorageComponent(sessionId))
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
    const imageTokens = (message.images?.length || 0) * 1200
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
    return this.store.delete(id)
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

    mainWindow.webContents.send("chat-started", { sessionId: session.id, requestId, userMessage })

    const controller = new AbortController()
    this.abortController = controller
    try {
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
      ...older.map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content}${message.images.length ? ` [包含 ${message.images.length} 张截图]` : ""}`)
    ].filter(Boolean).join("\n\n")

    try {
      const summary = (await this.summarize(transcript, signal)).trim()
      if (!summary) {
        console.warn("Chat context summary was empty; keeping original history")
        return
      }
      session.summary = summary
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
    const system = buildSystemPrompt(config.language, session.summary)
    let historyStart = Math.max(0, session.messages.length - config.contextMessageLimit)
    while (historyStart > 0 && session.messages[historyStart]?.role !== "user") {
      historyStart -= 1
    }
    let history = session.messages.slice(historyStart)
    const historyBudget = Math.max(0, config.contextWindowTokens - config.maxOutputTokens - estimateTokens([{ content: system }]) - 2048)
    if (estimateTokens(history) > historyBudget) {
      history = this.fitHistoryToBudget(history, historyBudget)
    }
    const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      ...history.map((message): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
        if (message.role === "assistant") return { role: "assistant", content: message.content }
        const imageUrls = message.images
          .map((image) => this.imageDataUrl(image.path))
          .filter((url): url is string => Boolean(url))
        if (!imageUrls.length) return { role: "user", content: message.content }
        return {
          role: "user",
          content: [
            { type: "text", text: message.content },
            ...imageUrls.map((url) => ({
              type: "image_url" as const,
              image_url: { url }
            }))
          ]
        }
      })
    ]

    if (config.apiProvider === "openai" || config.apiProvider === "openai-compatible") {
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
          const url = this.imageDataUrl(image.path)
          if (!url) continue
          parts.push({ inlineData: { mimeType: "image/png", data: url.split(",")[1] || "" } })
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
            const url = this.imageDataUrl(image.path)
            if (!url) return []
            return [{ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: url.split(",")[1] || "" } }]
          })
        ]
      }))
    }, { signal })
    const result = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")
    this.emitFinalDelta(requestId, session.id, result)
    return result
  }

  private fitHistoryToBudget(messages: ChatMessage[], budget: number): ChatMessage[] {
    const history = messages.map((message) => ({ ...message, images: [...message.images] }))
    while (history.length > 1 && estimateTokens(history) > budget) history.shift()
    if (!history.length) return history
    if (estimateTokens(history) <= budget) return history

    const last = history[history.length - 1]
    const imageBudget = Math.floor((budget - estimateTokens([{ content: "" }])) / 1200)
    const images = imageBudget >= last.images.length ? last.images : []
    const textBudget = Math.max(0, budget - images.length * 1200)
    history[history.length - 1] = {
      ...last,
      content: truncateToTokenBudget(last.content, textBudget),
      images
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

  private emitFinalDelta(requestId: string, sessionId: string, content: string): void {
    this.deps.getMainWindow()?.webContents.send("chat-stream", {
      requestId,
      sessionId,
      content: visibleResponseContent(content),
      done: true
    })
  }

  private imageDataUrl(filePath: string): string | null {
    try {
      if (!fs.existsSync(filePath)) return null
      const data = fs.readFileSync(filePath).toString("base64")
      return `data:image/png;base64,${data}`
    } catch {
      return null
    }
  }
}
