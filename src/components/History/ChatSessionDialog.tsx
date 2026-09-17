import { useCallback, useEffect, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog"
import type { ChatSession } from "../../types/chat"
import { useToast } from "../../contexts/toast"

interface ChatSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ChatSessionDialog({ open, onOpenChange }: ChatSessionDialogProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [loading, setLoading] = useState(false)
  const { showToast } = useToast()

  const loadSessions = useCallback(async () => {
    setLoading(true)
    try {
      setSessions(await window.electronAPI.listChatSessions())
    } catch (error) {
      console.error("Failed to load chat sessions:", error)
      showToast("错误", "读取聊天会话失败", "error")
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    if (open) void loadSessions()
  }, [open, loadSessions])

  const select = async (id: string) => {
    const session = await window.electronAPI.selectChatSession(id)
    if (!session) {
      showToast("错误", "无法打开聊天会话", "error")
      return
    }
    window.dispatchEvent(new CustomEvent<ChatSession>("chat-session-selected", { detail: session }))
    onOpenChange(false)
  }

  const remove = async (session: ChatSession) => {
    if (!window.confirm(`确定删除聊天会话“${session.title}”吗？`)) return
    const result = await window.electronAPI.deleteChatSession(session.id)
    if (!result.success) {
      showToast("错误", "删除聊天会话失败；如果当前有回答正在生成，请稍后重试", "error")
      return
    }
    setSessions((current) => {
      const remaining = current.filter((item) => item.id !== session.id)
      return result.session && !remaining.some((item) => item.id === result.session?.id)
        ? [result.session, ...remaining]
        : remaining
    })
    if (result.session) {
      window.dispatchEvent(new CustomEvent<ChatSession>("chat-session-selected", { detail: result.session }))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl bg-white/[0.90] border border-black/15 text-black backdrop-blur-xl p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3 mb-0 border-b border-black/10">
          <DialogTitle>聊天会话</DialogTitle>
          <DialogDescription>选择一个会话后，后续追问会继续使用它的上下文。</DialogDescription>
        </DialogHeader>
        <div className="max-h-[62vh] overflow-y-auto p-3 space-y-2">
          {loading ? (
            <div className="py-12 text-center text-sm text-black/60">正在读取…</div>
          ) : sessions.length === 0 ? (
            <div className="py-12 text-center text-sm text-black/60">暂无聊天会话</div>
          ) : (
            sessions.map((session) => (
              <div key={session.id} className="rounded-lg border border-black/10 bg-white/[0.52] px-4 py-3 hover:bg-black/[0.05] transition-colors">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-black truncate">{session.title}</div>
                    <div className="mt-1 text-xs text-black/50">
                      {new Date(session.updatedAt).toLocaleString("zh-CN")} · {session.messages.length} 条消息
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button className="rounded-md bg-black text-white px-3 py-1.5 text-xs hover:bg-black/80" onClick={() => void select(session.id)}>
                      打开
                    </button>
                    <button className="rounded-md border border-red-400/30 px-3 py-1.5 text-xs text-red-500 hover:bg-red-400/10" onClick={() => void remove(session)}>
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
