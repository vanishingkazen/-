/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const Module = require("node:module")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

// This file intentionally has its own Electron/provider mocks so it can run in isolation.
const ROOT = path.resolve(__dirname, "..")
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steamgamecode-chat-stability-"))
const appDataPath = path.join(tempRoot, "appData")
const sessionFile = path.join(appDataPath, "steamgamecode", "chat-sessions.json")
const attachmentRoot = path.join(appDataPath, "steamgamecode", "chat-attachments")

let openAICalls = []
let openAIResponder = defaultOpenAIResponder
let anthropicCalls = []
let anthropicResponder = defaultAnthropicResponder
let axiosCalls = []
let axiosResponder = defaultAxiosResponder

const ipcHandlers = new Map()
const electronMock = {
  app: {
    getPath(name) {
      if (name !== "appData") throw new Error(`Unexpected app path: ${name}`)
      return appDataPath
    }
  },
  BrowserWindow: class BrowserWindow {},
  ipcMain: {
    handle(channel, handler) {
      ipcHandlers.set(channel, handler)
    }
  },
  clipboard: { writeText() {} },
  shell: { openExternal: async () => {}, openPath: async () => "" }
}

function completion(content) {
  return { choices: [{ message: { content } }] }
}

function textFromMessage(message) {
  if (!message) return ""
  if (typeof message.content === "string") return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("\n")
  }
  return ""
}

async function defaultOpenAIResponder(body) {
  if (String(body.messages?.[0]?.content || "").includes("请压缩下面的对话")) {
    return completion("稳定性测试摘要")
  }
  if (body.stream) {
    return (async function* streamReply() {
      yield { choices: [{ delta: { content: "流式" } }] }
      yield { choices: [{ delta: { content: "回复" } }] }
    })()
  }
  return completion(`回复：${textFromMessage(body.messages?.at(-1))}`)
}

async function defaultAnthropicResponder(body) {
  if (String(body.system || "").includes("请压缩下面的对话")) {
    return { content: [{ type: "text", text: "Anthropic 稳定性摘要" }] }
  }
  return { content: [{ type: "text", text: `Anthropic 回复：${textFromMessage(body.messages?.at(-1))}` }] }
}

async function defaultAxiosResponder(url, body) {
  if (url.includes(":streamGenerateContent")) {
    return { data: { candidates: [{ content: { parts: [{ text: "Gemini 流式回复" }] } }] } }
  }
  return {
    data: {
      candidates: [{ content: { parts: [{ text: `Gemini 回复：${body.contents?.[0]?.parts?.[0]?.text || ""}` }] } }]
    }
  }
}

class MockOpenAI {
  constructor(options) {
    this.options = options
    this.chat = {
      completions: {
        create: async (body, requestOptions = {}) => {
          openAICalls.push({ body, requestOptions, clientOptions: options })
          return openAIResponder(body, requestOptions)
        }
      }
    }
  }
}

class MockAnthropic {
  constructor(options) {
    this.options = options
    this.messages = {
      create: async (body, requestOptions = {}) => {
        anthropicCalls.push({ body, requestOptions, clientOptions: options })
        return anthropicResponder(body, requestOptions)
      }
    }
  }
}

const axiosMock = {
  default: {
    post: async (url, body, options = {}) => {
      axiosCalls.push({ url, body, options })
      return axiosResponder(url, body, options)
    }
  },
  post: async (url, body, options = {}) => {
    axiosCalls.push({ url, body, options })
    return axiosResponder(url, body, options)
  }
}

const originalLoad = Module._load
const originalTsLoader = require.extensions[".ts"]
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return electronMock
  if (request === "openai") return { OpenAI: MockOpenAI }
  if (request === "@anthropic-ai/sdk") return MockAnthropic
  if (request === "axios") return axiosMock
  return originalLoad.call(this, request, parent, isMain)
}
require.extensions[".ts"] = function loadTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8")
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      strict: false
    },
    fileName: filename
  }).outputText
  module._compile(output, filename)
}

const { ChatService } = require(path.join(ROOT, "electron", "ChatService.ts"))
const { configHelper } = require(path.join(ROOT, "electron", "ConfigHelper.ts"))
const { initializeIpcHandlers } = require(path.join(ROOT, "electron", "ipcHandlers.ts"))

