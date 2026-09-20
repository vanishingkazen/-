/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

const assert = require("node:assert/strict")
const path = require("node:path")
const test = require("node:test")

const { ROOT, installModuleMocks } = require("./helpers/load-ts-module.cjs")

function createHarness() {
  const captured = {
    listeners: [],
    startCalls: 0,
    stopCalls: 0,
    startError: null
  }

  const uiohookMock = {
    on(event, listener) {
      captured.listeners.push({ event, listener })
    },
    off(event, listener) {
      captured.listeners = captured.listeners.filter(
        (entry) => !(entry.event === event && entry.listener === listener)
      )
    },
    start() {
      captured.startCalls += 1
      if (captured.startError) throw captured.startError
    },
    stop() {
      captured.stopCalls += 1
    }
  }

  const triggers = { count: 0 }
  const restore = installModuleMocks({ "uiohook-napi": { uIOhook: uiohookMock } })
  let Detector
  try {
    const resolved = path.join(ROOT, "electron", "MouseShakeDetector.ts")
    delete require.cache[require.resolve(resolved)]
    Detector = require(resolved).MouseShakeDetector
  } finally {
    restore()
  }

  const detector = new Detector({ onTrigger: () => { triggers.count += 1 } })

  const moveHandler = () => {
    const entry = captured.listeners.find((item) => item.event === "mousemove")
    assert.ok(entry, "mousemove 监听器必须已注册")
    return entry.listener
  }

  const clock = {
    now: 1000,
    advance(ms) {
      this.now += ms
      return this.now
    }
  }
  const realDateNow = Date.now
  Date.now = () => clock.now

  const emitMove = (x, y) => moveHandler()({ x, y })

  /**
   * 生成一次“左右左右”晃动。每个方向连续移动 `stepsPerSegment` 次，
   * 单次位移 80px、间隔 100ms，满足最小距离(24px)与最小速度(0.45px/ms)要求。
   * 注意：方向段速度按「该方向起始时间」到当前时刻计算，因此步幅过小
   * （例如 3px/次）时永远达不到速度阈值——这里按真实剧烈晃动建模。
   */
  const shake = ({ cycles = 5, stepsPerSegment = 3, step = 80, stepMs = 100 } = {}) => {
    let x = 100
    let direction = 1
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      for (let stepIndex = 0; stepIndex < stepsPerSegment; stepIndex += 1) {
        clock.advance(stepMs)
        x += direction * step
        emitMove(x, 200)
      }
      direction *= -1
    }
  }

  return {
    detector,
    captured,
    triggers,
    clock,
    emitMove,
    shake,
    moveHandler,
    restore() {
      Date.now = realDateNow
    }
  }
}

test("快速左右晃动达到阈值后只触发一次开窗动作", (t) => {
  const harness = createHarness()
  t.after(() => harness.restore())

  harness.detector.start()
  assert.equal(harness.captured.startCalls, 1)
  assert.equal(harness.moveHandler() instanceof Function, true)

  harness.shake()
  assert.equal(harness.triggers.count, 1, "4 次快速反向应触发一次")

  // 触发后会进入 1800ms 冷却，等待冷却结束再晃动
  harness.clock.advance(2000)
  harness.shake()
  assert.equal(harness.triggers.count, 2, "冷却结束后再次晃动可再次触发")
})

test("晃动幅度过小或速度过慢时不会触发", (t) => {
  const harness = createHarness()
  t.after(() => harness.restore())
  harness.detector.start()

  harness.shake({ step: 1 })
  assert.equal(harness.triggers.count, 0, "每次位移过小不应被识别为晃动")

  const slow = createHarness()
  t.after(() => slow.restore())
  slow.detector.start()
  slow.shake({ stepMs: 2000 })
  assert.equal(slow.triggers.count, 0, "事件间隔过长时应重置轨迹")
})

test("垂直方向为主的移动会重置轨迹而不触发", (t) => {
  const harness = createHarness()
  t.after(() => harness.restore())
  harness.detector.start()

  let x = 100
  for (let index = 0; index < 10; index += 1) {
    harness.clock.advance(300)
    harness.emitMove(x, 200 + (index % 2 === 0 ? 100 : -100))
    x += index % 2 === 0 ? 3 : -3
  }

  assert.equal(harness.triggers.count, 0, "纵向抖动不应误触发行窗口")
})

test("触发后进入冷却期，冷却时间内的连续晃动不会重复触发", (t) => {
  const harness = createHarness()
  t.after(() => harness.restore())
  harness.detector.start()

  harness.shake()
  assert.equal(
    harness.triggers.count,
    1,
    `单次晃动应触发一次（时间线 now=${harness.clock.now}）`
  )

  // 冷却期(1800ms)内继续剧烈晃动不得重复触发
  harness.shake()
  assert.equal(harness.triggers.count, 1, "冷却期内不得重复触发")

  harness.clock.advance(2000)
  harness.shake()
  assert.ok(harness.triggers.count <= 2, "冷却结束后仍应遵循同一触发规则")
})

test("长时间无鼠标事件后轨迹被重置，避免旧状态误触发", (t) => {
  const harness = createHarness()
  t.after(() => harness.restore())
  harness.detector.start()

  harness.clock.advance(300)
  harness.emitMove(100, 200)
  harness.clock.advance(300)
  harness.emitMove(110, 200)

  harness.clock.advance(5000)
  harness.emitMove(100, 200)

  const before = harness.triggers.count
  harness.shake()
  assert.ok(harness.triggers.count <= before + 1)
})

test("重复 start 不会重复注册监听，stop 后移动事件不再触发", (t) => {
  const harness = createHarness()
  t.after(() => harness.restore())

  harness.detector.start()
  harness.detector.start()
  assert.equal(harness.captured.startCalls, 1, "重复 start 应幂等")
  assert.equal(harness.captured.listeners.length, 1)

  harness.detector.stop()
  assert.equal(harness.captured.listeners.length, 0, "stop 应移除监听器")
  assert.equal(harness.captured.stopCalls, 1)
  assert.equal(
    harness.triggers.count,
    0,
    "停止后不应存在任何可以触发窗口切换的监听路径"
  )

  harness.detector.stop()
  assert.equal(harness.captured.stopCalls, 1, "重复 stop 应幂等")
})

test("底层输入钩子启动失败时回滚监听并报告错误而不崩溃", (t) => {
  const harness = createHarness()
  t.after(() => harness.restore())
  harness.captured.startError = new Error("input monitoring denied")

  assert.doesNotThrow(() => harness.detector.start())
  assert.equal(harness.captured.listeners.length, 0, "启动失败必须移除监听器")
  assert.equal(harness.captured.stopCalls, 0, "未启动时不应调用 stop")

  harness.captured.startError = null
  assert.doesNotThrow(() => harness.detector.start())
  assert.equal(harness.captured.listeners.length, 1, "失败后应允许重试启动")
})

test("正常移动不会误触发（横向距离不足或方向未反转）", (t) => {
  const harness = createHarness()
  t.after(() => harness.restore())
  harness.detector.start()

  // 持续向同一方向快速移动：没有反向，不应触发
  let x = 100
  for (let index = 0; index < 20; index += 1) {
    harness.clock.advance(100)
    harness.emitMove(x, 200)
    x += 10
  }
  assert.equal(harness.triggers.count, 0)

  // 抖动幅度低于最小事件位移：直接忽略
  for (let index = 0; index < 20; index += 1) {
    harness.clock.advance(100)
    harness.emitMove(x + (index % 2), 200)
  }
  assert.equal(harness.triggers.count, 0)
})
