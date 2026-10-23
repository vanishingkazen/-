import { randomUUID } from "node:crypto"

interface CaptureRequest {
  id: string
  context: string
  expiresAt: number
  uploading: boolean
  timer: ReturnType<typeof setTimeout>
  result: Promise<string>
  resolve: (path: string) => void
  reject: (error: Error) => void
}

/** One in-flight photo; a request belongs to the session/view where it began. */
export class PhoneCameraRequests {
  private pending: CaptureRequest | null = null
  private completed = new Map<string, { path: string; expiresAt: number }>()

  start(context: string): CaptureRequest {
    if (this.pending) throw new Error("正在拍照或上传，请等待完成")
    let resolve!: CaptureRequest["resolve"]
    let reject!: CaptureRequest["reject"]
    const result = new Promise<string>((yes, no) => { resolve = yes; reject = no })
    // Locally initiated requests are completed by HTTP, with no promise consumer.
    void result.catch(() => {})
    const id = randomUUID()
    const timer = setTimeout(() => this.fail(id, "拍照超时，请确认手机 App 在前台"), 30_000)
    this.pending = { id, context, expiresAt: Date.now() + 30_000, uploading: false, timer, result, resolve, reject }
    return this.pending
  }

  completedPath(id: string): string | undefined {
    for (const [key, value] of this.completed) {
      if (value.expiresAt < Date.now()) this.completed.delete(key)
    }
    return this.completed.get(id)?.path
  }

  isValid(id: string, context: string): boolean {
    return this.pending?.id === id && this.pending.context === context && this.pending.expiresAt > Date.now()
  }

  isUploading(id: string): boolean { return this.pending?.id === id && this.pending.uploading }

  beginUpload(id: string, context: string): void {
    if (!this.isValid(id, context)) throw new Error("拍照请求已失效或会话已切换，请重新拍摄")
    if (this.pending!.uploading) throw new Error("该照片正在上传")
    this.pending!.uploading = true
  }

  finish(id: string, path: string): void {
    if (this.pending?.id !== id) throw new Error("拍照请求已失效")
    const request = this.pending
    this.pending = null
    clearTimeout(request.timer)
    this.completed.set(id, { path, expiresAt: Date.now() + 60_000 })
    request.resolve(path)
  }

  fail(id: string, message: string): void {
    if (this.pending?.id !== id) return
    const request = this.pending
    this.pending = null
    clearTimeout(request.timer)
    request.reject(new Error(message))
  }

  cancel(): void {
    if (this.pending) this.fail(this.pending.id, "手机连接已关闭，请重新拍摄")
    this.completed.clear()
  }
}
