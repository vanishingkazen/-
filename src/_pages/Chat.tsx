import {
  Camera,
  Check,
  Code2,
  Copy,
  History,
  LoaderCircle,
  MessageSquarePlus,
  Minus,
  Mic,
  MicOff,
  Send,
  Settings,
  Square,
  X
} from "lucide-react"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter"
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism"
import python from "react-syntax-highlighter/dist/esm/languages/prism/python"
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript"
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript"
import java from "react-syntax-highlighter/dist/esm/languages/prism/java"
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp"
import csharp from "react-syntax-highlighter/dist/esm/languages/prism/csharp"
import go from "react-syntax-highlighter/dist/esm/languages/prism/go"
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust"
import type { ChatMessage as StoredChatMessage } from "../types/chat"
import { useToast } from "../contexts/toast"
import { COMMAND_KEY, isWindows } from "../utils/platform"

interface ChatProps {
  currentLanguage: string
}

interface ScreenshotAttachment {
  path: string
  preview: string
}

interface ChatMessage {
  id: string
  role: "user" | "assistant" | "error"
  content: string
  images?: ScreenshotAttachment[]
  streaming?: boolean
  speaker?: "用户A" | "用户B"
  stage?: "提交截图" | "题目提取" | "IQ 视觉解题" | "解答" | "调试" | "追问" | "语音输入" | "对话"
}

async function hydrateStoredMessages(messages: StoredChatMessage[]): Promise<ChatMessage[]> {
  return Promise.all(messages.map(async (message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    images: await Promise.all((message.images || []).map(async (image) => ({
      path: image.path,
      preview: image.preview || await window.electronAPI.getImagePreview(image.path).catch(() => "")
    }))),
    streaming: message.status === "streaming"
  })))
}

interface AudioCaptureChain {
  stream: MediaStream | null
  context: AudioContext | null
  sourceNode: MediaStreamAudioSourceNode | null
  processor: ScriptProcessorNode | null
}

type VoiceSource = "microphone" | "system"
interface VoiceConversation {
  systemTranscript: string
  microphoneTranscript: string
  rawMicrophoneTranscript: string
  removedSegments: number
}

const emptyAudioCaptureChain = (): AudioCaptureChain => ({
  stream: null,
  context: null,
  sourceNode: null,
  processor: null
})

SyntaxHighlighter.registerLanguage("python", python)
SyntaxHighlighter.registerLanguage("javascript", javascript)
SyntaxHighlighter.registerLanguage("typescript", typescript)
SyntaxHighlighter.registerLanguage("java", java)
SyntaxHighlighter.registerLanguage("cpp", cpp)
SyntaxHighlighter.registerLanguage("csharp", csharp)
SyntaxHighlighter.registerLanguage("go", go)
SyntaxHighlighter.registerLanguage("rust", rust)

