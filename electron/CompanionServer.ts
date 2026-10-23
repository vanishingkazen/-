import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { networkInterfaces } from "node:os"
import fs from "node:fs"
import path from "node:path"
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { WebSocket, WebSocketServer } from "ws"
import { PhoneCameraRequests } from "./capture/PhoneCameraRequests"
import { configHelper } from "./ConfigHelper"
import type { ChatAttachment, ChatService } from "./ChatService"
import type { VoiceRecognitionHelper } from "./VoiceRecognitionHelper"
import type { CompanionImage, CompanionMessage, CompanionSessionSummary, CompanionSnapshot, CompanionStatus, PeripheralRole, PeripheralStatus } from "./CompanionTypes"

const PAIRING_TTL_MS = 2 * 60 * 1000
const MAX_JSON_BODY_BYTES = 64 * 1024
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

export interface CompanionServerDeps {
  takeDesktopScreenshot?: () => Promise<string>
  importCameraPhoto?: (buffer: Buffer, isValid: () => boolean) => Promise<string>
  getCaptureContext?: () => string
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
  private captureSource: "screen" | "phone" = "screen"
  private cameraClient: WebSocket | null = null
  private cameraReady = false
  private readonly cameraRequests = new PhoneCameraRequests()
  private readonly deps: CompanionServerDeps
  private server: Server | null = null
  private sockets: WebSocketServer | null = null
  private clients = new Set<WebSocket>()
  private pairings: Record<PeripheralRole, PairingState | null> = { display: null, camera: null }
  private clientRoles = new Map<WebSocket, PeripheralRole>()
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

  private peripheralStatus(role: PeripheralRole): PeripheralStatus {
    const pairing = this.pairings[role]
    return {
      paired: Boolean(pairing?.sessionToken),
      connected: [...this.clients].some((client) => this.clientRoles.get(client) === role && client.readyState === WebSocket.OPEN),
      ...(!pairing?.sessionToken && pairing ? {
        pairingExpiresAt: pairing.expiresAt,
        pairingUrls: this.addresses.map(({ label, url }) => ({
          label,
          url: `${url}${role === "camera" ? "?role=camera" : ""}#${pairing.pairingToken}`
        }))
      } : {})
    }
  }

  public getStatus(): CompanionStatus {
    const display = this.peripheralStatus("display")
    return {
      // Legacy paired/connected fields describe the web display, including overlay policy.
      ...display,
      display,
      camera: this.peripheralStatus("camera"),
      captureSource: this.captureSource,
      cameraReady: this.cameraReady && this.cameraClient?.readyState === WebSocket.OPEN,
      running: Boolean(this.server),
      addresses: this.addresses
    }
  }

  private cameraSnapshot(): Record<string, unknown> {
    return {
      pendingCount: this.deps.getScreenshotPaths().length,
      captureSource: this.captureSource,
      cameraReady: this.cameraReady && this.cameraClient?.readyState === WebSocket.OPEN
    }
  }

  private checkedRole(role: unknown): PeripheralRole {
    if (role !== "display" && role !== "camera") throw new Error("无效的外设类型")
    return role
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
    this.createPairingToken("display")
    this.createPairingToken("camera")
    this.notifyStatus()
    return this.getStatus()
  }

  public setCaptureSource(source: unknown): CompanionStatus {
    if (source !== "screen" && source !== "phone") throw new Error("无效的图片来源")
    this.captureSource = source
    this.broadcast({ type: "refresh" })
    this.notifyStatus()
    return this.getStatus()
  }

  public usesPhoneCamera(): boolean { return this.captureSource === "phone" }

  private captureContext(): string {
    return this.deps.getCaptureContext?.() || this.deps.getChatService()?.getCurrentSession().id || ""
  }

  public async takePhonePhoto(): Promise<string> {
    if (!this.cameraReady || this.cameraClient?.readyState !== WebSocket.OPEN) {
      throw new Error("手机相机未就绪，请打开 iOS App 并保持在前台，或切换为电脑截图")
    }
    const request = this.cameraRequests.start(this.captureContext())
    try {
      this.cameraClient.send(JSON.stringify({ type: "capture.request", requestId: request.id, expiresAt: request.expiresAt }))
    } catch {
      this.cameraRequests.fail(request.id, "无法发送拍照指令")
    }
    return request.result
  }

