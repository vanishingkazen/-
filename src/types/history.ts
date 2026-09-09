import type { ProblemStatementData } from "./solutions"

export interface SavedSolutionData {
  display_text?: string
  basic_code?: string
  code: string
  thoughts: string[]
  time_complexity: string
  space_complexity: string
}

export interface HistoryRecord {
  id: string
  createdAt: string
  updatedAt: string
  title: string
  language: string
  problem: ProblemStatementData
  solution: SavedSolutionData
  debug?: unknown
  screenshotPaths: string[]
}
