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
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steamgamecode-shortcuts-"))
const expectedAccelerators = [
  "CommandOrControl+H",
  "CommandOrControl+Enter",
  "CommandOrControl+R",
  "CommandOrControl+Left",
  "CommandOrControl+Right",
  "CommandOrControl+Down",
  "CommandOrControl+Up",
  "CommandOrControl+Shift+0",
  "CommandOrControl+N",
  "CommandOrControl+B",
  "CommandOrControl+K",
  "CommandOrControl+Alt+Up",
  "CommandOrControl+Alt+Down",
  "CommandOrControl+Q",
  "CommandOrControl+[",
  "CommandOrControl+]",
  "CommandOrControl+-",
  "CommandOrControl+0",
  "CommandOrControl+=",
  "CommandOrControl+L"
]

let nativeInterceptor = null
const electronState = {
  globalRegistrations: [],
  globalHandlers: new Map(),
  unregisterAllCalls: 0,
  appListeners: new Map()
}

const electronMock = {
  app: {
    getPath(name) {
      if (name !== "appData") throw new Error(`Unexpected app path request: ${name}`)
      return tempRoot
    },
    isPackaged: true,
    on(event, listener) {
      const listeners = electronState.appListeners.get(event) || []
      listeners.push(listener)
      electronState.appListeners.set(event, listeners)
    },
    quit() {}
  },
  globalShortcut: {
    register(accelerator, callback) {
      electronState.globalRegistrations.push(accelerator)
      electronState.globalHandlers.set(accelerator, callback)
      return true
    },
    unregisterAll() {
      electronState.unregisterAllCalls += 1
    }
  }
}

const originalLoad = Module._load
const originalTsLoader = require.extensions[".ts"]
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return electronMock
  if (request === "./MacCommandInterceptor") {
    return { getMacCommandInterceptor: () => nativeInterceptor }
  }
  if (request === "openai") return { OpenAI: class OpenAI {} }
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

const { ShortcutsHelper } = require(path.join(ROOT, "electron", "shortcuts.ts"))

function resetElectronState() {
  electronState.globalRegistrations = []
  electronState.globalHandlers = new Map()
  electronState.unregisterAllCalls = 0
  electronState.appListeners = new Map()
}

function createHarness(overrides = {}) {
  const state = {
    toggles: 0,
    screenshotRequests: 0,
    moveLeft: 0,
    resetWindowPosition: 0
  }
  const deps = {
    getMainWindow: () => null,
    takeScreenshot: async () => {
      state.screenshotRequests += 1
      return path.join(tempRoot, "screenshot.png")
    },
    getImagePreview: async () => "preview",
    processingHelper: null,
    chatService: null,
    voiceRecognitionHelper: null,
    getScreenshotQueue: () => [],
    getExtraScreenshotQueue: () => [],
    getView: () => "queue",
    clearQueues: () => {},
    setView: () => {},
    isVisible: () => false,
    toggleMainWindow: () => {
      state.toggles += 1
    },
    moveWindowLeft: () => {
      state.moveLeft += 1
    },
    moveWindowRight: () => {},
    moveWindowUp: () => {},
    moveWindowDown: () => {},
    resetWindowPosition: () => {
      state.resetWindowPosition += 1
    },
    ...overrides
  }

  return {
    helper: new ShortcutsHelper(deps),
    state
  }
}

function quitListeners() {
  return electronState.appListeners.get("will-quit") || []
}

async function waitFor(predicate, timeoutMs = 750) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail("等待快捷键动作超时")
}

test.beforeEach(() => {
  resetElectronState()
  nativeInterceptor = null
})

