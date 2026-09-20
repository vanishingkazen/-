// ProcessingHelper.ts
import fs from "node:fs"
import { ScreenshotHelper } from "./ScreenshotHelper"
import type { IProcessingHelperDeps } from "./contracts"
import { BrowserWindow } from "electron"
import { OpenAI } from "openai"
import { configHelper } from "./ConfigHelper"
import type { VoiceConversationTranscript } from "./VoiceRecognitionHelper"
import Anthropic from '@anthropic-ai/sdk';
import { ProcessingAIClientManager } from "./ProcessingAIClientManager"
import { ProcessingVisionService, type VisionScreenshot } from "./ProcessingVisionService"
import { ProcessingDebugService } from "./ProcessingDebugService"
import { ProcessingVoiceCorrectionService } from "./ProcessingVoiceCorrectionService"
import { ProcessingFollowupService } from "./ProcessingFollowupService"

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function errorMessageFrom(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}


export class ProcessingHelper {
  private deps: IProcessingHelperDeps
  private screenshotHelper: ScreenshotHelper
  private readonly aiClients: ProcessingAIClientManager
  private readonly visionService: ProcessingVisionService
  private readonly debugService: ProcessingDebugService
  private readonly voiceCorrectionService: ProcessingVoiceCorrectionService
  private readonly followupService: ProcessingFollowupService

  private get openaiClient(): OpenAI | null {
    return this.aiClients.openaiClient
  }

  private get anthropicClient(): Anthropic | null {
    return this.aiClients.anthropicClient
  }
  private currentBasicCode = ""
  private currentSolutionCode = ""
  // AbortControllers for API requests
  private currentProcessingAbortController: AbortController | null = null
  private currentExtraProcessingAbortController: AbortController | null = null

  constructor(deps: IProcessingHelperDeps) {
    this.deps = deps
    const screenshotHelper = deps.getScreenshotHelper()
    if (!screenshotHelper) throw new Error("Screenshot helper is not initialized")
    this.screenshotHelper = screenshotHelper
    this.aiClients = new ProcessingAIClientManager()
    this.visionService = new ProcessingVisionService(this.aiClients, {
      getMainWindow: () => this.deps.getMainWindow(),
      getMaxOutputTokens: (config) => this.getMaxOutputTokens(config)
    })
    this.debugService = new ProcessingDebugService(this.aiClients, {
      getProblemInfo: () => this.deps.getProblemInfo(),
      getMainWindow: () => this.deps.getMainWindow(),
      getLanguage: () => this.getLanguage(),
      getCurrentBasicCode: () => this.currentBasicCode,
      getMaxOutputTokens: (config) => this.getMaxOutputTokens(config)
    })
    this.voiceCorrectionService = new ProcessingVoiceCorrectionService(this.aiClients)
    this.followupService = new ProcessingFollowupService(this.aiClients, {
      getMainWindow: () => this.deps.getMainWindow(),
      getLanguage: () => this.getLanguage(),
      getProblemInfo: () => this.deps.getProblemInfo(),
      getCurrentSolutionCode: () => this.currentSolutionCode,
      getCurrentBasicCode: () => this.currentBasicCode,
      getMaxOutputTokens: (config) => this.getMaxOutputTokens(config),
      setActiveController: (controller) => {
        this.currentExtraProcessingAbortController = controller
      },
      clearActiveController: (controller) => {
        if (this.currentExtraProcessingAbortController === controller) {
          this.currentExtraProcessingAbortController = null
        }
      }
    })
  }

  public dispose(): void {
    this.cancelActiveRequest()
    this.followupService.resetHistory()
    this.aiClients.dispose()
  }

  public setCurrentBasicCode(code?: unknown): void {
    this.currentBasicCode = typeof code === "string" ? code : ""
  }

  public setCurrentSolutionCode(code?: unknown): void {
    this.currentSolutionCode = typeof code === "string" ? code : ""
  }
  
  /**
   * Initialize or reinitialize the AI client with current config.
   * Kept as a small compatibility seam for request-time validation.
   */
  private initializeAIClient(): void {
    this.aiClients.initialize()
  }

  private async waitForInitialization(
    mainWindow: BrowserWindow
  ): Promise<void> {
    let attempts = 0
    const maxAttempts = 50 // 5 seconds total

    while (attempts < maxAttempts) {
      const isInitialized = await mainWindow.webContents.executeJavaScript(
        "window.__IS_INITIALIZED__"
      )
      if (isInitialized) return
      await new Promise((resolve) => setTimeout(resolve, 100))
      attempts++
    }
    throw new Error("App failed to initialize after 5 seconds")
  }

  private async getCredits(): Promise<number> {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow) return 999 // Unlimited credits in this version

