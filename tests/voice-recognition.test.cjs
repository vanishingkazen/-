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
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steamgamecode-voice-"))

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

const { VoiceRecognitionHelper } = require(path.join(ROOT, "electron", "VoiceRecognitionHelper.ts"))

test.after(() => {
  Module._load = originalLoad
  if (originalTsLoader) require.extensions[".ts"] = originalTsLoader
  else delete require.extensions[".ts"]
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test("双声道转写按时间合并为面试官和面试者队列，并过滤回声与口头语", () => {
  const helper = new VoiceRecognitionHelper(() => null)
  helper.sessions.system.finalTranscript = "请介绍一下项目\n为什么这样设计"
  helper.sessions.system.segments = [
    { text: "请介绍一下项目", completedAt: 1000 },
    { text: "为什么这样设计", completedAt: 3000 }
  ]
  helper.sessions.microphone.finalTranscript = "请介绍一下项目\n我会先说明背景\n明白"
  helper.sessions.microphone.segments = [
    { text: "请介绍一下项目", completedAt: 1100 },
    { text: "我会先说明背景", completedAt: 2000 },
    { text: "明白", completedAt: 2500 }
  ]

  const conversation = helper.getConversationTranscript()

  assert.equal(conversation.removedSegments, 2)
  assert.deepEqual(
    conversation.turns.map((turn) => [turn.speaker, turn.text, turn.completedAt]),
    [
      ["interviewer", "请介绍一下项目", 1000],
      ["candidate", "我会先说明背景", 2000],
      ["interviewer", "为什么这样设计", 3000]
    ]
  )
  assert.equal(conversation.systemTranscript, "请介绍一下项目\n为什么这样设计")
  assert.equal(conversation.microphoneTranscript, "我会先说明背景")
  assert.equal(conversation.rawMicrophoneTranscript, "请介绍一下项目\n我会先说明背景\n明白")
  assert.equal(helper.getTranscript(), "面试官：请介绍一下项目\n为什么这样设计\n面试者：请介绍一下项目\n我会先说明背景\n明白")
})
