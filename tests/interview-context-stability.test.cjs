/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const { freshLoad } = require("./helpers/load-ts-module.cjs")

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steamgamecode-context-"))

function appData() {
  return path.join(tempRoot, "appData")
}

function defaultContextPath() {
  return path.join(appData(), "steamgamecode", "interview-context.md")
}

function resetContext() {
  fs.rmSync(tempRoot, { recursive: true, force: true })
  fs.mkdirSync(tempRoot, { recursive: true })
}

function loadHelper(mocks = {}) {
  return freshLoad("electron/InterviewContextHelper.ts", {
    electron: {
      app: {
        getPath(name) {
          if (name !== "appData") throw new Error(`Unexpected app path request: ${name}`)
          return appData()
        }
      }
    },
    ...mocks
  })
}

function writeContext(content, filePath = defaultContextPath()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, "utf8")
}

test.beforeEach(() => {
  resetContext()
})

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test("上下文文件不存在时会自动创建空文件与父目录", () => {
  const helper = loadHelper()
  assert.equal(fs.existsSync(defaultContextPath()), false)

  const resolved = helper.ensureInterviewContextFile()

  assert.equal(resolved, defaultContextPath())
  assert.equal(fs.existsSync(defaultContextPath()), true)
  assert.equal(fs.readFileSync(defaultContextPath(), "utf8"), "")

  const customPath = path.join(tempRoot, "deep", "nested", "context.md")
  assert.equal(helper.ensureInterviewContextFile(customPath), customPath)
  assert.equal(fs.existsSync(customPath), true)
})

test("已存在的上下文文件内容不会被覆盖", () => {
  writeContext("已有简历内容")
  const helper = loadHelper()

  helper.ensureInterviewContextFile()
  helper.ensureInterviewContextFile()

  assert.equal(fs.readFileSync(defaultContextPath(), "utf8"), "已有简历内容")
})

test("空白路径回退到默认路径，带空格的路径会被裁剪", () => {
  const helper = loadHelper()

  assert.equal(helper.ensureInterviewContextFile("   "), defaultContextPath())
  const padded = `  ${path.join(tempRoot, "padded.md")}  `
  assert.equal(helper.ensureInterviewContextFile(padded), path.join(tempRoot, "padded.md"))
  assert.equal(fs.existsSync(path.join(tempRoot, "padded.md")), true)
})

test("状态查询返回字符数并标记空文件为不可用内容", () => {
  const helper = loadHelper()
  writeContext("第一行\n第二行")

  const status = helper.getInterviewContextStatus(true, defaultContextPath())
  assert.equal(status.enabled, true)
  assert.equal(status.available, true)
  assert.equal(status.characterCount, 7)
  assert.equal(status.error, undefined)

  writeContext("   \n\t  ")
  const emptyStatus = helper.getInterviewContextStatus(true, defaultContextPath())
  assert.equal(emptyStatus.available, true)
  assert.equal(emptyStatus.characterCount, 0)
  assert.equal(emptyStatus.error, "面试上下文文件为空")

  const disabledStatus = helper.getInterviewContextStatus(false)
  assert.equal(disabledStatus.enabled, false)
  assert.equal(disabledStatus.path, defaultContextPath())
})

test("上下文文件所在路径不可用时返回结构化错误而不是抛异常", () => {
  const helper = loadHelper()
  // 用一个「文件」占住父目录位置，使 mkdir/写入必然失败
  const blockedParent = path.join(tempRoot, "blocked-parent")
  fs.writeFileSync(blockedParent, "not a directory")

  let status
  assert.doesNotThrow(() => {
    status = helper.getInterviewContextStatus(true, path.join(blockedParent, "context.md"))
  })
  assert.equal(status.available, false)
  assert.equal(status.characterCount, 0)
  assert.equal(typeof status.error, "string")
  assert.ok(status.error.length > 0)
})

test("读取提示词时按需注入背景资料标记，禁用时返回空字符串", () => {
  const helper = loadHelper()
  writeContext("简历：熟悉 Redis 与 PostgreSQL")

  const enabled = helper.loadInterviewContextPrompt(true, defaultContextPath())
  assert.match(enabled, /<interview_background>/)
  assert.match(enabled, /<\/interview_background>/)
  assert.match(enabled, /熟悉 Redis 与 PostgreSQL/)
  assert.match(enabled, /始终优先回答最后一条用户问题/)

  assert.equal(helper.loadInterviewContextPrompt(false, defaultContextPath()), "")

  writeContext("   ")
  assert.equal(helper.loadInterviewContextPrompt(true, defaultContextPath()), "")
})

