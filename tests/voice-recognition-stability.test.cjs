/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

const assert = require("node:assert/strict")
const EventEmitter = require("node:events")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const { freshLoad } = require("./helpers/load-ts-module.cjs")

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steamgamecode-voice-"))
const contextPath = path.join(tempRoot, "interview-context.md")

const sockets = []
let configValues = {}

class MockWebSocket extends EventEmitter {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances = []

  constructor(url, options) {
    super()
    this.url = url
    this.options = options
    this.readyState = MockWebSocket.CONNECTING
    this.sent = []
    this.closeCalls = []
    sockets.push(this)
    MockWebSocket.instances.push(this)
  }

  send(payload, options) {
    this.sent.push({ payload, options })
  }

  close(code, reason) {
    this.closeCalls.push({ code, reason })
    this.readyState = MockWebSocket.CLOSED
    this.emit("close")
  }
}

MockWebSocket.OPEN = 1

async function tick() {
  await new Promise((resolve) => setImmediate(resolve))
}

function createFakeTimers() {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const pending = []
  globalThis.setTimeout = (callback, delay) => {
    const entry = { callback, delay, cleared: false, id: pending.length + 1 }
    pending.push(entry)
    return entry
  }
  globalThis.clearTimeout = (handle) => {
    if (handle && typeof handle === "object") handle.cleared = true
  }
  return {
    pending,
    restore() {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    },
    runByDelay(delay) {
      const entry = [...pending].reverse().find((item) => item.delay === delay && !item.cleared)
      assert.ok(entry, `未找到延迟为 ${delay}ms 的定时器`)
      entry.callback()
      return entry
    }
  }
}

function loadVoice() {
  return freshLoad("electron/VoiceRecognitionHelper.ts", {
    ws: { default: MockWebSocket, __esModule: true },
    "./ConfigHelper": {
      configHelper: {
        loadConfig: () => ({
          speechApiKey: "test-key",
          speechRegion: "cn-beijing",
          speechModel: "qwen-audio-3.0-asr-flash-streaming",
          speechWorkspaceId: "",
          interviewContextEnabled: false,
          interviewContextPath: contextPath,
          ...configValues
        })
      }
    },
    "./InterviewContextHelper": {
      loadInterviewAsrEnhancement: () => ({
        contextText: "",
        vocabulary: {},
        terms: []
      })
    },
    electron: {}
  })
}

function createWindow() {
  const sent = []
  return {
    sent,
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
    webContents: {
      send(channel, data) {
        sent.push({ channel, data })
      }
    }
  }
}

function normalizeText(text) {
  return text.toLowerCase().replace(/[嗯呃啊哦额]/g, "").replace(/[^\p{L}\p{N}]/gu, "")
}

function seedTranscript(helper, source, segments) {
  const session = helper.sessions[source]
  session.segments = segments.slice()
  session.finalTranscript = segments.map((segment) => segment.text).join("\n")
}

test.beforeEach(() => {
  sockets.length = 0
  MockWebSocket.instances.length = 0
  configValues = {}
  fs.rmSync(tempRoot, { recursive: true, force: true })
  fs.mkdirSync(tempRoot, { recursive: true })
})

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test("未配置语音 API Key 时不会建立连接并返回明确错误", async () => {
  configValues = { speechApiKey: "" }
  const helper = new (loadVoice().VoiceRecognitionHelper)(() => null)

  const result = await helper.start("microphone")
  assert.deepEqual(result, { success: false, error: "请先在设置中填写百炼语音 API Key" })
  assert.equal(sockets.length, 0)
})

