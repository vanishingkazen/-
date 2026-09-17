/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

const fs = require("node:fs")
const Module = require("node:module")
const os = require("node:os")
const path = require("node:path")
const ts = require("typescript")

const ROOT = path.resolve(__dirname, "..")
const realConfigPath = path.join(os.homedir(), "Library", "Application Support", "steamgamecode", "config.json")
if (!fs.existsSync(realConfigPath)) {
  console.error(`未找到真实配置：${realConfigPath}`)
  process.exit(2)
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steamgamecode-chat-live-"))
const appDataPath = path.join(tempRoot, "appData")
const configDirectory = path.join(appDataPath, "steamgamecode")
fs.mkdirSync(configDirectory, { recursive: true })
fs.copyFileSync(realConfigPath, path.join(configDirectory, "config.json"))

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
const config = configHelper.loadConfig()

function redact(value) {
  let text = value instanceof Error ? value.message : String(value)
  if (config.apiKey) text = text.replaceAll(config.apiKey, "[redacted]")
  if (config.solutionApiKey) text = text.replaceAll(config.solutionApiKey, "[redacted]")
  return text
}

function imagePath(name) {
  const source = path.join(ROOT, "assets", "icons", "png", name)
  const target = path.join(tempRoot, name)
  fs.copyFileSync(source, target)
  return target
}

async function main() {
  const events = []
  const mainWindow = {
    webContents: {
      send(channel, payload) {
        events.push({ channel, payload, at: Date.now() })
      }
    }
  }
  const service = new ChatService({ getMainWindow: () => mainWindow })
  const results = []

  async function runScenario(name, sessionId, text, images = []) {
    const startedAt = Date.now()
    const requestId = `${name}-${Date.now()}`
    const beforeStreamEvents = events.filter((event) => event.channel === "chat-stream").length
    const result = await service.sendMessage(sessionId, text, images, requestId)
    const streamEvents = events
      .filter((event) => event.channel === "chat-stream")
      .slice(beforeStreamEvents)
    const firstStreamAt = streamEvents[0]?.at || Date.now()
    const durationMs = Date.now() - startedAt
    results.push({
      name,
      success: Boolean(result.success && result.content?.trim()),
      durationMs,
      firstTokenMs: result.success ? firstStreamAt - startedAt : null,
      contentLength: result.content?.length || 0,
      contentPreview: result.content?.slice(0, 120) || "",
      error: result.error || ""
    })
  }

  const multiTurnSession = service.createSession()
  await runScenario("多轮-第一轮", multiTurnSession.id, "请只回复：第一轮正常")
  await runScenario("多轮-第二轮", multiTurnSession.id, "请结合上一轮，只回复：第二轮正常")

  const longSession = service.createSession()
  const longText = `以下内容仅用于长文本稳定性测试，请确认能够接收，并只回复：长文本正常。\n${"长文本稳定性输入。".repeat(1200)}`
  await runScenario("长文本", longSession.id, longText)

  const imageSession = service.createSession()
  await runScenario("多图片", imageSession.id, "请只回复你收到的图片数量。", [
    { path: imagePath("icon-32x32.png") },
    { path: imagePath("icon-64x64.png") }
  ])

  console.log(JSON.stringify({
    provider: config.apiProvider,
    model: config.extractionModel,
    baseURL: config.baseURL || "(provider default)",
    results
  }, null, 2))

  const failed = results.filter((result) => !result.success)
  if (failed.length) {
    console.error(`在线冒烟失败：${failed.map((result) => `${result.name}: ${redact(result.error || "空响应")}`).join("；")}`)
    process.exitCode = 1
  }
}

main()
  .catch((error) => {
    console.error(`在线冒烟异常：${redact(error)}`)
    process.exitCode = 1
  })
  .finally(() => {
    Module._load = originalLoad
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })
