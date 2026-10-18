import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { networkInterfaces } from "node:os"
import fs from "node:fs"
import path from "node:path"
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { WebSocket, WebSocketServer } from "ws"
import { configHelper } from "./ConfigHelper"
import type { ChatAttachment, ChatService } from "./ChatService"
import type { VoiceRecognitionHelper } from "./VoiceRecognitionHelper"
import type { CompanionImage, CompanionMessage, CompanionSessionSummary, CompanionSnapshot, CompanionStatus } from "./CompanionTypes"

const PAIRING_TTL_MS = 2 * 60 * 1000
const MAX_JSON_BODY_BYTES = 64 * 1024
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

export interface CompanionServerDeps {
  getChatService: () => ChatService | null
  getVoiceRecognitionHelper: () => VoiceRecognitionHelper | null
  getScreenshotPaths: () => string[]
  takeScreenshot: () => Promise<string>
  getImagePreview: (filepath: string) => Promise<string>
  deleteScreenshot: (filepath: string) => Promise<{ success: boolean; error?: string }>
  notifyScreenshotTaken: (filepath: string, preview: string) => void
  notifySessionSelected: (session: unknown) => void
  getStaticDirectory: () => string
  publishDesktopEvent?: (channel: string, payload?: unknown) => void
}

interface PairingState {
  pairingToken: string
  expiresAt: number
  sessionToken: string | null
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url")
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
}

function localIpv4Addresses(): Array<{ label: string; address: string; netmask: string }> {
  const result: Array<{ label: string; address: string; netmask: string }> = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal || !isPrivateIpv4(entry.address)) continue
      if (!entry.netmask) continue
      if (!result.some((item) => item.address === entry.address)) {
        result.push({ label: name, address: entry.address, netmask: entry.netmask })
      }
    }
  }
  return result
}

function mimeTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase()
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon"
  }
  return types[extension] || "application/octet-stream"
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  })
  response.end(body)
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new Error("请求内容过大"))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求格式无效")
        resolve(parsed as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
    request.on("error", reject)
  })
}

export class CompanionServer {
  private readonly deps: CompanionServerDeps
  private server: Server | null = null
  private sockets: WebSocketServer | null = null
  private clients = new Set<WebSocket>()
  private pairing: PairingState | null = null
  private port = 0
  private addresses: Array<{ label: string; url: string }> = []
  private allowedNetworks: Array<{ address: string; netmask: string }> = []
  private statusListener: ((status: CompanionStatus) => void) | null = null

  constructor(deps: CompanionServerDeps) {
    this.deps = deps
  }

  public onStatusChange(listener: ((status: CompanionStatus) => void) | null): void {
    this.statusListener = listener
  }

  public getStatus(): CompanionStatus {
    return {
      running: Boolean(this.server),
      connected: [...this.clients].some((client) => client.readyState === WebSocket.OPEN),
      paired: Boolean(this.pairing?.sessionToken),
      addresses: this.addresses,
      ...(this.pairing?.sessionToken ? {} : this.pairing ? {
        pairingExpiresAt: this.pairing.expiresAt,
        pairingUrls: this.addresses.map(({ label, url }) => ({
          label,
          url: `${url}#${this.pairing?.pairingToken || ""}`
        }))
      } : {})
    }
  }