test("连接超时会关闭 socket、进入 error 状态并返回可重试的错误", async (t) => {
  const timers = createFakeTimers()
  t.after(() => timers.restore())

  const { VoiceRecognitionHelper } = loadVoice()
  const window = createWindow()
  const helper = new VoiceRecognitionHelper(() => window)

  const pending = helper.start("microphone")
  await tick()
  const socket = sockets[0]
  assert.ok(socket, "连接建立后应创建 WebSocket")
  assert.equal(helper.sessions.microphone.state, "connecting")
  assert.match(socket.url, /^wss:\/\/dashscope\.aliyuncs\.com\/api-ws\/v1\/inference$/)
  assert.equal(socket.options.headers.Authorization, "Bearer test-key")

  timers.runByDelay(12000)
  const result = await pending

  assert.deepEqual(result, { success: false, error: "语音服务连接超时" })
  assert.equal(socket.closeCalls.length, 1, "超时必须主动关闭连接，避免悬挂 socket")
  assert.equal(window.sent.some((item) => item.channel === "voice-status" && item.data.state === "error"), true)

  // 失败后应能重新发起连接，并且新的连接仍然有独立的超时收敛路径
  const retryPending = helper.start("microphone")
  await tick()
  assert.equal(sockets.length, 2)
  timers.runByDelay(12000)
  const retryResult = await retryPending
  assert.deepEqual(retryResult, { success: false, error: "语音服务连接超时" })
})

test("握手成功后进入 listening，音频与停止流程保持稳定", async (t) => {
  const timers = createFakeTimers()
  t.after(() => timers.restore())

  const { VoiceRecognitionHelper } = loadVoice()
  const window = createWindow()
  const helper = new VoiceRecognitionHelper(() => window)

  const pending = helper.start("microphone")
  await tick()
  const socket = sockets[0]
  socket.readyState = MockWebSocket.OPEN
  socket.emit("open")
  assert.equal(socket.sent.length, 1, "连接建立后应发送 run-task")

  const runTask = JSON.parse(socket.sent[0].payload)
  assert.equal(runTask.header.action, "run-task")
  assert.equal(runTask.payload.parameters.format, "pcm")
  assert.equal(runTask.payload.parameters.sample_rate, 16000)

  socket.emit("message", JSON.stringify({ header: { event: "task-started" } }))
  const result = await pending
  assert.deepEqual(result, { success: true })
  assert.equal(window.sent.some((item) => item.channel === "voice-status" && item.data.state === "listening"), true)

  assert.deepEqual(helper.appendAudio(new Uint8Array([1, 2, 3])), { success: true })
  assert.equal(socket.sent.length, 2)
  assert.deepEqual(socket.sent[1].payload, new Uint8Array([1, 2, 3]))

  socket.emit("message", JSON.stringify({
    header: { event: "result-generated" },
    payload: { output: { sentence: { text: "介绍一下项目", sentence_end: true } } }
  }))
  assert.equal(helper.getTranscript("microphone"), "介绍一下项目")

  const stopPending = helper.stop("microphone")
  assert.equal(socket.sent.length, 3)
  const finishTask = JSON.parse(socket.sent[2].payload)
  assert.equal(finishTask.header.action, "finish-task")

  socket.emit("close")
  const stopResult = await stopPending
  assert.deepEqual(stopResult, { success: true, transcript: "介绍一下项目" })
})

test("连续 1000 帧音频在 listening 状态下全部写入且不抛异常", async (t) => {
  const timers = createFakeTimers()
  t.after(() => timers.restore())

  const { VoiceRecognitionHelper } = loadVoice()
  const helper = new VoiceRecognitionHelper(() => null)
  const pending = helper.start("microphone")
  await tick()
  const socket = sockets[0]
  socket.readyState = MockWebSocket.OPEN
  socket.emit("open")
  socket.emit("message", JSON.stringify({ header: { event: "task-started" } }))
  await pending

  for (let index = 0; index < 1000; index += 1) {
    assert.deepEqual(helper.appendAudio(new Uint8Array([index & 0xff, 0, 0, 0])), { success: true })
  }

  assert.equal(socket.sent.length, 1001, "应发送 1 条 run-task 和 1000 帧音频")
  assert.equal(socket.sent.slice(1).every((item) => item.options?.binary === true), true)
})

