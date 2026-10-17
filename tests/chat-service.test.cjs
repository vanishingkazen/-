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
let axiosDeletes = []
let nativeImageResizeCalls = []
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
      return axiosResponder(url, body, options)
    },
    delete: async (url, options = {}) => {
      axiosDeletes.push({ url, options })
      return { data: { id: url.split("/").pop(), deleted: true } }
    }
  },
  post: async (url, body, options = {}) => {
    axiosCalls.push({ url, body, options })
    return axiosResponder(url, body, options)
  },
  delete: async (url, options = {}) => {
    axiosDeletes.push({ url, options })
    return { data: { id: url.split("/").pop(), deleted: true } }
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
      BrowserWindow: class BrowserWindow {},
      nativeImage: {
        createFromPath(filePath) {
          const buffer = fs.readFileSync(filePath)
          const width = buffer.length >= 24 ? buffer.readUInt32BE(16) : 32
          const height = buffer.length >= 24 ? buffer.readUInt32BE(20) : 32
          return {
            isEmpty: () => false,
            getSize: () => ({ width, height }),
            resize: ({ width: nextWidth, height: nextHeight }) => {
              nativeImageResizeCalls.push({ filePath, width: nextWidth, height: nextHeight })
              return { toPNG: () => fakePngBuffer(nextWidth, nextHeight) }
            },
            toPNG: () => buffer
          }
        }
      }
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

function setup(overrides = {}, serviceOverrides = {}) {
  const sessionFile = path.join(appDataPath, "steamgamecode", "chat-sessions.json")
  fs.rmSync(sessionFile, { force: true })
  configHelper.saveConfig({ ...defaultConfig(), ...overrides })

  openAICalls = []
  axiosCalls = []
  axiosDeletes = []
  nativeImageResizeCalls = []
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
  const service = new ChatService({
    getMainWindow: () => mainWindow,
    ...serviceOverrides
  })
  return { service, events }
}

function fakePngBuffer(width, height) {
  const buffer = Buffer.alloc(24)
  buffer.writeUInt32BE(0x89504e47, 0)
  buffer.writeUInt32BE(0x0d0a1a0a, 4)
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function pngFile(name, width = 0, height = 0) {
  const filePath = path.join(tempRoot, name)
  fs.writeFileSync(filePath, width && height
    ? fakePngBuffer(width, height)
    : Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"))
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

test("语音面试请求会把完整面试背景注入系统提示词", async () => {
  const contextPath = path.join(tempRoot, "interview-context.md")
  fs.writeFileSync(contextPath, "项目经历：PandoraQ 使用 RAG 和 MCP。", "utf8")
  const { service } = setup({
    interviewContextEnabled: true,
    interviewContextPath: contextPath
  })
  const session = service.createSession()

  const result = await service.sendMessage(
    session.id,
    "以下线上会议双方对话上下文\n面试官：介绍一下你在 PandoraQ 里的 RAG 实践。\n面试者：核心流程是什么？",
    [],
    "request-voice-interview"
  )

  assert.equal(result.success, true)
  const systemPrompt = openAICalls[0].body.messages[0].content
  assert.match(systemPrompt, /系统音频转写代表面试官/)
  assert.match(systemPrompt, /项目经历：PandoraQ 使用 RAG 和 MCP。/)
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

test("消息被接受后只通知消费本轮源截图，并保留聊天记录附件", async () => {
  const acceptedEvents = []
  const { service, events } = setup({}, {
    onMessageAccepted(accepted) {
      acceptedEvents.push(accepted)
    }
  })
  const session = service.createSession()
  const firstImage = pngFile("accepted-first.png")
  const secondImage = pngFile("accepted-second.png")

  const result = await service.sendMessage(
    session.id,
    "分析本轮的两张截图",
    [{ path: firstImage }, { path: secondImage }],
    "request-accepted-images"
  )

  assert.equal(result.success, true)
  assert.equal(acceptedEvents.length, 1)
  assert.deepEqual(acceptedEvents[0].acceptedImagePaths, [firstImage, secondImage])

  const persistedImages = service.getCurrentSession().messages[0].images
  assert.equal(persistedImages.length, 2)
  assert.deepEqual(
    acceptedEvents[0].persistedImagePaths,
    persistedImages.map((image) => image.path)
  )
  assert.equal(persistedImages.every((image) => image.path !== firstImage && image.path !== secondImage), true)

  const startedEvent = events.find((event) => event.channel === "chat-started")
  assert.deepEqual(startedEvent.payload.acceptedImagePaths, [firstImage, secondImage])
})

test("DeepSeek 图片走 Files API，并在后续轮次复用 file_id", async () => {
  const { service } = setup({
    apiKey: "deepseek-test-key",
    baseURL: "https://api.deepseek.com",
    streamingEnabled: false
  })
  axiosResponder = async (url) => {
    if (url.endsWith("/files")) return { data: { id: "file-api-test-1", filename: "image.png" } }
    return defaultAxiosResponder(url, {})
  }
  const session = service.createSession()
  const image = pngFile("deepseek-files-api.png")

  const first = await service.sendMessage(session.id, "分析这张截图", [{ path: image }], "request-files-1")
  assert.equal(first.success, true)
  const uploadCalls = axiosCalls.filter((call) => call.url.endsWith("/files"))
  assert.equal(uploadCalls.length, 1)
  const firstContent = resolvedUserMessage(openAICalls[0].body).content
  assert.deepEqual(firstContent[1], { type: "file", file_id: "file-api-test-1" })
  const storedImage = service.getCurrentSession().messages[0].images[0]
  assert.equal(storedImage.fileId, "file-api-test-1")
  assert.equal(typeof storedImage.fileOwnerHash, "string")

  const second = await service.sendMessage(session.id, "继续分析", [], "request-files-2")
  assert.equal(second.success, true)
  const secondRequest = openAICalls[1].body.messages.find((message) => Array.isArray(message.content))
  assert.deepEqual(secondRequest.content[1], { type: "file", file_id: "file-api-test-1" })
  assert.equal(axiosCalls.filter((call) => call.url.endsWith("/files")).length, 1)

  const persisted = JSON.parse(fs.readFileSync(path.join(appDataPath, "steamgamecode", "chat-sessions.json"), "utf8"))
  const persistedImage = persisted.sessions[0].messages[0].images[0]
  assert.equal(persistedImage.fileId, "file-api-test-1")
  assert.equal(persistedImage.preview, undefined)

  assert.equal(service.deleteSession(session.id), true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(axiosDeletes.some((call) => call.url.endsWith("/file-api-test-1")), true)
})

test("发送 4 张图片会缩放到 1650px、保留 PNG 并显式使用 original", async () => {
  const { service } = setup()
  const session = service.createSession()
  const image = pngFile("large-screenshot.png", 2940, 1912)

  const result = await service.sendMessage(session.id, "请分析这张截图", [{ path: image }], "request-resize")
  assert.equal(result.success, true)
  assert.equal(nativeImageResizeCalls.length, 1)
  assert.deepEqual(nativeImageResizeCalls[0].width, 1650)
  assert.deepEqual(nativeImageResizeCalls[0].height, 1073)

  const storedImage = service.getCurrentSession().messages[0].images[0]
  assert.equal(Boolean(storedImage.transportPath && fs.existsSync(storedImage.transportPath)), true)
  const resized = fs.readFileSync(storedImage.transportPath)
  assert.equal(resized.readUInt32BE(16), 1650)
  assert.equal(resized.readUInt32BE(20), 1073)

  const imagePart = resolvedUserMessage(openAICalls[0].body).content.find((part) => part.type === "image_url")
  assert.equal(imagePart.image_url.detail, "original")
  assert.match(imagePart.image_url.url, /^data:image\/png;base64,/)
  assert.equal(imagePart.image_url.url.endsWith(resized.toString("base64")), true)
})

test("图片 MIME 根据文件内容识别，不会被固定写成 PNG", async () => {
  const { service } = setup()
  const session = service.createSession()
  const imagePath = path.join(tempRoot, "photo.bin")
  fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))

  const result = await service.sendMessage(session.id, "分析图片", [{ path: imagePath }], "request-mime")
  assert.equal(result.success, true)
  const imagePart = resolvedUserMessage(openAICalls[0].body).content.find((part) => part.type === "image_url")
  assert.match(imagePart.image_url.url, /^data:image\/jpeg;base64,/)
})

test("图片超出上下文预算时明确失败，不会静默丢弃当前截图", async () => {
  const { service } = setup({ contextWindowTokens: 8192, maxOutputTokens: 4096 })
  const session = service.createSession()
  const images = Array.from({ length: 4 }, (_, index) => ({ path: pngFile(`budget-image-${index}.png`) }))

  const result = await service.sendMessage(session.id, "分析四张图片", images, "request-image-budget")
  assert.equal(result.success, false)
  assert.match(result.error, /上下文预算不足/)
  assert.equal(openAICalls.length, 0)
  assert.equal(service.getCurrentSession().messages[0].images.length, 4)
})

test("上下文压缩会保存图片 file_id 引用", async () => {
  const { service } = setup({
    apiKey: "deepseek-test-key",
    baseURL: "https://api.deepseek.com",
    contextMessageLimit: 4,
    contextWindowTokens: 8192,
    maxOutputTokens: 1024,
    streamingEnabled: false
  })
  axiosResponder = async (url) => {
    if (url.endsWith("/files")) return { data: { id: "file-api-summary-1", filename: "image.png" } }
    return defaultAxiosResponder(url, {})
  }
  const session = service.createSession()
  const image = pngFile("summary-image.png")

  for (let index = 1; index <= 4; index += 1) {
    const result = await service.sendMessage(
      session.id,
      index === 1 ? "请记住这张截图" : `继续第 ${index} 轮`,
      index === 1 ? [{ path: image }] : [],
      `request-summary-image-${index}`
    )
    assert.equal(result.success, true)
  }

  assert.match(service.getCurrentSession().summary, /file_id=file-api-summary-1/)
})

test("截图回答中的语言标记会自动更新配置并从用户可见内容移除", async () => {
  const { service, events } = setup()
  const session = service.createSession()
  const screenshot = pngFile("language-detection.png")
  openAIResponder = async () => completion("[LANGUAGE: TypeScript]\n\n请使用截图中的接口实现。")

  const result = await service.sendMessage(
    session.id,
    "请分析这张截图",
    [{ path: screenshot }],
    "request-language"
  )

  assert.equal(result.success, true)
  assert.equal(result.content, "请使用截图中的接口实现。")
  assert.equal(configHelper.loadConfig().language, "typescript")
  assert.equal(configHelper.loadConfig().languageDetectionSource, "detected")
  assert.deepEqual(
    events.find((event) => event.channel === "language-detected")?.payload,
    { language: "typescript" }
  )
  assert.equal(service.getCurrentSession().messages.at(-1).content, "请使用截图中的接口实现。")
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

test("启动时会清理已不在会话列表中的附件目录", async () => {
  const { service } = setup()
  const session = service.createSession()
  const image = pngFile("orphan-attachment.png")

  const sent = await service.sendMessage(session.id, "请分析这张截图", [{ path: image }], "request-orphan-attachment")
  assert.equal(sent.success, true)

  const attachmentDir = path.join(appDataPath, "steamgamecode", "chat-attachments", session.id)
  assert.equal(fs.existsSync(attachmentDir), true)

  // 模拟上一次运行被保留上限裁掉的会话：会话记录没了，只剩附件目录
  const sessionFile = path.join(appDataPath, "steamgamecode", "chat-sessions.json")
  const persisted = JSON.parse(fs.readFileSync(sessionFile, "utf8"))
  persisted.sessions = persisted.sessions.filter((item) => item.id !== session.id)
  fs.writeFileSync(sessionFile, JSON.stringify(persisted), "utf8")

  new ChatService({ getMainWindow: () => ({ webContents: { send() {} } }) })

  assert.equal(fs.existsSync(attachmentDir), false)
})

test("会话超出保留上限时回收远端图片文件", async () => {
  const { service } = setup({
    apiKey: "deepseek-test-key",
    baseURL: "https://api.deepseek.com",
    streamingEnabled: false
  })
  axiosResponder = async (url) => {
    if (url.endsWith("/files")) return { data: { id: "file-retention-1", filename: "image.png" } }
    return defaultAxiosResponder(url, {})
  }
  const session = service.createSession()
  const image = pngFile("retention-remote.png")

  const sent = await service.sendMessage(session.id, "请分析这张截图", [{ path: image }], "request-retention-remote")
  assert.equal(sent.success, true)
  assert.equal(axiosCalls.filter((call) => call.url.endsWith("/files")).length, 1)

  for (let index = 0; index < 50; index += 1) service.createSession()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(axiosDeletes.some((call) => call.url.endsWith("/file-retention-1")), true)
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

test("1000 个流式增量按序广播且不丢失、不重复或改变最终文本", async () => {
  const { service, events } = setup({ streamingEnabled: true })
  const session = service.createSession()
  const chunks = Array.from({ length: 1000 }, (_, index) => `第${index + 1}段；`)
  const expected = chunks.join("")

  openAIResponder = async (body) => {
    assert.equal(body.stream, true)
    return (async function* streamReply() {
      for (const chunk of chunks) {
        yield streamChunk(chunk)
      }
    })()
  }

  const result = await service.sendMessage(session.id, "执行长流式回答", [], "request-1000-chunks")

  assert.equal(result.success, true)
  assert.equal(result.content, expected)
  const streamEvents = events.filter((event) => event.channel === "chat-stream")
  assert.equal(streamEvents.length, chunks.length)
  assert.equal(streamEvents.every((event) => event.payload.done === false), true)
  assert.equal(streamEvents[0].payload.content, chunks[0])
  assert.equal(streamEvents.at(-1).payload.content, expected)
  assert.equal(events.filter((event) => event.channel === "chat-success").length, 1)
  assert.equal(service.getCurrentSession().messages.at(-1).content, expected)
})

test("高压并发发送只接受一个请求，其余快速拒绝且不污染会话或上游调用", async () => {
  const { service } = setup()
  const session = service.createSession()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })

  openAIResponder = async (_body, { signal }) => {
    if (signal.aborted) {
      const error = new Error("request aborted")
      error.name = "AbortError"
      throw error
    }
    await gate
    return completion("完成")
  }

  const accepted = service.sendMessage(session.id, "唯一被接受的请求", [], "request-stress-owner")
  for (let index = 0; index < 20 && openAICalls.length === 0; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }

  const rejected = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      service.sendMessage(session.id, `并发请求 ${index}`, [], `request-stress-${index}`)
    )
  )
  assert.equal(rejected.every((result) => (
    result.success === false && result.error === "上一条消息仍在处理中，请稍后重试"
  )), true)
  assert.equal(openAICalls.length, 1, "并发拒绝不应创建额外上游请求")
  assert.equal(
    service.getCurrentSession().messages.filter((message) => message.role === "user").length,
    1,
    "被拒绝的并发请求不应写入会话"
  )

  release()
  const acceptedResult = await accepted
  assert.equal(acceptedResult.success, true)
  assert.equal(service.getCurrentSession().messages.filter((message) => message.role === "user").length, 1)
})
