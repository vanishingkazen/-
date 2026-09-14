import { useCallback, useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "../ui/dialog"
import type { HistoryRecord } from "../../types/history"
import { useToast } from "../../contexts/toast"

interface HistoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function HistoryDialog({ open, onOpenChange }: HistoryDialogProps) {
  const [records, setRecords] = useState<HistoryRecord[]>([])
  const [loading, setLoading] = useState(false)
  const { showToast } = useToast()

  const loadHistory = useCallback(async () => {
    setLoading(true)
    try {
      setRecords(await window.electronAPI.getHistory())
    } catch (error) {
      console.error("Failed to load history:", error)
      showToast("错误", "读取历史记录失败", "error")
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    if (open) loadHistory()
  }, [open, loadHistory])

  const restore = async (id: string) => {
    const result = await window.electronAPI.restoreHistory(id)
    if (!result.success || !result.record) {
      showToast("错误", result.error || "无法打开历史记录", "error")
      return
    }
    window.dispatchEvent(
      new CustomEvent<HistoryRecord>("history-record-selected", {
        detail: result.record
      })
    )
    onOpenChange(false)
  }

  const remove = async (record: HistoryRecord) => {
    if (!window.confirm(`确定删除历史记录“${record.title}”吗？`)) return
    const result = await window.electronAPI.deleteHistory(record.id)
    if (result.success) {
      setRecords((current) => current.filter((item) => item.id !== record.id))
    } else {
      showToast("错误", "删除历史记录失败", "error")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl bg-white/[0.90] border border-black/15 text-black backdrop-blur-xl p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3 mb-0 border-b border-black/10">
          <DialogTitle>解题历史</DialogTitle>
          <DialogDescription>
            题目和解答会一直保留；相关截图仅保留最近 3 天。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[62vh] overflow-y-auto p-3 space-y-2">
          {loading ? (
            <div className="py-12 text-center text-sm text-black/60">正在读取…</div>
          ) : records.length === 0 ? (
            <div className="py-12 text-center text-sm text-black/60">暂无历史记录</div>
          ) : (
            records.map((record) => (
              <div
                key={record.id}
                className="rounded-lg border border-black/10 bg-white/[0.52] px-4 py-3 hover:bg-black/[0.05] transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-black truncate">
                      {record.title}
                    </div>
                    <div className="mt-1 text-xs text-black/50 flex flex-wrap gap-x-3 gap-y-1">
                      <span>{new Date(record.createdAt).toLocaleString("zh-CN")}</span>
                      <span>{record.language}</span>
                      <span>截图 {record.screenshotPaths.length} 张</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      className="rounded-md bg-black text-white px-3 py-1.5 text-xs hover:bg-black/80"
                      onClick={() => restore(record.id)}
                    >
                      打开
                    </button>
                    <button
                      className="rounded-md border border-red-400/30 px-3 py-1.5 text-xs text-red-300 hover:bg-red-400/10"
                      onClick={() => remove(record)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