test("服务端意外关闭会清理连接与状态，并可立即重新建立会话", async (t) => {
  const timers = createFakeTimers()
  t.after(() => timers.restore())

  const { VoiceRecognitionHelper } = loadVoice()
  const window = createWindow()
  const helper = new VoiceRecognitionHelper(() => window)
  const firstPending = helper.start("microphone")
  await tick()
  const firstSocket = sockets[0]
  firstSocket.readyState = MockWebSocket.OPEN
  firstSocket.emit("open")
  firstSocket.emit("message", JSON.stringify({ header: { event: "task-started" } }))
  await firstPending

  firstSocket.emit("close")
  assert.equal(helper.sessions.microphone.state, "idle")
  assert.equal(helper.sessions.microphone.socket, null)
  assert.deepEqual(helper.appendAudio(new Uint8Array([1])), { success: false })

  const retryPending = helper.start("microphone")
  await tick()
  const secondSocket = sockets[1]
  assert.notEqual(secondSocket, firstSocket)
  secondSocket.readyState = MockWebSocket.OPEN
  secondSocket.emit("open")
  secondSocket.emit("message", JSON.stringify({ header: { event: "task-started" } }))
  assert.deepEqual(await retryPending, { success: true })
  assert.equal(helper.sessions.microphone.state, "listening")
})

test.todo("服务端意外关闭后应立即释放旧 socket 上的剩余监听器")

test("WebSocket 握手响应异常时返回服务端原因并进入 error 状态", async (t) => {
  const timers = createFakeTimers()
  t.after(() => timers.restore())

  const { VoiceRecognitionHelper } = loadVoice()
  const window = createWindow()
  const helper = new VoiceRecognitionHelper(() => window)
  const pending = helper.start("microphone")
  await tick()
  const socket = sockets[0]
  const response = new EventEmitter()
  response.statusCode = 401

  socket.emit("unexpected-response", {}, response)
  response.emit("data", Buffer.from(JSON.stringify({ message: "invalid api key" })))
  response.emit("end")

  assert.deepEqual(await pending, {
    success: false,
    error: "语音服务连接失败：invalid api key"
  })
  assert.equal(helper.sessions.microphone.state, "error")
  assert.equal(
    window.sent.some((item) => item.channel === "voice-status" && item.data.state === "error"),
    true
  )
})

test("任务启动失败会返回结构化错误，且不残留 listening 状态", async (t) => {
  const timers = createFakeTimers()
  t.after(() => timers.restore())

  const { VoiceRecognitionHelper } = loadVoice()
  const window = createWindow()
  const helper = new VoiceRecognitionHelper(() => window)

  const pending = helper.start("system")
  await tick()
  const socket = sockets[0]
  socket.readyState = MockWebSocket.OPEN
  socket.emit("open")
  socket.emit("message", JSON.stringify({
    header: { event: "task-failed", error_message: "quota exceeded" }
  }))

  const result = await pending
  assert.equal(result.success, false)
  assert.equal(typeof result.error, "string")
  assert.equal(window.sent.some((item) => item.channel === "voice-status" && item.data.state === "listening"), false)
})

test("未开始或已停止时会话上的音频写入返回失败而不是抛异常", () => {
  const { VoiceRecognitionHelper } = loadVoice()
  const helper = new VoiceRecognitionHelper(() => null)

  assert.deepEqual(helper.appendAudio(new Uint8Array([1])), { success: false })
  assert.deepEqual(helper.appendAudio(new ArrayBuffer(4)), { success: false })
  assert.deepEqual(helper.appendAudio(new Uint8Array()), { success: false })
})

test("没有活动 socket 时 stop 立即返回并保持空闲状态", async () => {
  const { VoiceRecognitionHelper } = loadVoice()
  const window = createWindow()
  const helper = new VoiceRecognitionHelper(() => window)

  const result = await helper.stop("microphone")
  assert.deepEqual(result, { success: true, transcript: "" })
  assert.equal(
    window.sent.some((item) => item.channel === "voice-status" && item.data.state === "idle"),
    true
  )
})

