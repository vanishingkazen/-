/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const { freshLoad } = require("./helpers/load-ts-module.cjs")

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steamgamecode-store-"))

function appData() {
  return path.join(tempRoot, "appData")
}

function storeDirectory() {
  return path.join(appData(), "steamgamecode")
}

function sessionFilePath() {
  return path.join(storeDirectory(), "chat-sessions.json")
}

function attachmentsRoot() {
  return path.join(storeDirectory(), "chat-attachments")
}

function resetStore() {
  fs.rmSync(appData(), { recursive: true, force: true })
}

function loadStore() {
  const module = freshLoad("electron/ChatStore.ts", {
    electron: {
      app: {
        getPath(name) {
          if (name !== "appData") throw new Error(`Unexpected app path request: ${name}`)
          return appData()
        }
      }
    }
  })
  return { ChatStore: module.ChatStore, safeStorageComponent: module.safeStorageComponent }
}

function writeSessionFile(payload) {
  fs.mkdirSync(storeDirectory(), { recursive: true })
  fs.writeFileSync(
    sessionFilePath(),
    typeof payload === "string" ? payload : JSON.stringify(payload),
    "utf8"
  )
}

function readSessionFile() {
  return JSON.parse(fs.readFileSync(sessionFilePath(), "utf8"))
}

function rawMessage(id, role = "user", content = "你好") {
  return {
    id,
    role,
    content,
    images: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "completed"
  }
}

function rawSession(id, messages = [], extra = {}) {
  return {
    id,
    title: `会话-${id}`,
    summary: "",
    messages,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra
  }
}

test.beforeEach(() => {
  resetStore()
})

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test("会话文件损坏时启动不抛异常，并以空状态重建可用会话", () => {
  writeSessionFile('{"sessions": [')

  const { ChatStore } = loadStore()
  const store = new ChatStore()

  const current = store.current()
  assert.ok(current.id)
  assert.deepEqual(current.messages, [])
  assert.deepEqual(store.list().map((session) => session.id), [current.id])
  assert.deepEqual(readSessionFile().sessions.map((session) => session.id), [current.id])
})

test("会话文件中结构异常或非法的条目会被过滤，合法会话仍然可用", () => {
  writeSessionFile({
    currentSessionId: "valid-2",
    sessions: [
      null,
      "not-a-session",
      { id: "", messages: [] },
      { id: "no-messages", messages: "oops" },
      rawSession("valid-1", [
        rawMessage("m1"),
        { role: "assistant", content: 42 },
        { role: "system", content: "ignored" },
        { id: "m2", role: "assistant", content: "回答", images: ["bad", { path: "" }, { path: "/tmp/x.png" }] }
      ]),
      rawSession("valid-2", [rawMessage("m3", "user", "第二个会话")])
    ]
  })

  const { ChatStore } = loadStore()
  const store = new ChatStore()

  assert.deepEqual(store.list().map((session) => session.id).sort(), ["valid-1", "valid-2"])
  assert.equal(store.current().id, "valid-2", "应恢复持久化的当前会话指针")

  const validOne = store.get("valid-1")
  assert.equal(validOne.messages.length, 2, "非法消息条目应被丢弃")
  assert.equal(validOne.messages[1].images.length, 1)
  assert.equal(validOne.messages[1].images[0].path, "/tmp/x.png")
  assert.equal(validOne.messages[1].status, "completed", "缺失状态应补为 completed")
})