    try {
      await this.waitForInitialization(mainWindow)
      return 999 // Always return sufficient credits to work
    } catch (error) {
      console.error("Error getting credits:", error)
      return 999 // Unlimited credits as fallback
    }
  }

  private async getLanguage(): Promise<string> {
    try {
      // Get language from config
      const config = configHelper.loadConfig();
      if (config.language) {
        return config.language;
      }
      
      // Fallback to window variable if config doesn't have language
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        try {
          await this.waitForInitialization(mainWindow)
          const language = await mainWindow.webContents.executeJavaScript(
            "window.__LANGUAGE__"
          )

          if (
            typeof language === "string" &&
            language !== undefined &&
            language !== null
          ) {
            return language;
          }
        } catch (err) {
          console.warn("Could not get language from window", err);
        }
      }
      
      // Default fallback
      return "auto";
    } catch (error) {
      console.error("Error getting language:", error)
      return "auto"
    }
  }

  private getMaxOutputTokens(config: ReturnType<typeof configHelper.loadConfig>): number {
    const requested = Math.min(
      65536,
      Math.max(1024, Math.floor(Number(config.maxOutputTokens) || 32768))
    )

    return requested
  }

  public async processScreenshots(userRequest = ""): Promise<void> {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow) return

    const config = configHelper.loadConfig();
    
    // First verify we have a valid AI client
    if (config.apiProvider === "openai-compatible" && !this.openaiClient) {
      this.initializeAIClient();
      
      if (!this.openaiClient) {
        console.error("OpenAI-compatible client not initialized");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        );
        return;
      }
    } else if (config.apiProvider === "anthropic" && !this.anthropicClient) {
      // Add check for Anthropic client
      this.initializeAIClient();
      
      if (!this.anthropicClient) {
        console.error("Anthropic client not initialized");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        );
        return;
      }
    }

    const view = this.deps.getView()
    console.log("Processing screenshots in view:", view)

    if (view === "queue") {
      const screenshotQueue = this.screenshotHelper.getScreenshotQueue()
      console.log("Processing main queue screenshots:", screenshotQueue)
      
      // Check if the queue is empty
      if (!screenshotQueue || screenshotQueue.length === 0) {
        console.log("No screenshots found in queue");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        return;
      }

      // Check that files actually exist
      const existingScreenshots = screenshotQueue.filter(path => fs.existsSync(path));
      if (existingScreenshots.length === 0) {
        console.log("Screenshot files don't exist on disk");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        return;
      }

      // Only create the UI task after a real screenshot has been found.
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.INITIAL_START, {
        questionMode: config.questionMode
      })

      try {
        // Initialize AbortController
        this.currentProcessingAbortController = new AbortController()
        const { signal } = this.currentProcessingAbortController

        const screenshots = await Promise.all(
          existingScreenshots.map(async (path) => {
            try {
              return {
                path,
                preview: await this.screenshotHelper.getImagePreview(path),
                data: fs.readFileSync(path).toString('base64')
              };
            } catch (err) {
              console.error(`Error reading screenshot ${path}:`, err);
              return null;
            }
          })
        )

        // Filter out any nulls from failed screenshots
        const validScreenshots = screenshots.filter(
          (screenshot): screenshot is { path: string; preview: string; data: string } =>
            screenshot !== null
        );
        
        if (validScreenshots.length === 0) {
          throw new Error("Failed to load screenshot data");
        }

        const result = await this.solveScreenshotsDirectly(
          validScreenshots,
          signal,
          userRequest
        )

        if (!result.success || !result.data) {
          throw new Error(result.error || "视觉模型解题失败")
        }

        const answer = result.data
        const detectedLanguage = result.language || "auto"
        configHelper.updateConfig({ language: detectedLanguage })
        if (result.language) {
          mainWindow.webContents.send("language-detected", { language: result.language })
        } else {
          mainWindow.webContents.send("language-detected", { language: "auto" })
        }
        const title = answer
          .split(/\r?\n/)
          .map((line) => line.replace(/^#+\s*/, "").trim())
          .find(Boolean)
          ?.slice(0, 100) || "截图视觉解题"
        const problemInfo = {
          problem_statement: title,
          constraints: "视觉模型直接分析截图并解答"
        }
        const solution = {
          display_text: answer,
          basic_code: "",
          code: "",
          thoughts: [],
          time_complexity: "由模型在解答中说明",
          space_complexity: "由模型在解答中说明"
        }

        this.deps.setProblemInfo(problemInfo)
        mainWindow.webContents.send("processing-status", {
          message: "视觉模型解题完成",
          progress: 100
        })
        mainWindow.webContents.send("solution-stream", {
          content: answer,
          isThinking: false,
          done: true
        })
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
          solution
        )

        // Every screenshot batch is independent, so the next capture starts
        // from a clean queue regardless of whether it is code or a quiz.
        this.screenshotHelper.clearQueues()
        this.deps.setView("queue")
        return
      } catch (error: unknown) {
        console.error("Processing error:", error)
        if (isAbortError(error)) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
            "Processing was canceled by the user."
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
            errorMessageFrom(error, "Server error. Please try again.")
          )
        }
        // Reset view back to queue on error
        console.log("Resetting view to queue due to error")
        this.deps.setView("queue")
      } finally {
        this.currentProcessingAbortController = null
      }
    } else {
      // view == 'solutions'
      const extraScreenshotQueue =
        this.screenshotHelper.getExtraScreenshotQueue()
      console.log("Processing extra queue screenshots:", extraScreenshotQueue)
      
      // Check if the extra queue is empty
      if (!extraScreenshotQueue || extraScreenshotQueue.length === 0) {
        console.log("No extra screenshots found in queue");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        
        return;
      }

      // Check that files actually exist
      const existingExtraScreenshots = extraScreenshotQueue.filter(path => fs.existsSync(path));
      if (existingExtraScreenshots.length === 0) {
        console.log("Extra screenshot files don't exist on disk");
        mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS);
        return;
      }
      
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.DEBUG_START)

      // Initialize AbortController
      this.currentExtraProcessingAbortController = new AbortController()
      const { signal } = this.currentExtraProcessingAbortController

      try {
        // Get all screenshots (both main and extra) for processing
        const allPaths = [
          ...this.screenshotHelper.getScreenshotQueue(),
          ...existingExtraScreenshots
        ];
        
        const screenshots = await Promise.all(
          allPaths.map(async (path) => {
            try {
              if (!fs.existsSync(path)) {
                console.warn(`Screenshot file does not exist: ${path}`);
                return null;
              }
              
              return {
                path,
                preview: await this.screenshotHelper.getImagePreview(path),
                data: fs.readFileSync(path).toString('base64')
              };
            } catch (err) {
              console.error(`Error reading screenshot ${path}:`, err);
              return null;
            }
          })
        )
        
        // Filter out any nulls from failed screenshots
        const validScreenshots = screenshots.filter(
          (s): s is { path: string; preview: string; data: string } => s !== null
        );
        
        if (validScreenshots.length === 0) {
          throw new Error("Failed to load screenshot data for debugging");
        }
        
        console.log(
          "Combined screenshots for processing:",
          validScreenshots.map((s) => s.path)
        )

        const result = await this.processExtraScreenshotsHelper(
          validScreenshots,
          signal,
          userRequest
        )

        if (result.success) {
          this.deps.setHasDebugged(true)
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_SUCCESS,
            result.data
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            result.error
          )
        }
      } catch (error: unknown) {
        if (isAbortError(error)) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            "Extra processing was canceled by the user."
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            errorMessageFrom(error, "Extra processing failed.")
          )
        }
      } finally {
        this.currentExtraProcessingAbortController = null
      }
    }
  }

  private async solveScreenshotsDirectly(
    screenshots: VisionScreenshot[],
    signal: AbortSignal,
    userRequest = ""
  ) {
    return this.visionService.solve(screenshots, signal, userRequest)
  }

  private async processExtraScreenshotsHelper(
    screenshots: Array<{ path: string; data: string }>,
    signal: AbortSignal,
    userRequest = ""
  ) {
    return this.debugService.process(screenshots, signal, userRequest)
  }

  public async correctVoiceConversation(
    conversation: VoiceConversationTranscript
  ): Promise<VoiceConversationTranscript & { corrected: boolean }> {
    return this.voiceCorrectionService.correct(conversation)
  }

  public async processChatMessage(
    requestId: string,
    message: string
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    return this.followupService.process(requestId, message)
  }

  public cancelOngoingRequests(): void {
    let wasCancelled = false

    if (this.currentProcessingAbortController) {
      this.currentProcessingAbortController.abort()
      this.currentProcessingAbortController = null
      wasCancelled = true
    }

    if (this.currentExtraProcessingAbortController) {
      this.currentExtraProcessingAbortController.abort()
      this.currentExtraProcessingAbortController = null
      wasCancelled = true
    }

    this.deps.setHasDebugged(false)

    this.deps.setProblemInfo(null)
    this.currentSolutionCode = ""
    this.followupService.resetHistory()

    const mainWindow = this.deps.getMainWindow()
    if (wasCancelled && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(this.deps.PROCESSING_EVENTS.NO_SCREENSHOTS)
    }
  }

  public cancelActiveRequest(): void {
    if (this.currentProcessingAbortController) {
      this.currentProcessingAbortController.abort()
      this.currentProcessingAbortController = null
    }
    if (this.currentExtraProcessingAbortController) {
      this.currentExtraProcessingAbortController.abort()
      this.currentExtraProcessingAbortController = null
    }
  }
}