function defaultConfig() {
  return {
    ...configHelper.loadConfig(),
    language: "auto",
    languageDetectionSource: "auto",
    apiProvider: "openai-compatible",
    apiKey: "test-api-key",
    baseURL: "https://chat.example.test/v1",
    extractionModel: "test-chat-model",
    solutionModel: "test-chat-model",
    streamingEnabled: false,
    maxOutputTokens: 1024,
    contextMessageLimit: 30,
    contextWindowTokens: 128000
  }
}

function setup(overrides = {}) {
  fs.rmSync(sessionFile, { force: true })
  fs.rmSync(attachmentRoot, { recursive: true, force: true })
  configHelper.saveConfig({ ...defaultConfig(), ...overrides })
  openAICalls = []
  anthropicCalls = []
  axiosCalls = []
  openAIResponder = defaultOpenAIResponder
  anthropicResponder = defaultAnthropicResponder
  axiosResponder = defaultAxiosResponder

  const events = []
  const mainWindow = {
    isDestroyed: () => false,
    webContents: {
      send(channel, payload) {
        events.push({ channel, payload })
      }
    }
  }
  const service = new ChatService({ getMainWindow: () => mainWindow })
  return { service, events, mainWindow }
}

function configure(overrides = {}) {
  configHelper.saveConfig({ ...defaultConfig(), ...overrides })
}

function pngFile(name, content = "89504e470d0a1a0a") {
  const filePath = path.join(tempRoot, name)
  fs.writeFileSync(filePath, Buffer.from(content, "hex"))
  return filePath
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail("等待异步条件超时")
}

function ipcDeps(service, mainWindow, overrides = {}) {
  let view = "queue"
  const state = { clearQueues: 0, setView: [], cancelRequests: 0 }
  const deps = {
    getMainWindow: () => mainWindow,
    setWindowDimensions: () => {},
    getScreenshotQueue: () => [],
    getExtraScreenshotQueue: () => [],
    deleteScreenshot: async () => ({ success: true }),
    getImagePreview: async () => "preview",
    processingHelper: {
      cancelOngoingRequests: () => { state.cancelRequests += 1 },
      setCurrentBasicCode: () => {},
      processScreenshots: async () => {}
    },
    chatService: service,
    voiceRecognitionHelper: null,
    PROCESSING_EVENTS: { API_KEY_INVALID: "api-key-invalid" },
    takeScreenshot: async () => pngFile(`screenshot-${Date.now()}.png`),
    getView: () => view,
    toggleMainWindow: () => {},
    clearQueues: () => { state.clearQueues += 1 },
    setView: (nextView) => { view = nextView; state.setView.push(nextView) },
    setProblemInfo: () => {},
    moveWindowLeft: () => {},
    moveWindowRight: () => {},
    moveWindowUp: () => {},
    moveWindowDown: () => {},
    ...overrides
  }
  initializeIpcHandlers(deps)
  return { state, deps }
}

function invoke(channel, payload) {
  const handler = ipcHandlers.get(channel)
  assert.ok(handler, `IPC handler not registered: ${channel}`)
  return handler({}, payload)
}

function eventFor(events, channel, requestId) {
  return events.find((event) => event.channel === channel && event.payload?.requestId === requestId)
}

