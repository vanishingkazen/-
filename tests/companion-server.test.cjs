/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const Module = require("node:module")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")
const WebSocket = require("ws")

const ROOT = path.resolve(__dirname, "..")
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steamgamecode-companion-test-"))
const staticDirectory = path.join(tempRoot, "mobile")
fs.mkdirSync(path.join(staticDirectory, "assets"), { recursive: true })
fs.writeFileSync(path.join(staticDirectory, "companion.html"), "<!doctype html><title>Companion</title>")
fs.writeFileSync(path.join(staticDirectory, "assets", "companion-test.js"), "console.log('companion')")
const pendingImage = path.join(tempRoot, "pending.png")
const sessionImage = path.join(tempRoot, "attachment.png")
const capturedImage = path.join(tempRoot, "captured.png")
fs.writeFileSync(pendingImage, Buffer.from("pending-image"))
fs.writeFileSync(sessionImage, Buffer.from("session-image"))

const originalLoad = Module._load
const originalTsLoader = require.extensions[".ts"]
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./ConfigHelper" && parent?.filename.endsWith("CompanionServer.ts")) {
    return { configHelper: { hasApiKey: () => true } }
  }
  if (request === "node:os" && parent?.filename.endsWith("CompanionServer.ts")) {
    return { ...os, networkInterfaces: () => ({ en0: [{ family: "IPv4", internal: false, address: "192.168.1.20", netmask: "255.255.255.0" }] }) }
  }
  return originalLoad.call(this, request, parent, isMain)
}
require.extensions[".ts"] = function loadTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8")
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename
  }).outputText
  module._compile(output, filename)
}
const { CompanionServer } = require(path.join(ROOT, "electron", "CompanionServer.ts"))

function request(port, hostHeader, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.rawBody || (options.body === undefined ? null : Buffer.from(JSON.stringify(options.body)))
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method: options.method || "GET",
      headers: {
        Host: hostHeader,
        ...(options.origin ? { Origin: options.origin } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(body ? { "Content-Type": options.contentType || "application/json", "Content-Length": body.length } : {})
      }
    }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => {
        const payload = Buffer.concat(chunks)
        let json = null
        try { json = JSON.parse(payload.toString("utf8")) } catch { /* binary or html response */ }
        resolve({ status: res.statusCode, headers: res.headers, body: payload, json })
      })
    })
    req.on("error", reject)
    if (body) req.write(body)
    req.end()
  })
}

function waitForSocketMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket message timeout")), 2000)
    socket.once("message", (raw) => {
      clearTimeout(timer)
      try { resolve(JSON.parse(String(raw))) } catch (error) { reject(error) }
    })
    socket.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

