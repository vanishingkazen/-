import { useState, useEffect, useRef, useId, type CSSProperties, type ReactNode } from "react"
import { Activity, ArrowRight, Check, CheckCircle2, ChevronDown, CircleHelp, FileText, HardDrive, Keyboard, Loader2, Mic, Monitor, Settings2, ShieldCheck, SlidersHorizontal, Waypoints, X, XCircle } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog"
import { Input } from "../ui/input"
import { Button } from "../ui/button"
import { useToast } from "../../contexts/toast"
import { COMMAND_KEY } from "../../utils/platform"
import { openLogDirectory } from "../../lib/logger"
import type { LLMConnectionTestRequest, LLMConnectionTestResult } from "../../../electron/LLMConnectionTest"
import { StoragePanel } from "./StoragePanel"
import "./settings.css"

type APIProvider = "openai-compatible" | "anthropic"
type Section = "models" | "requests" | "speech" | "appearance" | "storage" | "diagnostics"
type TestRoute = Omit<LLMConnectionTestRequest, "id">
const initialDraft = {
  apiProvider: "openai-compatible" as APIProvider, apiKey: "", baseURL: "", extractionModel: "gpt-4o",
  solutionApiKey: "", solutionBaseURL: "", solutionModel: "gpt-4o", debuggingModel: "gpt-4o",
  fallbackEnabled: false, fallbackApiProvider: "openai-compatible" as APIProvider,
  fallbackApiKey: "", fallbackBaseURL: "", fallbackModel: "", llmTimeoutSeconds: 90,
  streamingEnabled: true, maxOutputTokens: 65536, contextMessageLimit: 30, contextWindowTokens: 128000,
  speechApiKey: "", speechWorkspaceId: "", speechRegion: "cn-beijing", speechModel: "qwen-audio-3.0-asr-flash-streaming",
  interviewContextPath: "", opacity: 1,
}
type SettingsDraft = typeof initialDraft
const sections = [
  { id: "models" as const, label: "模型线路", icon: Waypoints, caption: "配置主线路与备用服务" },
  { id: "requests" as const, label: "请求参数", icon: SlidersHorizontal, caption: "控制响应、上下文与输出" },
  { id: "speech" as const, label: "语音与上下文", icon: Mic, caption: "连接语音识别与个人资料" },
  { id: "appearance" as const, label: "界面与快捷键", icon: Monitor, caption: "调整显示与查看操作方式" },
  { id: "storage" as const, label: "存储空间", icon: HardDrive, caption: "查看软件本体以外的本地空间占用" },
  { id: "diagnostics" as const, label: "诊断", icon: Activity, caption: "定位连接与运行问题" },
]
const claudeModels = ["claude-3-7-sonnet-20250219", "claude-3-5-sonnet-20241022", "claude-3-opus-20240229"]

function Field({ label, hint, children, className = "" }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  const id = useId()
  return <div className={"settings-field " + className}>
    <div id={id} className="settings-label">{label}</div>
    <div role="group" aria-labelledby={id}>{children}</div>
    {hint && <p className="settings-hint">{hint}</p>}
  </div>
}

function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (value: boolean) => void; label: string; description?: string }) {
  return <div className="settings-toggle-row">
    <div><div className="settings-label">{label}</div>{description && <p className="settings-hint">{description}</p>}</div>
    <button type="button" role="switch" aria-label={label} aria-checked={checked} onClick={() => onChange(!checked)} className={"settings-switch " + (checked ? "is-on" : "")}><span /></button>
  </div>
}

function Card({ title, description, children, accessory, compact = false }: { title: string; description?: string; children: ReactNode; accessory?: ReactNode; compact?: boolean }) {
  return <section className={"settings-card" + (compact ? " settings-route-card" : "")}>
    <div className="settings-card-heading"><div><h3>{title}</h3>{description && <p>{description}</p>}</div>{accessory}</div>
    {children}
  </section>
}

function ProviderSelect({ value, onChange }: { value: APIProvider; onChange: (value: APIProvider) => void }) {
  return <select className="settings-control" aria-label="接口协议" value={value} onChange={(event) => onChange(event.target.value as APIProvider)}>
    <option value="openai-compatible">OpenAI 兼容接口</option><option value="anthropic">Anthropic 官方接口</option>
  </select>
}