const createId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function ProseContent({ text }: { text: string }) {
  return (
    <div className="chat-prose break-words">
      {text.split("\n").map((line, index) => {
        const heading = line.match(/^(#{1,4})\s+(.+)$/)
        if (heading) {
          return <div key={index} className="chat-prose-heading">{heading[2]}</div>
        }
        const bullet = line.match(/^\s*[-*]\s+(.+)$/)
        if (bullet) {
          return <div key={index} className="chat-prose-bullet"><span>•</span><span>{bullet[1]}</span></div>
        }
        if (!line.trim()) return <div key={index} className="h-2" />
        return <div key={index} className="whitespace-pre-wrap">{line}</div>
      })}
    </div>
  )
}

const normalizeCodeLanguage = (fenceLanguage: string, currentLanguage: string) => {
  const requested = fenceLanguage.trim().toLowerCase()
  const fallback = currentLanguage === "golang" ? "go" : currentLanguage
  if (!requested || ["code", "text", "plaintext"].includes(requested)) return fallback
  const aliases: Record<string, string> = {
    py: "python",
    js: "javascript",
    ts: "typescript",
    cs: "csharp",
    "c++": "cpp"
  }
  return aliases[requested] || requested
}

function MessageContent({ content, currentLanguage }: { content: string; currentLanguage: string }) {
  const [copied, setCopied] = useState<number | null>(null)
  const parts = useMemo(() => content.split(/```([\w+-]*)\n?([\s\S]*?)```/g), [content])

  if (parts.length === 1) {
    return <ProseContent text={content} />
  }

  const nodes: React.ReactNode[] = []
  for (let index = 0; index < parts.length; index += 3) {
    const prose = parts[index]
    const language = parts[index + 1]
    const code = parts[index + 2]
    if (prose) {
      nodes.push(
        <ProseContent key={`text-${index}`} text={prose} />
      )
    }
    if (code !== undefined) {
      const codeIndex = index + 2
      const highlightedLanguage = normalizeCodeLanguage(language, currentLanguage)
      nodes.push(
        <div key={`code-${index}`} className="chat-code-block">
          <div className="chat-code-header">
            <span>{highlightedLanguage}</span>
            <button
              type="button"
              onClick={async () => {
                const result = await window.electronAPI.writeClipboardText(code.trim())
                if (result.success) {
                  setCopied(codeIndex)
                  window.setTimeout(() => setCopied(null), 1200)
                }
              }}
            >
              {copied === codeIndex ? <Check size={13} /> : <Copy size={13} />}
              {copied === codeIndex ? "已复制" : "复制"}
            </button>
          </div>
          <SyntaxHighlighter
            language={highlightedLanguage}
            style={oneLight}
            showLineNumbers
            wrapLongLines
            customStyle={{
              margin: 0,
              padding: "13px",
              background: "transparent",
              fontSize: "11.5px",
              lineHeight: 1.65
            }}
            codeTagProps={{
              style: { fontFamily: "var(--pandora-font-mono)" }
            }}
          >
            {code.trim()}
          </SyntaxHighlighter>
        </div>
      )
    }
  }
  return <>{nodes}</>
}

const normalizeScreenshots = (value: unknown): ScreenshotAttachment[] => {
  if (Array.isArray(value)) return value
  if (value && typeof value === "object" && "previews" in value) {
    const previews = (value as { previews?: ScreenshotAttachment[] }).previews
    return Array.isArray(previews) ? previews : []
  }
  return []
}

const downsampleToPcm16 = (input: Float32Array, sourceRate: number): ArrayBuffer => {
  const targetRate = 16000
  const ratio = sourceRate / targetRate
  const length = Math.max(1, Math.floor(input.length / ratio))
  const output = new Int16Array(length)

  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio)
    const end = Math.min(input.length, Math.floor((index + 1) * ratio))
    let sum = 0
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
      sum += input[sourceIndex]
    }
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)))
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return output.buffer
}