test("启动时清理已不在会话列表中的附件目录，保留在用目录", () => {
  const orphanDir = path.join(attachmentsRoot(), "orphan-session")
  const keptDir = path.join(attachmentsRoot(), "valid-session")
  fs.mkdirSync(orphanDir, { recursive: true })
  fs.mkdirSync(keptDir, { recursive: true })
  fs.writeFileSync(path.join(orphanDir, "a.png"), "orphan")
  fs.writeFileSync(path.join(keptDir, "b.png"), "kept")
  fs.writeFileSync(path.join(attachmentsRoot(), "keep-me.txt"), "not a directory")
  writeSessionFile({ currentSessionId: "valid-session", sessions: [rawSession("valid-session")] })

  const { ChatStore } = loadStore()
  new ChatStore()

  assert.equal(fs.existsSync(orphanDir), false, "孤立附件目录应被删除")
  assert.equal(fs.existsSync(keptDir), true)
  assert.equal(fs.existsSync(path.join(attachmentsRoot(), "keep-me.txt")), true)
})

test("会话文件解析失败时不会误删磁盘上的附件目录", () => {
  const keptDir = path.join(attachmentsRoot(), "session-under-repair")
  fs.mkdirSync(keptDir, { recursive: true })
  fs.writeFileSync(path.join(keptDir, "a.png"), "data")
  writeSessionFile("{not-json")

  const { ChatStore } = loadStore()
  const store = new ChatStore()
  store.current()

  assert.equal(fs.existsSync(keptDir), true, "解析失败时无法判断归属，不得清理附件")
})

test("会话 ID 会被安全化用于附件目录，避免路径穿越", () => {
  const { safeStorageComponent } = loadStore()

  assert.equal(safeStorageComponent("../../etc/passwd"), "______etc_passwd")
  assert.equal(safeStorageComponent("a/b\\c d"), "a_b_c_d")
  assert.equal(safeStorageComponent(""), "session")
  assert.equal(safeStorageComponent("会话 id-1"), "___id-1")

  const store = loadStoreSession("../../escape")
  assert.equal(store.getAttachmentDirectory("../../escape"), path.join(attachmentsRoot(), "______escape"))
})

function loadStoreSession(sessionId) {
  resetStore()
  const { ChatStore } = loadStore()
  const instance = new ChatStore()
  instance.delete(instance.current().id)
  instance.sessions = [{ ...rawSession(sessionId) }]
  return instance
}

test("单条超长消息与会话标题会被安全落盘，不产生非法 JSON", () => {
  const { ChatStore } = loadStore()
  const store = new ChatStore()
  const longTitle = "题".repeat(5000)
  const longContent = "答".repeat(20000)

  const session = store.create({
    title: longTitle,
    messages: [rawMessage("m1", "user", longContent)]
  })

  assert.equal(session.title.length, 5000)
  assert.equal(session.messages[0].content.length, 20000)
  const persisted = readSessionFile()
  const persistedSession = persisted.sessions.find((item) => item.id === session.id)
  assert.equal(persistedSession.messages[0].content.length, 20000)
})

test("create 传入非法种子数据时仍返回可用会话而不是抛异常", () => {
  const { ChatStore } = loadStore()
  const store = new ChatStore()

  for (const seed of [null, undefined, "text", 42, { title: 42, messages: "nope" }, { messages: [null, 1] }]) {
    const session = store.create(seed)
    assert.ok(session.id)
    assert.equal(typeof session.title, "string")
    assert.ok(session.title.length > 0)
    assert.deepEqual(session.messages, [])
  }
})

test("保存使用临时文件原子替换，且不会残留 .tmp 文件", () => {
  const { ChatStore } = loadStore()
  const store = new ChatStore()
  store.create({ title: "原子保存" })

  const entries = fs.readdirSync(storeDirectory())
  assert.equal(entries.some((name) => name.endsWith(".tmp")), false, "不应残留临时文件")
  assert.equal(entries.includes("chat-sessions.json"), true)
  const parsed = readSessionFile()
  assert.equal(parsed.sessions.length >= 1, true)
})

