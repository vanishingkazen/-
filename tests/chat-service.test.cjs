/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const Module = require("node:module")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const ROOT = path.resolve(__dirname, "..")
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steamgamecode-chat-test-"))
const appDataPath = path.join(tempRoot, "appData")

let openAICalls = []
let openAIResponder = defaultOpenAIResponder
let axiosCalls = []
let axiosResponder = defaultAxiosResponder
let anthropicCalls = []
let anthropicResponder = defaultAnthropicResponder

function completion(content) {
  return { choices: [{ message: { content } }] }
}

function streamChunk(content) {
  return { choices: [{ delta: { content } }] }
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
    return completion("已压缩的会话摘要")
  }
  if (body.stream) {
    return (async function* streamReply() {
      yield streamChunk("流式")
      yield streamChunk("回复")
    })()
  }
  return completion(`回复：${textFromMessage(body.messages?.at(-1))}`)
}

async function defaultAnthropicResponder(body) {
  if (String(body.system || "").includes("请压缩下面的对话")) {
    return { content: [{ type: "text", text: "Anthropic 会话摘要" }] }
  }
  return { content: [{ type: "text", text: "Anthropic 回复" }] }
}

async function defaultAxiosResponder(url, body) {
  if (url.includes(":streamGenerateContent")) {
    return {
      data: {
        candidates: [{ content: { parts: [{ text: "流式 Gemini 回复" }] } }]
      }
    }
  }
  return {
    data: {
      candidates: [{ content: { parts: [{ text: `Gemini 回复：${body.contents?.[0]?.parts?.[0]?.text || ""}` }] } }]
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

const axiosMock = {
  default: {
    post: async (url, body, options = {}) => {
      axiosCalls.push({ url, body, options })
      return axiosResponder(url, body)
    }
  },
  post: async (url, body, options = {}) => {
    axiosCalls.push({ url, body, options })
    return axiosResponder(url, body)
  }
}

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath(name) {
          if (name !== "appData") throw new Error(`Unexpected app path request: ${name}`)
          return appDataPath
        }
      },
      BrowserWindow: class BrowserWindow {}
    }
  }
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