test("主窗口已销毁时状态事件不会导致崩溃", async (t) => {
  const timers = createFakeTimers()
  t.after(() => timers.restore())

  const { VoiceRecognitionHelper } = loadVoice()
  const window = createWindow()
  window.destroyed = true
  const helper = new VoiceRecognitionHelper(() => window)

  const pending = helper.start("microphone")
  await tick()
  assert.doesNotThrow(() => helper.clearTranscript())
  timers.runByDelay(12000)
  await assert.doesNotReject(() => pending)
  assert.equal(window.sent.length, 0, "窗口销毁后不应继续发送 IPC 事件")
})

test("面试上下文词汇会注入 run-task 参数", async (t) => {
  const timers = createFakeTimers()
  t.after(() => timers.restore())
  configValues = { interviewContextEnabled: true }

  const enhancerCalls = []
  const module = freshLoad("electron/VoiceRecognitionHelper.ts", {
    ws: { default: MockWebSocket, __esModule: true },
    "./ConfigHelper": {
      configHelper: {
        loadConfig: () => ({
          speechApiKey: "test-key",
          speechRegion: "cn-beijing",
          speechModel: "qwen-audio-3.0-asr-flash-streaming",
          speechWorkspaceId: "workspace-1",
          interviewContextEnabled: true,
          interviewContextPath: contextPath
        })
      }
    },
    "./InterviewContextHelper": {
      loadInterviewAsrEnhancement: (enabled, filePath) => {
        enhancerCalls.push({ enabled, filePath })
        return {
          contextText: "面试背景：Redis、PostgreSQL",
          vocabulary: { Redis: 5, PostgreSQL: 5 },
          terms: ["Redis", "PostgreSQL"]
        }
      }
    },
    electron: {}
  })

  const helper = new module.VoiceRecognitionHelper(() => null)
  const pending = helper.start("system")
  await tick()
  const socket = sockets[0]
  assert.deepEqual(enhancerCalls, [{ enabled: true, filePath: contextPath }])
  assert.match(socket.url, /^wss:\/\/workspace-1\.cn-beijing\.maas\.aliyuncs\.com/)

  socket.readyState = MockWebSocket.OPEN
  socket.emit("open")
  const payload = JSON.parse(socket.sent[0].payload)
  assert.deepEqual(payload.payload.parameters.vocabulary, { Redis: 5, PostgreSQL: 5 })
  assert.equal(payload.payload.input.context[0].content[0].text, "面试背景：Redis、PostgreSQL")

  timers.runByDelay(12000)
  await pending
})

test("双声道会议转写按时间排序，并过滤回声与无意义语气词", () => {
  const { VoiceRecognitionHelper } = loadVoice()
  const helper = new VoiceRecognitionHelper(() => null)

  seedTranscript(helper, "system", [
    { text: "介绍一下你的项目经历", completedAt: 1000 },
    { text: "为什么选择这个架构", completedAt: 5000 }
  ])
  seedTranscript(helper, "microphone", [
    { text: "介绍一下你的项目经历", completedAt: 1200 },
    { text: "嗯", completedAt: 1500 },
    { text: "我会先介绍项目背景", completedAt: 2000 },
    { text: "因为需要支撑高并发写入", completedAt: 5200 }
  ])

  const conversation = helper.getConversationTranscript()

  assert.deepEqual(conversation.turns.map((turn) => [turn.speaker, turn.text]), [
    ["interviewer", "介绍一下你的项目经历"],
    ["candidate", "我会先介绍项目背景"],
    ["interviewer", "为什么选择这个架构"],
    ["candidate", "因为需要支撑高并发写入"]
  ])
  assert.equal(conversation.removedSegments, 2, "1 条回声 + 1 条语气词")
  assert.equal(conversation.microphoneTranscript, "我会先介绍项目背景\n因为需要支撑高并发写入")
  assert.equal(
    conversation.rawMicrophoneTranscript,
    "介绍一下你的项目经历\n嗯\n我会先介绍项目背景\n因为需要支撑高并发写入"
  )
  assert.equal(conversation.systemTranscript.includes("为什么选择这个架构"), true)
})

