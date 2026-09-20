/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const { freshLoad } = require("./helpers/load-ts-module.cjs")

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steamgamecode-logger-"))
const logDirectory = path.join(tempRoot, "logs")

const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug
}

const originalElectronVersion = process.versions.electron
const originalLogDir = process.env.STEAMGAMECODE_LOG_DIR

let logCalls = []
let openPathResult = ""
let openPathError = null

function record(scope, level, args) {
  logCalls.push({ scope, level, args })
}

function createScope(scope) {
  const make = (level) => (...args) => record(scope, level, args)
  return {
    error: make("error"),
    warn: make("warn"),
    info: make("info"),
    verbose: make("verbose"),
    debug: make("debug"),
    silly: make("silly"),
    log: make("log")
  }
}

const electronLogMock = {
  scope: (scope) => createScope(scope),
  transports: {
    file: {
      level: "",
      maxSize: 0,
      format: "",
      resolvePathFn: null
    },
    console: {
      level: "",
      format: ""
    }
  },
  eventLogger: {
    startLogging: () => record("event", "startLogging", [])
  }
}

const electronMock = {
  app: {
    isPackaged: true,
    getVersion: () => "1.0.19",
    getPath: (name) => {
      if (name === "appData") return tempRoot
      throw new Error(`Unexpected app path request: ${name}`)
    }
  },
  shell: {
    async openPath() {
      return openPathError || openPathResult
    }
  }
}

function loadLogger() {
  logCalls = []
  if (originalElectronVersion === undefined) {
    Object.defineProperty(process.versions, "electron", {
      value: "42.0.0",
      configurable: true,
      enumerable: true
    })
  }
  return freshLoad("electron/logger.ts", {
    electron: electronMock,
    "electron-log/main": electronLogMock
  })
}

function resetLogs() {
  fs.rmSync(logDirectory, { recursive: true, force: true })
  fs.mkdirSync(tempRoot, { recursive: true })
  openPathResult = ""
  openPathError = null
}

function restoreGlobals() {
  if (originalElectronVersion === undefined) {
    delete process.versions.electron
  }
  if (originalLogDir === undefined) delete process.env.STEAMGAMECODE_LOG_DIR
  else process.env.STEAMGAMECODE_LOG_DIR = originalLogDir
  console.log = originalConsole.log
  console.info = originalConsole.info
  console.warn = originalConsole.warn
  console.error = originalConsole.error
  console.debug = originalConsole.debug
}

test.beforeEach(() => {
  restoreGlobals()
  resetLogs()
  process.env.STEAMGAMECODE_LOG_DIR = logDirectory
  if (originalElectronVersion === undefined) {
    Object.defineProperty(process.versions, "electron", {
      value: "42.0.0",
      configurable: true,
      enumerable: true
    })
  }
})

test.afterEach(() => {
  restoreGlobals()
})

