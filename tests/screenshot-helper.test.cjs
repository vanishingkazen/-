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
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steamgamecode-screenshot-"))

const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath(name) {
          if (name === "userData") return path.join(tempRoot, "userData")
          if (name === "temp") return path.join(tempRoot, "temp")
          throw new Error(`Unexpected app path request: ${name}`)
        }
      },
      nativeImage: {
        createFromBuffer: () => ({
          isEmpty: () => false,
          getSize: () => ({ width: 3, height: 2 }),
          toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47])
        })
      }
    }
  }
  if (request === "screenshot-desktop") return async () => Buffer.from("png")
  return originalLoad.call(this, request, parent, isMain)
}

const originalTsLoader = require.extensions[".ts"]
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

const { ScreenshotHelper } = require(path.join(ROOT, "electron", "ScreenshotHelper.ts"))

function createImage(name) {
  const filePath = path.join(tempRoot, name)
  fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  return filePath
}

test.after(() => {
  Module._load = originalLoad
  if (originalTsLoader) require.extensions[".ts"] = originalTsLoader
  else delete require.extensions[".ts"]
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test("消费已发送截图时只移除本轮路径，并保留聊天记录仍引用的原文件", () => {
  const helper = new ScreenshotHelper()
  const consumed = createImage("consumed.png")
  const retained = createImage("retained.png")
  const nextRound = createImage("next-round.png")
  const extra = createImage("extra.png")
  const notQueued = createImage("not-queued.png")

  helper.screenshotQueue.push(consumed, retained, nextRound)
  helper.extraScreenshotQueue.push(extra)
  helper.consumeScreenshots([consumed, retained, notQueued], [retained])

  assert.deepEqual(helper.screenshotQueue, [nextRound])
  assert.deepEqual(helper.extraScreenshotQueue, [extra])
  assert.equal(fs.existsSync(consumed), false)
  assert.equal(fs.existsSync(retained), true)
  assert.equal(fs.existsSync(nextRound), true)
  assert.equal(fs.existsSync(extra), true)
  assert.equal(fs.existsSync(notQueued), true)
})


test("手机 JPEG 与截图共用队列，并拒绝已失效或超大尺寸的照片", async () => {
  const helper = new ScreenshotHelper()
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 2, 0, 3, 3, 1, 17, 0, 2, 17, 1, 3, 17, 1, 0xff, 0xd9])
  const photo = await helper.importCameraPhoto(jpeg, () => true)
  assert.deepEqual(helper.getScreenshotQueue(), [photo])
  assert.equal(path.extname(photo), ".png")
  assert.equal(fs.existsSync(photo), true)
  const before = fs.readdirSync(path.dirname(photo))
  await assert.rejects(helper.importCameraPhoto(jpeg, () => false), /会话或视图已切换/)
  assert.deepEqual(fs.readdirSync(path.dirname(photo)), before)
  assert.deepEqual(helper.getScreenshotQueue(), [photo])
  const oversized = Buffer.from(jpeg)
  oversized.writeUInt16BE(5000, 9)
  await assert.rejects(helper.importCameraPhoto(oversized, () => true), /尺寸超过/)
  await assert.rejects(helper.importCameraPhoto(Buffer.from("not-jpeg"), () => true), /JPEG/)
})
