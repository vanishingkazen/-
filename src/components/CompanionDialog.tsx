import { useEffect, useState } from "react"
import { Camera, Check, ChevronDown, Copy, LoaderCircle, Monitor, Power, QrCode, RefreshCw, Wifi, X } from "lucide-react"
import QRCode from "qrcode"
import type { CompanionStatus, PeripheralRole, PeripheralStatus } from "../../electron/CompanionTypes"

type ActionResult = { success: boolean; status?: CompanionStatus; error?: string }
const emptyPeripheral: PeripheralStatus = { paired: false, connected: false }
const roleDetails = {
  display: { title: "网页显示端", subtitle: "在手机、平板或浏览器中查看回答", scan: "用系统相机扫码，在浏览器打开", Icon: Monitor },
  camera: { title: "iOS 相机端", subtitle: "把 iPhone 作为局域网拍摄外设", scan: "用 iOS 拍摄 App 内的扫码功能连接", Icon: Camera }
}

function PeripheralCard({ role, peripheral, running, cameraReady, selectedAddress, now, busy, onAction }: {
  role: PeripheralRole; peripheral: PeripheralStatus; running: boolean; cameraReady: boolean
  selectedAddress: number; now: number; busy: boolean; onAction: (action: () => Promise<ActionResult>) => void
}) {
  const { title, subtitle, scan, Icon } = roleDetails[role]
  const [qr, setQr] = useState("")
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState("")
  const pairing = peripheral.pairingUrls?.[selectedAddress] || peripheral.pairingUrls?.[0]
  const seconds = Math.max(0, Math.ceil(((peripheral.pairingExpiresAt || 0) - now) / 1000))
  const valid = running && !peripheral.paired && seconds > 0 && Boolean(pairing)
  useEffect(() => {
    let active = true
    setQr("")
    setCopied(false)
    setCopyError("")
    if (valid && pairing) {
      void QRCode.toDataURL(pairing.url, { width: 192, margin: 2, errorCorrectionLevel: "M", color: { dark: "#172033", light: "#ffffff" } })
        .then((value) => { if (active) setQr(value) })
        .catch(() => { if (active) setCopyError("二维码生成失败，请刷新重试") })
    }
    return () => { active = false }
  }, [pairing?.url, valid])
  const online = peripheral.connected
  const label = !running ? "服务未开启" : online ? role === "camera" && !cameraReady ? "相机暂停" : "已连接" : peripheral.paired ? "等待重连" : "待配对"
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-slate-200 bg-white p-4" aria-labelledby={`peripheral-${role}`}>
      <div className="flex items-start gap-3">
        <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${role === "display" ? "bg-blue-50 text-blue-600" : "bg-violet-50 text-violet-600"}`}><Icon size={19} /></div>
        <div className="min-w-0 flex-1">
          <h3 id={`peripheral-${role}`} className="text-sm font-semibold text-slate-800">{title}</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{subtitle}</p>
        </div>
      </div>
      <div className="my-4 flex items-center gap-2 text-xs text-slate-600">
        <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-emerald-500" : peripheral.paired ? "bg-amber-400" : "bg-slate-300"}`} />{label}
        {role === "camera" && cameraReady && <span className="ml-auto text-emerald-600">可以拍摄</span>}
      </div>
      {peripheral.paired ? (
        <div className="flex flex-1 flex-col rounded-xl bg-slate-50 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-700"><Check size={16} className="text-emerald-600" />已授权此{role === "display" ? "显示" : "拍摄"}设备</div>
          <p className="text-xs leading-6 text-slate-500">{role === "display" ? "网页同步显示对话与附件。可以使用另一台 iPhone 连接相机端。" : "保持拍摄 App 在前台。采集后的照片会同步到电脑和已连接的网页显示端。"}</p>
          <button className="mt-5 self-start text-xs font-medium text-slate-600 underline decoration-slate-300 underline-offset-4 disabled:opacity-40" disabled={busy} onClick={() => onAction(() => window.electronAPI.disconnectCompanionPhone(role))}>断开并重新配对</button>
        </div>
      ) : running ? (
        <div className="flex flex-1 flex-col items-center rounded-xl bg-slate-50 p-3">
          {qr && valid ? <img className="h-40 w-40 rounded-lg" src={qr} alt={`${title}配对二维码`} /> : <div className="grid h-40 w-40 place-items-center rounded-lg border border-dashed border-slate-300 bg-white p-5 text-center text-xs leading-5 text-slate-400">{valid ? "正在生成二维码…" : "配对码已过期，点击下方刷新"}</div>}
          <p className="mt-3 text-center text-xs font-medium text-slate-600">{scan}</p>
          <p className="mt-1 text-[11px] tabular-nums text-slate-400">{seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} 后过期` : "配对码已过期"}</p>
          <div className="mt-3 flex gap-4 text-xs">
            <button className="inline-flex items-center gap-1.5 text-slate-600 disabled:opacity-40" disabled={busy} onClick={() => onAction(() => window.electronAPI.refreshCompanionPairing(role))}><RefreshCw size={13} />刷新</button>
            <button className="inline-flex items-center gap-1.5 text-slate-600 disabled:opacity-40" disabled={!valid || busy} onClick={() => {
              if (!pairing) return
              void navigator.clipboard.writeText(pairing.url).then(() => { setCopied(true); setCopyError("") }).catch(() => setCopyError("复制失败，请直接扫码连接"))
            }}><Copy size={13} />{copied ? "已复制" : "复制链接"}</button>
          </div>
          {copyError && <p className="mt-2 text-xs text-red-600" role="alert">{copyError}</p>}
        </div>
      ) : <div className="flex flex-1 flex-col items-center justify-center rounded-xl bg-slate-50 px-4 py-8 text-center"><QrCode size={30} className="mb-3 text-slate-300" /><p className="text-xs leading-6 text-slate-400">开启局域网服务后<br />显示此设备的独立配对码</p></div>}
    </section>
  )
}

export default function CompanionDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<CompanionStatus>({ running: false, connected: false, addresses: [] })
  const [selectedAddress, setSelectedAddress] = useState(0)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    let active = true
    void window.electronAPI.getCompanionStatus().then((value) => { if (active) setStatus(value) }).catch(() => { if (active) setError("无法读取外设服务状态") })
    const unsubscribe = window.electronAPI.onCompanionStatus(setStatus)
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { active = false; unsubscribe(); window.clearInterval(timer) }
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose() } }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  const runAction = async (action: () => Promise<ActionResult>) => {
    setBusy(true); setError("")
    try {
      const result = await action()
      if (result.status) setStatus(result.status)
      if (!result.success) setError(result.error || "操作失败")
    } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败") }
    finally { setBusy(false) }
  }
  const source = status.captureSource || "screen"
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="flex max-h-[90vh] w-full max-w-[760px] flex-col overflow-hidden rounded-3xl border border-white/80 bg-[#f7f8fb] shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="peripherals-title">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200/80 bg-white px-6 py-5">
          <div><div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-500">Local peripherals</div><h2 id="peripherals-title" className="text-lg font-semibold text-slate-900">局域网外设</h2><p className="mt-1 text-xs text-slate-500">显示与拍摄独立连接，可以分别使用不同的设备。</p></div>
          <button className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100" onClick={onClose} aria-label="关闭外设设置"><X size={18} /></button>
        </header>
        <div className="overflow-y-auto px-6 py-5">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <div className="flex items-center gap-3"><Wifi size={18} className={status.running ? "text-emerald-600" : "text-slate-400"} /><div><div className="text-sm font-medium text-slate-800">局域网服务 <span className={`ml-2 text-[11px] ${status.running ? "text-emerald-600" : "text-slate-400"}`}>{status.running ? "运行中" : "未开启"}</span></div><p className="mt-0.5 text-[11px] text-slate-400">电脑与外设需连接同一可信 Wi-Fi</p></div></div>
            <button className={`inline-flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-medium disabled:opacity-50 ${status.running ? "border border-slate-200 text-slate-600 hover:bg-slate-50" : "bg-slate-900 text-white hover:bg-slate-700"}`} disabled={busy} onClick={() => void runAction(() => status.running ? window.electronAPI.stopCompanion() : window.electronAPI.startCompanion())}>{busy ? <LoaderCircle size={14} className="animate-spin" /> : <Power size={14} />}{status.running ? "停止服务" : "开启服务"}</button>
          </div>
          <div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-semibold text-slate-700">连接外设</h3>{status.running && status.addresses.length > 0 && <label className="flex items-center gap-1 text-[11px] text-slate-500">网络<select aria-label="配对使用的网络地址" className="max-w-[210px] bg-transparent py-1 text-slate-600 outline-none" value={Math.min(selectedAddress, status.addresses.length - 1)} onChange={(event) => setSelectedAddress(Number(event.target.value))}>{status.addresses.map((item, index) => <option key={item.url} value={index}>{item.label} · {new URL(item.url).hostname}</option>)}</select></label>}</div>
          <div className="grid gap-4 sm:grid-cols-2">
            {(["display", "camera"] as const).map((role) => <PeripheralCard key={role} role={role} peripheral={status[role] || emptyPeripheral} running={status.running} cameraReady={Boolean(status.cameraReady)} selectedAddress={selectedAddress} now={now} busy={busy} onAction={(action) => void runAction(action)} />)}
          </div>
          <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-4" aria-label="图片采集来源">
            <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold text-slate-800">默认图片来源</h3><span className="text-[11px] text-slate-400">采集按钮 / Cmd 或 Ctrl + H</span></div>
            <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="默认图片来源">
              {([{ id: "screen", title: "电脑截图", detail: "直接截取本机屏幕", Icon: Monitor }, { id: "phone", title: "局域网相机", detail: status.cameraReady ? "iOS 相机已就绪" : "等待 iOS 相机连接", Icon: Camera }] as const).map(({ id, title, detail, Icon }) => <button key={id} role="radio" aria-checked={source === id} disabled={busy} onClick={() => void runAction(() => window.electronAPI.setCaptureSource(id))} className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-colors disabled:opacity-50 ${source === id ? "border-indigo-500 bg-indigo-50/60" : "border-slate-200 hover:bg-slate-50"}`}><Icon size={18} className={source === id ? "text-indigo-600" : "text-slate-400"} /><span className="flex-1"><span className="block text-xs font-medium text-slate-800">{title}</span><span className="mt-1 block text-[11px] text-slate-500">{detail}</span></span><span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${source === id ? "border-indigo-600 bg-indigo-600" : "border-slate-300"}`}>{source === id && <Check size={10} className="text-white" />}</span></button>)}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-slate-400">采集的图片进入同一个附件队列，在电脑或网页显示端预览、提交。</p>
          </section>
          {error && <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">{error}</p>}
          <details className="mt-4 text-[11px] leading-5 text-slate-400"><summary className="flex cursor-pointer list-none items-center gap-1.5"><ChevronDown size={12} />连接与传输说明</summary><div className="mt-2 pl-5">当前使用 HTTP 明文传输，请仅在可信局域网使用。停止服务会同时撤销两类外设的授权；关闭设置窗口不会停止服务。只有网页显示端配对时才保持 PC 悬浮窗隐藏，按 Cmd/Ctrl+B 可手动恢复。</div></details>
        </div>
      </section>
    </div>
  )
}