test.after(() => {
  restoreGlobals()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test("electron-log 加载失败时降级为仅控制台输出且不阻断启动", () => {
  const failing = freshLoad("electron/logger.ts", {
    electron: electronMock,
    "electron-log/main": null
  })

  const info = failing.getLogInfo()
  assert.equal(info.fileTransportEnabled, false)
  assert.equal(info.fileLevel, "console")
  assert.equal(info.consoleLevel, "console")
  assert.doesNotThrow(() => failing.initializeMainLogging())
  assert.doesNotThrow(() => failing.logFromRenderer("info", "降级日志"))
  assert.equal(fs.existsSync(path.join(logDirectory, "main.log")), false, "无文件传输时不应伪造日志文件")
})

test("初始化会写入启动索引与启动横幅，并可重复调用而不重复记录", () => {
  const logger = loadLogger()

  const info = logger.initializeMainLogging()
  assert.equal(info.fileTransportEnabled, true)
  assert.equal(info.mode, "production")
  assert.equal(info.appVersion, "1.0.19")
  assert.ok(info.runId.length > 0)

  const startupRecords = fs
    .readFileSync(path.join(logDirectory, "startup.log"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
  assert.equal(startupRecords.length, 1)
  assert.match(startupRecords[0], /version=1\.0\.19/)
  assert.match(startupRecords[0], /mode=production/)
  assert.match(startupRecords[0], new RegExp(`run=${info.runId}`))
  assert.match(startupRecords[0], /platform=(darwin|win32|linux)-/)

  const bannerText = logCalls
    .filter((call) => call.scope === `main:${info.runId}`)
    .map((call) => String(call.args[0]))
    .join("\n")
  assert.match(bannerText, /steamgamecode 启动/)
  assert.match(bannerText, /启动参数/)

  logger.initializeMainLogging()
  const afterSecondCall = fs
    .readFileSync(path.join(logDirectory, "startup.log"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
  assert.equal(afterSecondCall.length, 1, "重复初始化不应重复写入启动索引")
})

test("启动索引超过大小上限时轮转为最近 200 行", () => {
  const startupPath = path.join(logDirectory, "startup.log")
  fs.mkdirSync(logDirectory, { recursive: true })
  const filler = Array.from({ length: 400 }, (_, index) => `line-${index}-${"x".repeat(1600)}`)
  fs.writeFileSync(startupPath, `${filler.join("\n")}\n`, "utf8")
  assert.ok(fs.statSync(startupPath).size > 512 * 1024)

  const logger = loadLogger()
  logger.initializeMainLogging()

  const lines = fs
    .readFileSync(startupPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
  assert.ok(lines.length <= 201, `轮转后应保留最近 200 行并追加本次记录，实际 ${lines.length}`)
  assert.ok(lines.length >= 200)
  assert.equal(lines[0], filler[filler.length - 200], "应保留靠后的历史行，丢弃最早记录")
  assert.match(lines[lines.length - 1], /run=/, "轮转后仍应追加本次启动记录")
})

test("主进程 console.* 会镜像进日志，且不会递归写入", () => {
  const logger = loadLogger()
  const info = logger.initializeMainLogging()

  console.log("普通日志")
  console.warn("警告日志")
  console.error("错误日志")
  console.debug("调试日志")

  const mirrored = logCalls.filter((call) => call.scope === `main:${info.runId}`)
  const levels = mirrored.slice(-4).map((call) => call.level)
  const texts = mirrored.slice(-4).map((call) => String(call.args[0]))

  assert.deepEqual(levels, ["info", "warn", "error", "debug"])
  assert.deepEqual(texts, ["普通日志", "警告日志", "错误日志", "调试日志"])
})

test("渲染进程日志会截断超长消息与元数据并按级别转发", () => {
  const logger = loadLogger()
  const info = logger.initializeMainLogging()

  logger.logFromRenderer("warning", "x".repeat(9000), { big: "y".repeat(5000) })
  logger.logFromRenderer("unknown-level", "未知级别", "meta")

  const rendererCalls = logCalls.filter((call) => call.scope === `renderer:${info.runId}`)
  assert.equal(rendererCalls.length, 2)
  assert.equal(rendererCalls[0].level, "warn", "warning 应映射到 warn")
  assert.equal(rendererCalls[1].level, "info", "未知级别应回退到 info")

  assert.equal(rendererCalls[0].args.length, 1, "日志运输层按单行文本写入")
  const line = String(rendererCalls[0].args[0])
  assert.match(line, /已截断 1000 字符/, "超长消息应被截断并标注")
  assert.match(line, /已截断 1010 字符/, "超长元数据应被截断并标注")
  assert.ok(line.length <= 8100 + 4100, `单行日志应同时约束消息与元数据，实际 ${line.length}`)
  assert.ok(line.startsWith("x".repeat(100)), "消息应位于日志行前部")
  assert.ok(line.includes('"big":"y'), "元数据应位于日志行后部")
  assert.equal(rendererCalls[1].level, "info", "未知级别应回退到 info")
  assert.equal(rendererCalls[1].args[0], "未知级别 meta")
})

test("渲染进程日志对 Error 与循环引用对象保持可序列化且不抛异常", () => {
  const logger = loadLogger()
  const info = logger.initializeMainLogging()

  const circular = { name: "loop" }
  circular.self = circular

  assert.doesNotThrow(() => logger.logFromRenderer("error", new Error("boom")))
  assert.doesNotThrow(() => logger.logFromRenderer("info", circular))
  assert.doesNotThrow(() => logger.logFromRenderer("info", undefined, undefined))
  assert.doesNotThrow(() => logger.logFromRenderer("info", ""))

  const rendererCalls = logCalls.filter((call) => call.scope === `renderer:${info.runId}`)
  assert.equal(rendererCalls.length, 2, "空消息应被忽略")
  assert.match(String(rendererCalls[0].args[0]), /boom/)
})

test("webContents 控制台级别映射覆盖 error/warn/info/debug", () => {
  const logger = loadLogger()
  const info = logger.initializeMainLogging()

  logger.logFromRendererConsole(3, "严重错误", "app.js:1")
  logger.logFromRendererConsole(2, "警告", "app.js:2")
  logger.logFromRendererConsole(1, "信息", "app.js:3")
  logger.logFromRendererConsole(0, "调试", "app.js:4")
  logger.logFromRendererConsole(1, "", "")

  const calls = logCalls.filter((call) => call.scope === `renderer:${info.runId}`)
  assert.deepEqual(calls.map((call) => call.level), ["error", "warn", "info", "debug"])
  assert.match(String(calls[0].args[0]), /app\.js:1/)
})

test("openLogDirectory 返回结构化结果，失败时携带错误信息", async () => {
  const logger = loadLogger()

  const success = await logger.openLogDirectory()
  assert.deepEqual(success, { success: true, path: logDirectory })

  openPathResult = "无法打开目录"
  const failure = await logger.openLogDirectory()
  assert.deepEqual(failure, { success: false, path: logDirectory, error: "无法打开目录" })

  openPathResult = ""
  openPathError = "shell 不可用"
  const thrown = await logger.openLogDirectory()
  assert.deepEqual(thrown, { success: false, path: logDirectory, error: "shell 不可用" })
})

test("退出日志包含原因与运行时长", () => {
  const logger = loadLogger()
  const info = logger.initializeMainLogging()

  logger.logShutdown("before-quit")

  const call = logCalls.find((item) => item.scope === `main:${info.runId}` && /应用退出/.test(String(item.args[0])))
  assert.ok(call)
  assert.match(String(call.args[0]), /reason=before-quit/)
  assert.match(String(call.args[0]), /运行时长=\d+ms/)
})
