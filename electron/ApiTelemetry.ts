/**
 * 模型 API 调用遥测（写入 main.log）。
 *
 * 目的：每次向模型服务发起请求后，把「请求参数 + 服务端返回的关键字段」压缩成
 * 结构化日志，避免出现「回复为空但日志里毫无线索」的情况。
 *
 * 记录内容：
 * - 请求行：kind / provider / model / host / stream / max_tokens / temperature / messages / images
 * - 响应行：耗时、流式 chunk 数、首 token 与首正文时间、finish_reason、
 *           usage（含 reasoning_tokens）、思考与正文字符数、正文预览
 * - 告警行：空正文、正文被截断、思考接近输出上限、请求失败
 *
 * 该模块刻意不依赖 electron / logger，只使用 console.*，
 * 由 logger 的 console 补丁统一落盘，保证单元测试环境也能安全加载。
 */

const PREVIEW_LIMIT = 240
const REASONING_NEAR_LIMIT_RATIO = 0.85

export interface ApiCallRequestInfo {
  /** 调用场景：chat / vision / debug / followup / voice-correction / summary / file-upload ... */
  kind: string
  provider?: string
  model?: string
  /** 用于提取 host，不会记录完整 URL（可能含密钥或查询参数） */
  baseURL?: string
  stream?: boolean
  maxTokens?: number
  temperature?: number
  messageCount?: number
  imageCount?: number
  /** 追加的键值对，会原样拼进请求行 */
  notes?: Record<string, string | number | boolean | null | undefined>
}

export interface ApiCallResponseInfo {
  content?: string | null
  reasoningContent?: string | null
  finishReason?: string | null
  usage?: unknown
  notes?: Record<string, string | number | boolean | null | undefined>
}

export interface StreamChunkInfo {
  content?: string | null
  reasoningContent?: string | null
  finishReason?: string | null
}

export interface UsageSummary {
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
  cachedTokens?: number
  totalTokens?: number
}

let callSequence = 0

/** 本次运行的累计调用统计，进程退出时汇总一行，便于判断异常比例 */
interface ApiUsageTotals {
  calls: number
  failed: number
  aborted: number
  emptyReplies: number
  truncated: number
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  usageReportedCalls: number
}

const totals: ApiUsageTotals = {
  calls: 0,
  failed: 0,
  aborted: 0,
  emptyReplies: 0,
  truncated: 0,
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  usageReportedCalls: 0
}