test.after(() => {
  Module._load = originalLoad
  if (originalTsLoader) require.extensions[".ts"] = originalTsLoader
  else delete require.extensions[".ts"]
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test("会话切换、删除和 reset 始终保持当前会话可用", () => {
  const { service } = setup()
  const first = service.createSession({ title: "第一会话" })
  const second = service.createSession({ title: "第二会话" })

  assert.equal(service.selectSession(first.id).id, first.id)
  assert.equal(service.deleteSession(first.id), true)
  assert.equal(service.getCurrentSession().id, second.id)
  assert.equal(service.deleteSession(second.id), true)
  assert.ok(service.getCurrentSession().id)

  const beforeReset = service.getCurrentSession()
  const reset = service.resetCurrentSession()
  assert.notEqual(reset.id, beforeReset.id)
  assert.equal(reset.messages.length, 0)
  assert.equal(service.getSession(beforeReset.id)?.id, beforeReset.id)
})

test("持久化重启兼容新版对象、旧版数组和当前会话指针", () => {
  configure()
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
  const legacyMessage = {
    id: "legacy-user",
    role: "user",
    content: "旧格式消息",
    images: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "completed"
  }
  fs.writeFileSync(sessionFile, JSON.stringify([
    {
      id: "legacy-a",
      title: "旧 A",
      messages: [legacyMessage, { role: "invalid", content: "丢弃" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z"
    },
    {
      id: "legacy-b",
      title: "旧 B",
      messages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:01.000Z"
    }
  ]))

  let service = new ChatService({ getMainWindow: () => ({ webContents: { send() {} } }) })
  assert.equal(service.getCurrentSession().id, "legacy-b")
  assert.equal(service.getSession("legacy-a").messages.length, 1)

  fs.writeFileSync(sessionFile, JSON.stringify({
    version: 1,
    currentSessionId: "legacy-a",
    sessions: service.listSessions()
  }))
  service = new ChatService({ getMainWindow: () => ({ webContents: { send() {} } }) })
  assert.equal(service.getCurrentSession().id, "legacy-a")
})

test("会话附件复制后可跨源文件删除和服务重启继续使用", async () => {
  const { service } = setup()
  const session = service.createSession()
  const source = pngFile("stability-source.png", "89504e470d0a1a0a112233")

  const result = await service.sendMessage(session.id, "请记住这张截图", [{ path: source, preview: "p" }], "image-1")
  assert.equal(result.success, true)
  const stored = service.getSession(session.id).messages[0].images[0].path
  assert.notEqual(stored, source)
  assert.equal(fs.existsSync(stored), true)

  fs.rmSync(source)
  let restarted = new ChatService({ getMainWindow: () => ({ webContents: { send() {} } }) })
  assert.equal(fs.existsSync(restarted.getSession(session.id).messages[0].images[0].path), true)

  const followUp = await restarted.sendMessage(session.id, "继续分析刚才的图", [], "image-2")
  assert.equal(followUp.success, true)
  const historicImageMessage = openAICalls.at(-1).body.messages.find((message) => Array.isArray(message.content))
  assert.equal(historicImageMessage.content.filter((part) => part.type === "image_url").length, 1)
})

test("并发请求只允许一个请求，恢复后可继续同一会话", async () => {
  const { service } = setup()
  const session = service.createSession()
  const otherSession = service.createSession()
  const gate = deferred()
  openAIResponder = async (_body, { signal }) => {
    const abortPromise = new Promise((_, reject) => signal.addEventListener("abort", () => {
      const error = new Error("request aborted")
      error.name = "AbortError"
      reject(error)
    }, { once: true }))
    return Promise.race([gate.promise.then(() => completion("第一条完成")), abortPromise])
  }

  const first = service.sendMessage(session.id, "第一条", [], "concurrent-1")
  await waitFor(() => openAICalls.length === 1)
  const second = await service.sendMessage(session.id, "第二条", [], "concurrent-2")
  assert.deepEqual(second, { success: false, error: "上一条消息仍在处理中，请稍后重试" })
  assert.equal(service.selectSession(otherSession.id), null)
  assert.equal(service.deleteSession(otherSession.id), false)
  gate.resolve()
  assert.equal((await first).success, true)
  assert.deepEqual(service.getSession(session.id).messages.map((message) => message.content), ["第一条", "第一条完成"])
})

test("取消会产生可恢复的错误消息，不会让后续请求永久阻塞", async () => {
  const { service, events } = setup()
  const session = service.createSession()
  openAIResponder = async (_body, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => {
      const error = new Error("上游取消")
      error.name = "AbortError"
      reject(error)
    }, { once: true })
  })

  const pending = service.sendMessage(session.id, "待取消", [], "cancel-1")
  await waitFor(() => openAICalls.length === 1)
  service.cancel()
  const cancelled = await pending
  assert.equal(cancelled.success, false)
  assert.equal(service.getSession(session.id).messages.at(-1).status, "error")
  assert.ok(eventFor(events, "chat-error", "cancel-1"))

  openAIResponder = defaultOpenAIResponder
  const recovered = await service.sendMessage(session.id, "取消后恢复", [], "cancel-2")
  assert.equal(recovered.success, true)
})

test("reset 后旧请求的错误事件和消息仍绑定旧 sessionId", async () => {
  const { service, events } = setup()
  const oldSession = service.createSession({ title: "旧会话" })
  const gate = deferred()
  openAIResponder = async (_body, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      const error = new Error("reset cancelled")
      error.name = "AbortError"
      reject(error)
    }, { once: true })
    gate.promise.then(() => resolve(completion("不应污染新会话")))
  })

  const pending = service.sendMessage(oldSession.id, "旧请求", [], "old-request")
  await waitFor(() => openAICalls.length === 1)
  service.cancel()
  const newSession = service.resetCurrentSession()
  const oldResult = await pending
  assert.equal(oldResult.success, false)
  assert.equal(service.getCurrentSession().id, newSession.id)
  assert.equal(service.getSession(newSession.id).messages.length, 0)
  assert.equal(eventFor(events, "chat-error", "old-request").payload.sessionId, oldSession.id)
  assert.equal(events.some((event) => event.payload?.requestId === "old-request" && event.payload.sessionId === newSession.id), false)
})

