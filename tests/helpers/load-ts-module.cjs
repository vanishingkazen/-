/* eslint-disable @typescript-eslint/no-var-requires */
"use strict"

const fs = require("node:fs")
const Module = require("node:module")
const path = require("node:path")
const ts = require("typescript")

const ROOT = path.resolve(__dirname, "..", "..")
const originalLoad = Module._load

if (!require.extensions[".ts"]) {
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
}

/**
 * 在隔离的模块图中加载 electron/*.ts。
 *
 * - `mocks` 以 require 请求名为键（例如 "electron"、"./ConfigHelper"）
 * - 命中 mock 时返回 mock 值，否则回落到真实模块
 * - 每次调用都会清除目标模块缓存，便于重复加载同一模块做隔离用例
 */
function installModuleMocks(mocks = {}) {
  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request]
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  return () => {
    Module._load = originalLoad
  }
}

function loadTsModule(relativePath, mocks = {}) {
  const absolutePath = path.join(ROOT, relativePath)
  const restore = installModuleMocks(mocks)
  try {
    delete require.cache[require.resolve(absolutePath)]
    return require(absolutePath)
  } finally {
    restore()
  }
}

function freshLoad(relativePath, mocks = {}) {
  const absolutePath = path.join(ROOT, relativePath)
  const restore = installModuleMocks(mocks)
  try {
    const resolved = require.resolve(absolutePath)
    delete require.cache[resolved]
    for (const dependency of Object.keys(require.cache)) {
      if (dependency === resolved) continue
      if (!dependency.startsWith(path.dirname(absolutePath))) continue
      if (!dependency.endsWith(".ts")) continue
      delete require.cache[dependency]
    }
    return require(absolutePath)
  } finally {
    restore()
  }
}

module.exports = {
  ROOT,
  freshLoad,
  installModuleMocks,
  loadTsModule,
  originalLoad
}
