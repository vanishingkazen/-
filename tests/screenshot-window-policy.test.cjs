/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

const { loadTsModule } = require("./helpers/load-ts-module.cjs")

const { shouldRestoreWindowAfterScreenshot } = loadTsModule(
  "electron/ScreenshotWindowPolicy.ts"
)

test("截图前可见且手机未配对时，恢复 PC 悬浮窗", () => {
  assert.equal(shouldRestoreWindowAfterScreenshot({
    wasVisible: true,
    companionPaired: false
  }), true)
})

test("手机配对时，即使用户在截图前看到悬浮窗，也保持隐藏", () => {
  assert.equal(shouldRestoreWindowAfterScreenshot({
    wasVisible: true,
    companionPaired: true
  }), false)
})

test("截图前已经隐藏的悬浮窗不会被截图流程重新弹出", () => {
  assert.equal(shouldRestoreWindowAfterScreenshot({
    wasVisible: false,
    companionPaired: false
  }), false)
  assert.equal(shouldRestoreWindowAfterScreenshot({
    wasVisible: false,
    companionPaired: true
  }), false)
})