test("当前会话不会因为保留上限被挤出磁盘，同时触发远端回收回调", () => {
  const { ChatStore } = loadStore()
  const store = new ChatStore()

  const droppedIds = []
  store.onSessionsDropped = (sessions) => {
    for (const session of sessions) droppedIds.push(session.id)
  }

  for (let index = 0; index < 60; index += 1) {
    store.create({ title: `会话 ${index}` })
  }

  const persisted = readSessionFile()
  assert.equal(persisted.sessions.length, 50, "磁盘上最多保留 50 个会话")
  const currentId = store.current().id
  assert.equal(
    persisted.sessions.some((session) => session.id === currentId),
    true,
    "当前选中会话必须始终在落盘集合中"
  )
  assert.equal(persisted.currentSessionId, currentId)
  assert.ok(droppedIds.length > 0, "被裁掉的会话应触发远端文件回收回调")
  assert.equal(new Set(droppedIds).size, droppedIds.length, "同一会话不应重复上报回收")
  assert.equal(store.list().length, 60, "内存中仍保留全部会话，用户可再次选中")
})

test("会触发回收回调的异常不会破坏保存流程", () => {
  const { ChatStore } = loadStore()
  const store = new ChatStore()
  store.onSessionsDropped = () => {
    throw new Error("回收服务不可用")
  }

  assert.doesNotThrow(() => {
    for (let index = 0; index < 60; index += 1) store.create({ title: `会话 ${index}` })
  })
  assert.equal(readSessionFile().sessions.length, 50)
})

test("删除会话会同时清空其附件目录，再次删除同一会话返回 false", () => {
  const { ChatStore } = loadStore()
  const store = new ChatStore()
  const session = store.create({ title: "待删除" })

  const directory = store.getAttachmentDirectory(session.id)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, "a.png"), "data")

  assert.equal(store.delete(session.id), true)
  assert.equal(fs.existsSync(directory), false, "删除会话应删除本地附件")
  assert.equal(store.delete(session.id), false)
  assert.equal(store.current().id !== session.id, true, "删除当前会话后应切换到可用会话")
})

test("附件复制会把文件收拢到会话目录，源文件缺失时保留原引用", () => {
  const { ChatStore } = loadStore()
  const store = new ChatStore()
  const session = store.create({ title: "附件" })

  const sourcePath = path.join(tempRoot, "source-shots", "题目.PNG")
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
  fs.writeFileSync(sourcePath, Buffer.from("png-bytes"))

  const copied = store.copyAttachments(session.id, "msg-1", [
    { path: sourcePath, mimeType: "image/png" },
    { path: path.join(tempRoot, "missing.png") }
  ])

  assert.equal(copied.length, 2)
  assert.equal(copied[0].path.startsWith(store.getAttachmentDirectory(session.id)), true)
  assert.equal(fs.readFileSync(copied[0].path).toString(), "png-bytes")
  assert.match(path.basename(copied[0].path), /^msg-1-0\.PNG$/)
  assert.equal(copied[1].path, path.join(tempRoot, "missing.png"), "缺失文件应保留原引用而不是丢失附件")
})

test("重启后会话、当前指针与摘要保持一致", () => {
  const { ChatStore } = loadStore()
  const first = new ChatStore()
  const sessionA = first.create({ title: "A", messages: [rawMessage("m1", "user", "问题 A")] })
  first.create({ title: "B" })
  first.select(sessionA.id)

  const restarted = new ChatStore()
  assert.equal(restarted.current().id, sessionA.id)
  assert.equal(restarted.current().messages[0].content, "问题 A")
  assert.deepEqual(restarted.list().map((session) => session.title).sort(), ["A", "B"])
})

test("列表按更新时间倒序返回且不受内部数组顺序影响", () => {
  const { ChatStore } = loadStore()
  const store = new ChatStore()
  store.create({ title: "最早" })
  store.list()[0].updatedAt = "2020-01-01T00:00:00.000Z"
  const middle = store.create({ title: "中间" })
  middle.updatedAt = "2024-01-01T00:00:00.000Z"
  const latest = store.create({ title: "最新" })
  latest.updatedAt = "2026-01-01T00:00:00.000Z"

  assert.deepEqual(store.list().map((session) => session.title), ["最新", "中间", "最早"])
})