test.after(() => {
  Module._load = originalLoad
  if (originalTsLoader) require.extensions[".ts"] = originalTsLoader
  else delete require.extensions[".ts"]
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test("无原生拦截器时注册 globalShortcut，Cmd+B 可切换窗口且退出时统一注销", () => {
  const { helper, state } = createHarness()
  helper.registerGlobalShortcuts()

  assert.deepEqual(electronState.globalRegistrations, expectedAccelerators)
  electronState.globalHandlers.get("CommandOrControl+B")()
  assert.equal(state.toggles, 1)

  for (const listener of quitListeners()) listener()
  assert.equal(electronState.unregisterAllCalls, 1)
})

test("原生拦截器可用时不注册 globalShortcut，并为 Cmd+B 提交无修饰键的主键代码 11", { skip: process.platform !== "darwin" }, () => {
  const nativeState = {
    started: 0,
    stopped: 0,
    enabled: null,
    shortcuts: null,
    actions: []
  }
  nativeInterceptor = {
    isTrusted: () => true,
    start() {
      nativeState.started += 1
      return true
    },
    stop() {
      nativeState.stopped += 1
    },
    setEnabled(enabled) {
      nativeState.enabled = enabled
      return true
    },
    requestPermission() {
      return true
    },
    setShortcuts(shortcuts) {
      nativeState.shortcuts = shortcuts
      return true
    },
    setBrowserBundleIds() {
      return true
    },
    pollActions() {
      return nativeState.actions.splice(0)
    }
  }

  const { helper, state } = createHarness()
  helper.registerGlobalShortcuts()

  assert.deepEqual(electronState.globalRegistrations, [])
  assert.equal(nativeState.started, 1)
  assert.equal(nativeState.enabled, true)
  assert.deepEqual(
    nativeState.shortcuts.find((shortcut) => shortcut.action === "CommandOrControl+B"),
    {
      action: "CommandOrControl+B",
      keyCode: 11,
      shift: false,
      option: false,
      control: false
    }
  )

  nativeState.actions.push("CommandOrControl+B")
  return waitFor(() => state.toggles === 1).then(() => {
    for (const listener of quitListeners()) listener()
    assert.equal(nativeState.stopped, 1)

    nativeState.actions.push("CommandOrControl+B")
    return new Promise((resolve) => setTimeout(resolve, 40)).then(() => {
      assert.equal(state.toggles, 1)
    })
  })
})

test("原生权限或启动失败时明确回退到 globalShortcut", { skip: process.platform !== "darwin" }, () => {
  const deniedState = { permissionRequests: 0, starts: 0 }
  nativeInterceptor = {
    isTrusted: () => false,
    start() {
      deniedState.starts += 1
      return true
    },
    stop() {},
    setEnabled: () => true,
    requestPermission() {
      deniedState.permissionRequests += 1
      return false
    },
    setShortcuts: () => true,
    setBrowserBundleIds: () => true,
    pollActions: () => []
  }

  createHarness().helper.registerGlobalShortcuts()
  assert.equal(deniedState.permissionRequests, 1)
  assert.equal(deniedState.starts, 0)
  assert.deepEqual(electronState.globalRegistrations, expectedAccelerators)

  resetElectronState()
  const failedState = { starts: 0 }
  nativeInterceptor = {
    isTrusted: () => true,
    start() {
      failedState.starts += 1
      return false
    },
    stop() {},
    setEnabled: () => true,
    requestPermission: () => true,
    setShortcuts: () => true,
    setBrowserBundleIds: () => true,
    pollActions: () => []
  }

  createHarness().helper.registerGlobalShortcuts()
  assert.equal(failedState.starts, 1)
  assert.deepEqual(electronState.globalRegistrations, expectedAccelerators)
})

test("macOS 原生 tap 保持主动消费完整 Command 链路所需的不变量", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "native", "mac-command-interceptor", "src", "mac_command_interceptor.mm"),
    "utf8"
  )

  assert.match(source, /kCGSessionEventTap/)
  assert.match(source, /kCGHeadInsertEventTap/)
  assert.match(source, /kCGEventTapOptionDefault/)
  assert.match(source, /CGEventMaskBit\(kCGEventKeyDown\)/)
  assert.match(source, /CGEventMaskBit\(kCGEventKeyUp\)/)
  assert.match(source, /CGEventMaskBit\(kCGEventFlagsChanged\)/)
  assert.match(source, /gCommandShortcutConsumed/)
  assert.match(source, /if \(swallow\) return nullptr;/)
  assert.match(source, /com\.google\.Chrome/)
  assert.match(source, /com\.apple\.Safari/)
})