function defaultConfig() {
  return {
    ...configHelper.loadConfig(),
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
  const sessionFile = path.join(appDataPath, "steamgamecode", "chat-sessions.json")
  fs.rmSync(sessionFile, { force: true })
  configHelper.saveConfig({ ...defaultConfig(), ...overrides })

  openAICalls = []
  axiosCalls = []
  anthropicCalls = []
  openAIResponder = defaultOpenAIResponder
  axiosResponder = defaultAxiosResponder
  anthropicResponder = defaultAnthropicResponder

  const events = []
  const mainWindow = {
    webContents: {
      send(channel, payload) {
        events.push({ channel, payload })
      }
    }
  }
  const service = new ChatService({ getMainWindow: () => mainWindow })
  return { service, events }
}

function pngFile(name) {
  const filePath = path.join(tempRoot, name)
  fs.writeFileSync(filePath, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"))
  return filePath
}

function resolvedUserMessage(body) {
  return body.messages.at(-1)
}

test.after(() => {
  Module._load = originalLoad
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test("多轮对话按顺序携带历史并持久化消息", async () => {
  const { service, events } = setup()
  const session = service.createSession()

  const first = await service.sendMessage(session.id, "第一轮：请记住数字 42", [], "request-1")
  const second = await service.sendMessage(session.id, "第二轮：刚才的数字是多少？", [], "request-2")

  assert.equal(first.success, true)
  assert.equal(second.success, true)
  assert.equal(openAICalls.length, 2)

  const secondRequest = openAICalls[1].body.messages
  assert.deepEqual(secondRequest.map((message) => message.role), ["system", "user", "assistant", "user"])
  assert.equal(secondRequest[1].content, "第一轮：请记住数字 42")
  assert.match(secondRequest[2].content, /数字 42/)
  assert.equal(secondRequest[3].content, "第二轮：刚才的数字是多少？")

  const persisted = service.getCurrentSession().messages
  assert.deepEqual(persisted.map((message) => message.role), ["user", "assistant", "user", "assistant"])
  assert.equal(persisted.at(-1).id, "request-2")
  assert.equal(events.filter((event) => event.channel === "chat-success").length, 2)
})

test("多图片输入会编码全部有效图片并跳过损坏路径", async () => {
  const { service } = setup()
  const session = service.createSession()
  const images = [
    { path: pngFile("image-1.png"), preview: "preview-1" },
    { path: pngFile("image-2.png"), preview: "preview-2" },
    { path: pngFile("image-3.png"), preview: "preview-3" },
    { path: path.join(tempRoot, "missing.png"), preview: "missing" }
  ]

  const result = await service.sendMessage(session.id, "请比较这三张截图", images, "request-images")
  assert.equal(result.success, true)

  const userMessage = resolvedUserMessage(openAICalls[0].body)
  assert.equal(userMessage.role, "user")
  assert.equal(Array.isArray(userMessage.content), true)
  assert.deepEqual(userMessage.content[0], { type: "text", text: "请比较这三张截图" })

  const imageParts = userMessage.content.filter((part) => part.type === "image_url")
  assert.equal(imageParts.length, 3)
  imageParts.forEach((part, index) => {
    assert.match(part.image_url.url, /^data:image\/png;base64,/)
    const expected = fs.readFileSync(images[index].path).toString("base64")
    assert.equal(part.image_url.url.endsWith(expected), true)
  })

  const persistedImages = service.getCurrentSession().messages[0].images
  assert.deepEqual(persistedImages.map((image) => image.preview), images.map((image) => image.preview))
  assert.equal(persistedImages.slice(0, 3).every((image) => image.path !== images.find((item) => item.preview === image.preview).path), true)
  assert.equal(persistedImages.slice(0, 3).every((image) => fs.existsSync(image.path)), true)
  assert.equal(persistedImages[3].path, images[3].path)

  images.slice(0, 3).forEach((image) => fs.rmSync(image.path, { force: true }))
  const followUp = await service.sendMessage(session.id, "继续分析刚才的截图", [], "request-images-follow-up")
  assert.equal(followUp.success, true)
  const followUpImageMessage = openAICalls.at(-1).body.messages.find((message) => Array.isArray(message.content))
  assert.equal(followUpImageMessage.content.filter((part) => part.type === "image_url").length, 3)
})

test("图片-only 消息使用默认提示词，空消息直接拒绝", async () => {
  const { service } = setup()
  const session = service.createSession()

  const empty = await service.sendMessage(session.id, "   \n", [], "request-empty")
  assert.deepEqual(empty, { success: false, error: "消息不能为空" })
  assert.equal(openAICalls.length, 0)
  assert.equal(service.getCurrentSession().messages.length, 0)

  const result = await service.sendMessage(session.id, "  ", [{ path: pngFile("only-image.png") }], "request-image-only")
  assert.equal(result.success, true)
  assert.equal(resolvedUserMessage(openAICalls[0].body).content[0].text, "请分析截图并回答。")
})

test("长文本会触发上下文压缩并把摘要注入后续请求", async () => {
  const { service, events } = setup({
    contextMessageLimit: 4,
    contextWindowTokens: 8192,
    maxOutputTokens: 1024
  })
  const session = service.createSession()
  const longText = "长".repeat(2800)

  await service.sendMessage(session.id, longText, [], "request-long-1")
  await service.sendMessage(session.id, longText, [], "request-long-2")
  await service.sendMessage(session.id, "继续回答", [], "request-long-3")
  const fourth = await service.sendMessage(session.id, "再次继续", [], "request-long-4")

  assert.equal(fourth.success, true)
  const summaryCall = openAICalls.find((call) =>
    String(call.body.messages?.[0]?.content || "").includes("请压缩下面的对话")
  )
  assert.ok(summaryCall, "应调用摘要模型")

  const finalRequest = openAICalls.at(-1).body.messages
  assert.match(finalRequest[0].content, /此前对话摘要：\n已压缩的会话摘要/)
  assert.equal(finalRequest.length <= 6, true)
  assert.equal(service.getCurrentSession().summary, "已压缩的会话摘要")
  assert.equal(events.filter((event) => event.channel === "chat-context-compressed").length, 1)
})

test("流式响应会按增量广播并返回完整文本", async () => {
  const { service, events } = setup({ streamingEnabled: true })
  const session = service.createSession()

  const result = await service.sendMessage(session.id, "测试流式", [], "request-stream")

  assert.equal(result.success, true)
  assert.equal(result.content, "流式回复")
  const streamEvents = events.filter((event) => event.channel === "chat-stream")
  assert.deepEqual(streamEvents.map((event) => event.payload.content), ["流式", "流式回复"])
  assert.deepEqual(streamEvents.map((event) => event.payload.done), [false, false])
  assert.equal(events.some((event) => event.channel === "chat-success"), true)
})

test("连续 20 轮对话会限制请求历史且保留最近上下文", async () => {
  const { service, events } = setup({ contextMessageLimit: 30 })
  const session = service.createSession()

  for (let turn = 1; turn <= 20; turn += 1) {
    const result = await service.sendMessage(
      session.id,
      `第 ${turn} 轮：请记住轮次 ${turn}`,
      [],
      `request-turn-${turn}`
    )
    assert.equal(result.success, true)
  }

  assert.equal(openAICalls.filter((call) => !String(call.body.messages?.[0]?.content || "").includes("请压缩下面的对话")).length, 20)
  const finalRequest = openAICalls.at(-1).body.messages
  assert.equal(finalRequest.length <= 31, true)
  assert.deepEqual(service.getCurrentSession().messages.map((message) => message.role).slice(0, 4), [
    "user",
    "assistant",
    "user",
    "assistant"
  ])
  assert.equal(service.getCurrentSession().messages.length < 40, true)
  assert.equal(service.getCurrentSession().messages.at(-2).content, "第 20 轮：请记住轮次 20")
  assert.equal(service.getCurrentSession().messages.at(-1).role, "assistant")
  assert.notEqual(service.getCurrentSession().summary, "")
  assert.equal(events.filter((event) => event.channel === "chat-context-compressed").length > 0, true)
})

test("接近上下文上限的超长文本可正常发送", async () => {
  const { service } = setup({
    contextWindowTokens: 128000,
    maxOutputTokens: 1024,
    contextMessageLimit: 30
  })
  const session = service.createSession()
  const longText = "这是超长文本稳定性测试。".repeat(7000)

  const result = await service.sendMessage(session.id, longText, [], "request-very-long")

  assert.equal(result.success, true)
  assert.equal(resolvedUserMessage(openAICalls[0].body).content, longText)
  assert.equal(service.getCurrentSession().messages[0].content.length, longText.length)
})

test("取消请求会中止上游调用并返回错误而不挂起", async () => {
  const { service, events } = setup()
  const session = service.createSession()
  openAIResponder = async (_body, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      const error = new Error("request aborted")
      error.name = "AbortError"
      reject(error)
    }, { once: true })
  })

  const pending = service.sendMessage(session.id, "开始一个长请求", [], "request-cancel")
  for (let index = 0; index < 20 && openAICalls.length === 0; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(openAICalls.length, 1)

  service.cancel()
  const result = await pending
  assert.equal(result.success, false)
  assert.match(result.error, /aborted/i)
  assert.equal(events.some((event) => event.channel === "chat-error"), true)
})

test("上游失败会返回结构化错误，恢复后仍可继续同一会话", async () => {
  const { service, events } = setup()
  const session = service.createSession()
  openAIResponder = async () => {
    throw new Error("upstream 503")
  }

  const failed = await service.sendMessage(session.id, "第一次请求", [], "request-fail")
  assert.deepEqual(failed, { success: false, error: "upstream 503" })
  assert.equal(events.findLast((event) => event.channel === "chat-error").payload.requestId, "request-fail")

  openAIResponder = defaultOpenAIResponder
  const recovered = await service.sendMessage(session.id, "重试并继续", [], "request-retry")
  assert.equal(recovered.success, true)
  assert.match(recovered.content, /重试并继续/)
  assert.deepEqual(service.getCurrentSession().messages.map((message) => message.role), [
    "user",
    "assistant",
    "user",
    "assistant"
  ])
})

test("Gemini 多图片请求会生成 inlineData parts", async () => {
  const { service } = setup({
    apiProvider: "gemini",
    apiKey: "gemini-test-key",
    extractionModel: "gemini-2.0-flash",
    solutionModel: "gemini-2.0-flash"
  })
  const session = service.createSession()
  const images = [
    { path: pngFile("gemini-image-1.png") },
    { path: pngFile("gemini-image-2.png") }
  ]

  const result = await service.sendMessage(session.id, "分析两张图片", images, "request-gemini-images")

  assert.equal(result.success, true)
  assert.equal(axiosCalls.length, 1)
  const parts = axiosCalls[0].body.contents[0].parts
  assert.equal(parts[0].text.includes("多轮对话助手"), true)
  assert.equal(parts[1].text, "用户：分析两张图片")
  assert.equal(parts.filter((part) => part.inlineData).length, 2)
  parts.filter((part) => part.inlineData).forEach((part) => {
    assert.equal(part.inlineData.mimeType, "image/png")
    assert.equal(typeof part.inlineData.data, "string")
    assert.equal(part.inlineData.data.length > 0, true)
  })
})

test("Anthropic 长会话压缩后首条消息保持 user 角色", async () => {
  const { service } = setup({
    apiProvider: "anthropic",
    apiKey: "sk-ant-test",
    extractionModel: "claude-3-7-sonnet-20250219",
    solutionModel: "claude-3-7-sonnet-20250219",
    debuggingModel: "claude-3-7-sonnet-20250219",
    contextMessageLimit: 4,
    contextWindowTokens: 8192,
    maxOutputTokens: 1024
  })
  const session = service.createSession()
  const longText = "长".repeat(2800)

  await service.sendMessage(session.id, longText, [], "request-anthropic-1")
  await service.sendMessage(session.id, longText, [], "request-anthropic-2")
  await service.sendMessage(session.id, "继续回答", [], "request-anthropic-3")
  const fourth = await service.sendMessage(session.id, "再次继续", [], "request-anthropic-4")

  assert.equal(fourth.success, true)
  assert.equal(anthropicCalls.some((call) => String(call.body.system || "").includes("请压缩下面的对话")), true)
  const finalRequest = anthropicCalls.at(-1).body
  assert.equal(finalRequest.messages[0].role, "user")
  assert.equal(finalRequest.system.includes("Anthropic 会话摘要"), true)
})

test("并发发送第二条消息会被拒绝且不会污染会话", async () => {
  const { service } = setup()
  const session = service.createSession()
  openAIResponder = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    return completion("第一条回复")
  }

  const first = service.sendMessage(session.id, "第一条消息", [], "request-concurrent-1")
  for (let index = 0; index < 20 && openAICalls.length === 0; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  const second = await service.sendMessage(session.id, "第二条并发消息", [], "request-concurrent-2")
  assert.deepEqual(second, { success: false, error: "上一条消息仍在处理中，请稍后重试" })

  const firstResult = await first
  assert.equal(firstResult.success, true)
  assert.deepEqual(service.getCurrentSession().messages.map((message) => message.role), ["user", "assistant"])
  assert.equal(service.getCurrentSession().messages[0].content, "第一条消息")
})

test("无效会话 ID 会被拒绝且不会污染当前会话", async () => {
  const { service } = setup()
  const session = service.createSession()

  const result = await service.sendMessage("missing-session", "回退测试", [], "request-fallback")
  assert.equal(result.success, false)
  assert.equal(result.error, "会话不存在")
  assert.equal(service.getCurrentSession().id, session.id)
  assert.equal(service.getCurrentSession().messages.length, 0)
})

test("会话可以切换并把种子消息作为后续上下文", async () => {
  const { service } = setup()
  const first = service.createSession({
    title: "已恢复会话",
    messages: [{
      id: "seed-user",
      role: "user",
      content: "历史题目",
      images: [],
      createdAt: new Date().toISOString(),
      status: "completed"
    }, {
      id: "seed-assistant",
      role: "assistant",
      content: "历史答案",
      images: [],
      createdAt: new Date().toISOString(),
      status: "completed"
    }]
  })
  const second = service.createSession()

  assert.equal(service.getCurrentSession().id, second.id)
  assert.equal(service.selectSession(first.id).id, first.id)
  assert.equal(service.getCurrentSession().messages.length, 2)

  const result = await service.sendMessage(first.id, "继续追问", [], "request-seeded")
  assert.equal(result.success, true)
  assert.equal(service.getCurrentSession().messages.at(-2).content, "继续追问")
})

test("上下文摘要失败时保留原始历史", async () => {
  const { service } = setup({ contextMessageLimit: 2 })
  const session = service.createSession()
  let compressionFailed = true
  openAIResponder = async (body) => {
    if (String(body.messages?.[0]?.content || "").includes("请压缩下面的对话")) {
      if (compressionFailed) throw new Error("summary unavailable")
      return completion("摘要")
    }
    return completion(`回复：${textFromMessage(body.messages?.at(-1))}`)
  }

  await service.sendMessage(session.id, "第一条需要保留", [], "request-preserve-1")
  const second = await service.sendMessage(session.id, "第二条消息", [], "request-preserve-2")

  assert.equal(second.success, true)
  assert.equal(service.getCurrentSession().messages.some((message) => message.content === "第一条需要保留"), true)
  assert.equal(service.getCurrentSession().summary, "")
  compressionFailed = false
})

test("会话保留上限不会丢失当前选中的旧会话", async () => {
  const { service } = setup()
  const first = service.createSession({ title: "需要保留的旧会话" })
  for (let index = 0; index < 50; index += 1) {
    service.createSession({ title: `新会话 ${index}` })
  }
  assert.equal(service.selectSession(first.id).id, first.id)

  const sessionFile = path.join(appDataPath, "steamgamecode", "chat-sessions.json")
  const persisted = JSON.parse(fs.readFileSync(sessionFile, "utf8"))
  assert.equal(persisted.sessions.some((item) => item.id === first.id), true)
  assert.equal(persisted.currentSessionId, first.id)
  assert.equal(persisted.sessions.length, 50)
})

test("请求处理中禁止切换或删除会话", async () => {
  const { service } = setup()
  const first = service.createSession()
  const second = service.createSession()
  openAIResponder = async (_body, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      const error = new Error("request aborted")
      error.name = "AbortError"
      reject(error)
    }, { once: true })
  })

  const pending = service.sendMessage(second.id, "处理中", [], "request-busy-session")
  for (let index = 0; index < 20 && openAICalls.length === 0; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(service.selectSession(first.id), null)
  assert.equal(service.deleteSession(first.id), false)

  service.cancel()
  await pending
})

test("单条超长消息也会在发送给模型前截断而不破坏本地会话", async () => {
  const { service } = setup({ contextMessageLimit: 30, contextWindowTokens: 1800, maxOutputTokens: 512 })
  const session = service.createSession()
  const longText = "这是需要保留在本地但不能完整塞进模型上下文的内容。".repeat(2000)

  const result = await service.sendMessage(session.id, longText, [], "request-single-long")
  assert.equal(result.success, true)
  assert.equal(service.getCurrentSession().messages[0].content, longText)
  const requestContent = resolvedUserMessage(openAICalls.at(-1).body).content
  assert.equal(requestContent.length < longText.length, true)
  assert.match(requestContent, /内容过长，已截断/)
})
