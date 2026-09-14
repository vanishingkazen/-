import { uIOhook, type UiohookMouseEvent } from "uiohook-napi"

const REQUIRED_REVERSALS = 4
const REVERSAL_WINDOW_MS = 1200
const MAX_EVENT_GAP_MS = 180
const MIN_EVENT_DELTA = 1.5
const MIN_DIRECTION_DISTANCE = 24
const MIN_DIRECTION_SPEED = 0.45
const MIN_REVERSAL_INTERVAL_MS = 45
const TRIGGER_COOLDOWN_MS = 1800
const HORIZONTAL_RATIO = 1.35

type HorizontalDirection = -1 | 0 | 1

interface MouseShakeDetectorOptions {
  onTrigger: () => void
}

/**
 * Detects the rapid left/right pointer shake used by macOS pointer enlargement.
 * A reversal only counts after a fast-enough horizontal segment, which filters
 * ordinary mouse movement and small cursor jitter.
 */
export class MouseShakeDetector {
  private readonly onTrigger: () => void
  private lastX: number | null = null
  private lastY: number | null = null
  private lastEventAt = 0
  private direction: HorizontalDirection = 0
  private directionDistance = 0
  private directionStartedAt = 0
  private reversals: number[] = []
  private cooldownUntil = 0
  private running = false

  constructor({ onTrigger }: MouseShakeDetectorOptions) {
    this.onTrigger = onTrigger
  }

  public start(): void {
    if (this.running) return

    uIOhook.on("mousemove", this.handleMouseMove)
    this.running = true

    try {
      uIOhook.start()
      console.log("Mouse shake detector started: 4 rapid horizontal reversals toggle visibility")
    } catch (error) {
      this.running = false
      uIOhook.off("mousemove", this.handleMouseMove)
      console.error("Failed to start mouse shake detector:", error)
    }
  }

  public stop(): void {
    if (!this.running) return

    uIOhook.off("mousemove", this.handleMouseMove)
    uIOhook.stop()
    this.running = false
    this.resetTracking()
  }

  private readonly handleMouseMove = (event: UiohookMouseEvent): void => {
    const now = Date.now()

    if (this.lastX === null || this.lastY === null) {
      this.rememberPoint(event.x, event.y, now)
      return
    }

    const deltaX = event.x - this.lastX
    const deltaY = event.y - this.lastY
    const elapsed = Math.max(1, now - this.lastEventAt)
    this.rememberPoint(event.x, event.y, now)

    if (now < this.cooldownUntil) return

    if (elapsed > MAX_EVENT_GAP_MS) {
      this.resetTracking()
      return
    }

    const horizontalDistance = Math.abs(deltaX)
    const verticalDistance = Math.abs(deltaY)

    if (horizontalDistance < MIN_EVENT_DELTA) return

    if (horizontalDistance < verticalDistance * HORIZONTAL_RATIO) {
      this.resetTracking()
      return
    }

    const nextDirection: HorizontalDirection = deltaX > 0 ? 1 : -1

    if (this.direction === 0 || nextDirection === this.direction) {
      if (this.direction === 0) {
        this.direction = nextDirection
        this.directionStartedAt = now
        this.directionDistance = horizontalDistance
      } else {
        this.directionDistance += horizontalDistance
      }
      return
    }

    const previousDuration = Math.max(1, now - this.directionStartedAt)
    const previousSpeed = this.directionDistance / previousDuration
    const lastReversalAt = this.reversals[this.reversals.length - 1]
    const previousSegmentQualified =
      this.directionDistance >= MIN_DIRECTION_DISTANCE &&
      previousSpeed >= MIN_DIRECTION_SPEED
    const reversalIsSpaced =
      lastReversalAt === undefined ||
      now - lastReversalAt >= MIN_REVERSAL_INTERVAL_MS

    if (previousSegmentQualified && reversalIsSpaced) {
      this.reversals.push(now)
      this.reversals = this.reversals.filter(
        (timestamp) => now - timestamp <= REVERSAL_WINDOW_MS
      )

      if (this.reversals.length >= REQUIRED_REVERSALS) {
        this.cooldownUntil = now + TRIGGER_COOLDOWN_MS
        this.resetTracking()
        this.onTrigger()
        return
      }
    }

    this.direction = nextDirection
    this.directionDistance = horizontalDistance
    this.directionStartedAt = now
  }

  private rememberPoint(x: number, y: number, timestamp: number): void {
    this.lastX = x
    this.lastY = y
    this.lastEventAt = timestamp
  }

  private resetTracking(): void {
    this.direction = 0
    this.directionDistance = 0
    this.directionStartedAt = 0
    this.reversals = []
  }
}
