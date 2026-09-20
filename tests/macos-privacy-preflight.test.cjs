/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const ROOT = path.resolve(__dirname, "..")
const nativeModulePath = path.join(
  ROOT,
  "native",
  "mac-command-interceptor",
  "build",
  "Release",
  "mac_command_interceptor.node"
)

test("macOS 快捷键隐私拦截预检", { skip: process.platform !== "darwin" }, (t) => {
  assert.equal(fs.existsSync(nativeModulePath), true, `missing native module: ${nativeModulePath}`)
  const interceptor = require(nativeModulePath)

  for (const name of [
    "start",
    "stop",
    "setEnabled",
    "isTrusted",
    "requestPermission",
    "setShortcuts",
    "setBrowserBundleIds",
    "pollActions"
  ]) {
    assert.equal(typeof interceptor[name], "function", `missing native method: ${name}`)
  }

  const trusted = interceptor.isTrusted()
  t.diagnostic(`AXIsProcessTrusted=${trusted}`)
  if (!trusted) {
    const message = "未授予辅助功能权限，无法验证 Command 全链路不会被浏览器观察"
    if (process.env.STEAMGAMECODE_REQUIRE_PRIVACY === "1") {
      assert.fail(message)
    }
    t.skip(message)
    return
  }

  assert.equal(interceptor.start(), true)
  try {
    assert.equal(interceptor.setEnabled(true), true)
    assert.equal(interceptor.setBrowserBundleIds(["com.google.Chrome", "com.apple.Safari"]), true)
    assert.equal(interceptor.setShortcuts([]), true)
    assert.equal(interceptor.setEnabled(false), true)
  } finally {
    interceptor.stop()
  }
})
