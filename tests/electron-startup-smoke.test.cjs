/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

const assert = require("node:assert/strict")
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const ROOT = path.resolve(__dirname, "..")
const ELECTRON_BINARY = path.join(ROOT, "node_modules", ".bin", "electron")
const MAIN_BUNDLE = path.join(ROOT, "dist-electron", "main.js")

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test("生产构建可完整启动且不会重复注册 IPC handler", {
  skip: process.platform !== "darwin" || process.env.STEAMGAMECODE_RUN_STARTUP_SMOKE !== "1",
  timeout: 20000
}, async (t) => {
  assert.equal(fs.existsSync(ELECTRON_BINARY), true, "Electron binary not found")
  assert.equal(fs.existsSync(MAIN_BUNDLE), true, "dist-electron/main.js not found; run npm run build first")

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "steamgamecode-startup-userdata-"))
  const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "steamgamecode-startup-logs-"))
  const child = spawn(ELECTRON_BINARY, [
    `--user-data-dir=${userData}`,
    "--disable-gpu",
    "./dist-electron/main.js"
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      STEAMGAMECODE_LOG_DIR: logDirectory,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true"
    },
    stdio: ["ignore", "pipe", "pipe"]
  })

  let stdout = ""
  let stderr = ""
  let exited = false
  let exitCode = null
  let exitSignal = null
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  child.on("exit", (code, signal) => {
    exited = true
    exitCode = code
    exitSignal = signal
  })

  t.after(async () => {
    if (!exited) {
      child.kill("SIGTERM")
      await delay(1000)
      if (!exited) child.kill("SIGKILL")
    }
    fs.rmSync(userData, { recursive: true, force: true })
    fs.rmSync(logDirectory, { recursive: true, force: true })
  })

  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (exited) break
    if (stdout.includes("渲染进程加载完成") || stdout.includes("前端已挂载")) break
    await delay(100)
  }

  const output = stdout + stderr
  assert.equal(exited, false, `Electron exited before startup completed (code=${exitCode}, signal=${exitSignal})\n${output}`)
  assert.match(output, /主窗口已创建|主窗口创建完成/, `main window was not created\n${output}`)
  assert.equal(
    /Attempted to register a second handler|App threw an error during load/i.test(output),
    false,
    `duplicate IPC handler detected\n${output}`
  )
  assert.equal(
    /应用启动失败|startup-failure/i.test(output),
    false,
    `application startup failed\n${output}`
  )
})
