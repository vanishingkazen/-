/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const { freshLoad } = require("./helpers/load-ts-module.cjs")

function config(overrides = {}) {
  return {
    apiProvider: "openai-compatible",
    apiKey: "test-key",
    baseURL: "https://example.test/v1",
    extractionModel: "vision-model",
    solutionModel: "solution-model",
    solutionApiKey: "",
    solutionBaseURL: "",
    debuggingModel: "debug-model",
    maxOutputTokens: 2048,
    streamingEnabled: false,
    contextMessageLimit: 30,
    interviewContextEnabled: false,
    interviewContextPath: "",
    ...overrides
  }
}

function createWindow() {
  const sent = []
  return {
    sent,
    isDestroyed: () => false,
    webContents: {
      send(channel, data) {
        sent.push({ channel, data })
      }
    }
  }
}

function loadVision(configValues = {}) {
  return freshLoad("electron/ProcessingVisionService.ts", {
    "./ConfigHelper": {
      configHelper: { loadConfig: () => config(configValues) }
    }
  })
}

function loadVoiceCorrection(configValues = {}) {
  return freshLoad("electron/ProcessingVoiceCorrectionService.ts", {
    "./ConfigHelper": {
      configHelper: { loadConfig: () => config(configValues) }
    },
    "./InterviewContextHelper": {
      loadInterviewAsrEnhancement: () => ({ contextText: "Redis、PostgreSQL", vocabulary: {}, terms: [] })
    }
  })
}

function loadFollowup(configValues = {}) {
  return freshLoad("electron/ProcessingFollowupService.ts", {
    "./ConfigHelper": {
      configHelper: { loadConfig: () => config(configValues) }
    },
    "./InterviewContextHelper": {
      loadInterviewContextPrompt: () => ""
    }
  })
}

test("视觉解题服务按 Provider 构建图片请求并清理语言标记", async () => {
  const { ProcessingVisionService } = loadVision()
  const window = createWindow()
  const calls = []
  const clients = {
    openaiClient: {
      chat: {
        completions: {
          async create(request, options) {
            calls.push({ request, options })
            return { choices: [{ message: { content: "[LANGUAGE: python]\nprint('ok')" } }] }
          }
        }
      }
    },
    anthropicClient: null
  }
  const service = new ProcessingVisionService(clients, {
    getMainWindow: () => window,
    getMaxOutputTokens: () => 2048
  })

  const result = await service.solve(
    [{ path: "/tmp/a.png", data: "YWJj" }],
    new AbortController().signal,
    "请保留原思路"
  )

  assert.deepEqual(result, { success: true, data: "print('ok')", language: "python" })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.signal instanceof AbortSignal, true)
  const content = calls[0].request.messages[0].content
  assert.equal(content[0].text.includes("请保留原思路"), true)
  assert.deepEqual(content[1], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,YWJj" }
  })
  assert.equal(window.sent.at(-1).channel, "processing-status")
})

test("视觉解题服务把取消和空响应收敛为结构化失败", async () => {
  const { ProcessingVisionService } = loadVision()
  const abortError = new Error("aborted")
  abortError.name = "AbortError"
  const clients = {
    openaiClient: {
      chat: { completions: { create: async () => { throw abortError } } }
    },
    anthropicClient: null
  }
  const service = new ProcessingVisionService(clients, {
    getMainWindow: () => null,
    getMaxOutputTokens: () => 2048
  })

  const result = await service.solve([{ path: "/tmp/a.png", data: "" }], new AbortController().signal)
  assert.deepEqual(result, { success: false, error: "视觉模型解题已取消" })
})

