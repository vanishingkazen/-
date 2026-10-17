/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const { freshLoad } = require("./helpers/load-ts-module.cjs")

const originalDocument = globalThis.document

function silenceConsole(callback) {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error
  }
  console.log = () => {}
  console.warn = () => {}
  console.error = () => {}
  try {
    return callback()
  } finally {
    Object.assign(console, original)
  }
}

function createPreloadHarness() {
  const listeners = new Map()
  const invocations = []
  const responders = new Map()
  const externalLinks = []
  const exposed = new Map()

  const ipcRenderer = {
    invoke(channel, ...args) {
      invocations.push({ channel, args })
      const responder = responders.get(channel)
      if (responder) return Promise.resolve().then(() => responder(...args))
      return Promise.resolve({ channel, args })
    },
    on(channel, listener) {
      const channelListeners = listeners.get(channel) || []
      channelListeners.push(listener)
      listeners.set(channel, channelListeners)
    },
    removeListener(channel, listener) {
      const channelListeners = listeners.get(channel) || []
      listeners.set(channel, channelListeners.filter((item) => item !== listener))
    }
  }

  const electronMock = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        exposed.set(name, value)
      }
    },
    ipcRenderer,
    shell: {
      openExternal: async (url) => {
        externalLinks.push(url)
      }
    }
  }

  globalThis.document = { activeElement: null }
  silenceConsole(() => freshLoad("electron/preload.ts", { electron: electronMock }))

  return {
    api: exposed.get("electronAPI"),
    externalLinks,
    invocations,
    listeners,
    responders,
    emit(channel, ...args) {
      const event = { channel }
      for (const listener of [...(listeners.get(channel) || [])]) listener(event, ...args)
    },
    listenerCount(channel) {
      return (listeners.get(channel) || []).length
    }
  }
}

test.after(() => {
  if (originalDocument === undefined) delete globalThis.document
  else globalThis.document = originalDocument
})

test("preload 暴露完整且稳定的 electronAPI，IPC 调用保持参数与返回值", async () => {
  const harness = createPreloadHarness()
  const { api } = harness

  assert.ok(api, "electronAPI 必须暴露到主世界")
  for (const method of [
    "openSettingsPortal",
    "setOpacity",
    "updateContentDimensions",
    "getScreenshots",
    "deleteScreenshot",
    "sendChatMessage",
    "startVoiceRecognition",
    "sendVoiceAudio",
    "startUpdate",
    "installUpdate",
    "getConfig",
    "updateConfig",
    "logToMain",
    "getLogInfo"
  ]) {
    assert.equal(typeof api[method], "function", `missing electronAPI.${method}`)
  }

  const dimensions = { width: 1440, height: 900 }
  const configUpdate = { opacity: 0.75, contextMessageLimit: 30 }
  const chatPayload = { requestId: "request-1", sessionId: "session-1", text: "hello" }

  assert.deepEqual(await api.updateContentDimensions(dimensions), {
    channel: "update-content-dimensions",
    args: [dimensions]
  })
  assert.deepEqual(await api.updateConfig(configUpdate), {
    channel: "update-config",
    args: [configUpdate]
  })
  assert.deepEqual(await api.sendChatMessage(chatPayload), {
    channel: "chat-send-message",
    args: [chatPayload]
  })
  assert.deepEqual(await api.sendVoiceAudio(new Uint8Array([1, 2, 3]), "system"), {
    channel: "voice-audio",
    args: [new Uint8Array([1, 2, 3]), "system"]
  })
  assert.equal(api.getPlatform(), process.platform)

  await api.openLink("https://example.com/docs")
  assert.deepEqual(harness.externalLinks, ["https://example.com/docs"])
})

test("日志转发失败会被静默吸收，不会形成未处理 Promise 拒绝", async () => {
  const harness = createPreloadHarness()
  harness.responders.set("log-from-renderer", () => {
    throw new Error("main process unavailable")
  })

  assert.equal(harness.api.logToMain("error", "renderer failed", { source: "test" }), undefined)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(harness.invocations.at(-1), {
    channel: "log-from-renderer",
    args: [{ level: "error", message: "renderer failed", meta: { source: "test" } }]
  })
})

test("所有订阅接口只向业务回调传递载荷，并可通过返回值精确注销", () => {
  const harness = createPreloadHarness()
  const subscriptions = [
    ["onScreenshotTaken", "screenshot-taken", { path: "/tmp/a.png", preview: "data:image/png;base64,a" }],
    ["onResetView", "reset-view", { session: { id: "session-1" } }],
    ["onFocusChatInput", "focus-chat-input", undefined],
    ["onNewChatSession", "new-chat-session", undefined],
    ["onScrollChat", "scroll-chat", { direction: "down" }],
    ["onLanguageDetected", "language-detected", { language: "typescript" }],
    ["onChatStarted", "chat-started", { requestId: "r1", sessionId: "s1", userMessage: {} }],
    ["onChatStream", "chat-stream", { requestId: "r1", sessionId: "s1", content: "x", done: false }],
    ["onChatContextCompressed", "chat-context-compressed", { sessionId: "s1", summary: "摘要" }],
    ["onChatSuccess", "chat-success", { requestId: "r1", sessionId: "s1", content: "x", session: {} }],
    ["onChatError", "chat-error", { requestId: "r1", sessionId: "s1", error: "boom" }],
    ["onVoiceStatus", "voice-status", { source: "microphone", state: "listening", message: "ok" }],
    ["onVoicePartial", "voice-transcript-partial", { source: "microphone", text: "部分" }],
    ["onVoiceFinal", "voice-transcript-final", { source: "microphone", text: "完整", fullText: "完整", completedAt: 1 }],
    ["onVoiceContextCleared", "voice-context-cleared", { source: "microphone" }],
    ["onUpdateAvailable", "update-available", { version: "1.0.20" }],
    ["onUpdateDownloaded", "update-downloaded", { version: "1.0.20" }],
    ["onShowSettings", "show-settings-dialog", undefined],
    ["onApiKeyInvalid", "api-key-invalid", undefined],
    ["onDeleteLastScreenshot", "delete-last-screenshot", undefined]
  ]

  for (const [method, channel, payload] of subscriptions) {
    const calls = []
    const unsubscribe = harness.api[method]((...args) => calls.push(args))
    assert.equal(harness.listenerCount(channel), 1, `${method} 应仅注册一个监听器`)

    if (payload === undefined) harness.emit(channel)
    else harness.emit(channel, payload)

    assert.equal(calls.length, 1, `${method} 应收到一次回调`)
    assert.deepEqual(calls[0], payload === undefined ? [] : [payload], `${method} 不应向业务层泄漏 IpcRendererEvent`)
    unsubscribe()
    assert.equal(harness.listenerCount(channel), 0, `${method} 注销后不应残留监听器`)
  }
})

test("恢复焦点处理器兼容空指针对并只聚焦可聚焦元素", () => {
  const harness = createPreloadHarness()
  let focuses = 0
  globalThis.document.activeElement = { focus: () => { focuses += 1 } }

  assert.equal(harness.listenerCount("restore-focus"), 1)
  assert.doesNotThrow(() => harness.emit("restore-focus"))
  assert.equal(focuses, 1)

  globalThis.document.activeElement = null
  assert.doesNotThrow(() => harness.emit("restore-focus"))
  globalThis.document.activeElement = {}
  assert.doesNotThrow(() => harness.emit("restore-focus"))
  assert.equal(focuses, 1)
})