test("错误恢复后成功事件携带完整且一致的 sessionId/requestId", async () => {
  const { service, events } = setup()
  const session = service.createSession()
  let shouldFail = true
  openAIResponder = async (body) => {
    if (shouldFail) throw new Error("provider temporarily unavailable")
    return defaultOpenAIResponder(body)
  }

  const failed = await service.sendMessage(session.id, "第一次失败", [], "recover-1")
  assert.equal(failed.success, false)
  assert.equal(eventFor(events, "chat-error", "recover-1").payload.sessionId, session.id)
  shouldFail = false
  const succeeded = await service.sendMessage(session.id, "第二次成功", [], "recover-2")
  assert.equal(succeeded.success, true)
  assert.equal(eventFor(events, "chat-success", "recover-2").payload.sessionId, session.id)
  assert.equal(eventFor(events, "chat-success", "recover-2").payload.session.id, session.id)
  assert.equal(service.getSession(session.id).messages.at(-1).status, "completed")
})

test("上下文压缩成功时保存摘要并保留最近历史", async () => {
  const { service, events } = setup({ contextMessageLimit: 4, contextWindowTokens: 8192 })
  const session = service.createSession()
  const longText = "上下文稳定性。".repeat(1800)
  for (let index = 1; index <= 4; index += 1) {
    const result = await service.sendMessage(session.id, `${longText}-${index}`, [], `summary-${index}`)
    assert.equal(result.success, true)
  }
  assert.equal(service.getSession(session.id).summary, "稳定性测试摘要")
  assert.equal(events.filter((event) => event.channel === "chat-context-compressed").length > 0, true)
  assert.equal(events.filter((event) => event.channel === "chat-context-compressed").every((event) => event.payload.sessionId === session.id), true)
  assert.ok(openAICalls.some((call) => String(call.body.messages?.[0]?.content || "").includes("请压缩下面的对话")))
})

test("上下文压缩返回空摘要或抛错时不丢失原始历史", async () => {
  const { service } = setup({ contextMessageLimit: 4, contextWindowTokens: 8192 })
  const session = service.createSession()
  const original = "必须保留的历史".repeat(1000)
  let summaryMode = "empty"
  openAIResponder = async (body) => {
    if (String(body.messages?.[0]?.content || "").includes("请压缩下面的对话")) {
      if (summaryMode === "throw") throw new Error("summary down")
      return completion("")
    }
    return completion("正常回复")
  }
  await service.sendMessage(session.id, original, [], "summary-fail-1")
  await service.sendMessage(session.id, "第二条", [], "summary-fail-2")
  assert.ok(service.getSession(session.id).messages.some((message) => message.content === original))
  assert.equal(service.getSession(session.id).summary, "")

  summaryMode = "throw"
  await service.sendMessage(session.id, "第三条", [], "summary-fail-3")
  assert.ok(service.getSession(session.id).messages.some((message) => message.content === original))
})

test("超长单条消息只截断模型上下文，不截断本地会话", async () => {
  const { service } = setup({ contextWindowTokens: 8192, maxOutputTokens: 1024 })
  const session = service.createSession()
  const longText = "单条超长消息。".repeat(12000)
  const result = await service.sendMessage(session.id, longText, [], "long-one")
  assert.equal(result.success, true)
  assert.equal(service.getSession(session.id).messages[0].content, longText)
  const requestedText = textFromMessage(openAICalls.at(-1).body.messages.at(-1))
  assert.ok(requestedText.length < longText.length)
  assert.match(requestedText, /内容过长，已截断/)
})

test("provider、流式事件和请求标识不会串到其他会话", async () => {
  const { service, events } = setup({ streamingEnabled: true })
  const first = service.createSession({ title: "A" })
  const second = service.createSession({ title: "B" })
  const result = await service.sendMessage(first.id, "A 请求", [], "request-A")
  assert.equal(result.success, true)
  const secondResult = await service.sendMessage(second.id, "B 请求", [], "request-B")
  assert.equal(secondResult.success, true)

  for (const requestId of ["request-A", "request-B"]) {
    const requestEvents = events.filter((event) => event.payload?.requestId === requestId)
    assert.ok(requestEvents.length > 0)
    const expectedSessionId = requestId === "request-A" ? first.id : second.id
    assert.equal(requestEvents.every((event) => event.payload.sessionId === expectedSessionId), true)
  }
  assert.equal(events.some((event) => event.payload?.requestId === "request-A" && event.payload.sessionId === second.id), false)
})

