import type { BrowserWindow } from "electron"
import { randomUUID } from "node:crypto"
import WebSocket from "ws"
import { configHelper } from "./ConfigHelper"
import { loadInterviewAsrEnhancement } from "./InterviewContextHelper"

type VoiceState = "idle" | "connecting" | "listening" | "stopping" | "error"
export type VoiceSource = "microphone" | "system"

interface VoiceSession {
  socket: WebSocket | null
  taskId: string | null
  finalTranscript: string
  partialTranscript: string
  segments: TranscriptSegment[]
  state: VoiceState
}

interface TranscriptSegment {
  text: string
  completedAt: number
}

export type VoiceSpeaker = "interviewer" | "candidate"

export interface VoiceConversationTurn {
  speaker: VoiceSpeaker
  text: string
  completedAt: number
}

export interface VoiceConversationTranscript {
  systemTranscript: string
  microphoneTranscript: string
  rawMicrophoneTranscript: string
  removedSegments: number
  turns: VoiceConversationTurn[]
}

const TRANSCRIPT_DEDUPE_WINDOW_MS = 8_000
const MEANINGLESS_UTTERANCE = /^(嗯+|呃+|啊+|哦+|额+|哎+|喂+|诶+|对+|对呀|是的|好的|好|行+|行吧|可以|明白|收到|ok+|okay|拜拜)$/i

const normalizeForComparison = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[嗯呃啊哦额]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")

const lcsCoverage = (needle: string, haystack: string): number => {
  if (!needle || !haystack) return 0
  let previous = new Uint16Array(haystack.length + 1)
  for (let left = 1; left <= needle.length; left += 1) {
    const current = new Uint16Array(haystack.length + 1)
    for (let right = 1; right <= haystack.length; right += 1) {
      current[right] = needle[left - 1] === haystack[right - 1]
        ? previous[right - 1] + 1
        : Math.max(previous[right], current[right - 1])
    }
    previous = current
  }
  return previous[haystack.length] / needle.length
}

const bigramCoverage = (needle: string, haystack: string): number => {
  if (needle.length < 2 || haystack.length < 2) return 0
  const needleBigrams: string[] = []
  for (let index = 0; index < needle.length - 1; index += 1) {
    needleBigrams.push(needle.slice(index, index + 2))
  }
  const haystackBigrams = new Set<string>()
  for (let index = 0; index < haystack.length - 1; index += 1) {
    haystackBigrams.add(haystack.slice(index, index + 2))
  }
  const matches = needleBigrams.filter((item) => haystackBigrams.has(item)).length
  return matches / needleBigrams.length
}

export class VoiceRecognitionHelper {
  private readonly sessions: Record<VoiceSource, VoiceSession> = {
    microphone: { socket: null, taskId: null, finalTranscript: "", partialTranscript: "", segments: [], state: "idle" },
    system: { socket: null, taskId: null, finalTranscript: "", partialTranscript: "", segments: [], state: "idle" }
  }

  constructor(
    private readonly getMainWindow: () => BrowserWindow | null,
    private readonly onEvent?: (channel: string, payload?: unknown) => void
  ) {}

  public getTranscript(source?: VoiceSource): string {
    if (source) return this.sessions[source].finalTranscript.trim()
    const system = this.sessions.system.finalTranscript.trim()
    const microphone = this.sessions.microphone.finalTranscript.trim()
    return [
      system ? `面试官：${system}` : "",
      microphone ? `面试者：${microphone}` : ""
    ].filter(Boolean).join("\n")
  }

  public clearTranscript(source?: VoiceSource): void {
    const sources: VoiceSource[] = source ? [source] : ["microphone", "system"]
    for (const item of sources) {
      this.sessions[item].finalTranscript = ""
      this.sessions[item].partialTranscript = ""
      this.sessions[item].segments = []
      this.send("voice-context-cleared", { source: item })
    }
  }

  public getLiveSnapshot(): {
    system: { state: VoiceState; message: string; transcript: string; partialTranscript: string }
    microphone: { state: VoiceState; message: string; transcript: string; partialTranscript: string }
  } {
    const snapshot = (source: VoiceSource) => ({
      state: this.sessions[source].state,
      message: this.sessions[source].state === "listening"
        ? source === "system" ? "正在听会议系统音频" : "正在听笔记本麦克风"
        : "",
      transcript: this.sessions[source].finalTranscript,
      partialTranscript: this.sessions[source].partialTranscript
    })
    return { system: snapshot("system"), microphone: snapshot("microphone") }
  }

