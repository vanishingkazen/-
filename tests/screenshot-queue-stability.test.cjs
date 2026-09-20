/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const { freshLoad } = require("./helpers/load-ts-module.cjs")

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steamgamecode-shotqueue-"))
const userData = path.join(tempRoot, "userData")
const tempDir = path.join(tempRoot, "temp")

let uuidCounter = 0
let screenshotResult = Buffer.from("png-bytes")
let screenshotError = null

function resetState() {
  fs.rmSync(tempRoot, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(tempDir, { recursive: true })
  uuidCounter = 0
  screenshotResult = Buffer.from("png-bytes")
  screenshotError = null
}

function loadHelper(view = "queue") {
  const module = freshLoad("electron/ScreenshotHelper.ts", {
    electron: {
      app: {
        getPath(name) {
          if (name === "userData") return userData
          if (name === "temp") return tempDir
          throw new Error(`Unexpected app path request: ${name}`)
        }
      },
      nativeImage: {}
    },
    uuid: {
      v4: () => {
        uuidCounter += 1
        return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`
      }
    },
    "./ChatImageUtils": {
      detectImageMime: (filePath) => (filePath.endsWith(".jpg") ? "image/jpeg" : "image/png")
    },
    "screenshot-desktop": async () => {
      if (screenshotError) throw screenshotError
      return screenshotResult
    }
  })
  return new module.ScreenshotHelper(view)
}

function createFile(filePath, content = Buffer.from("png")) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  return filePath
}

function ageFile(filePath, ageMs) {
  const timestamp = (Date.now() - ageMs) / 1000
  fs.utimesSync(filePath, timestamp, timestamp)
}

test.beforeEach(() => {
  resetState()
})

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

test("启动清理只删除超过 3 天的 png，保留新文件与非 png 文件", () => {
  const screenshotDir = path.join(userData, "screenshots")
  const extraDir = path.join(userData, "extra_screenshots")
  const oldMain = createFile(path.join(screenshotDir, "old.png"))
  const freshMain = createFile(path.join(screenshotDir, "fresh.png"))
  const oldExtra = createFile(path.join(extraDir, "old-extra.png"))
  const freshExtra = createFile(path.join(extraDir, "fresh-extra.png"))
  const oldNotPng = createFile(path.join(screenshotDir, "keep.txt"))
  const subDirectory = path.join(screenshotDir, "nested")
  fs.mkdirSync(subDirectory, { recursive: true })

  ageFile(oldMain, 4 * 24 * 60 * 60 * 1000)
  ageFile(oldExtra, 4 * 24 * 60 * 60 * 1000)
  ageFile(oldNotPng, 10 * 24 * 60 * 60 * 1000)

  loadHelper()

  assert.equal(fs.existsSync(oldMain), false, "过期主队列截图应被清理")
  assert.equal(fs.existsSync(oldExtra), false, "过期附加队列截图应被清理")
  assert.equal(fs.existsSync(freshMain), true, "新鲜文件必须保留")
  assert.equal(fs.existsSync(freshExtra), true)
  assert.equal(fs.existsSync(oldNotPng), true, "非 png 文件不参与清理")
  assert.equal(fs.existsSync(subDirectory), true, "目录不应被当作文件删除")
})

test("清理过程遇到单个文件异常时不中断其他文件清理", () => {
  const screenshotDir = path.join(userData, "screenshots")
  const broken = path.join(screenshotDir, "broken.png")
  const healthy = path.join(screenshotDir, "healthy.png")
  fs.mkdirSync(screenshotDir, { recursive: true })
  fs.symlinkSync(path.join(screenshotDir, "missing-target.png"), broken)
  createFile(healthy)
  ageFile(healthy, 4 * 24 * 60 * 60 * 1000)

  let helper
  assert.doesNotThrow(() => {
    helper = loadHelper()
  })
  assert.ok(helper)
  assert.equal(fs.existsSync(healthy), false, "单个损坏条目不应中断清理")
})

test("新截图写入主队列并在超过 5 张时删除最旧文件", async () => {
  const helper = loadHelper("queue")
  const hideCalls = []
  const showCalls = []

  for (let index = 0; index < 6; index += 1) {
    const captured = await helper.takeScreenshot(
      () => hideCalls.push(index),
      () => showCalls.push(index)
    )
    assert.equal(fs.existsSync(captured), true)
  }

  const queue = helper.getScreenshotQueue()
  assert.equal(queue.length, 5, "主队列最多保留 5 张截图")
  assert.deepEqual(hideCalls, [0, 1, 2, 3, 4, 5])
  assert.deepEqual(showCalls, [0, 1, 2, 3, 4, 5])

  const onDisk = fs.readdirSync(path.join(userData, "screenshots")).filter((name) => name.endsWith(".png"))
  assert.equal(onDisk.length, 5, "被挤出队列的截图应从磁盘删除")
  for (const filePath of queue) {
    assert.equal(fs.existsSync(filePath), true)
  }
}, { timeout: 15000 })

test("附加视图的新截图进入额外队列，不污染主队列", async () => {
  const helper = loadHelper("solutions")
  const captured = await helper.takeScreenshot(() => {}, () => {})

  assert.equal(captured.startsWith(path.join(userData, "extra_screenshots")), true)
  assert.deepEqual(helper.getScreenshotQueue(), [])
  assert.deepEqual(helper.getExtraScreenshotQueue(), [captured])
  assert.equal(fs.existsSync(captured), true)
}, { timeout: 5000 })

test("截图失败时仍会恢复窗口显示并抛出可诊断错误", async () => {
  screenshotError = new Error("capture failed")
  const helper = loadHelper("queue")
  const events = []

  await assert.rejects(
    () => helper.takeScreenshot(() => events.push("hide"), () => events.push("show")),
    /capture failed/
  )
  assert.deepEqual(events, ["hide", "show"])
  assert.deepEqual(helper.getScreenshotQueue(), [], "失败时不得入队半成品")
})

test("空缓冲区截图被视为失败并恢复窗口", async () => {
  screenshotResult = Buffer.alloc(0)
  const helper = loadHelper("queue")
  const events = []
  screenshotError = null

  await assert.rejects(
    () => helper.takeScreenshot(() => events.push("hide"), () => events.push("show")),
    /empty buffer/i
  )
  assert.deepEqual(events, ["hide", "show"])
})

test("预览接口对缺失文件与损坏路径返回空字符串而不抛异常", async () => {
  const helper = loadHelper()

  assert.equal(await helper.getImagePreview(path.join(tempRoot, "missing.png")), "")

  const directoryAsImage = path.join(tempRoot, "a-directory.png")
  fs.mkdirSync(directoryAsImage, { recursive: true })
  assert.equal(await helper.getImagePreview(directoryAsImage), "")

  const image = createFile(path.join(tempRoot, "ok.jpg"), Buffer.from([1, 2, 3]))
  const preview = await helper.getImagePreview(image)
  assert.equal(preview.startsWith("data:image/jpeg;base64,"), true)
  assert.equal(preview.endsWith(Buffer.from([1, 2, 3]).toString("base64")), true)
})

test("删除截图会同时移除磁盘文件与当前视图队列条目", async () => {
  const helper = loadHelper("queue")
  const first = await helper.takeScreenshot(() => {}, () => {})
  const second = await helper.takeScreenshot(() => {}, () => {})

  const result = await helper.deleteScreenshot(first)
  assert.deepEqual(result, { success: true })
  assert.equal(fs.existsSync(first), false)
  assert.deepEqual(helper.getScreenshotQueue(), [second])

  // 删除已不存在的文件仍返回成功，避免 UI 因重复删除报错
  assert.deepEqual(await helper.deleteScreenshot(first), { success: true })

  const directory = path.join(tempRoot, "undeletable")
  fs.mkdirSync(directory, { recursive: true })
  const result2 = await helper.deleteScreenshot(directory)
  assert.equal(typeof result2.success, "boolean")
}, { timeout: 10000 })

test("清空队列会删除对应文件并重置数组", async () => {
  const helper = loadHelper("queue")
  const first = await helper.takeScreenshot(() => {}, () => {})
  const second = await helper.takeScreenshot(() => {}, () => {})

  helper.clearQueues()
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.deepEqual(helper.getScreenshotQueue(), [])
  assert.deepEqual(helper.getExtraScreenshotQueue(), [])
  assert.equal(fs.existsSync(first), false)
  assert.equal(fs.existsSync(second), false)
}, { timeout: 10000 })

test("视图切换后队列各自独立，清空附加队列不影响主队列", async () => {
  const helper = loadHelper("queue")
  const mainShot = await helper.takeScreenshot(() => {}, () => {})
  helper.setView("debug")
  assert.equal(helper.getView(), "debug")

  const extraShot = await helper.takeScreenshot(() => {}, () => {})
  assert.deepEqual(helper.getScreenshotQueue(), [mainShot])
  assert.deepEqual(helper.getExtraScreenshotQueue(), [extraShot])

  helper.clearExtraScreenshotQueue()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(fs.existsSync(extraShot), false)
  assert.equal(fs.existsSync(mainShot), true)
  assert.deepEqual(helper.getScreenshotQueue(), [mainShot])
}, { timeout: 10000 })
