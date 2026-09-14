import { app } from "electron"
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

function loadNativeModule(): NativeMacCommandInterceptor | null {
  if (process.platform !== "darwin") return null

  const nativeRequire = createRequire(__filename)
  const candidates = [
    path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "native",
      "mac-command-interceptor",
      "build",
      "Release",
      process.arch === "arm64"
        ? "mac_command_interceptor-arm64.node"
        : "mac_command_interceptor-x64.node"
    ),
    path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "native",
      "mac-command-interceptor",
      "build",
      "Release",
      "mac_command_interceptor.node"
    ),
    path.join(
      app.getAppPath(),
      "native",
      "mac-command-interceptor",
      "build",
      "Release",
      "mac_command_interceptor.node"
    ),
    path.join(
      process.cwd(),
      "native",
      "mac-command-interceptor",
      "build",
      "Release",
      "mac_command_interceptor.node"
    )
  ]

  for (const candidate of candidates) {
    try {
      return nativeRequire(candidate) as NativeMacCommandInterceptor
    } catch (error) {
      console.warn(`Could not load macOS command interceptor from ${candidate}:`, error)
    }
  }

  return null
}

export function getMacCommandInterceptor(): NativeMacCommandInterceptor | null {
  if (cachedInterceptor === undefined) {
    cachedInterceptor = loadNativeModule()
  }
  return cachedInterceptor
}