test("启用的上下文文件读取失败时，提示词加载抛出可读错误", () => {
  const helper = loadHelper({
    "node:fs": {
      ...fs,
      readFileSync: (target, ...rest) => {
        if (String(target).includes("context.md")) {
          const error = new Error("EACCES: permission denied")
          error.code = "EACCES"
          throw error
        }
        return fs.readFileSync(target, ...rest)
      }
    }
  })
  const contextPath = path.join(tempRoot, "readable-dir", "context.md")
  fs.mkdirSync(path.dirname(contextPath), { recursive: true })
  fs.writeFileSync(contextPath, "内容")

  assert.throws(
    () => helper.loadInterviewContextPrompt(true, contextPath),
    /EACCES/
  )
})

test("ASR 增强会从简历中提取技术术语并生成受限词汇表", () => {
  const helper = loadHelper()
  writeContext([
    "熟悉 `Redis` 与 `PostgreSQL`，做过 `pg_trgm` 检索优化。",
    "负责 PandoraQ Agent 平台，使用 RAG 和 MCP 协议，落地 Tool Calling。",
    "熟悉 Java/Go/Python，使用 Docker 与 Kubernetes。",
    "这个句子包含很多普通单词 the and for with from this that。"
  ].join("\n"))

  const enhancement = helper.loadInterviewAsrEnhancement(true, defaultContextPath())

  for (const term of ["Redis", "PostgreSQL", "pg_trgm", "PandoraQ", "Agent", "RAG", "MCP", "Java", "Python"]) {
    assert.equal(enhancement.terms.includes(term), true, `应识别术语 ${term}`)
  }

  assert.equal(enhancement.vocabulary.Redis, 5)
  assert.equal(enhancement.vocabulary["pg_trgm"], 5)
  assert.ok(enhancement.terms.length <= 80)
  assert.ok(enhancement.contextText.length <= 390)
  assert.match(enhancement.contextText, /^蚂蚁证券 Agent 工程师技术面试/)
  assert.match(enhancement.contextText, /Redis/)
})

test("禁用、空文件或不可用时 ASR 增强返回空结构而不是抛异常", () => {
  const helper = loadHelper()

  assert.deepEqual(helper.loadInterviewAsrEnhancement(false, defaultContextPath()), {
    contextText: "",
    vocabulary: {},
    terms: []
  })

  writeContext("   \n  ")
  assert.deepEqual(helper.loadInterviewAsrEnhancement(true, defaultContextPath()), {
    contextText: "",
    vocabulary: {},
    terms: []
  })

  const blockedParent = path.join(tempRoot, "blocked-asr")
  fs.writeFileSync(blockedParent, "not a directory")
  assert.deepEqual(
    helper.loadInterviewAsrEnhancement(true, path.join(blockedParent, "context.md")),
    { contextText: "", vocabulary: {}, terms: [] }
  )
})

test("ASR 术语过滤占位符、停用词与超长文本，并保证结果稳定", () => {
  const helper = loadHelper()
  writeContext([
    "`the` `id` `待填` `真实现象`",
    "`Redis` `Redis` `Redis`",
    "`ThisIsAnExtremelyLongTermThatShouldBeFilteredOut`",
    "`短`",
    "Postgres PostgreSQL PostgreSQL"
  ].join("\n"))

  const first = helper.loadInterviewAsrEnhancement(true, defaultContextPath())
  const second = helper.loadInterviewAsrEnhancement(true, defaultContextPath())

  assert.equal(first.terms.includes("the"), false)
  assert.equal(first.terms.includes("id"), false)
  assert.equal(first.terms.includes("待填"), false)
  assert.equal(first.terms.includes("真实现象"), false)
  assert.equal(first.terms.includes("短"), false)
  assert.equal(
    first.terms.some((term) => term.length > 40),
    false,
    "超长术语应被过滤"
  )
  assert.deepEqual(first.terms, second.terms, "同一输入应得到稳定排序")
  assert.equal(first.terms.indexOf("PostgreSQL") < first.terms.indexOf("Postgres"), true)
})

test("大量术语时上下文文本仍受长度预算约束且不截断到半个词", () => {
  const helper = loadHelper()
  const terms = Array.from({ length: 200 }, (_, index) => `Term${index}X`)
  writeContext(terms.map((term) => `\`${term}\``).join(" "))

  const enhancement = helper.loadInterviewAsrEnhancement(true, defaultContextPath())

  assert.ok(enhancement.contextText.length <= 390)
  assert.ok(enhancement.terms.length <= 80)
  const included = enhancement.terms.filter((term) => enhancement.contextText.includes(term))
  assert.ok(included.length > 0)
  for (const term of included) {
    assert.equal(enhancement.contextText.endsWith(term) || enhancement.contextText.includes(`${term}、`), true)
  }
})