  public refreshPairing(value: unknown = "display"): CompanionStatus {
    const role = this.checkedRole(value)
    if (!this.server) throw new Error("局域网外设服务尚未启动")
    if (this.pairings[role]?.sessionToken) throw new Error("该外设已配对，请先断开再重新配对")
    this.createPairingToken(role)
    this.notifyStatus()
    return this.getStatus()
  }

  public disconnectPhone(value: unknown = "display"): CompanionStatus {
    const role = this.checkedRole(value)
    this.pairings[role] = null
    if (role === "camera") {
      this.cameraRequests.cancel()
      this.cameraClient = null
      this.cameraReady = false
    }
    for (const client of this.clients) {
      if (this.clientRoles.get(client) !== role) continue
      this.clients.delete(client)
      this.clientRoles.delete(client)
      try { client.close(4001, "Pairing revoked") } catch { /* already closed */ }
    }
    if (this.server) this.createPairingToken(role)
    this.notifyStatus()
    this.broadcast({ type: "refresh" })
    return this.getStatus()
  }

  public async stop(): Promise<CompanionStatus> {
    const sockets = this.sockets
    const server = this.server
    this.pairings = { display: null, camera: null }
    this.clientRoles.clear()
    this.cameraRequests.cancel()
    this.cameraClient = null
    this.cameraReady = false
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
    if (!this.pairings.display?.sessionToken && !this.pairings.camera?.sessionToken) return
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

  private createPairingToken(role: PeripheralRole): void {
    this.pairings[role] = {
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

  private tokenRole(token: string): PeripheralRole | null {
    for (const role of ["display", "camera"] as const) {
      const expected = this.pairings[role]?.sessionToken
      if (expected && safeEqual(token, expected)) return role
    }
    return null
  }

  private authorizedRole(request: IncomingMessage): PeripheralRole | null {
    const auth = request.headers.authorization
    return typeof auth === "string" && auth.startsWith("Bearer ") ? this.tokenRole(auth.slice(7)) : null
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
      const role = body.role === undefined ? "display" : body.role
      if (role !== "display" && role !== "camera") {
        sendJson(response, 400, { success: false, error: "无效的外设类型" })
        return
      }
      const pairing = this.pairings[role]
      if (!pairing || pairing.sessionToken || Date.now() > pairing.expiresAt || !safeEqual(token, pairing.pairingToken)) {
        sendJson(response, 401, { success: false, error: "配对码已失效或类型不匹配，请使用对应外设的二维码" })
        return
      }
      pairing.sessionToken = randomToken()
      pairing.pairingToken = ""
      sendJson(response, 200, { success: true, token: pairing.sessionToken, role })
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
      const role = this.authorizedRole(request)
      if (!originAllowed || !role) {
        sendJson(response, 401, { success: false, error: "手机尚未配对或授权已撤销" })
        return
      }
      const cameraRoute = requestUrl.pathname.startsWith("/api/camera/")
      if ((role === "camera") !== cameraRoute) {
        sendJson(response, 403, { success: false, error: "该外设无权访问此功能" })
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
    if (method === "GET" && url.pathname === "/api/camera/state") {
      sendJson(response, 200, { success: true, state: this.cameraSnapshot() })
      return
    }
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

    if (url.pathname === "/api/camera/request") {
      if (!this.cameraReady || !this.cameraClient || !this.deps.importCameraPhoto) {
        sendJson(response, 409, { success: false, error: "手机相机未就绪" })
        return
      }
      try {
        const capture = this.cameraRequests.start(this.captureContext())
        sendJson(response, 200, { success: true, requestId: capture.id, expiresAt: capture.expiresAt })
      } catch (error) {
        sendJson(response, 409, { success: false, error: error instanceof Error ? error.message : "无法拍照" })
      }
      return
    }
    const photoMatch = url.pathname.match(/^\/api\/camera\/photo\/([a-f0-9-]{36})$/)
    if (photoMatch) {
      const id = photoMatch[1]
      if (this.cameraRequests.completedPath(id)) {
        request.resume()
        sendJson(response, 200, { success: true })
        return
      }
      if (this.cameraRequests.isUploading(id)) {
        request.resume()
        sendJson(response, 409, { success: false, error: "该照片正在上传" })
        return
      }
      try {
        if (!this.deps.importCameraPhoto || request.headers["content-type"] !== "image/jpeg") throw new Error("仅支持 JPEG 照片")
        const context = this.captureContext()
        this.cameraRequests.beginUpload(id, context)
        const auth = request.headers.authorization
        const valid = () => this.cameraRequests.isValid(id, this.captureContext()) && context === this.captureContext() && auth === `Bearer ${this.pairings.camera?.sessionToken}`
        const buffer = await new Promise<Buffer>((resolve, reject) => {
          request.setTimeout(15_000, () => request.destroy(new Error("照片上传超时")))
          const chunks: Buffer[] = []
          let size = 0
          request.on("data", (chunk: Buffer) => {
            size += chunk.length
            if (size > 8 * 1024 * 1024) { reject(new Error("照片超过 8MB")); request.destroy(); return }
            chunks.push(chunk)
          })
          request.on("end", () => resolve(Buffer.concat(chunks)))
          request.on("error", reject)
          request.on("aborted", () => reject(new Error("照片上传中断")))
        })
        if (!valid()) throw new Error("拍照请求已失效")
        const filepath = await this.deps.importCameraPhoto(buffer, valid)
        this.cameraRequests.finish(id, filepath)
        const preview = await this.deps.getImagePreview(filepath)
        this.deps.notifyScreenshotTaken(filepath, preview)
        this.broadcast({ type: "refresh" })
        sendJson(response, 200, { success: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : "照片上传失败"
        this.cameraRequests.fail(id, message)
        request.resume()
        if (!response.destroyed) sendJson(response, 409, { success: false, error: message })
      }
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
        case "/api/capture":
        case "/api/screenshot": {
          const capture = url.pathname === "/api/capture" ? this.deps.takeScreenshot : (this.deps.takeDesktopScreenshot || this.deps.takeScreenshot)
          const screenshotPath = await capture()
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
      captureSource: this.captureSource,
      cameraReady: this.cameraReady && this.cameraClient?.readyState === WebSocket.OPEN,
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
    const cleanup = () => {
      clearTimeout(authTimeout)
      if (this.cameraClient === client) {
        this.cameraClient = null
        this.cameraReady = false
        this.cameraRequests.cancel()
      }
      this.clients.delete(client)
      this.clientRoles.delete(client)
      this.notifyStatus()
      this.broadcast({ type: "refresh" })
    }
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
      const role = typeof payload.token === "string" ? this.tokenRole(payload.token) : null
      if (payload.type !== "auth" || !role || (payload.role !== undefined && payload.role !== role)) {
        client.close(4003, "Unauthorized")
        return
      }
      authenticated = true
      clearTimeout(authTimeout)
      // A reconnect replaces only the same peripheral role.
      for (const other of this.clients) {
        if (this.clientRoles.get(other) !== role) continue
        this.clients.delete(other)
        this.clientRoles.delete(other)
        other.close(4001, "Replaced by reconnect")
      }
      if (role === "camera") {
        this.cameraRequests.cancel()
        this.cameraClient = client
        this.cameraReady = false
      }
      this.clients.add(client)
      this.clientRoles.set(client, role)
      try {
        const event = role === "camera"
          ? { type: "camera.snapshot", state: this.cameraSnapshot() }
          : { type: "snapshot", state: await this.getSnapshot() }
        if (client.readyState !== WebSocket.OPEN || this.clientRoles.get(client) !== role) return
        client.send(JSON.stringify(event))
      } catch {
        client.close(1011, "Unable to load peripheral state")
        cleanup()
        return
      }
      this.notifyStatus()
    })
    client.on("message", (raw) => {
      if (!authenticated || !this.clientRoles.has(client)) return
      let payload: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(String(raw))
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
        payload = parsed as Record<string, unknown>
      } catch { return }
      if (payload.type === "camera.ready" && this.clientRoles.get(client) === "camera") {
        const ready = payload.ready === true
        const changed = ready !== this.cameraReady
        this.cameraReady = ready
        if (!ready) this.cameraRequests.cancel()
        this.notifyStatus()
        if (changed) this.broadcast({ type: "refresh" })
      }
      if (payload.type === "capture.failed" && client === this.cameraClient && typeof payload.requestId === "string") {
        this.cameraRequests.fail(payload.requestId, "相机拍摄失败，请检查权限并重试")
      }
      if (payload.type === "ping") client.send(JSON.stringify({ type: "pong", at: Date.now() }))
    })
    client.on("close", cleanup)
    client.on("error", () => { cleanup(); client.terminate() })
  }

  private broadcast(event: Record<string, unknown>): void {
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue
      const role = this.clientRoles.get(client)
      if (role === "camera" && event.type !== "refresh") continue
      const value = role === "camera" ? { type: "camera.snapshot", state: this.cameraSnapshot() } : event
      try { client.send(JSON.stringify(value)) } catch { /* removed on close */ }
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
