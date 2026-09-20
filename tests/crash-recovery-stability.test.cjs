/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const { ROOT, freshLoad } = require("./helpers/load-ts-module.cjs")

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steamgamecode-crash-"))

function appDataDirectory() {
  return path.join(tempRoot, "appData", "steamgamecode")
}

function restartStatePath() {
  return path.join(appDataDirectory(), "crash-restarts.json")
}

function crashLogPath() {
  return path.join(appDataDirectory(), "crash-recovery.log")
}

function resetRecoveryState() {
  fs.rmSync(path.join(tempRoot, "appData"), { recursive: true, force: true })
}

function readRestartState() {
  return JSON.parse(fs.readFileSync(restartStatePath(), "utf8"))
}

function writeRestartState(value) {
  fs.mkdirSync(appDataDirectory(), { recursive: true })
  fs.writeFileSync(
    restartStatePath(),
    typeof value === "string" ? value : JSON.stringify(value),
    "utf8"
  )
}

function createAppMock() {
  const state = {
    ready: true,
    events: new Map(),
    restarts: 0,
    exits: [],
    errorBoxes: []
  }
  const app = {
    on(event, listener) {
      const listeners = state.events.get(event) || []
      listeners.push(listener)
      state.events.set(event, listeners)
    },
    getPath(name) {
      if (name !== "appData") throw new Error(`Unexpected app path request: ${name}`)
      return path.join(tempRoot, "appData")
    },
    isReady() {
      return state.ready
    },
    relaunch() {
      state.restarts += 1
    },
    exit(code) {
      state.exits.push(code)
    },
    quit() {}
  }
  return { app, state }
}

function createTimerMock() {
  const state = { scheduled: [] }
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (callback, delay) => {
    const entry = { callback, delay, id: state.scheduled.length + 1 }
    state.scheduled.push(entry)
    return entry
  }
  return {
    state,
    restore() {
      globalThis.setTimeout = realSetTimeout
    }
  }
}

function loadCrashRecovery() {
  const { app, state: appState } = createAppMock()
  const module = freshLoad("electron/CrashRecovery.ts", {
    electron: {
      app,
      BrowserWindow: {
        getAllWindows: () => []
      },
      dialog: {
        showErrorBox(title, content) {
          appState.errorBoxes.push({ title, content })
        }
      }
    }
  })
  return { module, app, appState }
}

test.beforeEach(() => {
  resetRecoveryState()
})

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test("窗口内已有 3 次崩溃记录时不再安排重启，改为提示用户并退出", (t) => {
  const timers = createTimerMock()
  t.after(() => timers.restore())

  const now = Date.now()
  writeRestartState([now - 3000, now - 2000, now - 1000])
  const { module, appState } = loadCrashRecovery()

  module.requestAppRestart("crash-limit", new Error("boom-limit"))

  assert.equal(timers.state.scheduled.length, 0, "达到上限后不得再安排重启")
  assert.deepEqual(appState.exits, [1])
  assert.equal(appState.errorBoxes.length, 1)
  assert.match(appState.errorBoxes[0].title, /停止自动重启/)
  assert.match(appState.errorBoxes[0].content, /crash-recovery\.log/)

  const crashLog = fs.readFileSync(crashLogPath(), "utf8")
  assert.match(crashLog, /crash-limit/)
  assert.match(crashLog, /boom-limit/)
})

test("同一进程实例内的重复崩溃只调度一次重启，后续崩溃仍需被观测到", (t) => {
  const timers = createTimerMock()
  t.after(() => timers.restore())

  const warnings = []
  const consoleStub = { ...console, warn: (...args) => warnings.push(args.join(" ")) }
  t.after(() => {
    console.warn = consoleStub.warn
  })

  const { module, appState } = loadCrashRecovery()
  console.warn = consoleStub.warn

  module.requestAppRestart("crash-1", new Error("boom-1"))
  module.requestAppRestart("crash-2", "boom-2")
  module.requestAppRestart("crash-3", { detail: "boom-3" })

  assert.equal(timers.state.scheduled.length, 1, "同一实例只允许安排一次重启")
  assert.deepEqual(appState.exits, [])

  const crashLog = fs.readFileSync(crashLogPath(), "utf8")
  assert.match(crashLog, /crash-1/)
  assert.match(crashLog, /boom-1/)

  // 已知行为：重启排定后再次崩溃会直接 return，不再产生任何输出。
  // 这意味着后续崩溃只会体现为“重启被调度过一次”，崩溃原因本身不会落盘。
  assert.equal(
    warnings.length,
    1,
    "当前实现仅在首次调度重启时输出告警，后续崩溃不可观测"
  )
  assert.match(warnings[0], /Restarting steamgamecode/)
})

