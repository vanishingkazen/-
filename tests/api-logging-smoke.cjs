/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

/**
 * 模型调用日志在线冒烟（需要真实 API Key，因此不进入 npm test）。
 *
 * 必须在 Electron 主进程下运行，才能同时验证：
 *   console.* → logger → electron-log → main.log 的完整落盘链路
 *
 * 用法：
 *   npm run test:api-log
 *   STEAMGAMECODE_LOG_DIR=~/Library/Logs/steamgamecode npm run test:api-log
 *
 * 默认写入临时目录，避免污染正式日志；覆盖 STEAMGAMECODE_LOG_DIR 可写入正式目录。
 */
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { app } = require("electron")

const ROOT = path.resolve(__dirname, "..")
const REAL_CONFIG_PATH = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "steamgamecode",
  "config.json"
)

const defaultLogDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "steamgamecode-api-log-"))
const logDirectory = process.env.STEAMGAMECODE_LOG_DIR || defaultLogDirectory
process.env.STEAMGAMECODE_LOG_DIR = logDirectory

const checks = []
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail })
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function redact(text, config) {
  let value = String(text || "")
  for (const secret of [config.apiKey, config.solutionApiKey]) {
    if (secret) value = value.replaceAll(secret, "[redacted]")
  }
  return value
}

function baseConfig(raw) {
  return {
    apiProvider: raw.apiProvider || "openai-compatible",
    apiKey: raw.apiKey || "",
    baseURL: raw.baseURL || "",
    extractionModel: raw.extractionModel || "gpt-4o",
    solutionModel: raw.solutionModel || "",
    maxOutputTokens: raw.maxOutputTokens || 32768,
    streamingEnabled: raw.streamingEnabled !== false
  }
}

function request(config, content, extra = {}) {
  return {
    config,
    system: "你是一个测试助手，只按要求回答。",
    history: [],
    openaiMessages: [{ role: "user", content }],
    signal: extra.signal || new AbortController().signal,
    ...extra
  }
}

async function main() {
  if (!fs.existsSync(REAL_CONFIG_PATH)) {
    console.error(`未找到真实配置：${REAL_CONFIG_PATH}`)
    return 2
  }
  const rawConfig = JSON.parse(fs.readFileSync(REAL_CONFIG_PATH, "utf8"))

  const { initializeMainLogging, MAIN_LOG_PATH } = require(path.join(ROOT, "dist-electron", "logger.js"))
  initializeMainLogging()
  const { ChatProvider } = require(path.join(ROOT, "dist-electron", "ChatProvider.js"))
  const provider = new ChatProvider()

  console.log(`provider=${rawConfig.apiProvider} model=${rawConfig.extractionModel} log=${MAIN_LOG_PATH}`)

  // 1) 正常调用：应记录请求行 + 含 usage 的响应行
  const config = baseConfig(rawConfig)
  const okRequest = request({ ...config, maxOutputTokens: 1024 }, "只回复两个字：收到")
  try {
    const result = await provider.generateReply(okRequest)
    check("正常调用返回正文", result.content.trim().length > 0, `content=${JSON.stringify(result.content.slice(0, 40))}`)
  } catch (error) {
    check("正常调用返回正文", false, redact(error && error.message, rawConfig))
  }

  // 2) 复现空正文：max_tokens 过小，思考吃光预算 → finish_reason=length
  const truncated = request(
    { ...config, maxOutputTokens: 64 },
    "请逐步推理：一个三位数，各位数字之和为 15，百位比十位大 2，十位比个位大 1，求这个三位数。"
  )
  try {
    const result = await provider.generateReply(truncated)
    check("截断场景抛出明确错误", false, `竟然返回了正文：${JSON.stringify(result.content.slice(0, 40))}`)
  } catch (error) {
    check(
      "截断场景抛出明确错误",
      /思考过长|没有返回正文/.test(error.message),
      redact(error.message, rawConfig).slice(0, 80)
    )
  }

  // 3) 用户取消
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 400)
  try {
    await provider.generateReply(request(config, "讲一个很长的故事", { signal: controller.signal }))
    check("取消场景记录已取消", false, "取消后仍返回了正文")
  } catch (error) {
    check("取消场景抛出中断错误", /abort/i.test(error.name || "") || /中断|取消|abort/i.test(error.message), error.name)
  }

  // 4) 鉴权失败
  try {
    await provider.generateReply(request({ ...config, apiKey: "sk-invalid-for-logging-smoke" }, "只回复ok"))
    check("鉴权失败场景", false, "无效 key 竟然成功")
  } catch (error) {
    check("鉴权失败抛出错误", Boolean(error && error.message), redact(error.message, rawConfig).slice(0, 60))
  }

  // 等 electron-log 落盘
  await delay(800)

  const logText = fs.existsSync(MAIN_LOG_PATH) ? fs.readFileSync(MAIN_LOG_PATH, "utf8") : ""
  const apiLines = logText.split("\n").filter((line) => line.includes("[api]"))

  console.log("\n================ 新日志实际内容 ================")
  for (const line of apiLines) console.log(line)
  console.log("===============================================\n")

  check("日志写入文件", logText.length > 0, MAIN_LOG_PATH)
  check("记录了请求行", apiLines.some((line) => line.includes("[api] ->")))
  check("记录了响应行", apiLines.some((line) => line.includes("[api] <-")))
  check("响应行包含 finish_reason", apiLines.some((line) => /finish=\w+/.test(line)))
  check("响应行包含 usage（含 reasoning）", apiLines.some((line) => /usage=\{[^}]*reasoning=/.test(line)))
  check("截断场景出现空正文告警", apiLines.some((line) => line.includes("空正文")))
  check("空正文告警带输出预算占比", apiLines.some((line) => /输出 token \(\d+%\)|输出 token/.test(line)))
  check("取消场景记为已取消", apiLines.some((line) => line.includes("已取消")))
  check("失败场景记录错误", apiLines.some((line) => line.includes("[api] !!") && line.includes("失败")))
  check("正文预览被记录", apiLines.some((line) => line.includes("preview=")))

  const failed = checks.filter((item) => !item.ok)
  console.log(`\n结果：${checks.length - failed.length}/${checks.length} 项通过`)
  if (failed.length) console.log(`未通过：${failed.map((item) => item.name).join("；")}`)
  if (!process.env.STEAMGAMECODE_LOG_DIR) {
    console.log(`临时日志目录：${defaultLogDirectory}`)
  }
  return failed.length ? 1 : 0
}

app.whenReady().then(async () => {
  if (app.dock && typeof app.dock.hide === "function") app.dock.hide()
  let code = 1
  try {
    code = await main()
  } catch (error) {
    console.error("冒烟异常：", error && error.stack ? error.stack : error)
  } finally {
    app.exit(code)
  }
})