function useConnectionTest(open: boolean, route: TestRoute) {
  const [state, setState] = useState<{ pending: boolean; result?: LLMConnectionTestResult }>({ pending: false })
  const active = useRef<string | null>(null)
  // Only a private, in-memory draft fingerprint; never logged or persisted.
  const signature = JSON.stringify(route)
  useEffect(() => {
    setState({ pending: false })
    return () => {
      const id = active.current
      active.current = null
      if (id) void window.electronAPI.cancelLLMConnectionTest(id).catch(() => {})
    }
  }, [open, signature])
  const cancel = () => {
    const id = active.current
    active.current = null
    setState({ pending: false })
    if (id) void window.electronAPI.cancelLLMConnectionTest(id).catch(() => {})
  }
  const run = async () => {
    if (active.current) return
    const id = crypto.randomUUID()
    active.current = id
    setState({ pending: true })
    try {
      const result = await window.electronAPI.testLLMConnection({ ...route, id })
      if (active.current !== id) return
      active.current = null
      setState({ pending: false, result })
    } catch {
      if (active.current !== id) return
      active.current = null
      setState({ pending: false, result: { success: false, message: "无法执行测试，请确认已启动新版电脑端", elapsedMs: 0 } })
    }
  }
  return { ...state, run, cancel }
}