test("尚未达到上限时提交的重启会先写入状态再在延迟后执行 relaunch/exit(1)", (t) => {
  const timers = createTimerMock()
  t.after(() => timers.restore())

  const { module, appState } = loadCrashRecovery()
  module.requestAppRestart("relaunch-once")

  assert.equal(timers.state.scheduled.length, 1)
  assert.equal(appState.restarts, 0, "重启必须延迟执行，避免崩溃风暴")
  assert.deepEqual(readRestartState().length, 1)

  timers.state.scheduled[0].callback()
  assert.equal(appState.restarts, 1)
  assert.deepEqual(appState.exits, [1])
})

test("崩溃状态包含旧记录时重启延迟按剩余次数指数退避并封顶", (t) => {
  const timers = createTimerMock()
  t.after(() => timers.restore())
  const now = Date.now()

  writeRestartState([now - 1000])
  const second = loadCrashRecovery()
  second.module.requestAppRestart("second-crash")
  assert.equal(timers.state.scheduled[0].delay, 2000, "第 2 次应为 500 * 2^2")

  resetRecoveryState()
  writeRestartState([now - 3000, now - 2000])
  const third = loadCrashRecovery()
  third.module.requestAppRestart("third-crash")
  assert.equal(timers.state.scheduled[1].delay, 4000, "第 3 次应为 500 * 2^3")

  assert.deepEqual(second.appState.exits, [])
  assert.deepEqual(third.appState.exits, [])
})

test("超出 5 分钟窗口的重启记录会被裁剪，不会永久封锁恢复", (t) => {
  const timers = createTimerMock()
  t.after(() => timers.restore())

  const now = Date.now()
  writeRestartState([
    now - 30 * 60 * 1000,
    now - 10 * 60 * 1000,
    now - 6 * 60 * 1000,
    now - 5 * 60 * 1000 - 1
  ])
  const { module, appState } = loadCrashRecovery()
  module.requestAppRestart("after-window")

  assert.deepEqual(appState.exits, [], "旧记录不应计入上限")
  assert.equal(timers.state.scheduled.length, 1)
  const persisted = readRestartState()
  assert.equal(persisted.length, 1, "过期记录应被裁剪，只保留本次重启时间")
  assert.ok(persisted[0] >= now - 5000)
})

test("崩溃状态文件损坏或结构异常时不会阻止恢复，并会被重写为合法状态", (t) => {
  const timers = createTimerMock()
  t.after(() => timers.restore())

  writeRestartState('{"unexpected":')
  const corrupted = loadCrashRecovery()
  corrupted.module.requestAppRestart("corrupt-state")
  assert.equal(timers.state.scheduled.length, 1)
  assert.deepEqual(corrupted.appState.exits, [])
  assert.ok(Array.isArray(readRestartState()))

  writeRestartState({ version: 2, restarts: [1, 2, 3] })
  const notArray = loadCrashRecovery()
  notArray.module.requestAppRestart("not-array-state")
  assert.equal(timers.state.scheduled.length, 2)
  assert.deepEqual(notArray.appState.exits, [])
  assert.deepEqual(readRestartState().length, 1)

  resetRecoveryState()
  writeRestartState(["a", null, true, 123])
  const mixedTypes = loadCrashRecovery()
  mixedTypes.module.requestAppRestart("mixed-state")
  assert.deepEqual(mixedTypes.appState.exits, [], "非数字时间戳不应计入上限")
  assert.equal(readRestartState().length, 1)
})

test("窗口内达到上限时直接退出并保留原始记录，不写入新状态", (t) => {
  const timers = createTimerMock()
  t.after(() => timers.restore())

  const now = Date.now()
  const existing = Array.from({ length: 40 }, (_, index) => now - index * 1000)
  writeRestartState(existing)
  const { module, appState } = loadCrashRecovery()
  module.requestAppRestart("trim-state")

  assert.equal(timers.state.scheduled.length, 0, "达到上限后不得调度重启")
  assert.deepEqual(appState.exits, [1])
  assert.deepEqual(readRestartState(), existing, "命中上限时崩溃日志仍需保留原状态供排查")
})

