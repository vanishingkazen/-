import { useEffect, useRef, useState } from "react"
import { HardDrive, Loader2, RefreshCw } from "lucide-react"
import { Button } from "../ui/button"
import type { StorageUsage } from "../../../electron/StorageUsage"

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return (bytes / 1024 ** index).toLocaleString("zh-CN", { maximumFractionDigits: index ? 1 : 0 }) + " " + units[index]
}

export function StoragePanel() {
  const [usage, setUsage] = useState<StorageUsage>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const request = useRef(0)
  const refresh = async () => {
    const id = ++request.current
    setLoading(true)
    setError("")
    try {
      const result = await window.electronAPI.getStorageUsage()
      if (id === request.current) setUsage(result)
    } catch {
      if (id === request.current) setError("无法统计存储空间，请确认已启动新版电脑端后重试。")
    } finally {
      if (id === request.current) setLoading(false)
    }
  }
  useEffect(() => {
    void refresh()
    return () => { request.current++ }
  }, [])

  return <section className="settings-card settings-storage" aria-label="应用数据空间占用" aria-busy={loading}>
    <div className="settings-card-heading">
      <div><h3>应用数据占用</h3><p>不包含软件本体、源码和开发依赖</p></div>
      <Button type="button" variant="outline" className="settings-test-button" disabled={loading} onClick={() => void refresh()}>
        {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}刷新统计
      </Button>
    </div>
    <div aria-live="polite">
      {error && <p className="settings-test-result is-error">{error}</p>}
      {loading && !usage && <div className="settings-loading"><Loader2 size={18} className="animate-spin" />正在统计本地文件…</div>}
      {usage && <>
        <div className="settings-storage-total"><HardDrive size={24} /><div><span>{usage.partial ? "已统计占用（部分结果）" : "本地数据总占用"}</span><strong>{formatBytes(usage.totalBytes)}</strong></div></div>
        <div className="settings-storage-list">
          {usage.categories.map((category) => <div className="settings-storage-category" key={category.id}>
            <div><span>{category.label}</span><small>{category.files.toLocaleString("zh-CN")} 个文件</small><strong>{formatBytes(category.bytes)}</strong></div>
            <div className="settings-storage-track" aria-hidden="true"><span style={{ width: (usage.totalBytes ? category.bytes / usage.totalBytes * 100 : 0) + "%" }} /></div>
          </div>)}
        </div>
        <p className="settings-hint">{loading ? "正在刷新…" : "统计时间：" + new Date(usage.scannedAt).toLocaleString("zh-CN")}</p>
        {usage.partial && <p className="settings-test-result is-error">部分文件无法读取或达到统计时限，当前数值可能偏低。可稍后刷新。</p>}
        <details className="settings-details"><summary>查看统计路径</summary><div className="settings-details-content">{usage.locations.map((location) => <div className="settings-path" key={location}>{location}</div>)}</div></details>
      </>}
    </div>
    <p className="settings-hint">仅统计本应用使用的数据位置及已保存配置中的上下文文件；不跟随符号链接。macOS 按文件分配的磁盘块估算，其他平台可能按文件大小计算；压缩、共享磁盘块和统计期间的写入可能造成差异。</p>
  </section>
}