function nextCallId(): string {
  callSequence += 1
  return String(callSequence).padStart(4, "0")
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function pickRecord(source: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  if (!source) return undefined
  return asRecord(source[key])
}

/** 兼容 OpenAI（prompt/completion）与 Anthropic（input/output）两套 usage 字段 */
export function summarizeUsage(usage: unknown): UsageSummary | undefined {
  const record = asRecord(usage)
  if (!record) return undefined

  const completionDetails =
    pickRecord(record, "completion_tokens_details") || pickRecord(record, "output_tokens_details")
  const promptDetails = pickRecord(record, "prompt_tokens_details")

  const summary: UsageSummary = {
    promptTokens: asNumber(record.prompt_tokens) ?? asNumber(record.input_tokens),
    completionTokens: asNumber(record.completion_tokens) ?? asNumber(record.output_tokens),
    reasoningTokens: asNumber(completionDetails?.reasoning_tokens),
    cachedTokens:
      asNumber(promptDetails?.cached_tokens) ?? asNumber(record.prompt_cache_hit_tokens),
    totalTokens: asNumber(record.total_tokens)
  }

  const hasAny = Object.values(summary).some((value) => value !== undefined)
  return hasAny ? summary : undefined
}

export function formatUsage(usage: UsageSummary | undefined): string | undefined {
  if (!usage) return undefined
  const parts: string[] = []
  if (usage.promptTokens !== undefined) parts.push(`prompt=${usage.promptTokens}`)
  if (usage.completionTokens !== undefined) parts.push(`completion=${usage.completionTokens}`)
  if (usage.reasoningTokens !== undefined) parts.push(`reasoning=${usage.reasoningTokens}`)
  if (usage.cachedTokens !== undefined) parts.push(`cached=${usage.cachedTokens}`)
  if (usage.totalTokens !== undefined) parts.push(`total=${usage.totalTokens}`)
  return parts.length ? `{${parts.join(",")}}` : undefined
}

function describeHost(baseURL?: string): string | undefined {
  const value = String(baseURL || "").trim()
  if (!value) return undefined
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatFields(fields: Record<string, string | number | boolean | null | undefined>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue
    parts.push(`${key}=${value}`)
  }
  return parts.join(" ")
}

function truncatePreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= PREVIEW_LIMIT) return normalized
  return `${normalized.slice(0, PREVIEW_LIMIT)}…(+${normalized.length - PREVIEW_LIMIT})`
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name || "Error"}: ${error.message || ""}`.trim()
  }
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "APIUserAbortError")
}

/**
 * 单次模型调用的记录器。
 * - 流式调用请在循环里调用 noteStreamChunk()
 * - 结束时调用 finish() 或 fail()
 */
export class ApiCallTracker {
  public readonly id: string
  public readonly request: ApiCallRequestInfo

  private readonly startedAt = Date.now()
  private firstTokenAt: number | null = null
  private firstContentAt: number | null = null
  private chunks = 0
  private streamedContentChars = 0
  private streamedReasoningChars = 0
  private streamedFinishReason: string | null = null
  private streamedUsage: unknown
  private settled = false

  constructor(request: ApiCallRequestInfo) {
    this.request = request
    this.id = nextCallId()
    try {
      console.info(`[api] -> #${this.id} 请求 ${this.describeRequest()}`)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  private describeRequest(): string {
    return formatFields({
      kind: this.request.kind,
      provider: this.request.provider,
      model: this.request.model,
      stream: this.request.stream,
      max_tokens: this.request.maxTokens,
      temperature: this.request.temperature,
      messages: this.request.messageCount,
      images: this.request.imageCount,
      host: describeHost(this.request.baseURL),
      ...(this.request.notes || {})
    })
  }

  /** 记录一个流式增量；正文与思考内容都可用于统计 */
  public noteStreamChunk(chunk: StreamChunkInfo | undefined): void {
    if (this.settled) return
    try {
      const content = chunk?.content || ""
      const reasoning = chunk?.reasoningContent || ""
      this.chunks += 1
      const now = Date.now()
      if (content || reasoning) {
        if (this.firstTokenAt === null) this.firstTokenAt = now
      }
      if (content) {
        if (this.firstContentAt === null) this.firstContentAt = now
        this.streamedContentChars += content.length
      }
      if (reasoning) this.streamedReasoningChars += reasoning.length
      if (chunk?.finishReason) this.streamedFinishReason = chunk.finishReason
    } catch {
      /* 统计失败不影响主流程 */
    }
  }

  /** 记录流式响应末尾携带的 usage（OpenAI 的 include_usage / Anthropic 的 message_delta） */
  public noteUsage(usage: unknown): void {
    if (this.settled || !usage) return
    try {
      this.streamedUsage = usage
    } catch {
      /* 统计失败不影响主流程 */
    }
  }

  public finish(response: ApiCallResponseInfo = {}): void {
    if (this.settled) return
    this.settled = true
    try {
      const durationMs = Date.now() - this.startedAt
      const content = response.content || ""
      const reasoning = response.reasoningContent || ""
      const contentChars = content.length || this.streamedContentChars
      // 只有空白字符（换行、空格）同样视为空正文：调用方普遍按 trim() 判断
      const contentIsBlank =
        content.length > 0 ? content.trim().length === 0 : this.streamedContentChars === 0
      const reasoningChars = reasoning.length || this.streamedReasoningChars
      const finishReason = response.finishReason || this.streamedFinishReason || undefined
      const usage = summarizeUsage(response.usage ?? this.streamedUsage)

      const line = formatFields({
        kind: this.request.kind,
        model: this.request.model,
        dur: formatDuration(durationMs),
        stream: this.request.stream ? "true" : undefined,
        chunks: this.request.stream ? this.chunks : undefined,
        ttft: this.firstTokenAt !== null ? formatDuration(this.firstTokenAt - this.startedAt) : undefined,
        first_content:
          this.firstContentAt !== null ? formatDuration(this.firstContentAt - this.startedAt) : undefined,
        finish: finishReason,
        usage: formatUsage(usage),
        reasoning_chars: reasoningChars,
        content_chars: contentChars,
        ...(response.notes || {})
      })

      totals.calls += 1
      if (usage) {
        totals.usageReportedCalls += 1
        totals.promptTokens += usage.promptTokens || 0
        totals.completionTokens += usage.completionTokens || 0
        totals.reasoningTokens += usage.reasoningTokens || 0
      }
      if (contentIsBlank) totals.emptyReplies += 1
      if (finishReason === "length") totals.truncated += 1

      const preview = content ? ` preview="${truncatePreview(content)}"` : ""
      console.info(`[api] <- #${this.id} 响应 ${line}${preview}`)
      this.reportAnomalies({
        contentChars,
        contentIsBlank,
        reasoningChars,
        finishReason,
        usage,
        durationMs
      })
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  public fail(error: unknown): void {
    if (this.settled) return
    this.settled = true
    try {
      const durationMs = Date.now() - this.startedAt
      const line = formatFields({
        kind: this.request.kind,
        model: this.request.model,
        dur: formatDuration(durationMs),
        chunks: this.request.stream ? this.chunks : undefined,
        received_content_chars: this.streamedContentChars,
        received_reasoning_chars: this.streamedReasoningChars,
        error: describeError(error)
      })
      totals.calls += 1
      if (isAbort(error)) {
        totals.aborted += 1
        console.warn(`[api] !! #${this.id} 已取消 ${line}`)
      } else {
        totals.failed += 1
        console.error(`[api] !! #${this.id} 失败 ${line}`)
      }
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  private reportAnomalies(input: {
    contentChars: number
    contentIsBlank: boolean
    reasoningChars: number
    finishReason?: string
    usage?: UsageSummary
    durationMs: number
  }): void {
    const { contentChars, contentIsBlank, reasoningChars, finishReason, usage, durationMs } = input
    const maxTokens = this.request.maxTokens
    const reasoningTokens = usage?.reasoningTokens
    const duration = formatDuration(durationMs)

    if (contentIsBlank) {
      if (finishReason === "length") {
        const used = reasoningTokens ?? usage?.completionTokens
        const ratio =
          used !== undefined && maxTokens ? ` (${Math.round((used / maxTokens) * 100)}%)` : ""
        console.warn(
          `[api] !! #${this.id} 空正文：finish_reason=length，思考占用 ${used ?? "?"}/${maxTokens ?? "?"} 输出 token${ratio}，` +
            `耗时 ${duration}。这是推理长度吃光输出预算导致正文被截断，请提高 maxOutputTokens 或改用非推理模型。`
        )
      } else {
        console.warn(
          `[api] !! #${this.id} 空正文：finish_reason=${finishReason || "unknown"}，reasoning_chars=${reasoningChars}，` +
            `耗时 ${duration}，请检查模型能力、提示词或服务端返回。`
        )
      }
      return
    }

    if (finishReason === "length") {
      console.warn(
        `[api] !! #${this.id} 正文被截断：finish_reason=length，已收到正文 ${contentChars} 字符，` +
          `思考 token=${reasoningTokens ?? "?"}/${maxTokens ?? "?"}，耗时 ${duration}。`
      )
      return
    }

    if (reasoningTokens !== undefined && maxTokens && reasoningTokens / maxTokens >= REASONING_NEAR_LIMIT_RATIO) {
      console.warn(
        `[api] !! #${this.id} 思考接近输出上限：reasoning=${reasoningTokens}/${maxTokens} ` +
          `(${Math.round((reasoningTokens / maxTokens) * 100)}%)，正文可能被截断，耗时 ${duration}。`
      )
    }
  }
}

/** 当前运行的累计调用统计快照 */
export function getApiUsageTotals(): Readonly<ApiUsageTotals> {
  return { ...totals }
}

/** 生成一行可写入日志的累计统计文案（无调用时返回空串） */
export function describeApiUsageTotals(): string {
  if (!totals.calls) return ""
  const ok = totals.calls - totals.failed - totals.aborted
  const reasoningRatio =
    totals.completionTokens > 0
      ? ` reasoning_ratio=${Math.round((totals.reasoningTokens / totals.completionTokens) * 100)}%`
      : ""
  return formatFields({
    calls: totals.calls,
    ok,
    failed: totals.failed,
    aborted: totals.aborted,
    empty_replies: totals.emptyReplies,
    truncated: totals.truncated,
    usage_calls: totals.usageReportedCalls,
    prompt_tokens: totals.promptTokens,
    completion_tokens: totals.completionTokens,
    reasoning_tokens: totals.reasoningTokens
  }) + reasoningRatio
}

/** 开始一次模型调用记录（会立即写入请求行） */
export function beginApiCall(request: ApiCallRequestInfo): ApiCallTracker {
  return new ApiCallTracker(request)
}

/**
 * 包装一次模型调用：
 * - 成功时用 describe() 提取服务端返回的关键字段并落盘
 * - 失败时记录错误名、错误信息与已收到的部分统计
 */
export async function withApiCall<T>(
  request: ApiCallRequestInfo,
  run: (tracker: ApiCallTracker) => Promise<T>,
  describe?: (result: T, tracker: ApiCallTracker) => ApiCallResponseInfo
): Promise<T> {
  const tracker = beginApiCall(request)
  try {
    const result = await run(tracker)
    tracker.finish(describe ? describe(result, tracker) : {})
    return result
  } catch (error) {
    tracker.fail(error)
    throw error
  }
}