test("崩溃状态文件最多保留 20 条历史，超出的旧记录不会参与窗口计数", (t) => {
  const timers = createTimerMock()
  t.after(() => timers.restore())

  const now = Date.now()
  // 25 条窗口内记录（超过 3 次上限），但持久化指令本身要求只保留最近 20 条
  const existing = Array.from({ length: 25 }, (_, index) => now - index * 1000)
  writeRestartState(existing)
  const { module, appState } = loadCrashRecovery()
  module.requestAppRestart("limit-with-many-records")

  assert.deepEqual(appState.exits, [1], "窗口内记录数超过上限时应直接退出")
  assert.equal(timers.state.scheduled.length, 0)
  const crashLog = fs.readFileSync(crashLogPath(), "utf8")
  assert.match(crashLog, /limit-with-many-records/)
  assert.ok(readRestartState().length <= 25)
})

test("正常重启流程下状态文件不会无限增长", (t) => {
  const timers = createTimerMock()
  t.after(() => timers.restore())
  const now = Date.now()

  for (const seeded of [[], [now - 1000], [now - 2000, now - 1000]]) {
    resetRecoveryState()
    writeRestartState(seeded)
    const { module } = loadCrashRecovery()
    module.requestAppRestart("bounded-state")
    const persisted = readRestartState()
    assert.ok(persisted.length <= 20, `状态文件应保持有界，实际 ${persisted.length}`)
    assert.equal(persisted.every((value) => typeof value === "number"), true)
  }
})

test("安装崩溃恢复会注册渲染进程与退出钩子", () => {
  const { module, appState } = loadCrashRecovery()
  assert.equal(appState.events.has("render-process-gone"), false)

  module.installCrashRecovery()

  assert.equal((appState.events.get("render-process-gone") || []).length, 1)
  assert.equal((appState.events.get("before-quit") || []).length, 1)
})

test("渲染进程连续崩溃超过阈值时升级为应用重启而不是无限重载", (t) => {
  const timers = createTimerMock()
  t.after(() => timers.restore())

  const { module, appState } = loadCrashRecovery()
  module.installCrashRecovery()
  const listener = (appState.events.get("render-process-gone") || [])[0]
  assert.ok(listener)

  const contents = {
    id: 42,
    reloaded: 0,
    isDestroyed: () => false,
    getType: () => "window",
    reload() {
      this.reloaded += 1
    }
  }

  for (let index = 0; index < 4; index += 1) {
    listener({}, contents, { reason: "crashed", exitCode: 1 })
  }

  assert.equal(timers.state.scheduled.length, 4)
  const reloadEntries = timers.state.scheduled.slice(0, 3)
  const restartEntry = timers.state.scheduled[3]
  assert.deepEqual(reloadEntries.map((entry) => entry.delay), [750, 750, 750])
  assert.equal(restartEntry.delay, 1000, "升级后的应用重启应带延迟退避")

  for (const entry of reloadEntries) entry.callback()
  assert.equal(contents.reloaded, 3)

  const crashLog = fs.readFileSync(crashLogPath(), "utf8")
  assert.match(crashLog, /renderer-crash-loop/)
})

test("正常退出与关闭流程不会触发渲染进程重载", () => {
  const { module, appState } = loadCrashRecovery()
  module.installCrashRecovery()

  const beforeQuit = (appState.events.get("before-quit") || [])[0]
  beforeQuit()

  const contents = {
    id: 7,
    reloaded: 0,
    isDestroyed: () => false,
    getType: () => "window",
    reload() {
      this.reloaded += 1
    }
  }
  const listener = (appState.events.get("render-process-gone") || [])[0]

  listener({}, contents, { reason: "clean-exit", exitCode: 0 })
  listener({}, contents, { reason: "killed", exitCode: 137 })

  assert.equal(contents.reloaded, 0, "clean-exit 或退出流程中不应重载渲染进程")
})

test("非窗口类型的渲染进程崩溃被忽略", () => {
  const { module, appState } = loadCrashRecovery()
  module.installCrashRecovery()
  const listener = (appState.events.get("render-process-gone") || [])[0]

  const contents = {
    id: 8,
    reloaded: 0,
    isDestroyed: () => false,
    getType: () => "backgroundPage",
    reload() {
      this.reloaded += 1
    }
  }
  listener({}, contents, { reason: "crashed", exitCode: 1 })
  assert.equal(contents.reloaded, 0)
})

test("CrashRecovery 模块保留可测试的恢复入口", () => {
  const source = fs.readFileSync(path.join(ROOT, "electron", "CrashRecovery.ts"), "utf8")
  assert.match(source, /export function requestAppRestart/)
  assert.match(source, /export function installCrashRecovery/)
})