test("配对、授权访问、截图读取、对话接受、事件推送与撤销", async () => {
  let busy = false
  let sendCall = null
  let finishSend
  const screenshotPaths = [pendingImage]
  let currentSession = {
    id: "session-1",
    title: "会议问答",
    messages: [{
      id: "message-1",
      role: "user",
      content: "请看截图",
      createdAt: new Date().toISOString(),
      status: "completed",
      images: [{ path: sessionImage, mimeType: "image/png", width: 10, height: 10 }]
    }]
  }
  const service = {
    isBusy: () => busy,
    getCurrentSession: () => currentSession,
    listSessions: () => [currentSession],
    getSession: (id) => id === currentSession.id ? currentSession : null,
    resolveAttachmentPath: (_sessionId, _messageId, index) => index === 0 ? sessionImage : null,
    createSession: () => {
      currentSession = { id: "session-2", title: "新对话", messages: [] }
      return currentSession
    },
    selectSession: (id) => id === currentSession.id ? currentSession : null,
    deleteSession: () => false,
    sendMessage: (sessionId, text, images, requestId) => {
      busy = true
      sendCall = { sessionId, text, images, requestId }
      return new Promise((resolve) => { finishSend = (value) => { busy = false; resolve(value) } })
    },
    cancel: () => { busy = false }
  }
  const server = new CompanionServer({
    getChatService: () => service,
    getVoiceRecognitionHelper: () => ({ getLiveSnapshot: () => ({
      system: { state: "listening", message: "", transcript: "会议内容", partialTranscript: "" },
      microphone: { state: "idle", message: "", transcript: "", partialTranscript: "" }
    }) }),
    getScreenshotPaths: () => screenshotPaths,
    takeScreenshot: async () => {
      fs.writeFileSync(capturedImage, Buffer.from("captured-image"))
      screenshotPaths.push(capturedImage)
      return capturedImage
    },
    getImagePreview: async () => "data:image/png;base64,AA==",
    deleteScreenshot: async () => ({ success: true }),
    notifyScreenshotTaken: () => {},
    notifySessionSelected: () => {},
    getStaticDirectory: () => staticDirectory
  })

  let socket
  try {
    await server.start()
    const status = server.getStatus()
    assert.equal(status.running, true)
    assert.equal(status.paired, false)
    const pairingUrl = new URL(status.pairingUrls[0].url)
    const hostHeader = pairingUrl.host
    const origin = pairingUrl.origin
    const port = Number(pairingUrl.port)
    const pairingToken = pairingUrl.hash.slice(1)

    const mobilePage = await request(port, hostHeader, "/companion")
    assert.equal(mobilePage.status, 200)
    assert.match(mobilePage.body.toString(), /<title>Companion<\/title>/)
    const mobileAsset = await request(port, hostHeader, "/assets/companion-test.js")
    assert.equal(mobileAsset.status, 200)
    assert.equal(mobileAsset.body.toString(), "console.log('companion')")

    const wrongPair = await request(port, hostHeader, "/api/pair", {
      method: "POST", origin, body: { token: "incorrect" }
    })
    assert.equal(wrongPair.status, 401)

    const originalNow = Date.now
    try {
      Date.now = () => status.pairingExpiresAt + 1
      const expiredPair = await request(port, hostHeader, "/api/pair", {
        method: "POST", origin, body: { token: pairingToken }
      })
      assert.equal(expiredPair.status, 401)
    } finally {
      Date.now = originalNow
    }
    const refreshedPairing = server.refreshPairing()
    const refreshedUrl = new URL(refreshedPairing.pairingUrls[0].url)
    const refreshedToken = refreshedUrl.hash.slice(1)

    const unpaired = await request(port, hostHeader, "/api/state")
    assert.equal(unpaired.status, 401)

    const pairResult = await request(port, hostHeader, "/api/pair", {
      method: "POST", origin, body: { token: refreshedToken }
    })
    assert.equal(pairResult.status, 200)
    const sessionToken = pairResult.json.token
    assert.ok(sessionToken)
    assert.equal(server.getStatus().paired, true)

    const stateResult = await request(port, hostHeader, "/api/state", { token: sessionToken })
    assert.equal(stateResult.status, 200)
    assert.equal(stateResult.json.state.voice.system.transcript, "会议内容")
    assert.equal(stateResult.json.state.session.messages[0].images[0].url, "/api/session-image/session-1/message-1/0")

    const screenshotResult = await request(port, hostHeader, "/api/screenshot", {
      method: "POST", origin, token: sessionToken, body: {}
    })
    assert.equal(screenshotResult.status, 200)
    assert.equal(screenshotResult.json.state.pendingScreenshots.length, 2)

    const pendingForbidden = await request(port, hostHeader, "/api/pending-image/0")
    assert.equal(pendingForbidden.status, 401)
    const pendingAllowed = await request(port, hostHeader, "/api/pending-image/0", { token: sessionToken })
    assert.equal(pendingAllowed.status, 200)
    assert.equal(pendingAllowed.body.toString(), "pending-image")
    const sessionAllowed = await request(port, hostHeader, "/api/session-image/session-1/message-1/0", { token: sessionToken })
    assert.equal(sessionAllowed.status, 200)
    assert.equal(sessionAllowed.body.toString(), "session-image")
    const sessionTraversal = await request(port, hostHeader, "/api/session-image/session-1/message-1/1", { token: sessionToken })
    assert.equal(sessionTraversal.status, 404)

    const sendResult = await request(port, hostHeader, "/api/chat/send", {
      method: "POST", origin, token: sessionToken, body: { text: "追问", screenshotIds: ["0"] }
    })
    assert.equal(sendResult.status, 202)
    assert.equal(sendResult.json.accepted, true)
    assert.deepEqual(sendCall.images.map((image) => image.path), [pendingImage])
    assert.equal(sendCall.sessionId, "session-1")
    assert.equal(sendCall.text, "追问")
    const busyResult = await request(port, hostHeader, "/api/state", { token: sessionToken })
    assert.equal(busyResult.json.state.busy, true)

    socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`, {
      headers: { Host: hostHeader, Origin: origin }
    })
    await new Promise((resolve, reject) => {
      socket.once("open", resolve)
      socket.once("error", reject)
    })
    socket.send(JSON.stringify({ type: "auth", token: sessionToken }))
    const initialEvent = await waitForSocketMessage(socket)
    assert.equal(initialEvent.type, "snapshot")
    const pushedEventPromise = waitForSocketMessage(socket)
    server.publish("chat-stream", { requestId: "reply-1", sessionId: "session-1", content: "回答进行中", done: false })
    const pushedEvent = await pushedEventPromise
    assert.equal(pushedEvent.type, "chat-stream")
    assert.equal(pushedEvent.data.content, "回答进行中")

    finishSend({ success: true, content: "回答" })
    server.disconnectPhone()
    const revoked = await request(port, hostHeader, "/api/state", { token: sessionToken })
    assert.equal(revoked.status, 401)
    assert.equal(server.getStatus().paired, false)
    assert.ok(server.getStatus().pairingUrls?.length)
  } finally {
    finishSend?.({ success: false })
    socket?.close()
    await server.stop()
  }
})


test("手机相机：遥控拍照入队、重复上传去重、会话切换拒绝、断开取消", async () => {
  let context = "session-1:queue:0"
  let imports = 0
  const session = { id: "session-1", title: "Camera", messages: [] }
  const server = new CompanionServer({
    getCaptureContext: () => context,
    importCameraPhoto: async (_buffer, isValid) => {
      assert.equal(isValid(), true)
      imports += 1
      return capturedImage
    },
    getChatService: () => ({ isBusy: () => false, getCurrentSession: () => session, listSessions: () => [session] }),
    getVoiceRecognitionHelper: () => null,
    getScreenshotPaths: () => [],
    takeScreenshot: async () => capturedImage,
    getImagePreview: async () => "data:image/png;base64,AA==",
    deleteScreenshot: async () => ({ success: true }),
    notifyScreenshotTaken: () => {},
    notifySessionSelected: () => {},
    getStaticDirectory: () => staticDirectory
  })
  let socket
  try {
    await server.start()
    const pairing = new URL(server.getStatus().pairingUrls[0].url)
    const port = Number(pairing.port)
    const origin = pairing.origin
    const host = pairing.host
    const pair = await request(port, host, "/api/pair", { method: "POST", origin, body: { token: pairing.hash.slice(1) } })
    const token = pair.json.token
    await assert.rejects(server.takePhonePhoto(), /未就绪/)
    socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { headers: { Host: host, Origin: origin } })
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject) })
    const snapshot = waitForSocketMessage(socket)
    socket.send(JSON.stringify({ type: "auth", token }))
    await snapshot
    const ready = new Promise((resolve) => server.onStatusChange((status) => { if (status.cameraReady) resolve() }))
    socket.send(JSON.stringify({ type: "camera.ready", ready: true }))
    await ready
    server.setCaptureSource("phone")
    assert.equal(server.usesPhoneCamera(), true)
    assert.throws(() => server.setCaptureSource("invalid"), /无效/)

    const commandPromise = waitForSocketMessage(socket)
    const capture = server.takePhonePhoto()
    const command = await commandPromise
    assert.equal(command.type, "capture.request")
    const uploadOptions = { method: "POST", origin, token, contentType: "image/jpeg", rawBody: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }
    const path = `/api/camera/photo/${command.requestId}`
    const unauthorized = await request(port, host, path, { ...uploadOptions, token: "wrong" })
    assert.equal(unauthorized.status, 401)
    const uploaded = await request(port, host, path, uploadOptions)
    assert.equal(uploaded.status, 200)
    assert.equal(await capture, capturedImage)
    assert.equal(imports, 1)
    assert.equal((await request(port, host, path, uploadOptions)).status, 200)
    assert.equal(imports, 1)

    const local = await request(port, host, "/api/camera/request", { method: "POST", origin, token, body: {} })
    assert.equal(local.status, 200)
    assert.equal((await request(port, host, "/api/camera/request", { method: "POST", origin, token, body: {} })).status, 409)
    context = "session-2:queue:0"
    const stale = await request(port, host, `/api/camera/photo/${local.json.requestId}`, uploadOptions)
    assert.equal(stale.status, 409)
    assert.equal(imports, 1)

    // Drain the refresh event before waiting for the next command.
    const requestStarted = new Promise((resolve) => {
      const listener = (raw) => {
        const message = JSON.parse(String(raw))
        if (message.type === "capture.request") { socket.off("message", listener); resolve(message) }
      }
      socket.on("message", listener)
    })
    const cancelled = server.takePhonePhoto()
    const rejected = assert.rejects(cancelled, /连接已关闭/)
    await requestStarted
    server.disconnectPhone()
    await rejected
    assert.equal(server.getStatus().cameraReady, false)
  } finally {
    socket?.terminate()
    await server.stop()
  }
})

test("手机相机请求超时后可以重试", async (t) => {
  const { PhoneCameraRequests } = require(path.join(ROOT, "electron/capture/PhoneCameraRequests.ts"))
  const requests = new PhoneCameraRequests()
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const first = requests.start("session-1")
  assert.equal(requests.isValid(first.id, "session-2"), false)
  const rejected = assert.rejects(first.result, /超时/)
  t.mock.timers.tick(30_001)
  await rejected
  const second = requests.start("session-2")
  requests.beginUpload(second.id, "session-2")
  assert.throws(() => requests.beginUpload(second.id, "session-2"), /正在上传/)
  requests.finish(second.id, "photo.png")
  assert.equal(await second.result, "photo.png")
  assert.equal(requests.completedPath(second.id), "photo.png")
  requests.cancel()
  assert.equal(requests.completedPath(second.id), undefined)
})


test.after(() => {
  Module._load = originalLoad
  if (originalTsLoader) require.extensions[".ts"] = originalTsLoader
  else delete require.extensions[".ts"]
  fs.rmSync(tempRoot, { recursive: true, force: true })
})