test("只有面试者发言时不丢弃任何有效片段", () => {
  const { VoiceRecognitionHelper } = loadVoice()
  const helper = new VoiceRecognitionHelper(() => null)
  seedTranscript(helper, "microphone", [
    { text: "我先讲一下背景", completedAt: 1000 },
    { text: "然后展开技术方案", completedAt: 2000 }
  ])

  const conversation = helper.getConversationTranscript()
  assert.deepEqual(conversation.turns.map((turn) => turn.text), ["我先讲一下背景", "然后展开技术方案"])
  assert.equal(conversation.removedSegments, 0)
})

test("语气词的多语言与标点变体都会被过滤", () => {
  const { VoiceRecognitionHelper } = loadVoice()
  const helper = new VoiceRecognitionHelper(() => null)
  seedTranscript(helper, "microphone", [
    { text: "嗯。", completedAt: 100 },
    { text: "OK", completedAt: 200 },
    { text: "好的！", completedAt: 300 },
    { text: "收到，", completedAt: 400 },
    { text: "这个方案的重点是索引设计", completedAt: 500 }
  ])

  const conversation = helper.getConversationTranscript()
  assert.deepEqual(conversation.turns.map((turn) => turn.text), ["这个方案的重点是索引设计"])
  assert.equal(conversation.removedSegments, 4)
})

test("完全相同的文本即使超出时间窗口也会被当作回声过滤（当前行为）", () => {
  const { VoiceRecognitionHelper } = loadVoice()
  const helper = new VoiceRecognitionHelper(() => null)
  seedTranscript(helper, "system", [{ text: "请说明数据库选型理由", completedAt: 1000 }])
  seedTranscript(helper, "microphone", [
    { text: "请说明数据库选型理由", completedAt: 15000 }
  ])

  const conversation = helper.getConversationTranscript()
  // 已知行为：精确包含判断不检查时间窗口，窗口外的相同内容同样会被过滤，
  // 面试者如果逐字复述面试官问题会被静默丢弃。
  assert.equal(conversation.removedSegments, 1)
  assert.deepEqual(conversation.turns.map((turn) => turn.speaker), ["interviewer"])
})

test("相邻时间窗口内的模糊相似文本会被判为回声，窗口外不参与相似度比较", () => {
  const { VoiceRecognitionHelper } = loadVoice()
  const helper = new VoiceRecognitionHelper(() => null)
  seedTranscript(helper, "system", [{ text: "请说明数据库选型理由", completedAt: 1000 }])
  seedTranscript(helper, "microphone", [
    { text: "请说明数据库选型的原因", completedAt: 1500 }
  ])

  const inWindow = helper.getConversationTranscript()
  assert.equal(inWindow.removedSegments, 1, "窗口内高相似度转写应按回声处理")

  helper.sessions.microphone.segments = [
    { text: "请说明数据库选型的原因", completedAt: 60000 }
  ]
  const outOfWindow = helper.getConversationTranscript()
  assert.equal(outOfWindow.removedSegments, 0, "窗口外不做模糊匹配，避免误删真实发言")
  assert.deepEqual(outOfWindow.turns.map((turn) => turn.speaker), ["interviewer", "candidate"])
})

test("系统与麦克风文本归一化后才能正确匹配回声（含标点差异）", () => {
  const { VoiceRecognitionHelper } = loadVoice()
  const helper = new VoiceRecognitionHelper(() => null)
  seedTranscript(helper, "system", [{ text: "介绍，一下你的项目！", completedAt: 1000 }])
  seedTranscript(helper, "microphone", [{ text: "介绍 一下你的项目", completedAt: 1500 }])

  assert.equal(normalizeText("介绍，一下你的项目！"), normalizeText("介绍 一下你的项目"))
  const conversation = helper.getConversationTranscript()
  assert.equal(conversation.removedSegments, 1)
})

