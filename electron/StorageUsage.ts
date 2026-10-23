import { app } from "electron"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { LOG_DIRECTORY } from "./logger"
import { configHelper } from "./ConfigHelper"
import { DEFAULT_INTERVIEW_CONTEXT_PATH } from "./InterviewContextHelper"

export interface StorageUsage {
  totalBytes: number
  scannedAt: string
  partial: boolean
  categories: Array<{ id: string; label: string; bytes: number; files: number }>
  locations: string[]
}

// Only enumerate app-owned data locations, never the application bundle or disk.
async function scanStorage(): Promise<StorageUsage> {
  const userData = app.getPath("userData")
  const cache = path.join(userData, "cache")
  const temp = path.join(userData, "temp")
  // Match electron-builder's package name and electron-updater's platform cache root.
  const systemCache = process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches")
    : process.platform === "win32" ? process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    : process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")
  const updates = path.join(systemCache, "steamgamecode-updater")
  const stable = path.join(app.getPath("appData"), "steamgamecode")
  const context = path.resolve(configHelper.loadConfig().interviewContextPath?.trim() || DEFAULT_INTERVIEW_CONTEXT_PATH)
  const locations = [...new Set([
    userData, stable, LOG_DIRECTORY, app.getPath("sessionData"), cache, temp, updates, app.getPath("crashDumps"), context,
    path.join(app.getPath("appData"), "Electron", "config.json"),
  ].map((value) => path.resolve(value)))]
  const categories = [
    { id: "images", label: "截图与相机照片", bytes: 0, files: 0 },
    { id: "conversations", label: "聊天记录与附件", bytes: 0, files: 0 },
    { id: "logs", label: "运行与崩溃日志", bytes: 0, files: 0 },
    { id: "cache", label: "缓存与临时文件", bytes: 0, files: 0 },
    { id: "updates", label: "更新下载缓存", bytes: 0, files: 0 },
    { id: "settings", label: "配置与上下文", bytes: 0, files: 0 },
    { id: "other", label: "其他应用数据", bytes: 0, files: 0 },
  ]
  const inside = (file: string, root: string) => file === root || file.startsWith(root + path.sep)
  const visited = new Set<string>()
  const inodes = new Set<string>()
  let partial = false
  let entries = 0
  const deadline = Date.now() + 20000
  const walk = async (file: string): Promise<void> => {
    if (visited.has(file)) return
    visited.add(file)
    if (++entries > 200000 || Date.now() > deadline) { partial = true; return }
    try {
      const stat = await fs.lstat(file)
      if (stat.isSymbolicLink()) return
      if (stat.isDirectory()) {
        const dir = await fs.opendir(file)
        for await (const entry of dir) {
          if (entries > 200000 || Date.now() > deadline) { partial = true; break }
          await walk(path.join(file, entry.name))
        }
        return
      }
      if (!stat.isFile()) return
      const inode = stat.dev + ":" + stat.ino
      if (stat.ino && inodes.has(inode)) return
      if (stat.ino) inodes.add(inode)
      const relative = path.relative(userData, file).split(path.sep)
      const name = path.basename(file)
      const id = inside(file, updates) ? "updates"
        : inside(file, LOG_DIRECTORY) || inside(file, app.getPath("crashDumps")) || /\.log(?:\.\d+)?$/.test(name) || name === "crash-restarts.json" ? "logs"
        : file === context || name === "config.json" ? "settings"
        : inside(file, path.join(stable, "chat-attachments")) || name === "chat-sessions.json" ? "conversations"
        : ["screenshots", "extra_screenshots"].includes(relative[0]) ? "images"
        : [cache, temp].some((root) => inside(file, root))
          || relative.some((part) => /^(?:.*cache.*|Code Cache|GPUCache|DawnCache|blob_storage)$/i.test(part)) ? "cache" : "other"
      const category = categories.find((item) => item.id === id)!
      // POSIX reports allocated 512-byte blocks. Other platforms fall back to file length.
      category.bytes += typeof stat.blocks === "number" && process.platform !== "win32" ? stat.blocks * 512 : stat.size
      category.files++
    } catch (error) {
      // Files may disappear while Chromium writes its cache.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") partial = true
    }
  }
  for (const root of locations) await walk(root)
  return { totalBytes: categories.reduce((sum, item) => sum + item.bytes, 0), categories, locations, partial, scannedAt: new Date().toISOString() }
}

let pending: Promise<StorageUsage> | undefined
export function getStorageUsage(): Promise<StorageUsage> {
  if (!pending) pending = scanStorage().finally(() => { pending = undefined })
  return pending
}