const Chat: React.FC<ChatProps> = ({ currentLanguage }) => {
  const { showToast } = useToast()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessionId, setSessionId] = useState("")
  const [attachments, setAttachments] = useState<ScreenshotAttachment[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState("")
  const [sessionTitle, setSessionTitle] = useState("新建解题会话")
  const [voiceActive, setVoiceActive] = useState(false)
  const [systemVoiceStatus, setSystemVoiceStatus] = useState("")
  const [systemVoicePartial, setSystemVoicePartial] = useState("")
  const [systemVoiceTranscript, setSystemVoiceTranscript] = useState("")
  const [microphoneVoiceStatus, setMicrophoneVoiceStatus] = useState("")
  const [microphoneVoicePartial, setMicrophoneVoicePartial] = useState("")
  const [microphoneVoiceTranscript, setMicrophoneVoiceTranscript] = useState("")
  const [interviewContextEnabled, setInterviewContextEnabled] = useState(false)
  const [interviewContextAvailable, setInterviewContextAvailable] = useState(false)
  const [interviewContextPath, setInterviewContextPath] = useState("")
  const [interviewContextCharacters, setInterviewContextCharacters] = useState(0)
  const [interviewContextBusy, setInterviewContextBusy] = useState(false)
  const activeAssistantId = useRef<string | null>(null)
  const sessionIdRef = useRef("")
  const attachmentsRef = useRef<ScreenshotAttachment[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const voiceActiveRef = useRef(false)
  const systemVoiceTranscriptRef = useRef("")
  const microphoneVoiceTranscriptRef = useRef("")
  const audioCaptureRef = useRef<Record<VoiceSource, AudioCaptureChain>>({
    system: emptyAudioCaptureChain(),
    microphone: emptyAudioCaptureChain()
  })

  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  const updateAssistant = useCallback(
    (id: string, content: string, streaming: boolean) => {
      setMessages((current) =>
        current.map((item) =>
          item.id === id ? { ...item, content, streaming } : item
        )
      )
    },
    []
  )

  const showLocalSendError = useCallback(
    (assistantId: string, text: string, images: ScreenshotAttachment[], error: string) => {
      setMessages((current) => {
        if (current.some((item) => item.id === assistantId)) {
          return current.map((item) =>
            item.id === assistantId ? { ...item, content: error, streaming: false } : item
          )
        }
        return [
          ...current,
          {
            id: `${assistantId}-user`,
            role: "user" as const,
            content: text || "请分析截图并回答。",
            images,
            stage: images.length ? "提交截图" as const : undefined
          },
          {
            id: assistantId,
            role: "error" as const,
            content: error,
            streaming: false
          }
        ]
      })
    },
    []
  )

  const releaseVoiceCapture = useCallback(() => {
    for (const source of ["system", "microphone"] as const) {
      const chain = audioCaptureRef.current[source]
      chain.processor?.disconnect()
      chain.sourceNode?.disconnect()
      chain.stream?.getTracks().forEach((track) => track.stop())
      void chain.context?.close()
      audioCaptureRef.current[source] = emptyAudioCaptureChain()
    }
    voiceActiveRef.current = false
    setVoiceActive(false)
  }, [])

  const submitVoiceMessage = useCallback(async (conversation: VoiceConversation) => {
    const systemText = conversation.systemTranscript.trim()
    const microphoneText = conversation.microphoneTranscript.trim()
    if (!systemText && !microphoneText) {
      showToast("没有识别到语音", "请确认扬声器或麦克风有声音后重试", "error")
      return
    }
    const conversationText = [
      systemText ? `用户A（扬声器）：${systemText}` : "",
      microphoneText ? `用户B（麦克风）：${microphoneText}` : ""
    ].filter(Boolean).join("\n")
    if (busy) {
      setInput((current) => current ? `${current}\n${conversationText}` : conversationText)
      showToast("当前回答尚未结束", "语音内容已放入输入框", "neutral")
      return
    }

    const requestAttachments = [...attachmentsRef.current]
    const voiceAnswerFormat = `请给出用户B在面试现场可以直接说出口的回答：
- 默认只写一个短段落，用大白话解释，先说结论，再补一个简单例子或关键点。
- 如果面试背景资料中有相关项目经历，优先用第一人称结合我们的真实项目来回答，例如“在我们 PandoraQ 项目里……”，不要只背通用定义；资料没有的信息不要编造。
- 控制在3～6句话、约20～40秒能说完；不要写标题、分层编号、项目符号或长篇教程。
- 不主动展开英文全称和边缘细节，不说“好的”“我来分几层讲”等开场白。
- 只有问题明确要求详细分析、完整方案或代码时，才适当展开。`
    const requestText = `请从下面的双声道面试转写中，找到用户A真正需要用户B回答的问题，并直接给出自然、口语化的回答。\n\n${voiceAnswerFormat}\n\n${conversationText}`
    const assistantId = createId("assistant")
    activeAssistantId.current = assistantId
    setSystemVoiceTranscript("")
    setSystemVoicePartial("")
    systemVoiceTranscriptRef.current = ""
    setMicrophoneVoiceTranscript("")
    setMicrophoneVoicePartial("")
    microphoneVoiceTranscriptRef.current = ""
    setBusy(true)
    void window.electronAPI.clearVoiceContext()

    setPhase("正在发送语音问题...")
    try {
      const result = await window.electronAPI.sendChatMessage({
        requestId: assistantId,
        sessionId: sessionIdRef.current || sessionId,
        text: requestText,
        images: requestAttachments
      })
      if (!result.success) {
        showLocalSendError(assistantId, requestText, requestAttachments, result.error || "语音消息发送失败")
      }
    } catch (error) {
      showLocalSendError(assistantId, requestText, requestAttachments, error instanceof Error ? error.message : "语音消息发送失败")
    } finally {
      setBusy(false)
      setPhase("")
    }
  }, [busy, sessionId, showLocalSendError, showToast])

  const attachAudioStream = useCallback((stream: MediaStream, voiceSource: VoiceSource) => {
    const context = new AudioContext()
    const sourceNode = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(1024, 1, 1)
    processor.onaudioprocess = (event) => {
      const pcm = downsampleToPcm16(event.inputBuffer.getChannelData(0), context.sampleRate)
      void window.electronAPI.sendVoiceAudio(pcm, voiceSource)
    }
    sourceNode.connect(processor)
    processor.connect(context.destination)
    audioCaptureRef.current[voiceSource] = { stream, context, sourceNode, processor }
  }, [])

  const startVoiceInput = useCallback(async () => {
    if (voiceActiveRef.current) return
    if (busy) {
      showToast("当前回答尚未结束", "请等待 AI 回复完成后再开始语音输入", "neutral")
      return
    }
    let systemStream: MediaStream | null = null
    let microphoneStream: MediaStream | null = null
    try {
      systemStream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true
      })
      systemStream.getVideoTracks().forEach((track) => track.stop())
      if (!systemStream.getAudioTracks().length) {
        throw new Error("没有获取到 Windows 扬声器声音，请在共享时启用音频")
      }

      microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      })
      if (!microphoneStream.getAudioTracks().length) {
        throw new Error("没有获取到麦克风声音")
      }

      const [systemResult, microphoneResult] = await Promise.all([
        window.electronAPI.startVoiceRecognition("system"),
        window.electronAPI.startVoiceRecognition("microphone")
      ])
      if (!systemResult.success || !microphoneResult.success) {
        await Promise.all([
          window.electronAPI.stopVoiceRecognition("system"),
          window.electronAPI.stopVoiceRecognition("microphone")
        ])
        throw new Error(systemResult.error || microphoneResult.error || "无法连接语音识别服务")
      }

      attachAudioStream(systemStream, "system")
      attachAudioStream(microphoneStream, "microphone")
      systemStream = null
      microphoneStream = null
      voiceActiveRef.current = true
      setVoiceActive(true)
      setSystemVoiceStatus("正在听用户A...")
      setMicrophoneVoiceStatus("正在听用户B...")
    } catch (error) {
      systemStream?.getTracks().forEach((track) => track.stop())
      microphoneStream?.getTracks().forEach((track) => track.stop())
      releaseVoiceCapture()
      void window.electronAPI.stopVoiceRecognition("system")
      void window.electronAPI.stopVoiceRecognition("microphone")
      showToast("语音采集不可用", error instanceof Error ? error.message : "无法访问扬声器或麦克风", "error")
    }
  }, [attachAudioStream, busy, releaseVoiceCapture, showToast])

  const stopVoiceInput = useCallback(async () => {
    releaseVoiceCapture()
    await Promise.all([
      window.electronAPI.stopVoiceRecognition("system"),
      window.electronAPI.stopVoiceRecognition("microphone")
    ])
    const conversation = await window.electronAPI.getVoiceConversation()
    setPhase("正在校正语音文本...")
    const correctedConversation = await window.electronAPI.correctVoiceConversation(conversation)
    await submitVoiceMessage({
      ...correctedConversation,
      systemTranscript: correctedConversation.systemTranscript || systemVoiceTranscriptRef.current,
      microphoneTranscript: correctedConversation.rawMicrophoneTranscript
        ? correctedConversation.microphoneTranscript
        : microphoneVoiceTranscriptRef.current
    })
  }, [releaseVoiceCapture, submitVoiceMessage])

  const toggleVoiceInput = useCallback(() => {
    if (voiceActiveRef.current) void stopVoiceInput()
    else void startVoiceInput()
  }, [startVoiceInput, stopVoiceInput])

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  const removeLastAttachment = useCallback(async () => {
    const lastAttachment = attachmentsRef.current[attachmentsRef.current.length - 1]
    if (!lastAttachment) return

    const result = await window.electronAPI.deleteScreenshot(lastAttachment.path)
    if (!result.success) {
      showToast("删除截图失败", result.error || "无法删除最后一张截图", "error")
      return
    }

    setAttachments((current) =>
      current.filter((entry) => entry.path !== lastAttachment.path)
    )
  }, [showToast])

  useEffect(() => {
    void (async () => {
      const session = await window.electronAPI.getChatSession()
      if (!session) return
      // Do not let a slow initial IPC response overwrite a session selected or
      // created by the user while the window was mounting.
      if (sessionIdRef.current && session.id !== sessionIdRef.current) return
      setSessionId(session.id)
      sessionIdRef.current = session.id
      setSessionTitle(session.title || "新对话")
      setMessages(await hydrateStoredMessages(session.messages))
    })().catch(() => {})
    void window.electronAPI.getInterviewContextStatus().then((status) => {
      setInterviewContextEnabled(status.enabled && status.available)
      setInterviewContextAvailable(status.available)
      setInterviewContextPath(status.path)
      setInterviewContextCharacters(status.characterCount)
    })
  }, [])

  const toggleInterviewContext = useCallback(async () => {
    if (interviewContextBusy || busy) return
    setInterviewContextBusy(true)
    try {
      const result = await window.electronAPI.setInterviewContextEnabled(!interviewContextEnabled)
      setInterviewContextAvailable(result.available)
      setInterviewContextPath(result.path)
      setInterviewContextCharacters(result.characterCount)
      if (!result.success) {
        showToast("无法启用面试上下文", result.error || "上下文文件不可用", "error")
        return
      }
      setInterviewContextEnabled(result.enabled)
      showToast(
        result.enabled ? "已开启面试上下文" : "已切换到拍题模式",
        result.enabled ? "回答会参考复习手册，但仍优先处理最后一个问题" : "不会向模型发送复习手册",
        "neutral"
      )
    } finally {
      setInterviewContextBusy(false)
    }
  }, [busy, interviewContextBusy, interviewContextEnabled, showToast])

  useEffect(() => {
    window.electronAPI.getScreenshots()
      .then((value) => setAttachments(normalizeScreenshots(value)))
      .catch(() => setAttachments([]))

    const onChatSessionSelected = (event: Event) => {
      if (busy) {
        showToast("当前回答尚未结束", "请等待回答完成后再切换会话", "neutral")
        return
      }
      const session = (event as CustomEvent<import("../types/chat").ChatSession>).detail
      setSessionId(session.id)
      sessionIdRef.current = session.id
      setSessionTitle(session.title || "新对话")
      setInput("")
      setAttachments([])
      setPhase("")
      activeAssistantId.current = null
      void hydrateStoredMessages(session.messages).then(setMessages).catch(() => setMessages([]))
    }
    window.addEventListener("chat-session-selected", onChatSessionSelected)
    return () => {
      window.removeEventListener("chat-session-selected", onChatSessionSelected)
    }
  }, [busy, showToast])

  useEffect(() => {
    const cleanups = [
      window.electronAPI.onScreenshotTaken((item) => {
        setAttachments((current) =>
          current.some((existing) => existing.path === item.path)
            ? current
            : [...current, item]
        )
      }),
      window.electronAPI.onFocusChatInput(() => {
        inputRef.current?.focus()
      }),
      window.electronAPI.onDeleteLastScreenshot(() => {
        void removeLastAttachment()
      }),
      window.electronAPI.onScrollChat(({ direction }) => {
        scrollRef.current?.scrollBy({
          top: direction === "up" ? -120 : 120,
          behavior: "smooth"
        })
      }),
      window.electronAPI.onToggleVoiceInput(toggleVoiceInput),
      window.electronAPI.onVoiceStatus(({ source, state, message }) => {
        if (source === "system") setSystemVoiceStatus(message)
        else setMicrophoneVoiceStatus(message)
        if (state === "error") releaseVoiceCapture()
      }),
      window.electronAPI.onVoicePartial(({ source, text }) => {
        if (source === "system") setSystemVoicePartial(text)
        else setMicrophoneVoicePartial(text)
      }),
      window.electronAPI.onVoiceFinal(({ source, fullText }) => {
        if (source === "system") {
          systemVoiceTranscriptRef.current = fullText
          setSystemVoiceTranscript(fullText)
          setSystemVoicePartial("")
        } else {
          microphoneVoiceTranscriptRef.current = fullText
          setMicrophoneVoiceTranscript(fullText)
          setMicrophoneVoicePartial("")
        }
      }),
      window.electronAPI.onVoiceContextCleared(({ source }) => {
        if (source === "system") {
          systemVoiceTranscriptRef.current = ""
          setSystemVoiceTranscript("")
          setSystemVoicePartial("")
        } else {
          microphoneVoiceTranscriptRef.current = ""
          setMicrophoneVoiceTranscript("")
          setMicrophoneVoicePartial("")
        }
      }),
      window.electronAPI.onVoiceSubmit(({ requestId, text }) => {
        activeAssistantId.current = requestId
        setBusy(true)
        setMessages((current) => [
          ...current,
          { id: createId("user"), role: "user", content: text, stage: "语音输入" },
          { id: requestId, role: "assistant", content: "", streaming: true, stage: "追问" }
        ])
      }),
      window.electronAPI.onChatStarted((data) => {
        if (sessionIdRef.current && data.sessionId !== sessionIdRef.current) return
        setSessionId(data.sessionId)
        sessionIdRef.current = data.sessionId
        activeAssistantId.current = data.requestId
        setBusy(true)
        setPhase("正在连接模型...")
        setMessages((current) => [
          ...current,
          {
            id: data.userMessage.id,
            role: "user",
            content: data.userMessage.content,
            images: data.userMessage.images?.map((image) => ({ path: image.path, preview: image.preview || "" })),
            stage: data.userMessage.images?.length ? "提交截图" : undefined,
          },
          { id: data.requestId, role: "assistant", content: "", streaming: true, stage: "对话" },
        ])
      }),
      window.electronAPI.onChatStream((data) => {
        if (data.sessionId !== sessionIdRef.current || activeAssistantId.current !== data.requestId) return
        updateAssistant(data.requestId, data.content, !data.done)
      }),
      window.electronAPI.onChatSuccess((data) => {
        if (data.sessionId !== sessionIdRef.current || activeAssistantId.current !== data.requestId) return
        updateAssistant(data.requestId, data.content, false)
        activeAssistantId.current = null
        setBusy(false)
        setPhase("")
        setSessionTitle(data.session.title || "新对话")
        setMessages(data.session.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          images: message.images?.map((image) => ({ path: image.path, preview: image.preview || "" })),
          streaming: message.status === "streaming",
        })))
      }),
      window.electronAPI.onChatContextCompressed((data) => {
        if (data.sessionId !== sessionIdRef.current) return
        setPhase("上下文已压缩，继续生成回答...")
      }),
      window.electronAPI.onChatError((data) => {
        if (data.sessionId !== sessionIdRef.current || activeAssistantId.current !== data.requestId) return
        updateAssistant(data.requestId, data.error, false)
        activeAssistantId.current = null
        setBusy(false)
        setPhase("")
      }),
      window.electronAPI.onResetView((data) => {
        releaseVoiceCapture()
        void window.electronAPI.stopVoiceRecognition("system")
        void window.electronAPI.stopVoiceRecognition("microphone")
        setMessages([])
        setAttachments([])
        if (data?.session) {
          setSessionId(data.session.id)
          sessionIdRef.current = data.session.id
          setSessionTitle(data.session.title || "新对话")
        }
        setSystemVoiceTranscript("")
        setSystemVoicePartial("")
        setMicrophoneVoiceTranscript("")
        setMicrophoneVoicePartial("")
        if (!data?.session) setSessionTitle("新建解题会话")
        setBusy(false)
        setPhase("")
        activeAssistantId.current = null
      })
    ]
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [releaseVoiceCapture, removeLastAttachment, toggleVoiceInput, updateAssistant])

  useEffect(() => () => {
    releaseVoiceCapture()
    void window.electronAPI.stopVoiceRecognition("system")
    void window.electronAPI.stopVoiceRecognition("microphone")
  }, [releaseVoiceCapture])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
  }, [messages, phase])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        inputRef.current?.focus()
      }
      if (event.key === "Escape" && busy) {
        event.preventDefault()
        void window.electronAPI.cancelChat()
      }
    }
    window.addEventListener("keydown", handleShortcut)
    return () => window.removeEventListener("keydown", handleShortcut)
  }, [busy])

  const takeScreenshot = async () => {
    const result = await window.electronAPI.triggerScreenshot()
    if (!result.success) showToast("截图失败", result.error || "无法获取截图", "error")
  }

  const removeAttachment = async (item: ScreenshotAttachment) => {
    const result = await window.electronAPI.deleteScreenshot(item.path)
    if (result.success) {
      setAttachments((current) => current.filter((entry) => entry.path !== item.path))
    }
  }

  const send = async () => {
    const text = input.trim()
    if (busy || (!text && attachments.length === 0)) return

    const requestAttachments = [...attachments]
    const assistantId = createId("assistant")
    activeAssistantId.current = assistantId

    setInput("")
    if (requestAttachments.length > 0) setAttachments([])
    setBusy(true)

    setPhase("正在发送消息...")
    try {
      const result = await window.electronAPI.sendChatMessage({
        requestId: assistantId,
        sessionId: sessionIdRef.current || sessionId,
        text,
        images: requestAttachments
      })
      if (!result.success) {
        showLocalSendError(assistantId, text, requestAttachments, result.error || "消息发送失败")
      }
    } catch (error) {
      showLocalSendError(assistantId, text, requestAttachments, error instanceof Error ? error.message : "消息发送失败")
    } finally {
      setBusy(false)
      setPhase("")
    }
  }

  const newSession = useCallback(async () => {
    if (busy) {
      showToast("当前回答尚未结束", "请等待回答完成后再新建会话", "neutral")
      return
    }
    try {
      const session = await window.electronAPI.newChatSession()
      setSessionId(session?.id || "")
      sessionIdRef.current = session?.id || ""
      setMessages([])
      setInput("")
      setAttachments([])
      setSessionTitle(session?.title || "新对话")
      setPhase("")
      activeAssistantId.current = null
    } catch (error) {
      showToast("新建会话失败", error instanceof Error ? error.message : "无法创建新的聊天会话", "error")
    }
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [busy, showToast])
  useEffect(() => {
    return window.electronAPI.onNewChatSession(() => {
      void newSession()
    })
  }, [newSession])

  return (
    <main className="pandora-chat-shell">
      <header className={`pandora-chat-header ${isWindows ? "windows-draggable" : ""}`}>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-medium text-black/80">
            <Code2 size={15} className="text-black/[0.55]" />
            <span className="truncate">{sessionTitle}</span>
          </div>
          <div className="mt-0.5 text-[10px] text-black/[0.35]">快捷键优先 · {COMMAND_KEY} + H 截图 · {COMMAND_KEY} + Enter 按内置规则执行</div>
        </div>
        <div className="flex items-center gap-1">
          <span className="chat-auto-language" title="编程语言会根据截图自动识别">
            自动识别语言
          </span>
          <button className="chat-icon-button" title="历史会话" onClick={() => window.dispatchEvent(new Event("open-chat-sessions"))}>
            <History size={15} />
          </button>
          <button
            className={`chat-icon-button ${voiceActive ? "voice-active" : ""}`}
            title={`开始/停止扬声器与麦克风双声道识别（${COMMAND_KEY} + Shift + M）`}
            onClick={toggleVoiceInput}
          >
            {voiceActive ? <MicOff size={15} /> : <Mic size={15} />}
          </button>
          <button className="chat-icon-button" title="设置" onClick={() => window.electronAPI.openSettingsPortal()}>
            <Settings size={15} />
          </button>
          <button className="chat-icon-button" title="新建会话" onClick={newSession} disabled={busy}>
            <MessageSquarePlus size={15} />
          </button>
          {isWindows && (
            <div className="chat-window-controls" aria-label="窗口控制">
              <button
                className="chat-window-button"
                type="button"
                title="最小化"
                onClick={() => void window.electronAPI.minimizeMainWindow()}
              >
                <Minus size={14} />
              </button>
              <button
                className="chat-window-button close"
                type="button"
                title="关闭"
                onClick={() => void window.electronAPI.closeMainWindow()}
              >
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      </header>

      <section ref={scrollRef} className="pandora-message-list">
        {messages.length === 0 && !busy ? (
          <div className="chat-empty-state">
            <div className="chat-empty-icon"><Code2 size={25} /></div>
            <h1>从截图开始，或者直接输入问题</h1>
            <p>截图会直接发送给视觉模型，由模型判断题型和语言并完成解题。</p>
            <div className="chat-empty-shortcuts">
              <span><kbd>{COMMAND_KEY} H</kbd> 截图</span>
              <span><kbd>{COMMAND_KEY} Enter</kbd> 执行当前阶段</span>
              <span><kbd>{COMMAND_KEY} R</kbd> 重置</span>
              <span><kbd>{COMMAND_KEY} B</kbd> 或快速晃动鼠标 4 次</span>
              <span><kbd>{COMMAND_KEY} N</kbd> 新建会话</span>
              <span><kbd>{COMMAND_KEY} L</kbd> 删除末张截图</span>
            </div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[760px] px-5 py-6">
            {messages.map((message) => (
              <article key={message.id} className={`chat-message chat-message-${message.role}`}>
                <div className="chat-message-label">
                  {message.speaker || (message.role === "user" ? "你" : message.role === "assistant" ? "AI" : "错误")}
                  {message.stage ? ` · ${message.stage}` : ""}
                </div>
                {message.images?.length ? (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {message.images.map((item) => <img key={item.path} src={item.preview} className="h-20 w-28 rounded-md border border-black/10 object-cover" />)}
                  </div>
                ) : null}
                {message.content ? <MessageContent content={message.content} currentLanguage={currentLanguage} /> : null}
                {message.streaming && !message.content ? (
                  <div className="flex items-center gap-2 text-xs text-black/[0.45]"><LoaderCircle size={13} className="animate-spin" />等待首个正文...</div>
                ) : null}
              </article>
            ))}
            {busy && phase ? (
              <div className="chat-process-row">
                <LoaderCircle size={13} className="animate-spin" />
                <span>{phase}</span>
              </div>
            ) : null}
            {(voiceActive || systemVoiceTranscript || systemVoicePartial) ? (
              <article className="chat-message chat-message-user">
                <div className="chat-message-label">
                  用户A · 扬声器{systemVoiceStatus ? ` · ${systemVoiceStatus}` : ""}
                </div>
                <MessageContent
                  content={[systemVoiceTranscript, systemVoicePartial].filter(Boolean).join(" ") || "等待扬声器声音..."}
                  currentLanguage={currentLanguage}
                />
              </article>
            ) : null}
            {(voiceActive || microphoneVoiceTranscript || microphoneVoicePartial) ? (
              <article className="chat-message chat-message-user">
                <div className="chat-message-label">
                  用户B · 麦克风{microphoneVoiceStatus ? ` · ${microphoneVoiceStatus}` : ""}
                </div>
                <MessageContent
                  content={[microphoneVoiceTranscript, microphoneVoicePartial].filter(Boolean).join(" ") || "等待麦克风声音..."}
                  currentLanguage={currentLanguage}
                />
              </article>
            ) : null}
          </div>
        )}
      </section>

      <footer className="pandora-composer-wrap">
        <div className="pandora-composer">
          {attachments.length > 0 && (
            <div className="chat-attachment-strip">
              {attachments.map((item) => (
                <div key={item.path} className="chat-attachment">
                  <img src={item.preview} />
                  <button onClick={() => removeAttachment(item)}><X size={11} /></button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={input}
            disabled={busy}
            placeholder={attachments.length ? "可选：补充希望 AI 关注的内容…" : `可选输入；主流程请使用 ${COMMAND_KEY}+H、${COMMAND_KEY}+Enter…`}
            rows={2}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                // 保留原有全局快捷键语义，由主进程根据当前状态执行
                // 题目提取、生成解答或补充截图调试。
                event.preventDefault()
                return
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <div className="chat-composer-toolbar">
            <div className="flex items-center gap-1">
              <button className="chat-tool-button" onClick={takeScreenshot} disabled={busy} title={`截图（${COMMAND_KEY} + H）`}>
                <Camera size={15} /><span>截图</span>
              </button>
              <button className={`chat-tool-button ${voiceActive ? "voice-active" : ""}`} onClick={toggleVoiceInput} title={`${voiceActive ? "停止" : "开始"}扬声器与麦克风双声道识别（${COMMAND_KEY} + Shift + M）`}>
                {voiceActive ? <MicOff size={15} /> : <Mic size={15} />}<span>{voiceActive ? "停止" : "扬声器+麦克风"}</span>
              </button>
              <button
                className={`interview-context-toggle ${interviewContextEnabled ? "enabled" : ""}`}
                type="button"
                role="switch"
                aria-checked={interviewContextEnabled}
                disabled={busy || interviewContextBusy}
                onClick={() => void toggleInterviewContext()}
                title={interviewContextAvailable
                  ? `${interviewContextEnabled ? "已注入" : "未注入"}面试上下文 · ${interviewContextCharacters.toLocaleString()} 字符 · ${interviewContextPath}`
                  : `面试上下文文件不可用 · ${interviewContextPath}`}
              >
                <span className="interview-context-track" aria-hidden="true">
                  <span className="interview-context-thumb" />
                </span>
                <span>{interviewContextEnabled ? "面试上下文" : "无上下文"}</span>
              </button>
              {messages.length > 0 && <span className="ml-1 text-[10px] text-black/25">Shift + Enter 换行</span>}
            </div>
            {busy ? (
              <button className="chat-send-button stop" onClick={() => window.electronAPI.cancelChat()} title="停止">
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button className="chat-send-button" onClick={send} disabled={!input.trim() && attachments.length === 0} title="发送">
                <Send size={14} />
              </button>
            )}
          </div>
        </div>
      </footer>
    </main>
  )
}

export default Chat