  public getConversationTranscript(): VoiceConversationTranscript {
    const systemSegments = this.sessions.system.segments
    const microphoneSegments = this.sessions.microphone.segments
    const fullSystemText = normalizeForComparison(
      systemSegments.map((segment) => segment.text).join(" ")
    )
    const keptMicrophoneSegments: TranscriptSegment[] = []
    let removedSegments = 0

    for (const microphoneSegment of microphoneSegments) {
      const rawText = microphoneSegment.text.trim()
      if (!rawText) continue
      if (MEANINGLESS_UTTERANCE.test(rawText.replace(/[\s，。！？,.!?]/g, ""))) {
        removedSegments += 1
        continue
      }

      const microphoneText = normalizeForComparison(rawText)
      if (!microphoneText) continue
      const nearbySystemText = normalizeForComparison(
        systemSegments
          .filter((segment) =>
            Math.abs(segment.completedAt - microphoneSegment.completedAt) <= TRANSCRIPT_DEDUPE_WINDOW_MS
          )
          .map((segment) => segment.text)
          .join(" ")
      )

      let isEcho = microphoneText.length >= 3 && fullSystemText.includes(microphoneText)
      if (!isEcho && nearbySystemText && microphoneText.length >= 3) {
        const exactCoverage = nearbySystemText.includes(microphoneText)
        const coverage = Math.max(
          lcsCoverage(microphoneText, nearbySystemText),
          bigramCoverage(microphoneText, nearbySystemText)
        )
        const threshold = microphoneText.length >= 12
          ? 0.68
          : microphoneText.length >= 8
            ? 0.72
            : microphoneText.length >= 5
              ? 0.78
              : 1
        isEcho = exactCoverage || coverage >= threshold
      }
      if (!isEcho && microphoneText.length >= 8 && fullSystemText) {
        const globalCoverage = Math.max(
          lcsCoverage(microphoneText, fullSystemText),
          bigramCoverage(microphoneText, fullSystemText)
        )
        isEcho = globalCoverage >= 0.9
      }

      if (isEcho) removedSegments += 1
      else keptMicrophoneSegments.push(microphoneSegment)
    }

    const rawMicrophoneTranscript = this.getTranscript("microphone")
    const turns: VoiceConversationTurn[] = [
      ...systemSegments.map((segment) => ({
        speaker: "interviewer" as const,
        text: segment.text,
        completedAt: segment.completedAt
      })),
      ...keptMicrophoneSegments.map((segment) => ({
        speaker: "candidate" as const,
        text: segment.text,
        completedAt: segment.completedAt
      }))
    ].sort((left, right) =>
      left.completedAt - right.completedAt ||
      (left.speaker === right.speaker ? 0 : left.speaker === "interviewer" ? -1 : 1)
    )
    return {
      systemTranscript: this.getTranscript("system"),
      microphoneTranscript: keptMicrophoneSegments.map((segment) => segment.text).join("\n").trim(),
      rawMicrophoneTranscript,
      removedSegments,
      turns
    }
  }