function ConnectionTest({ test, ready, label, disabled = false }: { test: ReturnType<typeof useConnectionTest>; ready: boolean; label: string; disabled?: boolean }) {
  return <div className="settings-test">
    <div className="settings-test-actions">
      <Button type="button" variant="outline" className="settings-test-button" aria-label={label + (test.pending ? "取消测试" : "测试连接")} disabled={disabled || (!test.pending && !ready)} onClick={() => test.pending ? test.cancel() : void test.run()}>
        {test.pending ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />}
        {test.pending ? "取消测试" : "测试连接"}
      </Button>
    </div>
    {test.pending && <p className="settings-hint">正在请求，最多等待 20 秒…</p>}
    <div aria-live="polite" aria-atomic="true">
      {test.result && <div className={"settings-test-result " + (test.result.success ? "is-success" : "is-error")}>
        {test.result.success ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
        <span>{test.result.message}{test.result.status ? "（HTTP " + test.result.status + "）" : ""}</span>
        {test.result.elapsedMs > 0 && <small>{(test.result.elapsedMs / 1000).toFixed(1)} s</small>}
      </div>}
    </div>
  </div>
}

export function SettingsDialog({ open: externalOpen, onOpenChange }: { open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = externalOpen ?? internalOpen
  const [section, setSection] = useState<Section>("models")
  const [form, setForm] = useState<SettingsDraft>(initialDraft)
  const [saved, setSaved] = useState<SettingsDraft>(initialDraft)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [openingFile, setOpeningFile] = useState(false)
  const [logPath, setLogPath] = useState("")
  const [testPurpose, setTestPurpose] = useState<"extractionModel" | "solutionModel" | "debuggingModel">("extractionModel")
  const savedOpacity = useRef(1)
  const { showToast } = useToast()
  const set = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => setForm((previous) => ({ ...previous, [key]: value }))
  const separateSolution = testPurpose === "solutionModel" && Boolean(form.solutionApiKey.trim() || form.solutionBaseURL.trim())
  const primaryRoute: TestRoute = { route: "primary", apiProvider: separateSolution ? "openai-compatible" : form.apiProvider, apiKey: separateSolution ? form.solutionApiKey : form.apiKey, baseURL: separateSolution ? form.solutionBaseURL : form.baseURL, model: form[testPurpose] }
  const backupRoute: TestRoute = { route: "fallback", apiProvider: form.fallbackApiProvider, apiKey: form.fallbackApiKey, baseURL: form.fallbackBaseURL, model: form.fallbackModel }
  const primaryTest = useConnectionTest(open, primaryRoute)
  const backupTest = useConnectionTest(open, backupRoute)
  const dirty = JSON.stringify(form) !== JSON.stringify(saved)
  const currentSection = sections.find((item) => item.id === section)!

  const handleOpenChange = (next: boolean) => {
    if (saving) return
    if (!next) {
      primaryTest.cancel()
      backupTest.cancel()
      void window.electronAPI.setOpacity(savedOpacity.current)
    }
    setInternalOpen(next)
    onOpenChange?.(next)
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setLoadFailed(false)
    window.electronAPI.getConfig().then((config) => {
      if (cancelled) return
      const draft = Object.fromEntries(Object.entries(initialDraft).map(([key, value]) => [key, config[key as keyof typeof config] ?? value])) as SettingsDraft
      draft.opacity = Math.min(1, Math.max(0.1, draft.opacity))
      setForm(draft)
      setSaved(draft)
      savedOpacity.current = draft.opacity
    }).catch(() => {
      if (!cancelled) { setLoadFailed(true); showToast("无法读取设置", "请关闭设置后重新打开", "error") }
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, showToast])

  useEffect(() => {
    if (!open || section !== "diagnostics") return
    let cancelled = false
    window.electronAPI.getLogInfo().then((info) => { if (!cancelled) setLogPath(info.mainLogPath || "") }).catch(() => {})
    return () => { cancelled = true }
  }, [open, section])

  const validURL = (value: string) => {
    const url = new URL(value.trim())
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("请填写有效的 HTTP(S) API 地址")
  }
  const handleSave = async () => {
    try {
      if (!form.apiKey.trim() || !form.extractionModel.trim() || !form.solutionModel.trim() || !form.debuggingModel.trim()) throw new Error("请补全主线路 Key 和模型")
      if (form.apiProvider === "openai-compatible") validURL(form.baseURL)
      if (form.fallbackEnabled) {
        if (!form.fallbackApiKey.trim() || !form.fallbackModel.trim()) throw new Error("请补全备用线路 Key 和模型，或关闭备用线路")
        if (form.fallbackApiProvider === "openai-compatible") validURL(form.fallbackBaseURL)
      }
      if (form.solutionApiKey.trim() || form.solutionBaseURL.trim()) {
        if (!form.solutionApiKey.trim()) throw new Error("请补全独立追问接口的 Key")
        validURL(form.solutionBaseURL)
      }
      const ranges: Array<[number, number, number, string]> = [
        [form.llmTimeoutSeconds, 15, 180, "线路超时"], [form.maxOutputTokens, 1024, 65536, "最大输出"],
        [form.contextMessageLimit, 4, 100, "上下文消息数"], [form.contextWindowTokens, 8192, 1000000, "上下文窗口"],
      ]
      for (const [value, min, max, label] of ranges) if (!Number.isInteger(value) || value < min || value > max) throw new Error(label + "请填写 " + min + "～" + max + " 的整数")
    } catch (error) {
      showToast("请检查设置", error instanceof Error ? error.message : "输入有误", "error")
      return
    }
    setSaving(true)
    try {
      const next = { ...form }
      for (const key of Object.keys(next) as Array<keyof SettingsDraft>) {
        if (typeof next[key] === "string") Object.assign(next, { [key]: String(next[key]).trim() })
      }
      next.baseURL = next.baseURL.replace(/\/$/, "")
      next.fallbackBaseURL = next.fallbackBaseURL.replace(/\/$/, "")
      next.solutionBaseURL = next.solutionBaseURL.replace(/\/$/, "")
      const result = await window.electronAPI.updateConfig(next)
      if (!result) throw new Error()
      savedOpacity.current = next.opacity
      setSaved(next)
      setForm(next)
      showToast("设置已保存", "新的模型配置会用于后续请求", "success")
      primaryTest.cancel()
      backupTest.cancel()
      setInternalOpen(false)
      onOpenChange?.(false)
    } catch { showToast("保存失败", "请稍后再试", "error") } finally { setSaving(false) }
  }
  const openContextFile = async () => {
    setOpeningFile(true)
    try {
      const result = await window.electronAPI.openInterviewContextFile(form.interviewContextPath.trim())
      if (!result.success) throw new Error(result.error || "请检查文件路径")
      if (result.path) set("interviewContextPath", result.path)
    } catch (error) { showToast("无法打开文件", error instanceof Error ? error.message : "请稍后重试", "error") } finally { setOpeningFile(false) }
  }
  const ready = (route: TestRoute) => Boolean(route.apiKey.trim() && route.model.trim() && (route.apiProvider === "anthropic" || route.baseURL.trim()))
  const modelControl = (key: "extractionModel" | "solutionModel" | "debuggingModel", label: string) => <Field label={label}>
    {form.apiProvider === "anthropic" && !(key === "solutionModel" && form.solutionBaseURL.trim())
      ? <select className="settings-control" aria-label={label} value={form[key]} onChange={(event) => set(key, event.target.value)}>{claudeModels.map((model) => <option key={model} value={model}>{model}</option>)}</select>
      : <Input aria-label={label} className="settings-control settings-mono" value={form[key]} onChange={(event) => set(key, event.target.value)} placeholder="完整模型 ID" />}
  </Field>

  return <Dialog open={open} onOpenChange={handleOpenChange}>
    <DialogContent className="settings-dialog settings-shell" style={{ width: "min(920px, 94vw)", maxWidth: "920px", height: "min(760px, 90vh)", maxHeight: "90vh", overflow: "hidden", padding: 0 }}>
      <header className="settings-header">
        <div className="settings-heading-icon"><Settings2 size={20} /></div>
        <div><DialogTitle className="settings-title">设置</DialogTitle><DialogDescription className="settings-description">连接你的模型服务，调整适合自己的工作方式。</DialogDescription></div>
        <button type="button" className="settings-close" aria-label="关闭设置" disabled={saving} onClick={() => handleOpenChange(false)}><X size={18} /></button>
      </header>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="设置分类">
          {sections.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-current={section === id ? "page" : undefined} className={section === id ? "is-active" : ""} onClick={() => setSection(id)}><Icon size={16} /><span>{label}</span>{section === id && <span className="settings-nav-dot" />}</button>)}
          <div className="settings-nav-note"><ShieldCheck size={15} /><span>配置保存在本机</span></div>
        </nav>
        <main className="settings-main" key={section}>
          <div className="settings-section-title"><h2>{currentSection.label}</h2><p>{currentSection.caption}</p></div>
          {loading ? <div className="settings-loading"><Loader2 size={20} className="animate-spin" />正在读取设置…</div> : loadFailed ? <div className="settings-callout">设置读取失败。请关闭后重新打开，避免覆盖已有配置。</div> : <fieldset disabled={saving} className="settings-fields">
            {section === "models" && <>
              <Card compact title="主线路" description="每次请求优先使用的模型服务" accessory={<ConnectionTest label="主线路" test={primaryTest} ready={ready(primaryRoute)} disabled={saving} />}>
                <div className="settings-grid">
                  <Field label="接口协议"><ProviderSelect value={form.apiProvider} onChange={(provider) => {
                    const model = provider === "anthropic" ? claudeModels[0] : "gpt-4o"
                    setForm((previous) => ({ ...previous, apiProvider: provider, extractionModel: model, solutionModel: previous.solutionBaseURL ? previous.solutionModel : model, debuggingModel: model }))
                  }} /></Field>
                  <Field label="API Base URL" hint={form.apiProvider === "anthropic" ? "使用 Anthropic 官方地址" : "按服务商要求包含 /v1 等路径"}>
                    <Input aria-label="主线路 API 地址" className="settings-control settings-mono" disabled={form.apiProvider === "anthropic"} value={form.apiProvider === "anthropic" ? "https://api.anthropic.com" : form.baseURL} onChange={(event) => set("baseURL", event.target.value)} placeholder="https://api.example.com/v1" />
                  </Field>
                  <Field label="API Key"><Input aria-label="主线路 API Key" autoComplete="off" type="password" className="settings-control" value={form.apiKey} onChange={(event) => set("apiKey", event.target.value)} placeholder="输入主线路密钥" /></Field>
                  {modelControl("extractionModel", "视觉 / 对话模型")}
                </div>
                <details className="settings-details"><summary>更多模型与独立追问接口<ChevronDown size={14} /></summary><div className="settings-details-content">
                  <div className="settings-grid">{modelControl("solutionModel", "追问模型")}{modelControl("debuggingModel", "调试模型")}</div>
                  <p className="settings-hint">可为旧版解题流程的文字追问单独配置兼容接口；当前多轮聊天仍使用上方视觉 / 对话模型。留空沿用主线路。</p>
                  <div className="settings-grid"><Field label="独立追问 Base URL"><Input aria-label="独立追问 API 地址" className="settings-control settings-mono" value={form.solutionBaseURL} onChange={(event) => set("solutionBaseURL", event.target.value)} placeholder="可选" /></Field><Field label="独立追问 API Key"><Input aria-label="独立追问 API Key" type="password" autoComplete="off" className="settings-control" value={form.solutionApiKey} onChange={(event) => set("solutionApiKey", event.target.value)} placeholder="可选" /></Field></div>
                </div></details>
                <div className="settings-test-target"><span>测试模型</span><select className="settings-control" aria-label="主线路测试用途" value={testPurpose} onChange={(event) => setTestPurpose(event.target.value as typeof testPurpose)}><option value="extractionModel">视觉 / 对话模型</option><option value="solutionModel">追问模型{form.solutionBaseURL.trim() ? " · 独立接口" : ""}</option><option value="debuggingModel">调试模型</option></select></div>
              </Card>
              <Card compact title="备用线路" description="主线路不可用时，自动尝试备用服务一次" accessory={<ConnectionTest label="备用线路" test={backupTest} ready={ready(backupRoute)} disabled={saving} />}>
                <Toggle checked={form.fallbackEnabled} onChange={(value) => set("fallbackEnabled", value)} label="启用自动切换" description="关闭时无需填写，仍可提前配置并测试备用服务。" />
                <div className="settings-grid">
                  <Field label="接口协议"><ProviderSelect value={form.fallbackApiProvider} onChange={(value) => set("fallbackApiProvider", value)} /></Field>
                  <Field label="API Base URL"><Input aria-label="备用线路 API 地址" className="settings-control settings-mono" disabled={form.fallbackApiProvider === "anthropic"} value={form.fallbackApiProvider === "anthropic" ? "https://api.anthropic.com" : form.fallbackBaseURL} onChange={(event) => set("fallbackBaseURL", event.target.value)} placeholder="https://api.example.com/v1" /></Field>
                  <Field label="API Key"><Input aria-label="备用线路 API Key" type="password" autoComplete="off" className="settings-control" value={form.fallbackApiKey} onChange={(event) => set("fallbackApiKey", event.target.value)} placeholder="输入备用线路密钥" /></Field>
                  <Field label="备用模型"><Input aria-label="备用模型" className="settings-control settings-mono" value={form.fallbackModel} onChange={(event) => set("fallbackModel", event.target.value)} placeholder="支持图片输入的模型 ID" /></Field>
                </div>
              </Card>
              <div className="settings-callout"><CircleHelp size={16} /><p>填齐地址、Key 和模型后可测试，无需保存。仅测试文字响应，不验证图片输入，可能产生少量 API 费用。启用自动切换后，正常请求的上下文与图片可能发送给备用服务。</p></div>
            </>}
            {section === "requests" && <>
              <Card title="响应方式" description="主线路与备用线路共用的请求策略">
                <Toggle checked={form.streamingEnabled} onChange={(value) => set("streamingEnabled", value)} label="流式输出" description="边生成边显示；需当前接口支持。Anthropic 当前按完整回复显示。" />
                <div className="settings-grid"><Field label="每条线路超时（秒）" hint="15～180 秒，超时后按备用策略处理"><Input aria-label="每条线路超时" className="settings-control" type="number" min={15} max={180} value={form.llmTimeoutSeconds} onChange={(event) => set("llmTimeoutSeconds", Number(event.target.value))} /></Field><Field label="最大输出 Tokens" hint="1024～65536，需在服务商允许范围内"><Input aria-label="最大输出 Tokens" className="settings-control" type="number" min={1024} max={65536} value={form.maxOutputTokens} onChange={(event) => set("maxOutputTokens", Number(event.target.value))} /></Field></div>
              </Card>
              <Card title="上下文管理" description="历史越长，请求消耗与等待时间通常越高"><div className="settings-grid"><Field label="携带的消息数" hint="最近 4～100 条消息"><Input aria-label="上下文消息数" className="settings-control" type="number" min={4} max={100} value={form.contextMessageLimit} onChange={(event) => set("contextMessageLimit", Number(event.target.value))} /></Field><Field label="模型上下文窗口 Tokens" hint="8192～1000000，用于判断历史压缩时机"><Input aria-label="模型上下文窗口" className="settings-control" type="number" min={8192} max={1000000} value={form.contextWindowTokens} onChange={(event) => set("contextWindowTokens", Number(event.target.value))} /></Field></div></Card>
            </>}
            {section === "speech" && <>
              <Card title="实时语音识别" description="可选的 DashScope 服务，在聊天窗口中开始或停止录音"><div className="settings-grid">
                <Field label="DashScope API Key" className="settings-span-full"><Input aria-label="语音识别 API Key" type="password" autoComplete="off" className="settings-control" value={form.speechApiKey} onChange={(event) => set("speechApiKey", event.target.value)} placeholder="输入语音服务密钥" /></Field>
                <Field label="地域"><select className="settings-control" aria-label="语音识别地域" value={form.speechRegion} onChange={(event) => set("speechRegion", event.target.value)}><option value="cn-beijing">北京 · cn-beijing</option><option value="ap-southeast-1">新加坡 · ap-southeast-1</option></select></Field>
                <Field label="Workspace ID" hint="可选，留空使用公共入口"><Input aria-label="语音识别 Workspace ID" className="settings-control settings-mono" value={form.speechWorkspaceId} onChange={(event) => set("speechWorkspaceId", event.target.value)} placeholder="业务空间 ID" /></Field>
                <Field label="识别模型" className="settings-span-full"><Input aria-label="语音识别模型" className="settings-control settings-mono" value={form.speechModel} onChange={(event) => set("speechModel", event.target.value)} /></Field>
              </div></Card>
              <Card title="面试上下文" description="保存简历、项目经历与岗位资料；在聊天窗口中启用上下文"><Field label="上下文文件路径" hint="留空使用应用默认路径，文件不存在时会创建。"><Input aria-label="面试上下文文件路径" className="settings-control settings-mono" value={form.interviewContextPath} onChange={(event) => set("interviewContextPath", event.target.value)} placeholder="留空使用默认路径" /></Field><div className="settings-card-bottom"><span className="settings-hint">打开文件不会保存其他设置。</span><Button type="button" variant="outline" className="settings-test-button" disabled={openingFile} onClick={() => void openContextFile()}><FileText size={14} />{openingFile ? "正在打开…" : "打开文件"}</Button></div></Card>
            </>}
            {section === "appearance" && <>
              <Card title="窗口透明度" description="拖动实时预览，保存后生效；取消会恢复之前的设置" accessory={<span className="settings-opacity-value">{Math.round(form.opacity * 100)}%</span>}>
                <input type="range" aria-label="窗口透明度" min={0.1} max={1} step={0.01} value={form.opacity} className="opacity-slider" style={{ "--opacity-progress": ((form.opacity - 0.1) / 0.9 * 100) + "%" } as CSSProperties} onChange={(event) => { const value = Number(event.target.value); set("opacity", value); void window.electronAPI.setOpacity(value) }} /><div className="settings-range-labels"><span>更透明</span><span>更清晰</span></div>
              </Card>
              <Card title="快捷键" description="常用操作保持触手可及" accessory={<Keyboard size={17} className="text-slate-400" />}><div className="settings-shortcuts">{[
                ["显示 / 隐藏窗口", "B"], ["新建会话", "N"], ["采集图片", "H"], ["发送 / 处理", "Enter"], ["删除最近图片", "L"], ["重置视图", "R"], ["移动窗口", "方向键"], ["降低 / 提高透明度", "[ / ]"], ["缩小 / 放大", "− / +"], ["恢复缩放", "0"], ["退出应用", "Q"],
              ].map(([label, key]) => <div key={key}><span>{label}</span><kbd>{COMMAND_KEY} + {key}</kbd></div>)}<div><span>鼠标唤起窗口</span><small>快速左右晃动 4 次</small></div></div></Card>
            </>}
            {section === "storage" && <StoragePanel />}
            {section === "diagnostics" && <>
              <Card title="运行日志" description="按启动批次记录运行状态，便于定位模型与连接问题"><Field label="日志位置"><div className="settings-path">{logPath || "暂未获取到日志路径"}</div></Field><div className="settings-card-bottom"><span className="settings-hint">日志可能含请求信息，分享前请自行检查。</span><Button type="button" variant="outline" className="settings-test-button" onClick={() => void openLogDirectory().then((result) => { if (!result.success) showToast("无法打开日志目录", result.error || "请稍后重试", "error") }).catch(() => showToast("无法打开日志目录", "请稍后重试", "error"))}>打开日志目录<ArrowRight size={14} /></Button></div></Card>
              <Card title="线路诊断" description="主、备用线路可分别检查，不改变正在使用的配置"><p className="settings-hint">测试返回连接耗时，以及认证、余额、限流和服务端错误等结果。修改地址、Key 或模型后，旧结果会清除。</p><Button type="button" variant="outline" className="settings-test-button mt-4" onClick={() => setSection("models")}>前往模型线路<ArrowRight size={14} /></Button></Card>
            </>}
          </fieldset>}
        </main>
      </div>
      <footer className="settings-footer"><div className="settings-save-note">{saving ? <Loader2 size={14} className="animate-spin" /> : dirty ? <span className="settings-unsaved-dot" /> : <Check size={14} />}<span>{saving ? "正在保存" : dirty ? "有未保存的更改" : "设置已同步"}</span></div><div className="settings-footer-actions"><Button type="button" variant="ghost" className="settings-cancel" disabled={saving} onClick={() => handleOpenChange(false)}>取消</Button><Button type="button" className="settings-save" disabled={loading || loadFailed || saving || !dirty} onClick={() => void handleSave()}>{saving && <Loader2 size={14} className="animate-spin" />}保存更改</Button></div></footer>
    </DialogContent>
  </Dialog>
}
