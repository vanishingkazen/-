import { useEffect, useMemo, useState } from "react"
import { AlertTriangle, Check, LoaderCircle, QrCode, RefreshCw, Smartphone, Wifi, X } from "lucide-react"
import QRCode from "qrcode"
import type { CompanionStatus } from "../../electron/CompanionTypes"

type CompanionActionResult = { success: boolean; status?: CompanionStatus; error?: string }

export default function CompanionDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<CompanionStatus>({ running: false, connected: false, paired: false, addresses: [] })
  const [selectedAddress, setSelectedAddress] = useState(0)
  const [qrDataUrl, setQrDataUrl] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    let active = true
    void window.electronAPI.getCompanionStatus().then((value) => {
      if (active) setStatus(value)
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "无法读取伴随服务状态")
    })
    const unsubscribe = window.electronAPI.onCompanionStatus((value) => setStatus(value))
    const clock = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      active = false
      unsubscribe()
      window.clearInterval(clock)
    }
  }, [])

  const selectedPairing = status.pairingUrls?.[selectedAddress] || status.pairingUrls?.[0]
  const secondsLeft = status.pairingExpiresAt ? Math.max(0, Math.ceil((status.pairingExpiresAt - now) / 1000)) : 0
  useEffect(() => {
    let active = true
    if (!selectedPairing || secondsLeft <= 0) {
      setQrDataUrl("")
      return () => { active = false }
    }
    void QRCode.toDataURL(selectedPairing.url, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#18223a", light: "#ffffff" }
    }).then((value) => {
      if (active) setQrDataUrl(value)
    }).catch(() => {
      if (active) setError("二维码生成失败，请刷新配对码")
    })
    return () => { active = false }
  }, [selectedPairing?.url, secondsLeft > 0])

  const addressOptions = useMemo(() => status.pairingUrls || [], [status.pairingUrls])
  const runAction = async (action: () => Promise<CompanionActionResult>) => {
    setBusy(true)
    setError("")
    try {
      const result = await action()
      if (result.status) setStatus(result.status)
      if (!result.success) setError(result.error || "操作失败")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/35 p-4" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="w-full max-w-[480px] rounded-2xl border border-black/10 bg-white p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="companion-title">
        <header className="mb-4 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-50 text-indigo-600"><Smartphone size={19} /></span>
            <div>
              <h2 id="companion-title" className="text-base font-semibold text-slate-800">手机浏览器伴随端</h2>
              <p className="mt-1 text-xs text-slate-500">手机和笔记本需连接同一可信 Wi‑Fi</p>
            </div>
          </div>
          <button className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </header>

        <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-900">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p><strong>HTTP 明文传输：</strong>对话、截图和语音转写会在局域网中以未加密形式传输。配对码只控制访问、不提供加密；请勿在公共或不可信 Wi‑Fi 使用。</p>
        </div>

        {!status.running ? (
          <div className="rounded-xl bg-slate-50 px-4 py-5 text-center">
            <p className="mb-4 text-sm text-slate-600">伴随服务当前已关闭。开启后，本机只在局域网提供手机网页，不经过云端。</p>
            <button className="inline-flex h-10 items-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50" onClick={() => void runAction(() => window.electronAPI.startCompanion())} disabled={busy}>
              {busy ? <LoaderCircle className="animate-spin" size={16} /> : <Wifi size={16} />}开启手机伴随
            </button>
          </div>
        ) : status.paired ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800"><Check size={17} />{status.connected ? "手机已配对并连接" : "手机已配对，等待重新连接"}</div>
            <p className="mt-2 text-xs leading-relaxed text-emerald-800/80">手机断线后可使用已配对令牌重新连接。停止服务或断开设备后，当前授权会立即撤销。</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="inline-flex h-9 items-center gap-2 rounded-lg border border-emerald-300 bg-white px-3 text-xs font-medium text-emerald-800 disabled:opacity-50" onClick={() => void runAction(() => window.electronAPI.disconnectCompanionPhone())} disabled={busy}>断开手机并重新配对</button>
              <button className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-600 disabled:opacity-50" onClick={() => void runAction(() => window.electronAPI.stopCompanion())} disabled={busy}>停止服务</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-700"><QrCode size={17} />用手机相机扫描配对</div>
            {addressOptions.length > 1 && (
              <label className="mb-3 flex items-center gap-2 text-xs text-slate-600">
                笔记本网络
                <select className="max-w-[220px] rounded-md border border-slate-200 bg-white px-2 py-1.5" value={selectedAddress} onChange={(event) => setSelectedAddress(Number(event.target.value))}>
                  {addressOptions.map((item, index) => <option key={item.url} value={index}>{item.label} — {new URL(item.url).hostname}</option>)}
                </select>
              </label>
            )}
            {qrDataUrl && secondsLeft > 0
              ? <img className="h-[220px] w-[220px] rounded-lg bg-white p-2" src={qrDataUrl} alt="手机伴随端配对二维码" />
              : <div className="grid h-[220px] w-[220px] place-items-center rounded-lg border border-dashed border-slate-300 bg-white px-5 text-center text-xs text-slate-500">配对码已过期，请刷新后重新扫描</div>}
            <div className="mt-3 max-w-full break-all text-center text-[11px] text-slate-500">{selectedPairing?.url.split("#")[0]}</div>
            <div className="mt-2 text-xs text-slate-500">{secondsLeft > 0 ? `配对码将在 ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")} 后过期` : "配对码已过期"}</div>
            <div className="mt-4 flex gap-2">
              <button className="inline-flex h-9 items-center gap-2 rounded-lg bg-indigo-600 px-3 text-xs font-medium text-white disabled:opacity-50" onClick={() => void runAction(() => window.electronAPI.refreshCompanionPairing())} disabled={busy}>
                {busy ? <LoaderCircle className="animate-spin" size={14} /> : <RefreshCw size={14} />}刷新二维码
              </button>
              <button className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-600 disabled:opacity-50" onClick={() => void runAction(() => window.electronAPI.stopCompanion())} disabled={busy}>停止服务</button>
            </div>
          </div>
        )}

        {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">{error}</p>}
        <p className="mt-4 text-center text-[10px] text-slate-400">关闭此窗口不会自动停止服务；请手动停止以撤销手机授权。</p>
      </section>
    </div>
  )
}
