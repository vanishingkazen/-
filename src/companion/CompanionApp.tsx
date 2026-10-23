import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Camera,
  Check,
  ChevronDown,
  Clock3,
  LoaderCircle,
  MessageSquareText,
  Mic,
  MicOff,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Wifi,
  WifiOff,
  X
} from "lucide-react"
import type { CompanionImage, CompanionSnapshot } from "../../electron/CompanionTypes"

type ApiResult<T = unknown> = { success: boolean; error?: string; token?: string; state?: T }
type StreamMessage = {
  type: string
  state?: CompanionSnapshot
  channel?: string
  data?: Record<string, unknown>
}

const SESSION_TOKEN_KEY = "steamgamecode-companion-token"

async function parseResponse<T>(response: Response): Promise<ApiResult<T>> {
  const data = await response.json().catch(() => ({})) as ApiResult<T>
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `请求失败 (${response.status})`)
  }
  return data
}

function imageEntries(snapshot: CompanionSnapshot): CompanionImage[] {
  return [
    ...snapshot.pendingScreenshots,
    ...snapshot.session.messages.flatMap((message) => message.images)
  ]
}

export default function CompanionApp() {
  const [token, setToken] = useState("")
  const [snapshot, setSnapshot] = useState<CompanionSnapshot | null>(null)
  const [draft, setDraft] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [expandedImage, setExpandedImage] = useState<string | null>(null)
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({})
  const [streaming, setStreaming] = useState<{ sessionId: string; requestId: string; content: string } | null>(null)
  const tokenRef = useRef("")
  const socketRef = useRef<WebSocket | null>(null)
  const imageCacheRef = useRef(new Map<string, string>())
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestContentRef = useRef<HTMLDivElement>(null)
  const requestRef = useRef<(path: string, body?: unknown) => Promise<ApiResult<CompanionSnapshot>>>(async () => ({ success: false }))

  const setSessionToken = useCallback((value: string) => {
    tokenRef.current = value
    setToken(value)
    if (value) sessionStorage.setItem(SESSION_TOKEN_KEY, value)
    else sessionStorage.removeItem(SESSION_TOKEN_KEY)
  }, [])

  const refreshState = useCallback(async () => {
    if (!tokenRef.current) return
    try {
      const response = await fetch("/api/state", {
        headers: { Authorization: `Bearer ${tokenRef.current}` },
        cache: "no-store"
      })
      if (response.status === 401) {
        setSessionToken("")
        setError("手机授权已撤销，请重新扫描笔记本上的配对二维码。")
        return
      }
      const result = await parseResponse<CompanionSnapshot>(response)
      if (result.state) setSnapshot(result.state)
      setError("")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法连接笔记本")
    }
  }, [setSessionToken])

  const request = useCallback(async (path: string, body?: unknown) => {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenRef.current}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body || {}),
      cache: "no-store"
    })
    if (response.status === 401) {
      setSessionToken("")
      throw new Error("手机授权已撤销，请重新扫描笔记本上的配对二维码。")
    }
    const result = await parseResponse<CompanionSnapshot>(response)
    if (result.state) setSnapshot(result.state)
    setError("")
    return result
  }, [setSessionToken])

  requestRef.current = request

  useEffect(() => {
    let cancelled = false
    const pairFromLink = async () => {
      const fragment = window.location.hash.slice(1)
      const existingToken = sessionStorage.getItem(SESSION_TOKEN_KEY) || ""
      if (fragment) {
        history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
        try {
          const response = await fetch("/api/pair", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: fragment }),
            cache: "no-store"
          })
          const result = await parseResponse(response)
          if (cancelled) return
          if (!result.token) throw new Error("配对服务没有返回授权令牌")
          setSessionToken(result.token)
          setNotice("手机已配对到本机伴随服务")
          return
        } catch (reason) {
          if (!cancelled) setError(reason instanceof Error ? reason.message : "配对失败")
          return
        }
      }
      if (existingToken) setSessionToken(existingToken)
      else setError("请先在笔记本端开启手机伴随功能，再用手机扫描配对二维码。")
    }
    void pairFromLink()
    return () => { cancelled = true }
  }, [setSessionToken])

  useEffect(() => {
    if (!token) return
    void refreshState()
    let reconnectDelay = 1000
    let cancelled = false

    const connect = () => {
      if (cancelled) return
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
      const socket = new WebSocket(`${protocol}//${window.location.host}/api/events`)
      socketRef.current = socket
      socket.onopen = () => {
        reconnectDelay = 1000
        socket.send(JSON.stringify({ type: "auth", token: tokenRef.current }))
      }
      socket.onmessage = (event) => {
        let message: StreamMessage
        try { message = JSON.parse(String(event.data)) as StreamMessage } catch { return }
        if (message.type === "snapshot" && message.state) {
          setSnapshot(message.state)
          setConnected(true)
          setError("")
        } else if (message.type === "refresh") {
          void refreshState()
        } else if (message.type === "chat-stream" && message.data) {
          const sessionId = String(message.data.sessionId || "")
          if (snapshot?.currentSessionId && sessionId !== snapshot.currentSessionId) return
          const requestId = String(message.data.requestId || "")
          if (message.data.done) {
            setStreaming(null)
            void refreshState()
          } else {
            setStreaming({ sessionId, requestId, content: String(message.data.content || "") })
          }
        } else if (message.type === "voice-event") {
          setSnapshot((current) => {
            if (!current || !message.data) return current
            const source = message.data.source === "system" ? "system" : "microphone"
            const voice = { ...current.voice, [source]: { ...current.voice[source] } }
            if (message.channel === "voice-status") {
              voice[source].state = String(message.data.state || "idle")
              voice[source].message = String(message.data.message || "")
            } else if (message.channel === "voice-transcript-partial") {
              voice[source].partialTranscript = String(message.data.text || "")
            } else if (message.channel === "voice-transcript-final") {
              voice[source].transcript = String(message.data.fullText || voice[source].transcript)
              voice[source].partialTranscript = ""
            } else if (message.channel === "voice-context-cleared") {
              voice[source].transcript = ""
              voice[source].partialTranscript = ""
            }
            return { ...current, voice }
          })
        }
      }
      socket.onclose = (event) => {
        if (socketRef.current === socket) socketRef.current = null
        setConnected(false)
        if (event.code === 4003) {
          setSessionToken("")
          setError("手机授权已撤销，请重新扫描笔记本上的配对二维码。")
          return
        }
        if (!cancelled) {
          reconnectTimerRef.current = setTimeout(connect, reconnectDelay)
          reconnectDelay = Math.min(8000, reconnectDelay * 1.8)
        }
      }
      socket.onerror = () => socket.close()
    }
    connect()
    return () => {
      cancelled = true
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [token, refreshState, setSessionToken])

  useEffect(() => {
    if (!token) return
    const poll = window.setInterval(() => void refreshState(), 12_000)
    return () => window.clearInterval(poll)
  }, [token, refreshState])

  useEffect(() => {
    if (!snapshot || !token) return
    let cancelled = false
    const images = imageEntries(snapshot)
    const currentKeys = new Set(images.map((image) => image.url))
    for (const [key, objectUrl] of imageCacheRef.current) {
      if (!currentKeys.has(key)) {
        URL.revokeObjectURL(objectUrl)
        imageCacheRef.current.delete(key)
      }
    }
    const loadMissing = async () => {
      const loaded: Record<string, string> = {}
      await Promise.all(images.map(async (image) => {
        const cached = imageCacheRef.current.get(image.url)
        if (cached) {
          loaded[image.id] = cached
          return
        }
        try {
          const response = await fetch(image.url, {
            headers: { Authorization: `Bearer ${token}` },
            cache: "no-store"
          })
          if (!response.ok) return
          const objectUrl = URL.createObjectURL(await response.blob())
          if (cancelled) {
            URL.revokeObjectURL(objectUrl)
            return
          }
          imageCacheRef.current.set(image.url, objectUrl)
          loaded[image.id] = objectUrl
        } catch {
          // Keep the rest of the conversation usable if one image is unavailable.
        }
      }))
      if (!cancelled) {
        const complete: Record<string, string> = {}
        for (const image of images) {
          const url = imageCacheRef.current.get(image.url)
          if (url) complete[image.id] = url
        }
        setImageUrls(complete)
      }
    }
    void loadMissing()
    return () => { cancelled = true }
  }, [snapshot, token])

  useEffect(() => () => {
    for (const url of imageCacheRef.current.values()) URL.revokeObjectURL(url)
    imageCacheRef.current.clear()
  }, [])

  const currentSession = snapshot?.session
  const requestBusy = busy || Boolean(snapshot?.busy)
  const isCurrentSessionStreaming = Boolean(streaming && streaming.sessionId === snapshot?.currentSessionId)
  const messages = useMemo(() => {
    const base = currentSession?.messages || []
    if (!streaming || streaming.sessionId !== snapshot?.currentSessionId) return base
    const existing = base.find((message) => message.id === streaming.requestId)
    if (existing) return base.map((message) => message.id === streaming.requestId ? { ...message, content: streaming.content, status: "streaming" as const } : message)
    return [...base, {
      id: streaming.requestId,
      role: "assistant" as const,
      content: streaming.content,
      createdAt: new Date().toISOString(),
      status: "streaming" as const,
      images: []
    }]
  }, [currentSession?.messages, snapshot?.currentSessionId, streaming])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      latestContentRef.current?.scrollIntoView({
        behavior: isCurrentSessionStreaming ? "auto" : "smooth",
        block: "end"
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [messages, snapshot?.currentSessionId, isCurrentSessionStreaming])

  const doAction = async (path: string, body?: unknown) => {
    setBusy(true)
    try { await request(path, body) }
    catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败") }
    finally { setBusy(false) }
  }

  const send = async () => {
    if (!snapshot || requestBusy) return
    const text = draft.trim()
    if (!text && snapshot.pendingScreenshots.length === 0) return
    setBusy(true)
    setError("")
    try {
      await request("/api/chat/send", {
        text,
        screenshotIds: snapshot.pendingScreenshots.map((image) => image.id)
      })
      setDraft("")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "发送失败")
    } finally {
      setBusy(false)
    }
  }

  const chooseSession = async (id: string) => {
    setShowHistory(false)
    if (id !== snapshot?.currentSessionId) await doAction("/api/session/select", { id })
  }

  const imageFor = (image: CompanionImage) => imageUrls[image.id]
  const connectionLabel = connected ? "笔记本已连接" : "正在连接笔记本…"

  if (!token) {
    return (
      <main className="companion-pair-screen">
        <div className="companion-pair-card">
          <div className="companion-brand-mark"><MessageSquareText size={24} /></div>
          <h1>网页显示端</h1>
          <p>{error || "正在配对本地会话…"}</p>
          {error && <div className="companion-hint">确认手机和笔记本连接在同一个可信 Wi‑Fi，再重新扫描笔记本上的二维码。</div>}
          <div className="companion-security-note">HTTP 明文传输：对话、截图和语音转写未加密；配对码仅控制访问。只在可信私人 Wi‑Fi 使用。</div>
        </div>
      </main>
    )
  }

  return (
    <main className="companion-app">
      <header className="companion-header">
        <div className="companion-heading">
          <div className="companion-brand-mark small"><MessageSquareText size={18} /></div>
          <div className="companion-title-wrap">
            <strong>网页显示端</strong>
            <span className={connected ? "connection good" : "connection"}>
              {connected ? <Wifi size={12} /> : <WifiOff size={12} />}{connectionLabel}
            </span>
          </div>
        </div>
        <div className="companion-header-actions">
          <button className="icon-button" aria-label="历史会话" title="历史会话" onClick={() => setShowHistory(true)}>
            <Clock3 size={19} />
          </button>
          <button className="icon-button" aria-label="新建会话" title="新建会话" disabled={requestBusy} onClick={() => void doAction("/api/session/new")}>
            <Plus size={20} />
          </button>
        </div>
      </header>

      {notice && <button className="companion-notice" onClick={() => setNotice("")}><Check size={14} />{notice}<X size={14} /></button>}
      {error && <div className="companion-error" role="alert">{error}<button onClick={() => void refreshState()} aria-label="重试"><RefreshCw size={15} /></button></div>}

      {snapshot && (
        <>
          <section className="companion-session-bar">
            <span>{currentSession?.title || "新对话"}</span>
            <ChevronDown size={15} />
          </section>

          <section className="companion-voice-card" aria-label="笔记本语音识别状态">
            <div className="voice-card-heading"><Mic size={15} /><strong>笔记本语音转写</strong><span className="voice-source-state">{snapshot.voice.system.state === "listening" || snapshot.voice.microphone.state === "listening" ? "采集中" : "待机"}</span></div>
            {(snapshot.voice.system.transcript || snapshot.voice.system.partialTranscript) && (
              <p><b>会议音频：</b>{snapshot.voice.system.transcript} <em>{snapshot.voice.system.partialTranscript}</em></p>
            )}
            {(snapshot.voice.microphone.transcript || snapshot.voice.microphone.partialTranscript) && (
              <p><b>笔记本麦克风：</b>{snapshot.voice.microphone.transcript} <em>{snapshot.voice.microphone.partialTranscript}</em></p>
            )}
            {!snapshot.voice.system.transcript && !snapshot.voice.system.partialTranscript && !snapshot.voice.microphone.transcript && !snapshot.voice.microphone.partialTranscript && (
              <p className="muted"><MicOff size={13} />语音采集在笔记本悬浮窗中启动</p>
            )}
          </section>

          <section className="companion-messages" aria-live="polite">
            {messages.length === 0 && <div className="companion-empty"><MessageSquareText size={30} /><strong>对话会显示在这里</strong><span>可在手机输入追问，或请求笔记本截取当前屏幕。</span></div>}
            {messages.map((message) => (
              <article key={message.id} className={`companion-message ${message.role}`}>
                <div className="message-label">{message.role === "user" ? "你" : "助手"}{message.status === "streaming" && <span className="streaming-label"><LoaderCircle size={12} />生成中</span>}</div>
                {message.content && <div className="message-content">{message.content}</div>}
                {message.images.length > 0 && <div className="message-images">{message.images.map((image) => (
                  <button key={image.id} className="message-image-button" onClick={() => imageFor(image) && setExpandedImage(imageFor(image)!)}>
                    {imageFor(image) ? <img src={imageFor(image)} alt="对话截图" /> : <span className="image-loading"><LoaderCircle size={16} /></span>}
                  </button>
                ))}</div>}
                {message.status === "error" && <span className="message-error">本次请求未成功</span>}
              </article>
            ))}
          </section>

          {snapshot.pendingScreenshots.length > 0 && (
            <section className="pending-screenshots">
              <div className="section-caption">待发送图片 · {snapshot.pendingScreenshots.length}</div>
              <div className="pending-image-list">
                {snapshot.pendingScreenshots.map((image) => (
                  <div className="pending-image" key={image.id}>
                    <button className="pending-image-preview" onClick={() => imageFor(image) && setExpandedImage(imageFor(image)!)}>
                      {imageFor(image) ? <img src={imageFor(image)} alt="待发送截图" /> : <LoaderCircle size={16} />}
                    </button>
                    <button className="remove-pending" aria-label="删除截图" onClick={() => void doAction("/api/screenshot/delete", { id: image.id })}><X size={14} /></button>
                  </div>
                ))}
              </div>
            </section>
          )}

          <footer className="companion-composer">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void send()
                }
              }}
              placeholder={snapshot.pendingScreenshots.length ? "补充问题，或直接发送图片…" : "输入会议问题或追问…"}
              rows={2}
              maxLength={20_000}
            />
            <div className="composer-actions">
              <button className="secondary-action" disabled={requestBusy} onClick={() => void doAction("/api/capture")}><Camera size={17} /><span>{snapshot?.captureSource === "phone" ? "相机拍照" : "电脑截图"}</span></button>
              <div className="composer-spacer" />
              {requestBusy ? (
                <button className="stop-action" onClick={() => void doAction("/api/chat/cancel")} title="停止回答"><X size={17} /></button>
              ) : (
                <button className="send-action" disabled={!draft.trim() && snapshot.pendingScreenshots.length === 0} onClick={() => void send()} title="发送"><Send size={17} /></button>
              )}
            </div>
            <div className="keyboard-hint">笔记本仍可使用 Cmd+Enter 提交图片问题</div>
          </footer>
        </>
      )}

      {showHistory && snapshot && (
        <div className="history-backdrop" onClick={() => setShowHistory(false)}>
          <section className="history-panel" onClick={(event) => event.stopPropagation()}>
            <header><strong>历史会话</strong><button className="icon-button" onClick={() => setShowHistory(false)} aria-label="关闭"><X size={19} /></button></header>
            <div className="history-list">
              {snapshot.sessions.map((session) => (
                <div className={`history-item ${session.id === snapshot.currentSessionId ? "selected" : ""}`} key={session.id}>
                  <button className="history-select" onClick={() => void chooseSession(session.id)}>
                    <span>{session.title || "新对话"}</span>
                    <small>{new Date(session.updatedAt).toLocaleString()}</small>
                  </button>
                  <button className="history-delete" aria-label="删除会话" disabled={busy} onClick={() => {
                    if (window.confirm(`删除“${session.title || "新对话"}”？`)) void doAction("/api/session/delete", { id: session.id })
                  }}><Trash2 size={15} /></button>
                </div>
              ))}
              {!snapshot.sessions.length && <p className="history-empty">暂无历史会话</p>}
            </div>
          </section>
        </div>
      )}

      {expandedImage && <div className="image-lightbox" onClick={() => setExpandedImage(null)}><button aria-label="关闭"><X size={22} /></button><img src={expandedImage} alt="截图放大预览" /></div>}
      <div className="companion-network-footnote"><Wifi size={11} />仅可信局域网使用 · HTTP 传输未加密</div>
      <div ref={latestContentRef} className="companion-scroll-anchor" aria-hidden="true" />
    </main>
  )
}