  public async start(): Promise<CompanionStatus> {
    if (this.server) return this.getStatus()
    const staticDirectory = path.resolve(this.deps.getStaticDirectory())
    const companionPage = path.join(staticDirectory, "companion.html")
    if (!fs.existsSync(companionPage) || !fs.statSync(companionPage).isFile()) {
      throw new Error(`手机页面资源不存在：${companionPage}。请先重新构建应用后再开启伴随端。`)
    }
    const localAddresses = localIpv4Addresses()
    if (!localAddresses.length) throw new Error("未找到可用的局域网 IPv4 地址，请确认笔记本已连接 Wi-Fi")

    const server = createServer((request, response) => {
      void this.handleHttp(request, response).catch((error) => {
        console.error("Companion request failed:", error)
        if (!response.headersSent) sendJson(response, 500, { success: false, error: "本地伴随服务发生错误" })
        else response.destroy()
      })
    })
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })

    server.on("upgrade", (request, socket, head) => {
      let requestUrl: URL
      try {
        requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`)
      } catch {
        socket.destroy()
        return
      }
      if (
        requestUrl.pathname !== "/api/events" ||
        !this.isAllowedHost(request.headers.host) ||
        !this.isAllowedPeer(request.socket.remoteAddress) ||
        !this.isAllowedOrigin(request)
      ) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n")
        socket.destroy()
        return
      }
      if (sockets.clients.size >= 4) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n")
        socket.destroy()
        return
      }
      sockets.handleUpgrade(request, socket, head, (webSocket) => sockets.emit("connection", webSocket, request))
    })

    sockets.on("connection", (client) => this.handleSocket(client))
    server.on("error", (error) => {
      console.error("Companion server error:", error)
      this.notifyStatus()
    })

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "0.0.0.0", () => {
        server.removeListener("error", reject)
        resolve()
      })
    })

    const address = server.address()
    if (!address || typeof address === "string") {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      throw new Error("无法取得伴随服务地址")
    }

    this.server = server
    this.sockets = sockets
    this.port = address.port
    this.addresses = localAddresses.map(({ label, address: host }) => ({
      label,
      url: `http://${host}:${this.port}/companion`
    }))
    this.allowedNetworks = localAddresses.map(({ address, netmask }) => ({ address, netmask }))
    this.createPairingToken()
    this.notifyStatus()
    return this.getStatus()
  }

  public refreshPairing(): CompanionStatus {
    if (!this.server) throw new Error("手机伴随服务尚未启动")
    if (this.pairing?.sessionToken) throw new Error("手机已配对，请先断开当前设备")
    this.createPairingToken()
    this.notifyStatus()
    return this.getStatus()
  }

  public disconnectPhone(): CompanionStatus {
    this.pairing = null
    for (const client of this.clients) {
      try { client.close(4001, "Pairing revoked") } catch { /* already closed */ }
    }
    this.clients.clear()
    if (this.server) this.createPairingToken()
    this.notifyStatus()
    return this.getStatus()
  }

  public async stop(): Promise<CompanionStatus> {
    const sockets = this.sockets
    const server = this.server
    this.pairing = null
    this.clients.clear()
    this.sockets = null
    this.server = null
    this.port = 0
    this.addresses = []
    this.allowedNetworks = []
    if (sockets) {
      for (const client of sockets.clients) {
        try { client.close(1001, "Companion service stopped") } catch { /* already closed */ }
      }
      sockets.close()
    }
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    this.notifyStatus()
    return this.getStatus()
  }

  public publish(channel: string, payload?: unknown): void {
    if (!this.pairing?.sessionToken) return
    let event: Record<string, unknown>
    if (channel === "chat-stream" && payload && typeof payload === "object") {
      const value = payload as Record<string, unknown>
      event = {
        type: "chat-stream",
        data: {
          requestId: typeof value.requestId === "string" ? value.requestId : "",
          sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
          content: typeof value.content === "string" ? value.content : "",
          done: Boolean(value.done)
        }
      }
    } else if (channel.startsWith("voice-") && payload && typeof payload === "object") {
      event = { type: "voice-event", channel, data: payload }
    } else {
      event = { type: "refresh" }
    }
    this.broadcast(event)
  }

  private createPairingToken(): void {
    this.pairing = {
      pairingToken: randomToken(),
      expiresAt: Date.now() + PAIRING_TTL_MS,
      sessionToken: null
    }
  }

  private notifyStatus(): void {
    this.statusListener?.(this.getStatus())
  }

  private isAllowedOrigin(request: IncomingMessage): boolean {
    const host = request.headers.host
    const origin = request.headers.origin
    if (typeof host !== "string" || typeof origin !== "string") return false
    const allowedHosts = new Set(this.addresses.map(({ url }) => new URL(url).host))
    if (!allowedHosts.has(host.toLowerCase())) return false
    try {
      return new URL(origin).origin === `http://${host}`
    } catch {
      return false
    }
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const auth = request.headers.authorization
    if (!this.pairing?.sessionToken || typeof auth !== "string" || !auth.startsWith("Bearer ")) return false
    return safeEqual(auth.slice(7), this.pairing.sessionToken)
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method || "GET"
    const host = request.headers.host
    const requestUrl = new URL(request.url || "/", `http://${host || "localhost"}`)
    if (!this.isAllowedHost(host)) {
      sendJson(response, 403, { success: false, error: "不允许的本地网络主机" })
      return
    }
    if (!this.isAllowedPeer(request.socket.remoteAddress)) {
      sendJson(response, 403, { success: false, error: "仅允许从已连接的本地网络访问伴随服务" })
      return
    }

    if (method === "POST" && requestUrl.pathname === "/api/pair") {
      if (!this.isAllowedOrigin(request)) {
        sendJson(response, 403, { success: false, error: "配对来源无效" })
        return
      }
      const body = await readJson(request)
      const token = typeof body.token === "string" ? body.token : ""
      if (!this.pairing || this.pairing.sessionToken || Date.now() > this.pairing.expiresAt || !safeEqual(token, this.pairing.pairingToken)) {
        sendJson(response, 401, { success: false, error: "配对码已失效或不正确，请在电脑端刷新二维码" })
        return
      }
      this.pairing.sessionToken = randomToken()
      this.pairing.pairingToken = ""
      sendJson(response, 200, { success: true, token: this.pairing.sessionToken })
      this.notifyStatus()
      return
    }

    if (requestUrl.pathname.startsWith("/api/")) {
      // Browsers omit Origin on some same-origin safe GETs. The bearer token
      // still gates all data; mutation endpoints require an exact same-origin.
      const safeRead = method === "GET" || method === "HEAD"
      const originAllowed = safeRead && !request.headers.origin
        ? true
        : this.isAllowedOrigin(request)
      if (!originAllowed || !this.isAuthorized(request)) {
        sendJson(response, 401, { success: false, error: "手机尚未配对或授权已撤销" })
        return
      }
      await this.handleApi(method, requestUrl, request, response)
      return
    }

    if (method !== "GET" && method !== "HEAD") {
      sendJson(response, 405, { success: false, error: "不支持的请求方法" })
      return
    }
    this.serveStatic(requestUrl.pathname, response, method === "HEAD")
  }

  private isAllowedHost(host: string | undefined): boolean {
    if (!host) return false
    const allowedHosts = new Set(this.addresses.map(({ url }) => new URL(url).host))
    return allowedHosts.has(host.toLowerCase())
  }

  private isAllowedPeer(remoteAddress: string | undefined): boolean {
    if (!remoteAddress) return false
    const peer = remoteAddress.startsWith("::ffff:") ? remoteAddress.slice(7) : remoteAddress
    // Keep local diagnostics and automated tests usable from the same laptop.
    if (peer === "127.0.0.1" || peer === "::1") return true
    const peerParts = peer.split(".").map(Number)
    if (peerParts.length !== 4 || peerParts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
    return this.allowedNetworks.some(({ address, netmask }) => {
      const addressParts = address.split(".").map(Number)
      const maskParts = netmask.split(".").map(Number)
      return addressParts.length === 4 && maskParts.length === 4 &&
        addressParts.every((part, index) => (part & maskParts[index]) === (peerParts[index] & maskParts[index]))
    })
  }

  private async handleApi(method: string, url: URL, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, { success: true, state: await this.getSnapshot() })
      return
    }

    const imageMatch = url.pathname.match(/^\/api\/(pending-image|session-image)\/([^/]+)(?:\/([^/]+))?(?:\/(\d+))?$/)
    if (method === "GET" && imageMatch) {
      const imagePath = this.resolveImagePath(imageMatch[1], imageMatch[2], imageMatch[3], imageMatch[4])
      if (!imagePath || !fs.existsSync(imagePath)) {
        sendJson(response, 404, { success: false, error: "截图不存在" })
        return
      }
      if (!IMAGE_MIME_TYPES.has(mimeTypeFor(imagePath).split(";")[0])) {
        sendJson(response, 404, { success: false, error: "截图格式不受支持" })
        return
      }
      const stream = fs.createReadStream(imagePath)
      stream.on("error", () => {
        if (!response.headersSent) sendJson(response, 404, { success: false, error: "截图读取失败" })
        else response.destroy()
      })
      response.writeHead(200, {
        "Content-Type": mimeTypeFor(imagePath),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer"
      })
      stream.pipe(response)
      return
    }

    if (method !== "POST") {
      sendJson(response, 405, { success: false, error: "不支持的请求方法" })
      return
    }

    const body = await readJson(request)
    const service = this.deps.getChatService()
    if (!service) {
      sendJson(response, 503, { success: false, error: "对话服务尚未就绪" })
      return
    }

    try {
      switch (url.pathname) {
        case "/api/session/new": {
          if (service.isBusy()) {
            sendJson(response, 409, { success: false, error: "当前回答尚未结束" })
            return
          }
          const session = service.createSession()
          this.deps.notifySessionSelected(session)
          this.broadcast({ type: "refresh" })
          sendJson(response, 200, { success: true, state: await this.getSnapshot() })
          return
        }
        case "/api/session/select": {
          const id = typeof body.id === "string" ? body.id : ""
          const session = id ? service.selectSession(id) : null
          if (!session) {
            sendJson(response, 409, { success: false, error: "会话不存在或当前请求尚未结束" })
            return
          }
          this.deps.notifySessionSelected(session)
          this.broadcast({ type: "refresh" })
          sendJson(response, 200, { success: true, state: await this.getSnapshot() })
          return
        }
        case "/api/session/delete": {
          const id = typeof body.id === "string" ? body.id : ""
          const wasCurrent = id && service.getCurrentSession().id === id
          const success = Boolean(id && service.deleteSession(id))
          if (!success) {
            sendJson(response, 409, { success: false, error: "无法删除会话；请先等待回答结束" })
            return
          }
          const current = service.getCurrentSession()
          if (wasCurrent) this.deps.notifySessionSelected(current)
          this.broadcast({ type: "refresh" })
          sendJson(response, 200, { success: true, state: await this.getSnapshot() })
          return
        }
        case "/api/screenshot": {
          const screenshotPath = await this.deps.takeScreenshot()
          const preview = await this.deps.getImagePreview(screenshotPath)
          this.deps.notifyScreenshotTaken(screenshotPath, preview)
          this.broadcast({ type: "refresh" })
          sendJson(response, 200, { success: true, state: await this.getSnapshot() })
          return
        }
        case "/api/screenshot/delete": {
          const id = typeof body.id === "string" ? Number(body.id) : -1
          const paths = this.deps.getScreenshotPaths()
          if (!Number.isInteger(id) || id < 0 || id >= paths.length) {
            sendJson(response, 404, { success: false, error: "待发送截图不存在" })
            return
          }
          const result = await this.deps.deleteScreenshot(paths[id])
          if (!result.success) {
            sendJson(response, 409, { success: false, error: result.error || "无法删除截图" })
            return
          }
          this.broadcast({ type: "refresh" })
          sendJson(response, 200, { success: true, state: await this.getSnapshot() })
          return
        }
        case "/api/chat/send": {
          if (!configHelper.hasApiKey()) {
            sendJson(response, 409, { success: false, error: "请先在笔记本设置中配置对话 API Key" })
            return
          }
          if (service.isBusy()) {
            sendJson(response, 409, { success: false, error: "上一条消息仍在处理中，请稍后重试" })
            return
          }
          const text = typeof body.text === "string" ? body.text.trim().slice(0, 20_000) : ""
          const selectedIds = Array.isArray(body.screenshotIds)
            ? body.screenshotIds.filter((value): value is string => typeof value === "string")
            : []
          const screenshotPaths = this.deps.getScreenshotPaths()
          const uniqueIndices = [...new Set(selectedIds.map((value) => Number(value)))].filter(
            (index) => Number.isInteger(index) && index >= 0 && index < screenshotPaths.length
          )
          const images: ChatAttachment[] = await Promise.all(uniqueIndices.map(async (index) => ({
            path: screenshotPaths[index],
            preview: await this.deps.getImagePreview(screenshotPaths[index])
          })))
          if (!text && !images.length) {
            sendJson(response, 400, { success: false, error: "请输入问题或选择截图" })
            return
          }
          const requestId = randomUUID()
          const resultPromise = service.sendMessage(
            service.getCurrentSession().id,
            text,
            images,
            requestId
          )
          // ChatService emits its normal start/stream/success/error events. Do
          // not hold the phone's HTTP request open for the full model reply.
          void resultPromise.then((result) => {
            if (!result.success) this.broadcast({ type: "refresh" })
          }).catch((error) => {
            console.warn("Companion chat request failed:", error)
            this.broadcast({ type: "refresh" })
          })
          sendJson(response, 202, { success: true, accepted: true, requestId })
          return
        }
        case "/api/chat/cancel":
          service.cancel()
          sendJson(response, 200, { success: true })
          return
        default:
          sendJson(response, 404, { success: false, error: "未找到该本地功能" })
      }
    } catch (error) {
      sendJson(response, 500, {
        success: false,
        error: error instanceof Error ? error.message : "本地操作失败"
      })
    }
  }

  private async getSnapshot(): Promise<CompanionSnapshot> {
    const service = this.deps.getChatService()
    if (!service) throw new Error("对话服务尚未就绪")
    const session = service.getCurrentSession()
    const sessions: CompanionSessionSummary[] = service.listSessions().map((item) => ({
      id: item.id,
      title: item.title,
      updatedAt: item.updatedAt
    }))
    const safeMessages: CompanionMessage[] = session.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      status: message.status,
      images: message.images.map((image, index) => ({
        id: `${session.id}:${message.id}:${index}`,
        url: `/api/session-image/${encodeURIComponent(session.id)}/${encodeURIComponent(message.id)}/${index}`,
        ...(image.mimeType ? { mimeType: image.mimeType } : {}),
        ...(image.width ? { width: image.width } : {}),
        ...(image.height ? { height: image.height } : {})
      }))
    }))
    const pendingScreenshots: CompanionImage[] = this.deps.getScreenshotPaths().map((_, index) => ({
      id: String(index),
      url: `/api/pending-image/${index}`
    }))
    const voice = this.deps.getVoiceRecognitionHelper()?.getLiveSnapshot()
    return {
      busy: service.isBusy(),
      currentSessionId: session.id,
      sessions,
      session: {
        id: session.id,
        title: session.title,
        messages: safeMessages
      },
      pendingScreenshots,
      voice: voice || {
        system: { state: "idle", message: "", transcript: "", partialTranscript: "" },
        microphone: { state: "idle", message: "", transcript: "", partialTranscript: "" }
      }
    }
  }

  private resolveImagePath(kind: string, first?: string, second?: string, third?: string): string | null {
    if (kind === "pending-image") {
      const index = Number(first)
      if (!Number.isInteger(index) || index < 0) return null
      return this.deps.getScreenshotPaths()[index] || null
    }
    if (kind !== "session-image" || !first || !second || third === undefined) return null
    const session = this.deps.getChatService()?.getSession(first)
    const imageIndex = Number(third)
    if (!session || !Number.isInteger(imageIndex) || imageIndex < 0) return null
    const message = session.messages.find((item) => item.id === second)
    const image = message?.images[imageIndex]
    if (!image) return null
    return this.deps.getChatService()?.resolveAttachmentPath(first, second, imageIndex) || null
  }

  private handleSocket(client: WebSocket): void {
    const authTimeout = setTimeout(() => {
      if (client.readyState === WebSocket.OPEN) client.close(4003, "Authentication timeout")
    }, 5_000)
    let authenticated = false
    client.once("message", async (raw) => {
      let payload: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(String(raw))
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid auth message")
        payload = parsed as Record<string, unknown>
      } catch {
        client.close(4002, "Invalid auth message")
        return
      }
      if (payload.type !== "auth" || typeof payload.token !== "string" || !this.pairing?.sessionToken || !safeEqual(payload.token, this.pairing.sessionToken)) {
        client.close(4003, "Unauthorized")
        return
      }
      authenticated = true
      clearTimeout(authTimeout)
      for (const other of this.clients) {
        if (other !== client) other.close(4001, "Replaced by reconnect")
      }
      this.clients.add(client)
      try {
        client.send(JSON.stringify({ type: "snapshot", state: await this.getSnapshot() }))
      } catch {
        client.close(1011, "Unable to load session")
        this.clients.delete(client)
        return
      }
      this.notifyStatus()
    })
    client.on("message", (raw) => {
      if (!authenticated) return
      let payload: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(String(raw))
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
        payload = parsed as Record<string, unknown>
      } catch { return }
      if (payload.type === "ping") client.send(JSON.stringify({ type: "pong", at: Date.now() }))
    })
    client.on("close", () => {
      clearTimeout(authTimeout)
      this.clients.delete(client)
      this.notifyStatus()
    })
    client.on("error", () => {
      clearTimeout(authTimeout)
      this.clients.delete(client)
      this.notifyStatus()
    })
  }

  private broadcast(event: Record<string, unknown>): void {
    const serialized = JSON.stringify(event)
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(serialized) } catch { /* connection will be removed on close */ }
      }
    }
  }

  private serveStatic(requestPath: string, response: ServerResponse, headOnly = false): void {
    let decoded: string
    try { decoded = decodeURIComponent(requestPath) } catch {
      sendJson(response, 400, { success: false, error: "路径无效" })
      return
    }
    const relative = decoded === "/" || decoded === "/companion" || decoded === "/companion/"
      ? "companion.html"
      : decoded.replace(/^\/+/, "")
    const root = path.resolve(this.deps.getStaticDirectory())
    const target = path.resolve(root, relative)
    const rel = path.relative(root, target)
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      sendJson(response, 403, { success: false, error: "不允许读取该文件" })
      return
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      sendJson(response, 404, { success: false, error: "手机页面资源不存在，请更新应用" })
      return
    }
    const body = fs.readFileSync(target)
    response.writeHead(200, {
      "Content-Type": mimeTypeFor(target),
      "Content-Length": body.length,
      "Cache-Control": target.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws:; frame-ancestors 'none'; base-uri 'self'"
    })
    response.end(headOnly ? undefined : body)
  }
}
