import {
  Camera,
  Check,
  ChevronDown,
  Code2,
  Copy,
  History,
  LoaderCircle,
  MessageSquarePlus,
  Mic,
  MicOff,
  Send,
  Settings,
  Square,
  X
} from "lucide-react"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter"
import { dracula } from "react-syntax-highlighter/dist/esm/styles/prism"
import python from "react-syntax-highlighter/dist/esm/languages/prism/python"
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript"
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript"
import java from "react-syntax-highlighter/dist/esm/languages/prism/java"
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp"
import csharp from "react-syntax-highlighter/dist/esm/languages/prism/csharp"
import go from "react-syntax-highlighter/dist/esm/languages/prism/go"
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust"
import type { HistoryRecord, SavedSolutionData } from "../types/history"
import type { ProblemStatementData } from "../types/solutions"
import { useToast } from "../contexts/toast"

interface ChatProps {
  credits: number
  currentLanguage: string
  setLanguage: (language: string) => void
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
  stage?: "提交截图" | "题目提取" | "IQ 视觉解题" | "解答" | "调试" | "追问" | "语音输入"
}

interface AudioCaptureChain {
  stream: MediaStream | null
  context: AudioContext | null
  sourceNode: MediaStreamAudioSourceNode | null
  processor: ScriptProcessorNode | null
}

type VoiceSource = "microphone" | "system"
type QuestionMode = "coding" | "iq"

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

const LANGUAGES = [
  ["python", "Python"],
  ["javascript", "JavaScript"],
  ["typescript", "TypeScript"],
  ["java", "Java"],
  ["cpp", "C++"],
  ["csharp", "C#"],
  ["golang", "Go"],
  ["rust", "Rust"]
]

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

const formatSolution = (solution: SavedSolutionData) => {
  if (solution.display_text) return solution.display_text
  const thoughts = solution.thoughts?.map((item) => `- ${item}`).join("\n") || ""
  return `### 解题思路
${thoughts}

${solution.basic_code ? `### 基础解法\n\n\`\`\`\n${solution.basic_code}\n\`\`\`\n\n` : ""}### 优化解法

\`\`\`
${solution.code || ""}
\`\`\`

### 时间复杂度
${solution.time_complexity || "未提供"}

### 空间复杂度
${solution.space_complexity || "未提供"}`
}

const formatProblem = (problem: ProblemStatementData) => `### 题目提取结果

${problem.problem_statement || "未识别到题目描述"}

${problem.constraints ? `### 约束条件\n${problem.constraints}\n\n` : ""}${problem.example_input ? `### 示例输入\n${problem.example_input}\n\n` : ""}${problem.example_output ? `### 示例输出\n${problem.example_output}\n\n` : ""}${problem.starter_code ? `### 识别到的代码模板\n\n\`\`\`\n${problem.starter_code}\n\`\`\`\n\n` : ""}${problem.required_signature ? `### 固定函数签名\n${problem.required_signature}` : ""}`.trim()

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
            style={dracula}
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