test("清空转写会重置指定声道并广播事件，不影响其他声道", () => {
  const { VoiceRecognitionHelper } = loadVoice()
  const window = createWindow()
  const helper = new VoiceRecognitionHelper(() => window)
  seedTranscript(helper, "system", [{ text: "面试官问题", completedAt: 1000 }])
  seedTranscript(helper, "microphone", [{ text: "面试者回答", completedAt: 2000 }])

  helper.clearTranscript("microphone")

  assert.equal(helper.getTranscript("microphone"), "")
  assert.equal(helper.getTranscript("system"), "面试官问题")
  assert.deepEqual(window.sent, [
    { channel: "voice-context-cleared", data: { source: "microphone" } }
  ])

  helper.clearTranscript()
  assert.equal(helper.getTranscript("system"), "")
  assert.deepEqual(
    window.sent.map((item) => item.data.source),
    ["microphone", "microphone", "system"],
    "指定声道清空后再全量清空，应各自广播一次"
  )
})

test("部分转写不会进入最终文本，完整句子才会落库", async (t) => {
  const timers = createFakeTimers()
  t.after(() => timers.restore())

  const { VoiceRecognitionHelper } = loadVoice()
  const window = createWindow()
  const helper = new VoiceRecognitionHelper(() => window)
  const pending = helper.start("microphone")
  await tick()
  const socket = sockets[0]
  socket.readyState = MockWebSocket.OPEN
  socket.emit("open")
  socket.emit("message", JSON.stringify({ header: { event: "task-started" } }))
  await pending

  socket.emit("message", JSON.stringify({
    header: { event: "result-generated" },
    payload: { output: { sentence: { text: "我正在说", sentence_end: false } } }
  }))
  assert.equal(helper.getTranscript("microphone"), "")
  assert.equal(window.sent.some((item) => item.channel === "voice-transcript-partial"), true)

  socket.emit("message", JSON.stringify({
    header: { event: "result-generated" },
    payload: { output: { sentence: { text: "我正在说完整的话", sentence_end: true } } }
  }))
  assert.equal(helper.getTranscript("microphone"), "我正在说完整的话")
  assert.equal(window.sent.some((item) => item.channel === "voice-transcript-final"), true)
})

test("无法解析的服务端消息不会中断后续转写", async (t) => {
  const timers = createFakeTimers()
  t.after(() => timers.restore())

  const { VoiceRecognitionHelper } = loadVoice()
  const helper = new VoiceRecognitionHelper(() => null)
  const pending = helper.start("microphone")
  await tick()
  const socket = sockets[0]
  socket.readyState = MockWebSocket.OPEN
  socket.emit("open")
  socket.emit("message", "not-json")
  socket.emit("message", JSON.stringify({ header: { event: "task-started" } }))
  const result = await pending
  assert.deepEqual(result, { success: true })

  socket.emit("message", JSON.stringify({
    header: { event: "result-generated" },
    payload: { output: { sentence: { text: "仍然可用", sentence_end: true } } }
  }))
  assert.equal(helper.getTranscript("microphone"), "仍然可用")
})

test("心跳消息不会产生转写片段", async (t) => {
  const timers = createFakeTimers()
  t.after(() => timers.restore())

  const { VoiceRecognitionHelper } = loadVoice()
  const helper = new VoiceRecognitionHelper(() => null)
  const pending = helper.start("microphone")
  await tick()
  const socket = sockets[0]
  socket.readyState = MockWebSocket.OPEN
  socket.emit("open")
  socket.emit("message", JSON.stringify({ header: { event: "task-started" } }))
  await pending

  socket.emit("message", JSON.stringify({
    header: { event: "result-generated" },
    payload: { output: { sentence: { text: "心跳", sentence_end: true, heartbeat: true } } }
  }))
  assert.equal(helper.getTranscript("microphone"), "")
  assert.equal(helper.sessions.microphone.segments.length, 0)
})
