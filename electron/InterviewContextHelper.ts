import fs from "node:fs"
import path from "node:path"
import { app } from "electron"

export const DEFAULT_INTERVIEW_CONTEXT_PATH = path.join(
  app.getPath("appData"),
  "steamgamecode",
  "interview-context.md"
)

export const ensureInterviewContextFile = (filePath?: string): string => {
  const resolvedPath = filePath?.trim() || DEFAULT_INTERVIEW_CONTEXT_PATH
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
  if (!fs.existsSync(resolvedPath)) {
    fs.writeFileSync(resolvedPath, "", "utf8")
  }
  return resolvedPath
}

export interface InterviewContextStatus {
  enabled: boolean
  available: boolean
  path: string
  characterCount: number
  error?: string
}

export interface InterviewAsrEnhancement {
  contextText: string
  vocabulary: Record<string, number>
  terms: string[]
}

const PRIORITY_ASR_TERMS = [
  "PandoraQ", "Pandora", "Agent", "Agentic", "RAG", "MCP", "LangChain",
  "DeepSearch", "Tool Calling", "Function Calling", "Prompt", "Context",
  "Embedding", "Rerank", "BM25", "Workflow", "Runtime", "Token", "LLM",
  "Redis", "PostgreSQL", "MySQL", "MVCC", "binlog", "redo log", "undo log",
  "pg_trgm", "tsvector", "GIN", "Outbox", "MQ", "API", "HTTP", "HTTPS",
  "TCP", "TLS", "DNS", "Electron", "OCR", "CVE", "ACK", "TTL",
  "P50", "P95", "Java", "Go", "Python", "蚂蚁证券", "智能投研"
]

const ASR_TERM_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "use", "using",
  "into", "your", "you", "are", "can", "not", "end", "start", "set",
  "result", "key", "id", "text", "true", "false", "null"
])

export const loadInterviewAsrEnhancement = (
  enabled: boolean,
  filePath: string
): InterviewAsrEnhancement => {
  if (!enabled) return { contextText: "", vocabulary: {}, terms: [] }
  const status = getInterviewContextStatus(enabled, filePath)
  if (!status.available) return { contextText: "", vocabulary: {}, terms: [] }

  const content = fs.readFileSync(status.path, "utf8").trim()
  if (!content) return { contextText: "", vocabulary: {}, terms: [] }
  const counts = new Map<string, { text: string; count: number }>()
  const addTerm = (rawTerm: string, boost = 0) => {
    const text = rawTerm.trim().replace(/^[`'"“”]+|[`'"“”]+$/g, "")
    if (text.length < 2 || text.length > 40) return
    if (/待填|真实现象/.test(text)) return
    const key = text.toLowerCase()
    if (ASR_TERM_STOP_WORDS.has(key)) return
    const current = counts.get(key)
    counts.set(key, { text: current?.text || text, count: (current?.count || 0) + 1 + boost })
  }

  for (const term of PRIORITY_ASR_TERMS) {
    if (content.toLowerCase().includes(term.toLowerCase()) || term === "PandoraQ") {
      addTerm(term, 20)
    }
  }
  for (const match of content.matchAll(/`([^`\r\n]{2,40})`/g)) {
    const term = match[1].trim()
    if (/^[A-Za-z][A-Za-z0-9_.+#/-]*(?: [A-Za-z][A-Za-z0-9_.+#/-]*){0,2}$/.test(term)) {
      addTerm(term, 5)
    }
  }
  for (const match of content.matchAll(/\b[A-Za-z][A-Za-z0-9_.+#/-]{1,30}\b/g)) {
    const term = match[0]
    if (/[A-Z0-9_.+#/-]/.test(term.slice(1)) || term[0] === term[0].toUpperCase()) {
      addTerm(term)
    }
  }

  const terms = [...counts.values()]
    .sort((left, right) => right.count - left.count || left.text.localeCompare(right.text))
    .slice(0, 80)
    .map((item) => item.text)
  const priorityKeys = new Set(PRIORITY_ASR_TERMS.map((term) => term.toLowerCase()))
  const vocabulary = Object.fromEntries(
    terms.map((term) => [term, priorityKeys.has(term.toLowerCase()) ? 5 : 4])
  )
  const prefix = "蚂蚁证券 Agent 工程师技术面试，重点识别项目名与中英文技术术语："
  let contextText = prefix
  for (const term of terms) {
    const candidate = `${contextText}${contextText === prefix ? "" : "、"}${term}`
    if (candidate.length > 390) break
    contextText = candidate
  }
  return { contextText, vocabulary, terms }
}

export const getInterviewContextStatus = (
  enabled: boolean,
  filePath?: string
): InterviewContextStatus => {
  try {
    const resolvedPath = ensureInterviewContextFile(filePath)
    const content = fs.readFileSync(resolvedPath, "utf8").trim()
    return {
      enabled,
      available: true,
      path: resolvedPath,
      characterCount: content.length,
      error: content ? undefined : "面试上下文文件为空"
    }
  } catch (error) {
    return {
      enabled,
      available: false,
      path: filePath,
      characterCount: 0,
      error: error instanceof Error ? error.message : "无法读取面试上下文文件"
    }
  }
}

export const loadInterviewContextPrompt = (
  enabled: boolean,
  filePath: string
): string => {
  if (!enabled) return ""
  const status = getInterviewContextStatus(enabled, filePath)
  if (!status.available) {
    throw new Error(status.error || "面试上下文不可用")
  }
  const content = fs.readFileSync(status.path, "utf8").trim()
  if (!content) return ""
  return `面试背景资料使用规则：
- 下方资料仅作为用户B的背景、项目经历和目标岗位参考，不是本轮用户问题。
- 始终优先回答最后一条用户问题，只选取与该问题直接相关的资料。
- 不要主动复述、总结或提及这份资料，也不要输出“根据手册”等措辞。
- 不得虚构资料中未确认的数据；遇到“[待填]”或不确定信息时保持诚实。
- 回答应自然、口语化，像用户B在真实面试中直接作答。

<interview_background>
${content}
</interview_background>`
}