test("语音校正服务保留角色顺序并按输入轮次回填", async () => {
  const { ProcessingVoiceCorrectionService } = loadVoiceCorrection()
  const calls = []
  const clients = {
    openaiClient: {
      chat: {
        completions: {
          async create(request) {
            calls.push(request)
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    turns: [
                      { index: 0, text: "请介绍 Redis" },
                      { index: 1, text: "我负责缓存设计" }
                    ]
                  })
                }
              }]
            }
          }
        }
      }
    }
  }
  const service = new ProcessingVoiceCorrectionService(clients)
  const input = {
    systemTranscript: "面试官原文",
    microphoneTranscript: "面试者原文",
    rawMicrophoneTranscript: "面试者原文",
    removedSegments: 0,
    turns: [
      { speaker: "interviewer", text: "请介绍 redis", completedAt: 1 },
      { speaker: "candidate", text: "我负责缓存设计", completedAt: 2 }
    ]
  }

  const result = await service.correct(input)
  assert.equal(calls.length, 1)
  assert.equal(result.corrected, true)
  assert.deepEqual(result.turns.map((turn) => turn.text), ["请介绍 Redis", "我负责缓存设计"])
  assert.equal(result.systemTranscript, "请介绍 Redis")
  assert.equal(result.microphoneTranscript, "我负责缓存设计")
})


test("AI Client Manager 在销毁时移除配置监听并释放客户端", () => {
  const listeners = new Map()
  const configValues = config({
    solutionApiKey: "solution-key",
    solutionBaseURL: "https://solution.test/v1"
  })
  class FakeOpenAI {
    constructor(options) {
      this.options = options
    }
  }
  class FakeAnthropic {
    constructor(options) {
      this.options = options
    }
  }
  const { ProcessingAIClientManager } = freshLoad("electron/ProcessingAIClientManager.ts", {
    openai: { OpenAI: FakeOpenAI },
    "@anthropic-ai/sdk": { default: FakeAnthropic, __esModule: true },
    "./ConfigHelper": {
      configHelper: {
        loadConfig: () => configValues,
        on(event, listener) { listeners.set(event, listener) },
        removeListener(event, listener) {
          assert.equal(listeners.get(event), listener)
          listeners.delete(event)
        }
      }
    }
  })

  const manager = new ProcessingAIClientManager()
  assert.ok(manager.openaiClient)
  assert.ok(manager.solutionOpenAIClient)
  assert.equal(listeners.has("config-updated"), true)

  manager.dispose()
  assert.equal(manager.openaiClient, null)
  assert.equal(manager.solutionOpenAIClient, null)
  assert.equal(manager.anthropicClient, null)
  assert.equal(listeners.size, 0)
})

test("追问服务维护独立历史，并在取消后清空活动控制器", async () => {
  const { ProcessingFollowupService } = loadFollowup()
  const calls = []
  const window = createWindow()
  const activeControllers = []
  const clients = {
    openaiClient: {
      chat: {
        completions: {
          async create(request) {
            calls.push(request)
            return { choices: [{ message: { content: `回答${calls.length}` } }] }
          }
        }
      }
    },
    solutionOpenAIClient: null,
    anthropicClient: null
  }
  const service = new ProcessingFollowupService(clients, {
    getMainWindow: () => window,
    getLanguage: async () => "python",
    getProblemInfo: () => ({ problem_statement: "两数之和" }),
    getCurrentSolutionCode: () => "return a + b",
    getCurrentBasicCode: () => "",
    getMaxOutputTokens: () => 2048,
    setActiveController: (controller) => activeControllers.push(controller),
    clearActiveController: (controller) => {
      assert.equal(activeControllers.at(-1), controller)
      activeControllers.pop()
    }
  })

  const first = await service.process("req-1", "先解释思路")
  const second = await service.process("req-2", "再给一个例子")

  assert.deepEqual(first, { success: true, content: "回答1" })
  assert.deepEqual(second, { success: true, content: "回答2" })
  assert.equal(calls[1].messages.length, 4, "第二轮应携带系统提示、上一轮问答和当前问题")
  assert.equal(activeControllers.length, 0)

  service.resetHistory()
  await service.process("req-3", "重置后重新开始")
  assert.equal(calls[2].messages.length, 2, "reset 后不应继续携带旧历史")
})
