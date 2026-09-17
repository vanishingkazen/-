import { app } from "electron"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

export interface NativeShortcutSpec {
  action: string
  keyCode: number
  shift: boolean
  option: boolean
  control: boolean
}

interface NativeMacCommandInterceptor {
  start(): boolean
  stop(): void
  setEnabled(enabled: boolean): boolean
  isTrusted(): boolean
  requestPermission(): boolean
  setShortcuts(shortcuts: NativeShortcutSpec[]): boolean
  setBrowserBundleIds(bundleIds: string[]): boolean
  pollActions(): string[]
}

let cachedInterceptor: NativeMacCommandInterceptor | null | undefined

function releaseDirectories(): string[] {
  return [
    // 开发模式：源码目录下编译好的产物优先
    path.join(app.getAppPath(), "native", "mac-command-interceptor", "build", "Release"),
    path.join(process.cwd(), "native", "mac-command-interceptor", "build", "Release"),
    // 打包后：asar 解包目录
    path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "native",
      "mac-command-interceptor",
      "build",
      "Release"
    )
  ]
}

function candidateFileNames(): string[] {
  return [
    process.arch === "arm64"
      ? "mac_command_interceptor-arm64.node"
      : "mac_command_interceptor-x64.node",
    "mac_command_interceptor.node"
  ]
}

function loadNativeModule(): NativeMacCommandInterceptor | null {
  if (process.platform !== "darwin") return null

  const nativeRequire = createRequire(__filename)
  const attempted: string[] = []

  for (const directory of releaseDirectories()) {
    for (const fileName of candidateFileNames()) {
      const candidate = path.join(directory, fileName)
      if (!fs.existsSync(candidate)) continue

      try {
        const interceptor = nativeRequire(candidate) as NativeMacCommandInterceptor
        console.log("macOS command interceptor native module loaded from", candidate)
        return interceptor
      } catch (error) {
        attempted.push(candidate)
        console.warn(`Failed to load macOS command interceptor from ${candidate}:`, error)
      }
    }
  }

  // 正常情况下（例如尚未执行 build:native:mac）回退到 Electron globalShortcut，
  // 不需要把每个候选路径都打印成警告。
  console.log(
    "macOS command interceptor native module unavailable; falling back to Electron globalShortcut"
  )
  if (attempted.length) console.log("Attempted native modules:", attempted)
  return null
}

export function getMacCommandInterceptor(): NativeMacCommandInterceptor | null {
  if (cachedInterceptor === undefined) {
    cachedInterceptor = loadNativeModule()
  }
  return cachedInterceptor
}
