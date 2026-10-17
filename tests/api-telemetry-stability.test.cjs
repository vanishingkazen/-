/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const { loadTsModule, freshLoad } = require("./helpers/load-ts-module.cjs")

/**
 * 捕获 console 输出，验证模型 API 遥测日志的内容。
 * 遥测只依赖 console.*，由 logger 的 console 补丁统一落盘。
 */
function captureConsole() {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error
  }
  const lines = { info: [], warn: [], error: [], log: [] }
  const record = (level) => (...args) => {
    lines[level].push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "))
  }
  console.log = record("log")
  console.info = record("info")
  console.warn = record("warn")
  console.error = record("error")
  return {
    lines,
    all: () => [...lines.info, ...lines.warn, ...lines.error, ...lines.log].join("\n"),
    restore: () => Object.assign(console, original)
  }
}

function loadTelemetry() {
  return loadTsModule("electron/ApiTelemetry.ts")
}

test("正常响应会记录请求参数与 usage（含推理 token）", () => {
  const telemetry = loadTelemetry()
  const capture = captureConsole()
  try {
    const tracker = telemetry.beginApiCall({
      kind: "chat",
      provider: "openai-compatible",
      model: "deepseek-flash",
      baseURL: "https://api.deepseek.com",
      stream: true,
      maxTokens: 32768,
      temperature: 0.2,
      messageCount: 2,
      imageCount: 1
    })
    tracker.noteStreamChunk({ reasoningContent: "思考中" })
    tracker.noteStreamChunk({ content: "答案：4" })
    tracker.finish({
      content: "答案：4",
      finishReason: "stop",
      usage: {
        prompt_tokens: 545,
        completion_tokens: 5357,
        total_tokens: 5902,
        completion_tokens_details: { reasoning_tokens: 5219 },
        prompt_tokens_details: { cached_tokens: 384 }
      }
    })
  } finally {
    capture.restore()
  }

  const text = capture.all()
  assert.match(text, /\[api\] -> #0001 请求/)
  assert.match(text, /kind=chat/)
  assert.match(text, /model=deepseek-flash/)
  assert.match(text, /host=api\.deepseek\.com/)
  assert.match(text, /max_tokens=32768/)
  assert.match(text, /messages=2 images=1/)
  assert.match(text, /\[api\] <- #0001 响应/)
  assert.match(text, /finish=stop/)
  assert.match(text, /reasoning=5219/)
  assert.match(text, /cached=384/)
  assert.match(text, /content_chars=4/)
  assert.match(text, /preview="答案：4"/)
})

test("空正文且 finish_reason=length 会给出可定位的告警", () => {
  const telemetry = loadTelemetry()
  const capture = captureConsole()
  try {
    const tracker = telemetry.beginApiCall({
      kind: "chat",
      model: "deepseek-flash",
      stream: true,
      maxTokens: 32768
    })
    tracker.noteStreamChunk({ reasoningContent: "很长很长的思考" })
    tracker.finish({
      content: "",
      finishReason: "length",
      usage: {
        completion_tokens: 32768,
        completion_tokens_details: { reasoning_tokens: 32768 }
      }
    })
  } finally {
    capture.restore()
  }

  const text = capture.all()
  assert.match(text, /空正文/)
  assert.match(text, /finish_reason=length/)
  assert.match(text, /32768\/32768/)
  assert.match(text, /100%/)
  assert.ok(
    capture.lines.warn.some((line) => line.includes("提高 maxOutputTokens")),
    "告警应给出可执行的修复建议"
  )
})

test("空正文但 finish_reason 正常时同样会告警", () => {
  const telemetry = loadTelemetry()
  const capture = captureConsole()
  try {
    const tracker = telemetry.beginApiCall({ kind: "chat", model: "m", maxTokens: 2048 })
    tracker.finish({ content: "   ", finishReason: "stop", usage: { completion_tokens: 3 } })
  } finally {
    capture.restore()
  }
  const text = capture.all()
  assert.match(text, /空正文/)
  assert.match(text, /finish_reason=stop/)
})

test("正文被截断与思考接近上限都会记录告警", () => {
  const telemetry = loadTelemetry()
  const capture = captureConsole()
  try {
    telemetry
      .beginApiCall({ kind: "chat", model: "m", maxTokens: 1000 })
      .finish({ content: "半截答案", finishReason: "length", usage: { completion_tokens: 1000 } })
    telemetry
      .beginApiCall({ kind: "chat", model: "m", maxTokens: 1000 })
      .finish({
        content: "完整答案",
        finishReason: "stop",
        usage: { completion_tokens: 950, completion_tokens_details: { reasoning_tokens: 940 } }
      })
  } finally {
    capture.restore()
  }
  const warnings = capture.lines.warn.join("\n")
  assert.match(warnings, /正文被截断/)
  assert.match(warnings, /思考接近输出上限/)
  assert.match(warnings, /94%/)
})

test("失败与取消分别记录错误信息，且不抛出", () => {
  const telemetry = loadTelemetry()
  const capture = captureConsole()
  try {
    const failed = telemetry.beginApiCall({ kind: "vision", model: "m" })
    failed.noteStreamChunk({ content: "部分" })
    failed.fail(new Error("connect ECONNREFUSED"))
    const aborted = telemetry.beginApiCall({ kind: "chat", model: "m" })
    const abortError = new Error("aborted")
    abortError.name = "AbortError"
    aborted.fail(abortError)
    // 重复结束不应重复写日志
    failed.fail(new Error("dup"))
  } finally {
    capture.restore()
  }

  const text = capture.all()
  assert.match(text, /失败/)
  assert.match(text, /ECONNREFUSED/)
  assert.match(text, /received_content_chars=2/)
  assert.match(text, /已取消/)
  assert.equal(capture.lines.error.length, 1, "重复 fail 不应重复写入 error 日志")
  assert.equal(capture.lines.warn.length, 1, "取消应记为 warn")
})

test("兼容 Anthropic 的 input/output token 字段", () => {
  const telemetry = loadTelemetry()
  const capture = captureConsole()
  try {
    telemetry
      .beginApiCall({ kind: "chat", provider: "anthropic", model: "claude" })
      .finish({ content: "答案", finishReason: "end_turn", usage: { input_tokens: 120, output_tokens: 45 } })
  } finally {
    capture.restore()
  }
  const text = capture.all()
  assert.match(text, /prompt=120/)
  assert.match(text, /completion=45/)
  assert.match(text, /finish=end_turn/)
})

test("noteUsage 可补全流式响应缺失的 usage", () => {
  const telemetry = loadTelemetry()
  const capture = captureConsole()
  try {
    const tracker = telemetry.beginApiCall({ kind: "followup", model: "m", stream: true, maxTokens: 100 })
    tracker.noteStreamChunk({ content: "正文" })
    tracker.noteUsage({ completion_tokens: 88, completion_tokens_details: { reasoning_tokens: 80 } })
    tracker.finish({ content: "正文", finishReason: "stop" })
  } finally {
    capture.restore()
  }
  assert.match(capture.all(), /reasoning=80/)
})

test("异常输入不会让遥测抛错（日志失败不影响主流程）", () => {
  const telemetry = loadTelemetry()
  const capture = captureConsole()
  try {
    assert.doesNotThrow(() => {
      const tracker = telemetry.beginApiCall({ kind: "chat" })
      tracker.noteStreamChunk(undefined)
      tracker.finish({ content: null, usage: "not-an-object" })
      telemetry.beginApiCall({ kind: "chat" }).fail(undefined)
      telemetry.beginApiCall({ kind: "chat" }).fail({ weird: true })
    })
  } finally {
    capture.restore()
  }
})

test("withApiCall 成功时记录响应，失败时记录错误并继续抛出", async () => {
  const telemetry = loadTelemetry()
  const capture = captureConsole()
  try {
    const result = await telemetry.withApiCall(
      { kind: "chat", model: "m" },
      async () => ({ text: "ok" }),
      (value) => ({ content: value.text, finishReason: "stop" })
    )
    assert.equal(result.text, "ok")

    await assert.rejects(
      telemetry.withApiCall(
        { kind: "chat", model: "m" },
        async () => {
          throw new Error("boom")
        }
      ),
      /boom/
    )
  } finally {
    capture.restore()
  }
  const text = capture.all()
  assert.match(text, /preview="ok"/)
  assert.match(text, /boom/)
})

/** 用假的 OpenAI 客户端加载真实的 ChatProvider，验证遥测接入是否生效 */
function loadChatProvider(streamFactory) {
  const calls = []
  class MockOpenAI {
    constructor(options) {
      this.options = options
      this.chat = {
        completions: {
          create: async (body) => {
            calls.push(body)
            return streamFactory(body)
          }
        }
      }
    }
  }
  const { ChatProvider } = freshLoad("electron/ChatProvider.ts", {
    openai: { OpenAI: MockOpenAI },
    "./ChatImageUtils": { imageDataUrl: () => null }
  })
  return { provider: new ChatProvider(), calls }
}

function chatRequest(overrides = {}) {
  return {
    config: {
      apiProvider: "openai-compatible",
      apiKey: "test-key",
      baseURL: "https://api.deepseek.com",
      extractionModel: "deepseek-flash",
      maxOutputTokens: 32768,
      streamingEnabled: true
    },
    system: "system",
    history: [],
    openaiMessages: [{ role: "user", content: "这题怎么做" }],
    signal: new AbortController().signal,
    ...overrides
  }
}

test("ChatProvider 流式链路会写出请求行与含 usage 的响应行", async () => {
  const { provider, calls } = loadChatProvider(async () =>
    (async function* streamWithUsage() {
      yield { choices: [{ delta: { reasoning_content: "先算一下" } }] }
      yield { choices: [{ delta: { content: "答案：4" } }] }
      yield {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 545,
          completion_tokens: 5357,
          completion_tokens_details: { reasoning_tokens: 5219 }
        }
      }
    })()
  )

  const capture = captureConsole()
  try {
    const result = await provider.generateReply(chatRequest())
    assert.equal(result.content, "答案：4")
    assert.equal(result.streamed, true)
  } finally {
    capture.restore()
  }

  const text = capture.all()
  assert.match(text, /\[api\] -> #\d+ 请求 kind=chat/)
  assert.match(text, /model=deepseek-flash/)
  assert.match(text, /host=api\.deepseek\.com/)
  assert.match(text, /\[api\] <- #\d+ 响应 kind=chat/)
  assert.match(text, /finish=stop/)
  assert.match(text, /reasoning=5219/)
  // include_usage 必须开启，否则流式拿不到 reasoning token 数
  assert.equal(calls[0].stream_options.include_usage, true)
})

test("ChatProvider 空正文时既不吞掉错误，也留下可定位的告警", async () => {
  const { provider } = loadChatProvider(async () =>
    (async function* reasoningOnly() {
      yield { choices: [{ delta: { reasoning_content: "想很久" } }] }
      yield { choices: [{ delta: {}, finish_reason: "length" }] }
    })()
  )

  const capture = captureConsole()
  let error = null
  try {
    await provider.generateReply(chatRequest())
  } catch (caught) {
    error = caught
  } finally {
    capture.restore()
  }

  assert.ok(error, "空正文必须抛出而不是静默返回空串")
  assert.match(error.message, /思考过长/)
  assert.match(error.message, /finish_reason=length/)

  const text = capture.all()
  assert.match(text, /\[api\] <- #\d+ 响应/)
  assert.match(text, /finish=length/)
  assert.match(text, /空正文/)
})

test("累计统计汇总调用数、失败数与 reasoning 占比", () => {
  const telemetry = loadTelemetry()
  const capture = captureConsole()
  let text
  let totals
  try {
    telemetry
      .beginApiCall({ kind: "chat", model: "m", maxTokens: 1000 })
      .finish({
        content: "答案",
        finishReason: "stop",
        usage: { prompt_tokens: 10, completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 80 } }
      })
    telemetry
      .beginApiCall({ kind: "chat", model: "m", maxTokens: 1000 })
      .finish({
        content: "",
        finishReason: "length",
        usage: { completion_tokens: 1000, completion_tokens_details: { reasoning_tokens: 1000 } }
      })
    telemetry.beginApiCall({ kind: "chat", model: "m" }).fail(new Error("boom"))
    text = telemetry.describeApiUsageTotals()
    totals = telemetry.getApiUsageTotals()
  } finally {
    capture.restore()
  }

  assert.equal(totals.calls, 3)
  assert.equal(totals.failed, 1)
  assert.equal(totals.emptyReplies, 1)
  assert.equal(totals.truncated, 1)
  assert.equal(totals.promptTokens, 10)
  assert.equal(totals.completionTokens, 1100)
  assert.equal(totals.reasoningTokens, 1080)
  assert.match(text, /calls=3/)
  assert.match(text, /ok=2/)
  assert.match(text, /failed=1/)
  assert.match(text, /empty_replies=1/)
  assert.match(text, /reasoning_tokens=1080/)
  assert.match(text, /reasoning_ratio=98%/)
})

test("没有任何调用时不输出累计统计", () => {
  const telemetry = loadTelemetry()
  assert.equal(telemetry.describeApiUsageTotals(), "")
})

test("流式被取消但迭代静默结束时，应报取消而不是空正文", async () => {
  // 真实网关（DeepSeek 流式）取消时不会抛错，只是让迭代结束；
  // 若不做显式判定，就会被误报成「模型没有返回正文」。
  const { provider } = loadChatProvider(async () =>
    (async function* silentOnAbort() {
      yield await Promise.resolve(undefined).then(() => ({ choices: [] }))
    })()
  )

  const controller = new AbortController()
  controller.abort()
  const capture = captureConsole()
  let error = null
  try {
    await provider.generateReply(chatRequest({ signal: controller.signal }))
  } catch (caught) {
    error = caught
  } finally {
    capture.restore()
  }

  assert.ok(error, "取消必须抛出而不是返回空串")
  assert.equal(error.name, "AbortError")
  assert.match(error.message, /取消/)
  assert.match(capture.all(), /已取消/)
  assert.doesNotMatch(capture.all(), /空正文/)
})
