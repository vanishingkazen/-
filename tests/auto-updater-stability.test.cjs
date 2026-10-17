/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

const assert = require("node:assert/strict")
const EventEmitter = require("node:events")
const test = require("node:test")

const { freshLoad } = require("./helpers/load-ts-module.cjs")

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

function createHarness({ isPackaged, checkForUpdates } = {}) {
  const handlers = new Map()
  const intervals = []
  const downloadCalls = []
  const checkCalls = []
  const quitCalls = []
  const windows = []
  const updater = new EventEmitter()

  updater.autoDownload = true
  updater.autoInstallOnAppQuit = false
  updater.allowDowngrade = false
  updater.allowPrerelease = false
  updater.downloadUpdate = async () => {
    downloadCalls.push(Date.now())
  }
  updater.quitAndInstall = () => {
    quitCalls.push(Date.now())
  }
  updater.checkForUpdates = async () => {
    checkCalls.push(Date.now())
    if (checkForUpdates) return checkForUpdates()
    return { updateInfo: { version: "1.0.20" } }
  }

  const app = { isPackaged }
  const electronMock = {
    app,
    ipcMain: {
      handle(channel, handler) {
        if (handlers.has(channel)) {
          throw new Error(`Attempted to register a second handler for '${channel}'`)
        }
        handlers.set(channel, handler)
      }
    },
    BrowserWindow: {
      getAllWindows: () => windows
    }
  }

  const logger = {
    transports: {
      file: { level: "info" }
    }
  }

  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  globalThis.setInterval = (callback, delay) => {
    const timer = { callback, delay, cleared: false }
    intervals.push(timer)
    return timer
  }
  globalThis.clearInterval = (timer) => {
    if (timer && typeof timer === "object") timer.cleared = true
  }

  let module
  try {
    module = silenceConsole(() => freshLoad("electron/autoUpdater.ts", {
      electron: electronMock,
      "electron-updater": { autoUpdater: updater },
      "electron-log": logger
    }))
    silenceConsole(() => module.initAutoUpdater())
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  }

  return {
    app,
    checkCalls,
    downloadCalls,
    handlers,
    intervals,
    logger,
    quitCalls,
    updater,
    windows,
    async invoke(channel) {
      const handler = handlers.get(channel)
      assert.ok(handler, `missing IPC handler: ${channel}`)
      return silenceConsole(() => handler({}, undefined))
    },
    runIntervals() {
      for (const timer of intervals) {
        if (!timer.cleared) silenceConsole(() => timer.callback())
      }
    }
  }
}

test("开发模式下仍注册更新 IPC，但返回结构化禁用结果且不访问更新服务", async () => {
  const harness = createHarness({ isPackaged: false })

  assert.equal(harness.handlers.has("start-update"), true)
  assert.equal(harness.handlers.has("install-update"), true)
  assert.deepEqual(await harness.invoke("start-update"), {
    success: false,
    error: "Updates are disabled in development"
  })
  assert.deepEqual(await harness.invoke("install-update"), {
    success: false,
    error: "Updates are disabled in development"
  })
  assert.equal(harness.downloadCalls.length, 0)
  assert.equal(harness.quitCalls.length, 0)
  assert.equal(harness.checkCalls.length, 0)
  assert.equal(harness.intervals.length, 0)
})

test("打包模式启用受控更新策略、立即检查并按小时调度，不重复创建检查入口", async () => {
  const harness = createHarness({ isPackaged: true })

  assert.equal(harness.updater.autoDownload, false, "更新必须等待用户显式下载")
  assert.equal(harness.updater.autoInstallOnAppQuit, true)
  assert.equal(harness.updater.allowDowngrade, true)
  assert.equal(harness.updater.allowPrerelease, true)
  assert.equal(harness.updater.logger, harness.logger)
  assert.equal(harness.logger.transports.file.level, "debug")
  assert.equal(harness.checkCalls.length, 1, "初始化后只应立即检查一次")
  assert.equal(harness.intervals.length, 1)
  assert.equal(harness.intervals[0].delay, 60 * 60 * 1000)

  harness.runIntervals()
  assert.equal(harness.checkCalls.length, 2)

  await harness.invoke("start-update")
  assert.equal(harness.downloadCalls.length, 1)
  assert.deepEqual(await harness.invoke("install-update"), { success: true })
  assert.equal(harness.quitCalls.length, 1)
})

test("更新事件只向现存窗口广播，缺失窗口时不会影响主进程事件处理", () => {
  const harness = createHarness({ isPackaged: true })
  const events = []
  harness.windows.push(
    { webContents: { send: (channel, payload) => events.push({ channel, payload }) } },
    { webContents: { send: (channel, payload) => events.push({ channel, payload }) } }
  )
  const available = { version: "1.0.20" }
  const downloaded = { version: "1.0.20", files: [] }

  assert.doesNotThrow(() => harness.updater.emit("update-available", available))
  assert.doesNotThrow(() => harness.updater.emit("update-downloaded", downloaded))
  assert.doesNotThrow(() => harness.updater.emit("checking-for-update"))
  assert.doesNotThrow(() => harness.updater.emit("update-not-available", available))
  assert.doesNotThrow(() => harness.updater.emit("download-progress", { percent: 50 }))
  assert.doesNotThrow(() => harness.updater.emit("error", new Error("network down")))

  assert.deepEqual(events, [
    { channel: "update-available", payload: available },
    { channel: "update-available", payload: available },
    { channel: "update-downloaded", payload: downloaded },
    { channel: "update-downloaded", payload: downloaded }
  ])
})

test("下载失败转换为可展示错误，后续重试仍可成功", async () => {
  const harness = createHarness({ isPackaged: true })
  harness.updater.downloadUpdate = async () => {
    throw new Error("network unavailable")
  }

  assert.deepEqual(await harness.invoke("start-update"), {
    success: false,
    error: "network unavailable"
  })

  harness.updater.downloadUpdate = async () => {
    harness.downloadCalls.push(Date.now())
  }
  assert.deepEqual(await harness.invoke("start-update"), { success: true })
  assert.equal(harness.downloadCalls.length, 1)
})

test("检查更新失败会被收敛，不会产生未处理拒绝或中断定时器", async () => {
  const harness = createHarness({
    isPackaged: true,
    checkForUpdates: async () => {
      throw new Error("temporary check failure")
    }
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.doesNotThrow(() => harness.runIntervals())
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.checkCalls.length, 2)
  assert.equal(harness.intervals[0].cleared, false)
})
