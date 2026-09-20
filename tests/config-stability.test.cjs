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
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steamgamecode-config-"))
const configDirectory = path.join(tempRoot, "steamgamecode")
const configPath = path.join(configDirectory, "config.json")

const originalLoad = Module._load
const originalTsLoader = require.extensions[".ts"]
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath(name) {
          if (name !== "appData") throw new Error(`Unexpected app path request: ${name}`)
          return tempRoot
        }
      }
    }
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

const { ConfigHelper } = require(path.join(ROOT, "electron", "ConfigHelper.ts"))

function resetConfigPath() {
  fs.rmSync(configDirectory, { recursive: true, force: true })
}

test.after(() => {
  Module._load = originalLoad
  if (originalTsLoader) require.extensions[".ts"] = originalTsLoader
  else delete require.extensions[".ts"]
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test("损坏的 config.json 不阻塞启动，后续更新会恢复为可解析配置", () => {
  resetConfigPath()
  fs.mkdirSync(configDirectory, { recursive: true })
  fs.writeFileSync(configPath, '{"apiProvider":', "utf8")

  const helper = new ConfigHelper()
  const defaults = helper.loadConfig()
  assert.equal(defaults.apiProvider, "gemini")
  assert.equal(defaults.maxOutputTokens, 32768)

  helper.updateConfig({
    apiProvider: "openai-compatible",
    apiKey: "test-key",
    baseURL: "https://example.test/v1",
    maxOutputTokens: 999999,
    contextMessageLimit: 0,
    contextWindowTokens: 1,
    opacity: 0.5
  })

  const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"))
  assert.equal(persisted.apiKey, "test-key")
  assert.equal(persisted.maxOutputTokens, 65536)
  assert.equal(persisted.contextMessageLimit, 30)
  assert.equal(persisted.contextWindowTokens, 8192)

  const restarted = new ConfigHelper().loadConfig()
  assert.equal(restarted.apiKey, "test-key")
  assert.equal(restarted.opacity, 0.5)
})

test("无效 provider、模型和历史语言设置会被安全归一化", () => {
  resetConfigPath()
  fs.mkdirSync(configDirectory, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({
    apiProvider: "invalid-provider",
    extractionModel: "invalid-model",
    solutionModel: "invalid-model",
    debuggingModel: "invalid-model",
    maxOutputTokens: "not-a-number",
    contextMessageLimit: -100,
    contextWindowTokens: "invalid",
    language: "python",
    languageDetectionSource: "auto"
  }), "utf8")

  const config = new ConfigHelper().loadConfig()
  assert.equal(config.apiProvider, "gemini")
  assert.equal(config.extractionModel, "gemini-2.0-flash")
  assert.equal(config.solutionModel, "gemini-2.0-flash")
  assert.equal(config.debuggingModel, "gemini-2.0-flash")
  assert.equal(config.maxOutputTokens, 32768)
  assert.equal(config.contextMessageLimit, 4)
  assert.equal(config.contextWindowTokens, 128000)
  assert.equal(config.language, "auto")
  assert.equal(config.languageDetectionSource, "auto")
})

test("配置路径不可读或不可写时仍返回默认配置而不抛出", () => {
  resetConfigPath()
  fs.mkdirSync(configPath, { recursive: true })

  const helper = new ConfigHelper()
  assert.doesNotThrow(() => helper.loadConfig())
  assert.equal(helper.loadConfig().apiProvider, "gemini")
  assert.doesNotThrow(() => helper.updateConfig({ opacity: 0.5 }))
})