test("非法输入返回结构化错误且不污染会话或上游调用", async () => {
  const { service } = setup()
  const session = service.createSession()
  assert.deepEqual(await service.sendMessage("missing", "消息", [], "bad-session"), { success: false, error: "会话不存在" })
  assert.deepEqual(await service.sendMessage(session.id, "   ", [], "empty"), { success: false, error: "消息不能为空" })
  assert.deepEqual(await service.sendMessage(session.id, "消息", undefined, "bad-images"), { success: true, content: "回复：消息" })
  assert.deepEqual(await service.sendMessage(session.id, "消息", [], ""), { success: false, error: "请求标识无效" })
  assert.equal(openAICalls.length, 1)
  assert.equal(service.getSession(session.id).messages.filter((message) => message.role === "user").length, 1)

  const noWindow = new ChatService({ getMainWindow: () => null })
  const noWindowSession = noWindow.createSession()
  assert.deepEqual(await noWindow.sendMessage(noWindowSession.id, "消息", [], "no-window"), { success: false, error: "主窗口不可用" })
})

test("IPC chat handlers 校验参数、尊重显式 sessionId 并支持切换删除", async () => {
  const { service, mainWindow } = setup()
  const first = service.createSession({ title: "first" })
  const second = service.createSession({ title: "second" })
  ipcDeps(service, mainWindow)

  assert.deepEqual(await invoke("chat-send-message"), { success: false, error: "请求参数无效" })
  assert.deepEqual(await invoke("chat-send-message", { requestId: "", sessionId: first.id, text: "x" }), { success: false, error: "请求标识无效" })
  assert.equal((await invoke("chat-select-session", first.id)).id, first.id)
  const sent = await invoke("chat-send-message", { requestId: "ipc-1", sessionId: second.id, text: "显式会话" })
  assert.equal(sent.success, true)
  assert.equal(service.getSession(second.id).messages.some((message) => message.content === "显式会话"), true)
  assert.equal(service.getCurrentSession().id, first.id)

  const deleted = await invoke("chat-delete-session", first.id)
  assert.equal(deleted.success, true)
  assert.equal(deleted.session.id, second.id)
})

test("IPC reset 会取消请求、创建新会话并广播 reset-view", async () => {
  const { service, mainWindow, events } = setup()
  const oldSession = service.createSession({ title: "before reset" })
  const gate = deferred()
  openAIResponder = async (_body, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      const error = new Error("reset abort")
      error.name = "AbortError"
      reject(error)
    }, { once: true })
    gate.promise.then(resolve)
  })
  const pending = service.sendMessage(oldSession.id, "正在请求", [], "ipc-reset-old")
  await waitFor(() => openAICalls.length === 1)
  const { state } = ipcDeps(service, mainWindow)
  const result = await invoke("trigger-reset")
  assert.equal(result.success, true)
  assert.equal(state.cancelRequests, 1)
  const newSession = service.getCurrentSession()
  assert.notEqual(newSession.id, oldSession.id)
  assert.equal(events.at(-1).channel, "reset-view")
  assert.equal(events.at(-1).payload.session.id, newSession.id)
  await pending
  assert.equal(service.getSession(newSession.id).messages.length, 0)
})

test("IPC 在无 API key、无 chat service 和无效图片输入时保持可预测", async () => {
  const { service, mainWindow } = setup()
  const session = service.createSession()
  ipcDeps(service, mainWindow)
  configure({ apiKey: "" })
  assert.deepEqual(await invoke("chat-send-message", { requestId: "no-key", sessionId: session.id, text: "x" }), { success: false, error: "API key required" })

  configure({ apiKey: "test-api-key" })
  ipcDeps(null, mainWindow)
  assert.deepEqual(await invoke("chat-send-message", { requestId: "no-service", text: "x" }), { success: false, error: "Chat service unavailable" })

  const secondSetup = setup()
  ipcDeps(secondSetup.service, secondSetup.mainWindow)
  const secondSession = secondSetup.service.createSession()
  const result = await invoke("chat-send-message", {
    requestId: "invalid-images",
    sessionId: secondSession.id,
    text: "仍应发送",
    images: "not-an-array"
  })
  assert.equal(result.success, true)
})