const Chat: React.FC<ChatProps> = ({ currentLanguage, setLanguage }) => {
  const { showToast } = useToast()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [attachments, setAttachments] = useState<ScreenshotAttachment[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState("")
  const [progress, setProgress] = useState(0)
  const [sessionTitle, setSessionTitle] = useState("新建解题会话")
  const [languageOpen, setLanguageOpen] = useState(false)
  const [voiceActive, setVoiceActive] = useState(false)
  const [systemVoiceStatus, setSystemVoiceStatus] = useState("")
  const [systemVoicePartial, setSystemVoicePartial] = useState("")
  const [systemVoiceTranscript, setSystemVoiceTranscript] = useState("")
  const [microphoneVoiceStatus, setMicrophoneVoiceStatus] = useState("")
  const [microphoneVoicePartial, setMicrophoneVoicePartial] = useState("")
  const [microphoneVoiceTranscript, setMicrophoneVoiceTranscript] = useState("")
  const [questionMode, setQuestionMode] = useState<QuestionMode>("coding")
  const [questionModeBusy, setQuestionModeBusy] = useState(false)
  const [interviewContextEnabled, setInterviewContextEnabled] = useState(false)
  const [interviewContextAvailable, setInterviewContextAvailable] = useState(false)
  const [interviewContextPath, setInterviewContextPath] = useState("")
  const [interviewContextCharacters, setInterviewContextCharacters] = useState(0)
  const [interviewContextBusy, setInterviewContextBusy] = useState(false)
  const activeAssistantId = useRef<string | null>(null)
  const extractionAssistantId = useRef<string | null>(null)
  const pendingUserMessage = useRef(false)
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
    pendingUserMessage.current = true
    setMessages((current) => [
      ...current,
      {
        id: createId("user"),
        role: "user" as const,
        content: [
          systemText ? `用户A：${systemText}` : "",
          microphoneText ? `用户B：${microphoneText}` : ""
        ].filter(Boolean).join("\n\n"),
        images: requestAttachments.length ? requestAttachments : undefined,
        stage: "语音输入" as const
      },
      {
        id: assistantId,
        role: "assistant",
        content: "",
        streaming: true,
        stage: requestAttachments.length ? undefined : "追问"
      }
    ])
    setSystemVoiceTranscript("")
    setSystemVoicePartial("")
    systemVoiceTranscriptRef.current = ""
    setMicrophoneVoiceTranscript("")
    setMicrophoneVoicePartial("")
    microphoneVoiceTranscriptRef.current = ""
    setBusy(true)
    void window.electronAPI.clearVoiceContext()

    if (requestAttachments.length) {
      const result = await window.electronAPI.triggerProcessScreenshots(requestText)
      if (!result.success) {
        updateAssistant(assistantId, result.error || "截图处理失败", false)
        setBusy(false)
      }
      return
    }

    setPhase("正在发送语音问题...")
    const result = await window.electronAPI.sendChatMessage({
      requestId: assistantId,
      message: requestText
    })
    if (!result.success) {
      updateAssistant(assistantId, result.error || "语音消息发送失败", false)
      setBusy(false)
      setPhase("")
    }
  }, [busy, showToast, updateAssistant])

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

  useEffect(() => {
    void window.electronAPI.getConfig().then((config) => {
      setQuestionMode(config.questionMode || "coding")
      setSessionTitle(config.questionMode === "iq" ? "新建 IQ 解题会话" : "新建解题会话")
    })
    void window.electronAPI.getInterviewContextStatus().then((status) => {
      setInterviewContextEnabled(status.enabled && status.available)
      setInterviewContextAvailable(status.available)
      setInterviewContextPath(status.path)
      setInterviewContextCharacters(status.characterCount)
    })
  }, [])

  const selectQuestionMode = useCallback(async (mode: QuestionMode) => {
    if (busy || questionModeBusy || mode === questionMode) return
    setQuestionModeBusy(true)
    try {
      const result = await window.electronAPI.updateConfig({ questionMode: mode })
      if (!result) throw new Error("配置保存失败")
      setQuestionMode(mode)
      setSessionTitle(mode === "iq" ? "新建 IQ 解题会话" : "新建解题会话")
      showToast(
        mode === "iq" ? "已切换到 IQ 测评" : "已切换到编程题",
        mode === "iq"
          ? "提交截图时将直接调用视觉模型解题"
          : "提交截图时将执行编程题识别与代码生成流程",
        "neutral"
      )
    } catch (error) {
      console.error("Failed to update question mode:", error)
      showToast("切换失败", "无法保存题目模式", "error")
    } finally {
      setQuestionModeBusy(false)
    }
  }, [busy, questionMode, questionModeBusy, showToast])

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

  const addRestoredRecord = useCallback((record: HistoryRecord) => {
    setSessionTitle(record.title)
    setMessages([
      {
        id: `history-user-${record.id}`,
        role: "user",
        content: `已提交题目截图（${record.screenshotPaths?.length || 1} 张）`,
        stage: "提交截图"
      },
      {
        id: `history-extraction-${record.id}`,
        role: "assistant",
        content: formatProblem(record.problem),
        stage: "题目提取"
      },
      {
        id: `history-assistant-${record.id}`,
        role: "assistant",
        content: formatSolution(record.solution),
        stage: "解答"
      }
    ])
    setLanguage(record.language)
  }, [setLanguage])

  useEffect(() => {
    window.electronAPI.getScreenshots()
      .then((value) => setAttachments(normalizeScreenshots(value)))
      .catch(() => setAttachments([]))

    const restoreLatest = async () => {
      const records = await window.electronAPI.getHistory()
      if (!records.length) return
      const result = await window.electronAPI.restoreHistory(records[0].id)
      if (result.success && result.record) addRestoredRecord(result.record)
    }
    restoreLatest().catch((error) => console.error("Failed to restore chat:", error))

    const onHistorySelected = (event: Event) => {
      addRestoredRecord((event as CustomEvent<HistoryRecord>).detail)
    }
    window.addEventListener("history-record-selected", onHistorySelected)
    return () => window.removeEventListener("history-record-selected", onHistorySelected)
  }, [addRestoredRecord])

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
      window.electronAPI.onSolutionStart((data?: { questionMode?: "coding" | "iq" }) => {
        const isIqMode = data?.questionMode === "iq"
        setQuestionMode(isIqMode ? "iq" : "coding")
        setBusy(true)
        setPhase(isIqMode ? "正在使用视觉模型解答 IQ 题目..." : "正在识别截图中的题目...")
        setProgress(15)
        if (!pendingUserMessage.current) {
          setMessages((current) => [
            ...current,
            {
              id: createId("user"),
              role: "user",
              content: `已提交题目截图（${attachmentsRef.current.length} 张）${systemVoiceTranscriptRef.current ? `\n\n用户A语音：${systemVoiceTranscriptRef.current}` : ""}`,
              images: attachmentsRef.current,
              stage: "提交截图"
            }
          ])
        }
        pendingUserMessage.current = false
        const hasExistingAssistant = Boolean(activeAssistantId.current)
        const id = activeAssistantId.current || createId("assistant")
        extractionAssistantId.current = id
        activeAssistantId.current = id
        if (!hasExistingAssistant) {
          setMessages((current) => [
            ...current,
            { id, role: "assistant", content: "", streaming: true, stage: isIqMode ? "IQ 视觉解题" : "题目提取" }
          ])
        } else {
          setMessages((current) => current.map((message) =>
            message.id === id ? { ...message, stage: isIqMode ? "IQ 视觉解题" : "题目提取" } : message
          ))
        }
      }),
      window.electronAPI.onProblemExtracted((problem) => {
        setSessionTitle(problem?.problem_statement?.split("\n")[0]?.slice(0, 48) || "编程题解答")
        setPhase("题目识别完成，正在连接解答模型...")
        setProgress(45)
        const extractionId = extractionAssistantId.current || activeAssistantId.current
        if (extractionId) updateAssistant(extractionId, formatProblem(problem), false)
        extractionAssistantId.current = null

        const solutionId = createId("assistant")
        activeAssistantId.current = solutionId
        setMessages((current) => [
          ...current,
          { id: solutionId, role: "assistant", content: "", streaming: true, stage: "解答" }
        ])
      }),
      window.electronAPI.onProcessingStatus((status) => {
        setPhase(status.message)
        setProgress(status.progress)
      }),
      window.electronAPI.onSolutionStream((data) => {
        const id = activeAssistantId.current
        if (id) updateAssistant(id, data.content, !data.done)
      }),
      window.electronAPI.onSolutionSuccess((solution: SavedSolutionData) => {
        const id = activeAssistantId.current
        if (!id) return
        setMessages((current) =>
          current.map((item) =>
            item.id === id
              ? {
                  ...item,
                  content: item.content.trim() ? item.content : formatSolution(solution),
                  streaming: false
                }
              : item
          )
        )
        activeAssistantId.current = null
        extractionAssistantId.current = null
        setBusy(false)
        setPhase("")
        setProgress(0)
        setAttachments([])
      }),
      window.electronAPI.onSolutionError((error) => {
        const id = activeAssistantId.current
        if (id) updateAssistant(id, error, false)
        activeAssistantId.current = null
        extractionAssistantId.current = null
        setBusy(false)
        setPhase("")
      }),
      window.electronAPI.onDebugStart(() => {
        setBusy(true)
        setPhase("正在分析补充截图...")
        const id = activeAssistantId.current
        if (id) {
          setMessages((current) => current.map((message) =>
            message.id === id ? { ...message, stage: "调试" } : message
          ))
        }
      }),
      window.electronAPI.onDebugSuccess((data) => {
        const id = activeAssistantId.current
        if (id) updateAssistant(id, data.debug_analysis || data.code || "调试完成", false)
        activeAssistantId.current = null
        extractionAssistantId.current = null
        setBusy(false)
        setPhase("")
        setAttachments([])
      }),
      window.electronAPI.onDebugError((error) => {
        const id = activeAssistantId.current
        if (id) updateAssistant(id, error, false)
        activeAssistantId.current = null
        extractionAssistantId.current = null
        setBusy(false)
        setPhase("")
      }),
      window.electronAPI.onChatStream((data) => {
        updateAssistant(data.requestId, data.content, !data.done)
      }),
      window.electronAPI.onChatSuccess((data) => {
        updateAssistant(data.requestId, data.content, false)
        if (activeAssistantId.current === data.requestId) activeAssistantId.current = null
        setBusy(false)
        setPhase("")
      }),
      window.electronAPI.onChatError((data) => {
        updateAssistant(data.requestId, data.error, false)
        if (activeAssistantId.current === data.requestId) activeAssistantId.current = null
        setBusy(false)
        setPhase("")
      }),
      window.electronAPI.onResetView(() => {
        releaseVoiceCapture()
        void window.electronAPI.stopVoiceRecognition("system")
        void window.electronAPI.stopVoiceRecognition("microphone")
        setMessages([])
        setAttachments([])
        setSystemVoiceTranscript("")
        setSystemVoicePartial("")
        setMicrophoneVoiceTranscript("")
        setMicrophoneVoicePartial("")
        setSessionTitle(questionMode === "iq" ? "新建 IQ 解题会话" : "新建解题会话")
        setBusy(false)
        setPhase("")
        activeAssistantId.current = null
        extractionAssistantId.current = null
      })
    ]
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [questionMode, releaseVoiceCapture, toggleVoiceInput, updateAssistant])

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

    const visibleText = text || "请分析这些截图并给出解答。"
    const assistantId = createId("assistant")
    activeAssistantId.current = assistantId
    pendingUserMessage.current = true
    setMessages((current) => [
      ...current,
      {
        id: createId("user"),
        role: "user",
        content: visibleText,
        images: attachments.length ? [...attachments] : undefined,
        stage: attachments.length ? "提交截图" : undefined
      },
      { id: assistantId, role: "assistant", content: "", streaming: true, stage: attachments.length ? undefined : "追问" }
    ])
    setInput("")
    setBusy(true)

    if (attachments.length > 0) {
      const result = await window.electronAPI.triggerProcessScreenshots(text)
      if (!result.success) {
        updateAssistant(assistantId, result.error || "截图处理失败", false)
        setBusy(false)
      }
      return
    }

    setPhase("正在发送消息...")
    const result = await window.electronAPI.sendChatMessage({
      requestId: assistantId,
      message: text
    })
    if (!result.success) {
      updateAssistant(assistantId, result.error || "消息发送失败", false)
      setBusy(false)
      setPhase("")
    }
  }

  const newSession = async () => {
    await window.electronAPI.triggerReset()
    setMessages([])
    setInput("")
    setAttachments([])
    setSessionTitle(questionMode === "iq" ? "新建 IQ 解题会话" : "新建解题会话")
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  return (
    <main className="pandora-chat-shell">
      <header className="pandora-chat-header">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-medium text-white/90">
            <Code2 size={15} className="text-white/55" />
            <span className="truncate">{sessionTitle}</span>
          </div>
          <div className="mt-0.5 text-[10px] text-white/35">快捷键优先 · Ctrl/Cmd + H 截图 · Ctrl/Cmd + Enter 按内置规则执行</div>
        </div>
        <div className="flex items-center gap-1">
          <div className="relative">
            <button className="chat-icon-button gap-1 px-2" onClick={() => setLanguageOpen((value) => !value)}>
              <span className="text-[11px]">{LANGUAGES.find(([value]) => value === currentLanguage)?.[1] || currentLanguage}</span>
              <ChevronDown size={12} />
            </button>
            {languageOpen && (
              <div className="chat-language-menu">
                {LANGUAGES.map(([value, label]) => (
                  <button
                    key={value}
                    className={currentLanguage === value ? "selected" : ""}
                    onClick={async () => {
                      await window.electronAPI.updateConfig({ language: value })
                      window.__LANGUAGE__ = value
                      setLanguage(value)
                      setLanguageOpen(false)
                    }}
                  >
                    {label}
                    {currentLanguage === value && <Check size={12} />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="chat-icon-button" title="历史会话" onClick={() => window.dispatchEvent(new Event("open-history"))}>
            <History size={15} />
          </button>
          <button
            className={`chat-icon-button ${voiceActive ? "voice-active" : ""}`}
            title="开始/停止扬声器与麦克风双声道识别（Ctrl/Cmd + Shift + M）"
            onClick={toggleVoiceInput}
          >
            {voiceActive ? <MicOff size={15} /> : <Mic size={15} />}
          </button>
          <button className="chat-icon-button" title="设置" onClick={() => window.electronAPI.openSettingsPortal()}>
            <Settings size={15} />
          </button>
          <button className="chat-icon-button" title="新建会话" onClick={newSession}>
            <MessageSquarePlus size={15} />
          </button>
        </div>
      </header>

      <section ref={scrollRef} className="pandora-message-list">
        {messages.length === 0 && !busy ? (
          <div className="chat-empty-state">
            <div className="chat-empty-icon"><Code2 size={25} /></div>
            <h1>{questionMode === "iq" ? "截取完整 IQ 题干和选项" : "从截图开始，或者直接输入问题"}</h1>
            <p>{questionMode === "iq"
              ? "当前为 IQ 测评模式：截图会直接发送给视觉模型，不会进入代码生成流程。"
              : "当前为编程题模式：截图将经过题目识别、代码生成与复杂度分析。"}</p>
            <div className="chat-empty-shortcuts">
              <span><kbd>Ctrl H</kbd> 截图</span>
              <span><kbd>Ctrl Enter</kbd> 执行当前阶段</span>
              <span><kbd>Ctrl R</kbd> 重置</span>
              <span><kbd>Ctrl B</kbd> 显示/隐藏</span>
              <span><kbd>Ctrl L</kbd> 删除末张截图</span>
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
                    {message.images.map((item) => <img key={item.path} src={item.preview} className="h-20 w-28 rounded-md border border-white/10 object-cover" />)}
                  </div>
                ) : null}
                {message.content ? <MessageContent content={message.content} currentLanguage={currentLanguage} /> : null}
                {message.streaming && !message.content ? (
                  <div className="flex items-center gap-2 text-xs text-white/45"><LoaderCircle size={13} className="animate-spin" />等待首个正文...</div>
                ) : null}
              </article>
            ))}
            {busy && phase ? (
              <div className="chat-process-row">
                <LoaderCircle size={13} className="animate-spin" />
                <span>{phase}</span>
                {progress > 0 ? <span className="ml-auto tabular-nums">{progress}%</span> : null}
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
            placeholder={attachments.length ? "可选：补充希望 AI 关注的内容…" : "可选输入；主流程请使用 Ctrl+H、Ctrl+Enter…"}
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
              <button className="chat-tool-button" onClick={takeScreenshot} disabled={busy} title="截图（Ctrl/Cmd + H）">
                <Camera size={15} /><span>截图</span>
              </button>
              <button className={`chat-tool-button ${voiceActive ? "voice-active" : ""}`} onClick={toggleVoiceInput} title={`${voiceActive ? "停止" : "开始"}扬声器与麦克风双声道识别（Ctrl/Cmd + Shift + M）`}>
                {voiceActive ? <MicOff size={15} /> : <Mic size={15} />}<span>{voiceActive ? "停止" : "扬声器+麦克风"}</span>
              </button>
              <div className="question-mode-switch" role="group" aria-label="题目模式">
                <button
                  type="button"
                  className={questionMode === "coding" ? "active" : ""}
                  disabled={busy || questionModeBusy}
                  onClick={() => void selectQuestionMode("coding")}
                  title="截图后识别编程题并生成代码"
                >
                  编程题
                </button>
                <button
                  type="button"
                  className={questionMode === "iq" ? "active" : ""}
                  disabled={busy || questionModeBusy}
                  onClick={() => void selectQuestionMode("iq")}
                  title="截图后直接使用视觉模型解答 IQ 题"
                >
                  IQ 测评
                </button>
              </div>
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
              {messages.length > 0 && <span className="ml-1 text-[10px] text-white/25">Shift + Enter 换行</span>}
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
