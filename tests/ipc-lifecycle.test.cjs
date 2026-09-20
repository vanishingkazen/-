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
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steamgamecode-ipc-"))
const handlers = new Map()
const registeredChannels = []
const clipboardWrites = []
const config = {
  apiProvider: "openai-compatible",
  apiKey: "test-key",
  opacity: 1,
  interviewContextEnabled: false,
  interviewContextPath: path.join(tempRoot, "interview-context.md")
}

const electronMock = {
  BrowserWindow: {
    fromWebContents() {
      return {}
    }
  },
  clipboard: {
    writeText(text) {
      clipboardWrites.push(text)
    }
  },
  shell: {
    openPath: async () => "",
    openExternal: async () => {}
  },
  ipcMain: {
    handle(channel, handler) {
      if (handlers.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      handlers.set(channel, handler)
      registeredChannels.push(channel)
    }
  }
}

const originalLoad = Module._load
const originalTsLoader = require.extensions[".ts"]
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return electronMock
  if (request === "./ConfigHelper") {
    return {
      configHelper: {
        loadConfig: () => ({ ...config }),
        updateConfig: (updates) => ({ ...config, ...updates }),
        hasApiKey: () => Boolean(config.apiKey)
      }
    }
  }
  if (request === "./logger") {
    return {
      getLogInfo: () => ({ runId: "test" }),
      logFromRenderer: () => {},
      openLogDirectory: async () => ({ success: true, path: tempRoot })
    }
  }
  if (request === "./InterviewContextHelper") {
    return {
      ensureInterviewContextFile: (filePath) => filePath,
      getInterviewContextStatus: (enabled, filePath) => ({
        enabled,
        available: true,
        path: filePath,
        characterCount: 0
      })
    }
  }
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

const { initializeIpcHandlers } = require(path.join(ROOT, "electron", "ipcHandlers.ts"))

function createDeps() {
  const state = {
    currentWindow: null,
    toggles: 0,
    clears: 0,
    view: "queue"
  }
  const deps = {
    getMainWindow: () => state.currentWindow,
    setWindowDimensions: () => {},
    getScreenshotQueue: () => [],
    getExtraScreenshotQueue: () => [],
    deleteScreenshot: async () => ({ success: true }),
    getImagePreview: async () => "preview",
    processingHelper: null,
    chatService: null,
    voiceRecognitionHelper: null,
    PROCESSING_EVENTS: { API_KEY_INVALID: "api-key-invalid" },
    takeScreenshot: async () => path.join(tempRoot, "screenshot.png"),
    getView: () => state.view,
    toggleMainWindow: () => {
      state.toggles += 1
    },
    clearQueues: () => {
      state.clears += 1
    },
    setView: (view) => {
      state.view = view
    },
    setProblemInfo: () => {},
    moveWindowLeft: () => {},
    moveWindowRight: () => {},
    moveWindowUp: () => {},
    moveWindowDown: () => {}
  }
  return { deps, state }
}

const shared = createDeps()
initializeIpcHandlers(shared.deps)

function invoke(channel, payload) {
  const handler = handlers.get(channel)
  assert.ok(handler, `IPC handler not registered: ${channel}`)
  return handler({ sender: {} }, payload)
}

test.after(() => {
  Module._load = originalLoad
  if (originalTsLoader) require.extensions[".ts"] = originalTsLoader
  else delete require.extensions[".ts"]
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test("IPC 初始化注册唯一的处理器集合", () => {
  assert.equal(registeredChannels.length, new Set(registeredChannels).size)
  for (const channel of [
    "log-from-renderer",
    "get-config",
    "update-config",
    "set-opacity",
    "voice-start",
    "get-screenshots",
    "trigger-screenshot",
    "chat-get-session",
    "chat-send-message",
    "chat-cancel",
    "trigger-reset",
    "delete-last-screenshot"
  ]) {
    assert.equal(handlers.has(channel), true, `missing IPC handler: ${channel}`)
  }
})

test("无主窗口或窗口已销毁时，窗口相关 IPC 返回可预测结果", async () => {
  const { deps } = shared

  assert.deepEqual(await invoke("set-opacity", 0.01), {
    success: false,
    opacity: 0.1,
    error: "Main window not available"
  })
  assert.deepEqual(await invoke("open-settings-portal"), {
    success: false,
    error: "Main window not available"
  })
  assert.deepEqual(await invoke("minimize-main-window"), { success: false })
  assert.deepEqual(await invoke("close-main-window"), { success: false })
  assert.deepEqual(await invoke("trigger-screenshot"), {
    error: "No main window available"
  })
  assert.deepEqual(await invoke("toggle-window"), { success: true })

  deps.getMainWindow = () => ({ isDestroyed: () => true })
  assert.deepEqual(await invoke("set-opacity", 0.5), {
    success: false,
    opacity: 0.5,
    error: "Main window not available"
  })
  assert.deepEqual(await invoke("minimize-main-window"), { success: false })
  assert.deepEqual(await invoke("close-main-window"), { success: false })
})

test("缺少可选 helper 时，剪贴板、语音、Chat 和 reset IPC 不会崩溃", async () => {
  const { state } = shared

  assert.deepEqual(await invoke("clipboard-write", 123), {
    success: false,
    error: "复制内容无效"
  })
  assert.deepEqual(await invoke("clipboard-write", "可复制文本"), { success: true })
  assert.deepEqual(clipboardWrites, ["可复制文本"])

  assert.deepEqual(await invoke("voice-start", "system"), undefined)
  assert.equal(await invoke("voice-audio", new Uint8Array()), undefined)
  assert.deepEqual(await invoke("voice-clear"), { success: true })
  assert.deepEqual(await invoke("voice-conversation"), {
    systemTranscript: "",
    microphoneTranscript: "",
    rawMicrophoneTranscript: "",
    removedSegments: 0,
    turns: []
  })

  assert.equal(await invoke("chat-get-session"), null)
  assert.deepEqual(await invoke("chat-list-sessions"), [])
  assert.deepEqual(await invoke("chat-send-message", {
    requestId: "ipc-no-service",
    text: "hello"
  }), { success: false, error: "Chat service unavailable" })
  assert.deepEqual(await invoke("chat-cancel"), { success: true })

  assert.deepEqual(await invoke("trigger-reset"), { success: true })
  assert.equal(state.clears, 1)
  assert.equal(state.view, "queue")
  assert.deepEqual(await invoke("delete-last-screenshot"), {
    success: false,
    error: "No screenshots to delete"
  })
})