  public async start(source: VoiceSource = "microphone"): Promise<{ success: boolean; error?: string }> {
    const config = configHelper.loadConfig()
    if (!config.speechApiKey?.trim()) {
      return { success: false, error: "请先在设置中填写百炼语音 API Key" }
    }
    await this.closeSocket(source)
    const session = this.sessions[source]
    this.setState(source, "connecting", source === "system" ? "正在连接面试官声道..." : "正在连接面试者声道...")

    const region = config.speechRegion || "cn-beijing"
    const model = config.speechModel || "qwen-audio-3.0-asr-flash-streaming"
    const workspaceId = config.speechWorkspaceId?.trim()
    const host = workspaceId
      ? `${encodeURIComponent(workspaceId)}.${region}.maas.aliyuncs.com`
      : region === "ap-southeast-1"
        ? "dashscope-intl.aliyuncs.com"
        : "dashscope.aliyuncs.com"
    const url = `wss://${host}/api-ws/v1/inference`
    const taskId = randomUUID()
    session.taskId = taskId
    const asrEnhancement = loadInterviewAsrEnhancement(
      config.interviewContextEnabled,
      config.interviewContextPath
    )

    return new Promise((resolve) => {
      let settled = false
      const socket = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${config.speechApiKey.trim()}`
        }
      })
      session.socket = socket

      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        socket.close()
        this.setState(source, "error", "语音服务连接超时")
        resolve({ success: false, error: "语音服务连接超时" })
      }, 12_000)

      socket.on("open", () => {
        socket.send(JSON.stringify({
          header: {
            action: "run-task",
            task_id: taskId,
            streaming: "duplex"
          },
          payload: {
            task_group: "audio",
            task: "asr",
            function: "recognition",
            model,
            parameters: {
              format: "pcm",
              sample_rate: 16000,
              max_sentence_silence: 1000,
              semantic_punctuation_enabled: false,
              heartbeat: true,
              ...(Object.keys(asrEnhancement.vocabulary).length
                ? { vocabulary: asrEnhancement.vocabulary }
                : {})
            },
            input: asrEnhancement.contextText
              ? {
                  context: [{
                    role: "user",
                    content: [{ type: "input_text", text: asrEnhancement.contextText }]
                  }]
                }
              : {}
          }
        }))
      })

      socket.on("message", (raw) => {
        const event = this.handleMessage(source, raw.toString())
        if (event === "task-started" && !settled) {
          clearTimeout(timeout)
          settled = true
          this.setState(source, "listening", source === "system" ? "正在听面试官..." : "正在听面试者...")
          resolve({ success: true })
        } else if (event === "task-failed" && !settled) {
          clearTimeout(timeout)
          settled = true
          resolve({ success: false, error: "语音识别任务启动失败" })
        } else if (event === "task-finished" && socket.readyState === WebSocket.OPEN) {
          socket.close(1000, "voice stopped")
        }
      })
      socket.on("unexpected-response", (_request, response) => {
        let body = ""
        response.on("data", (chunk) => {
          body += chunk.toString()
        })
        response.on("end", () => {
          let detail = `HTTP ${response.statusCode || "握手失败"}`
          try {
            const payload = JSON.parse(body) as { message?: string }
            if (payload.message) detail = payload.message
          } catch {
            if (body.trim()) detail = body.trim().slice(0, 200)
          }
          const message = `语音服务连接失败：${detail}`
          this.setState(source, "error", message)
          if (!settled) {
            clearTimeout(timeout)
            settled = true
            resolve({ success: false, error: message })
          }
        })
      })
      socket.on("error", (error) => {
        const message = error.message || "实时语音连接失败"
        this.setState(source, "error", message)
        if (!settled) {
          clearTimeout(timeout)
          settled = true
          resolve({ success: false, error: message })
        }
      })
      socket.on("close", () => {
        if (session.socket === socket) session.socket = null
        session.taskId = null
        if (session.state !== "error") this.setState(source, "idle", "语音识别已停止")
      })
    })
  }

  public appendAudio(audio: ArrayBuffer | Uint8Array, source: VoiceSource = "microphone"): { success: boolean } {
    const session = this.sessions[source]
    const socket = session.socket
    if (!socket || socket.readyState !== WebSocket.OPEN || session.state !== "listening") {
      return { success: false }
    }
    const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio)
    socket.send(bytes, { binary: true })
    return { success: true }
  }

  public async stop(source: VoiceSource = "microphone"): Promise<{ success: boolean; transcript: string }> {
    const session = this.sessions[source]
    if (!session.socket) {
      this.setState(source, "idle", "语音识别已停止")
      return { success: true, transcript: this.getTranscript(source) }
    }
    this.setState(source, "stopping", "正在结束语音识别...")
    if (session.socket.readyState === WebSocket.OPEN) {
      const socket = session.socket
      socket.send(JSON.stringify({
        header: {
          action: "finish-task",
          task_id: session.taskId,
          streaming: "duplex"
        },
        payload: { input: {} }
      }))
      await new Promise<void>((resolve) => {
        let finished = false
        const finish = () => {
          if (finished) return
          finished = true
          resolve()
        }
        socket.once("close", finish)
        setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN) socket.close(1000, "voice stopped")
        }, 3000)
        setTimeout(finish, 3500)
      })
    } else {
      await this.closeSocket(source)
    }
    return { success: true, transcript: this.getTranscript(source) }
  }

  private handleMessage(source: VoiceSource, raw: string): string | undefined {
    try {
      const event = JSON.parse(raw) as {
        header?: { event?: string; error_message?: string }
        payload?: {
          output?: {
            sentence?: {
              text?: string
              sentence_end?: boolean
              heartbeat?: boolean
            }
          }
        }
      }
      const eventName = event.header?.event
      if (eventName === "result-generated") {
        const sentence = event.payload?.output?.sentence
        if (!sentence || sentence.heartbeat) return eventName
        const text = sentence.text?.trim() || ""
        if (!sentence.sentence_end) {
          this.sessions[source].partialTranscript = text
          this.send("voice-transcript-partial", { source, text })
        } else if (text) {
          const session = this.sessions[source]
          const completedAt = Date.now()
          session.partialTranscript = ""
          session.finalTranscript = [session.finalTranscript, text].filter(Boolean).join("\n")
          session.segments.push({ text, completedAt })
          this.send("voice-transcript-final", {
            source,
            text,
            fullText: session.finalTranscript,
            completedAt
          })
        }
      } else if (eventName === "task-failed") {
        this.setState(source, "error", event.header?.error_message || "语音服务返回错误")
      }
      return eventName
    } catch (error) {
      console.warn("Unable to parse voice recognition event:", error)
      return undefined
    }
  }

  private setState(source: VoiceSource, state: VoiceState, message: string): void {
    this.sessions[source].state = state
    if (state !== "listening") this.sessions[source].partialTranscript = ""
    this.send("voice-status", { source, state, message })
  }

  private send(channel: string, data?: unknown): void {
    const window = this.getMainWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, data)
    this.onEvent?.(channel, data)
  }

  private async closeSocket(source: VoiceSource): Promise<void> {
    const session = this.sessions[source]
    const socket = session.socket
    session.socket = null
    session.taskId = null
    if (!socket) return
    try {
      socket.removeAllListeners()
      socket.close()
    } catch {
      // Socket is already closed.
    }
  }
}
