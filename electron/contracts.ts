import type { BrowserWindow } from "electron"
import type { ChatService } from "./ChatService"
import type { ProcessingHelper } from "./ProcessingHelper"
import type { ScreenshotHelper } from "./ScreenshotHelper"
import type { VoiceRecognitionHelper } from "./VoiceRecognitionHelper"
import type { CompanionServer } from "./CompanionServer"

export type AppView = "queue" | "solutions" | "debug"

export interface ProblemInfo {
  problem_statement: string
  constraints?: string
}

export const PROCESSING_EVENTS = {
  UNAUTHORIZED: "processing-unauthorized",
  NO_SCREENSHOTS: "processing-no-screenshots",
  OUT_OF_CREDITS: "out-of-credits",
  API_KEY_INVALID: "api-key-invalid",
  INITIAL_START: "initial-start",
  PROBLEM_EXTRACTED: "problem-extracted",
  SOLUTION_SUCCESS: "solution-success",
  INITIAL_SOLUTION_ERROR: "solution-error",
  DEBUG_START: "debug-start",
  DEBUG_SUCCESS: "debug-success",
  DEBUG_ERROR: "debug-error"
} as const

export type ProcessingEvents = typeof PROCESSING_EVENTS

export interface ScreenshotOperationResult {
  success: boolean
  error?: string
}

export interface IProcessingHelperDeps {
  getScreenshotHelper: () => ScreenshotHelper | null
  getMainWindow: () => BrowserWindow | null
  getView: () => AppView
  setView: (view: AppView) => void
  getProblemInfo: () => ProblemInfo | null
  setProblemInfo: (info: ProblemInfo | null) => void
  getScreenshotQueue: () => string[]
  getExtraScreenshotQueue: () => string[]
  clearQueues: () => void
  takeScreenshot: () => Promise<string>
  getImagePreview: (filepath: string) => Promise<string>
  deleteScreenshot: (path: string) => Promise<ScreenshotOperationResult>
  setHasDebugged: (value: boolean) => void
  getHasDebugged: () => boolean
  PROCESSING_EVENTS: ProcessingEvents
}

export interface IShortcutsHelperDeps {
  getMainWindow: () => BrowserWindow | null
  takeScreenshot: () => Promise<string>
  getImagePreview: (filepath: string) => Promise<string>
  processingHelper: ProcessingHelper | null
  chatService: ChatService | null
  voiceRecognitionHelper: VoiceRecognitionHelper | null
  getScreenshotQueue: () => string[]
  getExtraScreenshotQueue: () => string[]
  getView: () => AppView
  clearQueues: () => void
  setView: (view: AppView) => void
  isVisible: () => boolean
  toggleMainWindow: () => void
  moveWindowLeft: () => void
  moveWindowRight: () => void
  moveWindowUp: () => void
  moveWindowDown: () => void
  resetWindowPosition: () => void
}

export interface IIpcHandlerDeps {
  getMainWindow: () => BrowserWindow | null
  setWindowDimensions: (width: number, height: number) => void
  getScreenshotQueue: () => string[]
  getExtraScreenshotQueue: () => string[]
  deleteScreenshot: (path: string) => Promise<ScreenshotOperationResult>
  getImagePreview: (filepath: string) => Promise<string>
  processingHelper: ProcessingHelper | null
  chatService: ChatService | null
  voiceRecognitionHelper: VoiceRecognitionHelper | null
  PROCESSING_EVENTS: ProcessingEvents
  takeScreenshot: () => Promise<string>
  getView: () => AppView
  toggleMainWindow: () => void
  clearQueues: () => void
  setView: (view: AppView) => void
  setProblemInfo: (info: ProblemInfo | null) => void
  moveWindowLeft: () => void
  moveWindowRight: () => void
  moveWindowUp: () => void
  moveWindowDown: () => void
  companionServer: CompanionServer | null
}
