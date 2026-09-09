import { app } from "electron"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

export interface HistoryRecord {
  id: string
  createdAt: string
  updatedAt: string
  title: string
  language: string
  problem: Record<string, unknown>
  solution: Record<string, unknown>
  debug?: unknown
  screenshotPaths: string[]
}

class HistoryHelper {
  private readonly screenshotRetentionMs = 3 * 24 * 60 * 60 * 1000

  private get historyDir(): string {
    const applicationData =
      process.platform === "win32" && process.env.APPDATA
        ? process.env.APPDATA
        : app.getPath("userData")
    return path.join(applicationData, "steamgamecode", "history")
  }

  private get screenshotsDir(): string {
    return path.join(this.historyDir, "screenshots")
  }

  private get historyFile(): string {
    return path.join(this.historyDir, "history.json")
  }

  public initialize(): void {
    this.ensureDirectories()
    this.cleanupExpiredScreenshots()
    console.log(`Solution history initialized at: ${this.historyDir}`)
  }

  public list(): HistoryRecord[] {
    this.ensureDirectories()
    this.cleanupExpiredScreenshots()
    return this.readRecords().sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    )
  }

  public get(id: string): HistoryRecord | null {
    return this.list().find((record) => record.id === id) ?? null
  }

  public saveSolution(
    problem: Record<string, unknown>,
    solution: Record<string, unknown>,
    language: string,
    screenshotPaths: string[]
  ): HistoryRecord {
    this.ensureDirectories()
    const id = randomUUID()
    const now = new Date().toISOString()
    const retainedScreenshots = this.copyScreenshots(id, screenshotPaths)
    const problemStatement = String(problem.problem_statement || "未命名题目")
    const title = problemStatement
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean)
      ?.slice(0, 100) || "未命名题目"

    const record: HistoryRecord = {
      id,
      createdAt: now,
      updatedAt: now,
      title,
      language,
      problem,
      solution,
      screenshotPaths: retainedScreenshots
    }

    const records = this.readRecords()
    records.unshift(record)
    this.writeRecords(records)
    this.cleanupExpiredScreenshots()
    return record
  }

  public attachDebug(problem: Record<string, unknown>, debug: unknown): void {
    const records = this.readRecords()
    const statement = String(problem.problem_statement || "")
    const record = records.find(
      (item) => String(item.problem?.problem_statement || "") === statement
    )
    if (!record) return

    record.debug = debug
    record.updatedAt = new Date().toISOString()
    this.writeRecords(records)
  }

  public delete(id: string): boolean {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false
    const records = this.readRecords()
    const nextRecords = records.filter((record) => record.id !== id)
    if (nextRecords.length === records.length) return false

    this.writeRecords(nextRecords)
    const screenshotDirectory = path.join(this.screenshotsDir, id)
    if (fs.existsSync(screenshotDirectory)) {
      fs.rmSync(screenshotDirectory, { recursive: true, force: true })
    }
    return true
  }

  private ensureDirectories(): void {
    fs.mkdirSync(this.screenshotsDir, { recursive: true })
  }

  private readRecords(): HistoryRecord[] {
    try {
      if (!fs.existsSync(this.historyFile)) return []
      const parsed = JSON.parse(fs.readFileSync(this.historyFile, "utf8"))
      return Array.isArray(parsed) ? parsed : []
    } catch (error) {
      console.error("Failed to read solution history:", error)
      return []
    }
  }

  private writeRecords(records: HistoryRecord[]): void {
    this.ensureDirectories()
    fs.writeFileSync(this.historyFile, JSON.stringify(records, null, 2), "utf8")
  }

  private copyScreenshots(id: string, sourcePaths: string[]): string[] {
    const targetDirectory = path.join(this.screenshotsDir, id)
    fs.mkdirSync(targetDirectory, { recursive: true })

    return sourcePaths.flatMap((sourcePath, index) => {
      try {
        if (!fs.existsSync(sourcePath)) return []
        const extension = path.extname(sourcePath) || ".png"
        const targetPath = path.join(targetDirectory, `${index + 1}${extension}`)
        fs.copyFileSync(sourcePath, targetPath)
        return [targetPath]
      } catch (error) {
        console.warn("Failed to retain history screenshot:", error)
        return []
      }
    })
  }

  private cleanupExpiredScreenshots(): void {
    this.ensureDirectories()
    const cutoff = Date.now() - this.screenshotRetentionMs
    let deletedCount = 0

    for (const directoryEntry of fs.readdirSync(this.screenshotsDir, {
      withFileTypes: true
    })) {
      if (!directoryEntry.isDirectory()) continue
      const directory = path.join(this.screenshotsDir, directoryEntry.name)
      for (const fileEntry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!fileEntry.isFile()) continue
        const filePath = path.join(directory, fileEntry.name)
        try {
          if (fs.statSync(filePath).mtimeMs < cutoff) {
            fs.unlinkSync(filePath)
            deletedCount += 1
          }
        } catch (error) {
          console.warn("Failed to clean expired screenshot:", error)
        }
      }
      if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory)
    }

    const records = this.readRecords()
    let changed = false
    for (const record of records) {
      const existing = (record.screenshotPaths || []).filter(fs.existsSync)
      if (existing.length !== (record.screenshotPaths || []).length) {
        record.screenshotPaths = existing
        changed = true
      }
    }
    if (changed) this.writeRecords(records)
    if (deletedCount > 0) {
      console.log(`Deleted ${deletedCount} expired history screenshot(s)`)
    }
  }
}

export const historyHelper = new HistoryHelper()
