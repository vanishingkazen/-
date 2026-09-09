// ProcessingHelper.ts
import fs from "node:fs"
import path from "node:path"
import { ScreenshotHelper } from "./ScreenshotHelper"
import { IProcessingHelperDeps } from "./main"
import * as axios from "axios"
import { app, BrowserWindow, dialog } from "electron"
import { OpenAI } from "openai"
import { configHelper } from "./ConfigHelper"
import { historyHelper } from "./HistoryHelper"
import { loadInterviewAsrEnhancement, loadInterviewContextPrompt } from "./InterviewContextHelper"
import type { VoiceConversationTranscript } from "./VoiceRecognitionHelper"
import Anthropic from '@anthropic-ai/sdk';

// Interface for Gemini API requests
interface GeminiMessage {
  role: string;
  parts: Array<{
    text?: string;
    inlineData?: {
      mimeType: string;
      data: string;
    }
  }>;
}

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text: string;
      }>;
    };
    finishReason: string;
  }>;
}
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Array<{
    type: 'text' | 'image';
    text?: string;
    source?: {
      type: 'base64';
      media_type: string;
      data: string;
    };
  }>;
}

type DeepSeekStreamingRequest =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
    thinking?: { type: "enabled" | "disabled" }
    reasoning_effort?: "low" | "medium" | "high" | "max"
  }

type QwenCorrectionRequest =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
    chat_template_kwargs?: { enable_thinking: boolean }
  }

const isOfficialDeepSeekEndpoint = (baseURL: string): boolean => {
  try {
    return new URL(baseURL).hostname.toLowerCase() === "api.deepseek.com"
  } catch {
    return false
  }
}

export class ProcessingHelper {
  private deps: IProcessingHelperDeps
  private screenshotHelper: ScreenshotHelper
  private openaiClient: OpenAI | null = null
  private solutionOpenAIClient: OpenAI | null = null
  private geminiApiKey: string | null = null
  private anthropicClient: Anthropic | null = null
  private currentBasicCode = ""
  private currentSolutionCode = ""
  private chatHistories: Record<
    "interview" | "problem",
    Array<{ role: "user" | "assistant"; content: string }>
  > = { interview: [], problem: [] }

  // AbortControllers for API requests
  private currentProcessingAbortController: AbortController | null = null
  private currentExtraProcessingAbortController: AbortController | null = null

  constructor(deps: IProcessingHelperDeps) {
    this.deps = deps
    this.screenshotHelper = deps.getScreenshotHelper()
    
    // Initialize AI client based on config
    this.initializeAIClient();
    
    // Listen for config changes to re-initialize the AI client
    configHelper.on('config-updated', () => {
      this.initializeAIClient();
    });
  }

  public setCurrentBasicCode(code?: unknown): void {
    this.currentBasicCode = typeof code === "string" ? code : ""
  }

  public setCurrentSolutionCode(code?: unknown): void {
    this.currentSolutionCode = typeof code === "string" ? code : ""
  }
  
  /**
   * Initialize or reinitialize the AI client with current config
   */
  private initializeAIClient(): void {
    try {
      const config = configHelper.loadConfig();
      
      if (config.apiProvider === "openai" || config.apiProvider === "openai-compatible") {
        if (config.apiKey) {
          this.openaiClient = new OpenAI({ 
            apiKey: config.apiKey,
            ...(config.apiProvider === "openai-compatible" && config.baseURL
              ? { baseURL: config.baseURL.replace(/\/$/, "") }
              : {}),
            timeout: 180000,
            maxRetries: 0
          });
          this.geminiApiKey = null;
          this.anthropicClient = null;
          console.log("OpenAI client initialized successfully");
        } else {
          this.openaiClient = null;
          this.geminiApiKey = null;
          this.anthropicClient = null;
          console.warn("No API key available, OpenAI client not initialized");
        }
      } else if (config.apiProvider === "gemini"){
        // Gemini client initialization
        this.openaiClient = null;
        this.anthropicClient = null;
        if (config.apiKey) {
          this.geminiApiKey = config.apiKey;
          console.log("Gemini API key set successfully");
        } else {
          this.openaiClient = null;
          this.geminiApiKey = null;
          this.anthropicClient = null;
          console.warn("No API key available, Gemini client not initialized");
        }
      } else if (config.apiProvider === "anthropic") {
        // Reset other clients
        this.openaiClient = null;
        this.geminiApiKey = null;
        if (config.apiKey) {
          this.anthropicClient = new Anthropic({
            apiKey: config.apiKey,
            timeout: 180000,
            maxRetries: 0
          });
          console.log("Anthropic client initialized successfully");
        } else {
          this.openaiClient = null;
          this.geminiApiKey = null;
          this.anthropicClient = null;
          console.warn("No API key available, Anthropic client not initialized");
        }
      }

      if (config.solutionApiKey && config.solutionBaseURL) {
        this.solutionOpenAIClient = new OpenAI({
          apiKey: config.solutionApiKey,
          baseURL: config.solutionBaseURL.replace(/\/$/, ""),
          timeout: 180000,
          maxRetries: 0
        });
        console.log("Separate solution client initialized successfully");
      } else {
        this.solutionOpenAIClient = null;
      }
    } catch (error) {
      console.error("Failed to initialize AI client:", error);
      this.openaiClient = null;
      this.solutionOpenAIClient = null;
      this.geminiApiKey = null;
      this.anthropicClient = null;
    }
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
      return "python";
    } catch (error) {
      console.error("Error getting language:", error)
      return "python"
    }
  }

  public async processScreenshots(userRequest = ""): Promise<void> {
    const mainWindow = this.deps.getMainWindow()
    if (!mainWindow) return

    const config = configHelper.loadConfig();
    
    // First verify we have a valid AI client
    if ((config.apiProvider === "openai" || config.apiProvider === "openai-compatible") && !this.openaiClient) {
      this.initializeAIClient();
      
      if (!this.openaiClient) {
        console.error("OpenAI client not initialized");
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.API_KEY_INVALID
        );
        return;
      }
    } else if (config.apiProvider === "gemini" && !this.geminiApiKey) {
      this.initializeAIClient();
      
      if (!this.geminiApiKey) {
        console.error("Gemini API key not initialized");
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

        if (config.questionMode === "iq") {
          const iqResult = await this.solveIqScreenshots(
            validScreenshots,
            signal,
            userRequest
          )

          if (!iqResult.success || !iqResult.data) {
            throw new Error(iqResult.error || "IQ 题目解答失败")
          }

          const iqProblem = {
            problem_statement: "IQ 测评题",
            constraints: "使用视觉模型直接分析截图"
          }
          const iqSolution = {
            display_text: iqResult.data,
            basic_code: "",
            code: "",
            thoughts: [],
            time_complexity: "不适用",
            space_complexity: "不适用"
          }

          this.deps.setProblemInfo(iqProblem)
          historyHelper.saveSolution(
            iqProblem,
            iqSolution,
            "iq",
            existingScreenshots
          )

          mainWindow.webContents.send("processing-status", {
            message: "IQ 题目解答完成",
            progress: 100
          })
          mainWindow.webContents.send("solution-stream", {
            content: iqResult.data,
            isThinking: false,
            done: true
          })
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
            iqSolution
          )

          // IQ questions are independent. Return to the capture queue so the
          // next screenshot starts a fresh visual solve instead of debugging.
          this.screenshotHelper.clearQueues()
          this.deps.setView("queue")
          return
        }

        const result = await this.processScreenshotsHelper(
          validScreenshots,
          signal,
          userRequest
        )

        if (!result.success) {
          console.log("Processing failed:", result.error)
          if (result.error?.includes("API Key") || result.error?.includes("OpenAI") || result.error?.includes("Gemini")) {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.API_KEY_INVALID
            )
          } else {
            mainWindow.webContents.send(
              this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
              result.error
            )
          }
          // Reset view back to queue on error
          console.log("Resetting view to queue due to error")
          this.deps.setView("queue")
          return
        }

        historyHelper.saveSolution(
          this.deps.getProblemInfo(),
          result.data,
          configHelper.loadConfig().language,
          existingScreenshots
        )

        // Only set view to solutions if processing succeeded
        console.log("Setting view to solutions after successful processing")
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
          result.data
        )
        this.deps.setView("solutions")
      } catch (error: any) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
          error
        )
        console.error("Processing error:", error)
        if (axios.isCancel(error)) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
            "Processing was canceled by the user."
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.INITIAL_SOLUTION_ERROR,
            error.message || "Server error. Please try again."
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
        const validScreenshots = screenshots.filter(Boolean);
        
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
          historyHelper.attachDebug(this.deps.getProblemInfo(), result.data)
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
      } catch (error: any) {
        if (axios.isCancel(error)) {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            "Extra processing was canceled by the user."
          )
        } else {
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.DEBUG_ERROR,
            error.message
          )
        }
      } finally {
        this.currentExtraProcessingAbortController = null
      }
    }
  }

  private async solveIqScreenshots(
    screenshots: Array<{ path: string; data: string }>,
    signal: AbortSignal,
    userRequest = ""
  ): Promise<{ success: boolean; data?: string; error?: string }> {
    const config = configHelper.loadConfig()
    const mainWindow = this.deps.getMainWindow()
    const imageDataList = screenshots.map((screenshot) => screenshot.data)
    const prompt = `你是专业的 IQ 与认知能力测评视觉解题助手。请直接观察所提供的全部截图并完成题目，不要把它当作编程题，也不要生成代码。

要求：
1. 综合分析题干、图形、数字、文字和全部选项，适用于图形矩阵、旋转、镜像、空间折叠、数列、类比、分类及逻辑推理题。
2. 第一行必须写“答案：<选项编号或具体答案>”，让用户能立即看到结论。
3. 随后依次给出“置信度：高/中/低”、“题型：...”和“规律：...”，规律说明保持简短、清晰。
4. 如果题干或选项被遮挡、截图不完整，禁止猜测；答案写“无法确定”，并明确指出需要补拍的内容。
5. 全程使用简体中文，不要输出 JSON，不要复述无关的页面信息。
${userRequest.trim() ? `\n用户补充要求：${userRequest.trim()}` : ""}`

    mainWindow?.webContents.send("processing-status", {
      message: "正在使用视觉模型分析 IQ 题目...",
      progress: 35
    })

    try {
      let answer = ""

      if (config.apiProvider === "openai" || config.apiProvider === "openai-compatible") {
        if (!this.openaiClient) throw new Error("视觉模型客户端尚未初始化")
        const response = await this.openaiClient.chat.completions.create(
          {
            model: config.extractionModel || "gpt-4o",
            messages: [
              {
                role: "system",
                content: "你负责直接观察图片并解答 IQ 测评题，答案必须准确、简洁。"
              },
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  ...imageDataList.map((data) => ({
                    type: "image_url" as const,
                    image_url: { url: `data:image/png;base64,${data}` }
                  }))
                ]
              }
            ],
            max_tokens: config.apiProvider === "openai-compatible" ? 8192 : 2000,
            temperature: 0.1
          },
          { signal }
        )
        answer = response.choices[0]?.message?.content?.trim() || ""
      } else if (config.apiProvider === "gemini") {
        if (!this.geminiApiKey) throw new Error("Gemini API Key 尚未配置")
        const response = await axios.default.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${config.extractionModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
          {
            contents: [
              {
                role: "user",
                parts: [
                  { text: prompt },
                  ...imageDataList.map((data) => ({
                    inlineData: { mimeType: "image/png", data }
                  }))
                ]
              }
            ],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 2000
            }
          },
          { signal }
        )
        answer = response.data?.candidates?.[0]?.content?.parts
          ?.map((part: { text?: string }) => part.text || "")
          .join("")
          .trim() || ""
      } else if (config.apiProvider === "anthropic") {
        if (!this.anthropicClient) throw new Error("Anthropic API Key 尚未配置")
        const response = await this.anthropicClient.messages.create(
          {
            model: config.extractionModel || "claude-3-7-sonnet-20250219",
            max_tokens: 2000,
            temperature: 0.1,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  ...imageDataList.map((data) => ({
                    type: "image" as const,
                    source: {
                      type: "base64" as const,
                      media_type: "image/png" as const,
                      data
                    }
                  }))
                ]
              }
            ]
          },
          { signal }
        )
        answer = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim()
      }

      if (!answer) throw new Error("视觉模型没有返回解答内容")
      return { success: true, data: answer }
    } catch (error: any) {
      if (error?.name === "AbortError" || axios.isCancel(error)) {
        return { success: false, error: "IQ 题目解答已取消" }
      }
      console.error("IQ visual solving failed:", error)
      return {
        success: false,
        error: error?.message || "视觉模型解答失败，请检查截图和模型配置"
      }
    }
  }

  private async processScreenshotsHelper(
    screenshots: Array<{ path: string; data: string }>,
    signal: AbortSignal,
    userRequest = ""
  ) {
    try {
      const config = configHelper.loadConfig();
      const language = await this.getLanguage();
      const mainWindow = this.deps.getMainWindow();
      
      // Step 1: Extract problem info using AI Vision API (OpenAI or Gemini)
      const imageDataList = screenshots.map(screenshot => screenshot.data);
      
      // Update the user on progress
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Analyzing problem from screenshots...",
          progress: 20
        });
      }

      let problemInfo;
      
      if (config.apiProvider === "openai" || config.apiProvider === "openai-compatible") {
        // Verify OpenAI client
        if (!this.openaiClient) {
          this.initializeAIClient(); // Try to reinitialize
          
          if (!this.openaiClient) {
            return {
              success: false,
              error: "OpenAI API key not configured or invalid. Please check your settings."
            };
          }
        }

        // Use OpenAI for processing
        const messages = [
          {
            role: "system" as const, 
            content: "你是编程题解析助手。分析题目截图并提取所有相关信息。只返回 JSON，不要添加其他文字。JSON 必须包含 problem_statement、constraints、example_input、example_output、starter_code、required_signature。若截图中存在平台提供的代码模板、类定义、函数定义或方法签名，必须逐字提取到 starter_code，并将不可更改的类名、方法名、参数及返回类型写入 required_signature；若截图没有代码模板，这两个字段返回空字符串。除代码、变量名和原始输入输出外，所有字段值必须使用简体中文。"
          },
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const, 
                text: `请从这些截图中提取编程题信息并按指定 JSON 格式返回。特别检查截图中的编辑器区域：如果存在预置代码模板，必须完整、准确地提取，不能只提取函数名。所有说明必须使用简体中文。解题语言为 ${language}。`
              },
              ...imageDataList.map(data => ({
                type: "image_url" as const,
                image_url: { url: `data:image/png;base64,${data}` }
              }))
            ]
          }
        ];

        // Send to OpenAI Vision API
        const extractionResponse = await this.openaiClient.chat.completions.create({
          model: config.extractionModel || "gpt-4o",
          messages: messages,
          max_tokens: config.apiProvider === "openai-compatible" ? 16384 : 4000,
          temperature: 0.2
        });

        // Parse the response
        try {
          const extractionMessage = extractionResponse.choices[0]?.message as {
            content: string | null;
            reasoning_content?: string | null;
          };
          const responseText = extractionMessage?.content;
          if (!responseText?.trim()) {
            const finishReason = extractionResponse.choices[0]?.finish_reason || "unknown";
            const reasoningLength = extractionMessage?.reasoning_content?.length || 0;
            throw new Error(`模型没有返回题目解析正文（finish_reason=${finishReason}, reasoning_length=${reasoningLength}）`);
          }
          // Handle when OpenAI might wrap the JSON in markdown code blocks
          const jsonText = responseText.replace(/```json|```/g, '').trim();
          problemInfo = JSON.parse(jsonText);
        } catch (error) {
          console.error("Error parsing OpenAI response:", error);
          return {
            success: false,
            error: "Failed to parse problem information. Please try again or use clearer screenshots."
          };
        }
      } else if (config.apiProvider === "gemini")  {
        // Use Gemini API
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }

        try {
          // Create Gemini message structure
          const geminiMessages: GeminiMessage[] = [
            {
              role: "user",
              parts: [
                {
                  text: `你是编程题解析助手。分析题目截图并提取所有相关信息。只返回 JSON，必须包含 problem_statement、constraints、example_input、example_output、starter_code、required_signature。若编辑器区域存在预置代码模板、类定义、函数定义或方法签名，必须逐字完整提取到 starter_code，并将不可更改的类名、方法名、参数及返回类型写入 required_signature；若没有模板则两个字段返回空字符串。除代码、变量名和原始输入输出外，所有字段值必须使用简体中文。解题语言为 ${language}。`
                },
                ...imageDataList.map(data => ({
                  inlineData: {
                    mimeType: "image/png",
                    data: data
                  }
                }))
              ]
            }
          ];

          // Make API request to Gemini
          const response = await axios.default.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.extractionModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
            {
              contents: geminiMessages,
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 4000
              }
            },
            { signal }
          );

          const responseData = response.data as GeminiResponse;
          
          if (!responseData.candidates || responseData.candidates.length === 0) {
            throw new Error("Empty response from Gemini API");
          }
          
          const responseText = responseData.candidates[0].content.parts[0].text;
          
          // Handle when Gemini might wrap the JSON in markdown code blocks
          const jsonText = responseText.replace(/```json|```/g, '').trim();
          problemInfo = JSON.parse(jsonText);
        } catch (error) {
          console.error("Error using Gemini API:", error);
          return {
            success: false,
            error: "Failed to process with Gemini API. Please check your API key or try again later."
          };
        }
      } else if (config.apiProvider === "anthropic") {
        if (!this.anthropicClient) {
          return {
            success: false,
            error: "Anthropic API key not configured. Please check your settings."
          };
        }

        try {
          const messages = [
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: `请从这些截图中提取编程题信息。只返回 JSON，必须包含 problem_statement、constraints、example_input、example_output、starter_code、required_signature。若编辑器区域存在预置代码模板、类定义、函数定义或方法签名，必须逐字完整提取到 starter_code，并将不可更改的类名、方法名、参数及返回类型写入 required_signature；若没有模板则两个字段返回空字符串。除代码、变量名和原始输入输出外，所有字段值必须使用简体中文。解题语言为 ${language}。`
                },
                ...imageDataList.map(data => ({
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: "image/png" as const,
                    data: data
                  }
                }))
              ]
            }
          ];

          const response = await this.anthropicClient.messages.create({
            model: config.extractionModel || "claude-3-7-sonnet-20250219",
            max_tokens: 4000,
            messages: messages,
            temperature: 0.2
          });

          const responseText = (response.content[0] as { type: 'text', text: string }).text;
          const jsonText = responseText.replace(/```json|```/g, '').trim();
          problemInfo = JSON.parse(jsonText);
        } catch (error: any) {
          console.error("Error using Anthropic API:", error);

          // Add specific handling for Claude's limitations
          if (error.status === 429) {
            return {
              success: false,
              error: "Claude API rate limit exceeded. Please wait a few minutes before trying again."
            };
          } else if (error.status === 413 || (error.message && error.message.includes("token"))) {
            return {
              success: false,
              error: "Your screenshots contain too much information for Claude to process. Switch to OpenAI or Gemini in settings which can handle larger inputs."
            };
          }

          return {
            success: false,
            error: "Failed to process with Anthropic API. Please check your API key or try again later."
          };
        }
      }
      
      // Update the user on progress
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Problem analyzed successfully. Preparing to generate solution...",
          progress: 40
        });
      }

      // Store problem info in AppState
      this.deps.setProblemInfo(problemInfo);

      // Send first success event
      if (mainWindow) {
        mainWindow.webContents.send(
          this.deps.PROCESSING_EVENTS.PROBLEM_EXTRACTED,
          problemInfo
        );

        // Generate solutions after successful extraction
        const solutionsResult = await this.generateSolutionsHelper(signal, userRequest);
        if (solutionsResult.success) {
          // Clear any existing extra screenshots before transitioning to solutions view
          this.screenshotHelper.clearExtraScreenshotQueue();
          
          // Final progress update
          mainWindow.webContents.send("processing-status", {
            message: "Solution generated successfully",
            progress: 100
          });
          
          mainWindow.webContents.send(
            this.deps.PROCESSING_EVENTS.SOLUTION_SUCCESS,
            solutionsResult.data
          );
          return { success: true, data: solutionsResult.data };
        } else {
          throw new Error(
            solutionsResult.error || "Failed to generate solutions"
          );
        }
      }

      return { success: false, error: "Failed to process screenshots" };
    } catch (error: any) {
      // If the request was cancelled, don't retry
      if (axios.isCancel(error)) {
        return {
          success: false,
          error: "Processing was canceled by the user."
        };
      }
      
      // Handle OpenAI API errors specifically
      if (error?.response?.status === 401) {
        return {
          success: false,
          error: "Invalid OpenAI API key. Please check your settings."
        };
      } else if (error?.response?.status === 429) {
        return {
          success: false,
          error: "OpenAI API rate limit exceeded or insufficient credits. Please try again later."
        };
      } else if (error?.response?.status === 500) {
        return {
          success: false,
          error: "OpenAI server error. Please try again later."
        };
      }

      console.error("API Error Details:", error);
      return { 
        success: false, 
        error: error.message || "Failed to process screenshots. Please try again." 
      };
    }
  }

  private async generateSolutionsHelper(signal: AbortSignal, userRequest = "") {
    try {
      const problemInfo = this.deps.getProblemInfo();
      const language = await this.getLanguage();
      const config = configHelper.loadConfig();
      const mainWindow = this.deps.getMainWindow();
      const interviewContextPrompt = loadInterviewContextPrompt(
        config.interviewContextEnabled,
        config.interviewContextPath
      )
      const solutionSystemPrompt = [
        "你是专业的编程题解答助手。所有解释、思路、标题和代码注释必须使用简体中文；代码语法、变量名和必要的专有名词可以保持原样。请提供清晰、最优且解释充分的解法。",
        interviewContextPrompt
      ].filter(Boolean).join("\n\n")

      if (!problemInfo) {
        throw new Error("No problem info available");
      }

      // Update progress status
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Creating optimal solution with detailed explanations...",
          progress: 60
        });
      }

      // Create prompt for solution generation
      const promptText = `
请为下面的编程题生成详细解法。

题目描述：
${problemInfo.problem_statement}

约束条件：
${problemInfo.constraints || "题目未提供明确的约束条件。"}

示例输入：
${problemInfo.example_input || "题目未提供示例输入。"}

示例输出：
${problemInfo.example_output || "题目未提供示例输出。"}

编程语言：${language}

用户本轮补充要求：
${userRequest.trim() || "无额外要求，请直接完成题目。"}

截图中识别到的平台代码模板：
${problemInfo.starter_code || "未识别到代码模板"}

必须保持的代码签名：
${problemInfo.required_signature || "未识别到固定签名"}

模板规则：
- 如果上方识别到了代码模板，必须严格在该模板基础上续写并返回补全后的完整代码。
- 必须保留模板的整体结构、类名、方法名、参数顺序、参数类型、返回类型和平台预置代码。
- 只能补充实现所需的代码，不得把类方法改成裸函数，不得自创 main、输入输出逻辑或更换函数签名。
- 即使你认为另一种签名更合理，也必须以截图模板为准。
- 只有在确实没有识别到任何模板时，才可以根据题目自行选择合适的代码结构。

必须严格使用简体中文回答，并采用以下格式：
1. 基础解法：给出逻辑正确、容易理解但复杂度较高的实现。它不应故意包含错误；允许因为复杂度较高而在大规模数据上超时。代码必须放在第一个 Markdown 代码块中。
2. 优化解法：给出复杂度更优、完整处理边界情况的实现。代码必须放在第二个 Markdown 代码块中。
3. 解题思路：用项目符号说明基础解法如何演进为优化解法
4. 时间复杂度：分别说明基础解法和优化解法的时间复杂度
5. 空间复杂度：分别说明基础解法和优化解法的空间复杂度

两个代码块都必须遵守上方模板规则。如果截图中有代码模板，两个代码块都必须分别返回基于该模板补全后的完整代码，不能只返回方法体或裸函数。代码注释使用简体中文。

除代码语法、变量名、专有名词及复杂度符号外，不得输出英文说明。解法应高效、注释清晰，并正确处理边界情况。
`;

      let responseContent;
      
      if (
        this.solutionOpenAIClient ||
        config.apiProvider === "openai" ||
        config.apiProvider === "openai-compatible"
      ) {
        // OpenAI processing
        const solutionClient = this.solutionOpenAIClient || this.openaiClient;
        if (!solutionClient) {
          return {
            success: false,
            error: "Solution API endpoint is not configured. Please check your settings."
          };
        }
        
        // Stream solution tokens so the renderer can display the answer while
        // the model is still generating it. Problem extraction remains
        // non-streaming because it must be parsed as one complete JSON object.
        const solutionRequest: DeepSeekStreamingRequest = {
          model: config.solutionModel || "gpt-4o",
          messages: [
            { role: "system", content: solutionSystemPrompt },
            { role: "user", content: promptText }
          ],
          max_tokens: this.solutionOpenAIClient || config.apiProvider === "openai-compatible" ? 32768 : 4000,
          temperature: 0.2,
          stream: true
        }
        const solutionEndpoint = this.solutionOpenAIClient
          ? config.solutionBaseURL
          : config.baseURL
        if (isOfficialDeepSeekEndpoint(solutionEndpoint)) {
          solutionRequest.thinking = { type: "enabled" }
          solutionRequest.reasoning_effort = "low"
        }
        const solutionStream = await solutionClient.chat.completions.create(
          solutionRequest,
          { signal }
        );

        responseContent = "";
        let reasoningLength = 0;
        let finishReason = "unknown";
        let lastStreamUpdate = 0;

        mainWindow?.webContents.send("solution-stream", {
          content: "",
          isThinking: true,
          done: false
        });

        for await (const chunk of solutionStream) {
          const choice = chunk.choices[0];
          const delta = choice?.delta as {
            content?: string | null;
            reasoning_content?: string | null;
          } | undefined;

          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }
          if (delta?.reasoning_content) {
            reasoningLength += delta.reasoning_content.length;
          }
          if (delta?.content) {
            responseContent += delta.content;
          }

          // Limit IPC/React updates to about 20 FPS while preserving every
          // token in the accumulated content.
          const now = Date.now();
          if (now - lastStreamUpdate >= 50) {
            mainWindow?.webContents.send("solution-stream", {
              content: responseContent,
              isThinking: responseContent.length === 0 && reasoningLength > 0,
              done: false
            });
            lastStreamUpdate = now;
          }
        }

        mainWindow?.webContents.send("solution-stream", {
          content: responseContent,
          isThinking: false,
          done: true
        });

        if (!responseContent?.trim()) {
          throw new Error(`模型完成了思考但没有返回最终解答（finish_reason=${finishReason}, reasoning_length=${reasoningLength}）。请提高服务端最大输出长度。`);
        }
      } else if (config.apiProvider === "gemini")  {
        // Gemini processing
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }
        
        try {
          // Create Gemini message structure
          const geminiMessages = [
            {
              role: "user",
              parts: [
                {
                  text: `你是专业的编程题解答助手。必须全程使用简体中文提供清晰、最优且解释充分的解法。\n\n${promptText}`
                }
              ]
            }
          ];

          // Make API request to Gemini
          const response = await axios.default.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.solutionModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
            {
              contents: geminiMessages,
              systemInstruction: {
                parts: [{ text: solutionSystemPrompt }]
              },
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 4000
              }
            },
            { signal }
          );

          const responseData = response.data as GeminiResponse;
          
          if (!responseData.candidates || responseData.candidates.length === 0) {
            throw new Error("Empty response from Gemini API");
          }
          
          responseContent = responseData.candidates[0].content.parts[0].text;
        } catch (error) {
          console.error("Error using Gemini API for solution:", error);
          return {
            success: false,
            error: "Failed to generate solution with Gemini API. Please check your API key or try again later."
          };
        }
      } else if (config.apiProvider === "anthropic") {
        // Anthropic processing
        if (!this.anthropicClient) {
          return {
            success: false,
            error: "Anthropic API key not configured. Please check your settings."
          };
        }
        
        try {
          const messages = [
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: `你是专业的编程题解答助手。必须全程使用简体中文提供清晰、最优且解释充分的解法。\n\n${promptText}`
                }
              ]
            }
          ];

          // Send to Anthropic API
          const response = await this.anthropicClient.messages.create({
            model: config.solutionModel || "claude-3-7-sonnet-20250219",
            max_tokens: 4000,
            system: solutionSystemPrompt,
            messages: messages,
            temperature: 0.2
          });

          responseContent = (response.content[0] as { type: 'text', text: string }).text;
        } catch (error: any) {
          console.error("Error using Anthropic API for solution:", error);

          // Add specific handling for Claude's limitations
          if (error.status === 429) {
            return {
              success: false,
              error: "Claude API rate limit exceeded. Please wait a few minutes before trying again."
            };
          } else if (error.status === 413 || (error.message && error.message.includes("token"))) {
            return {
              success: false,
              error: "Your screenshots contain too much information for Claude to process. Switch to OpenAI or Gemini in settings which can handle larger inputs."
            };
          }

          return {
            success: false,
            error: "Failed to generate solution with Anthropic API. Please check your API key or try again later."
          };
        }
      }
      
      // Extract parts from the response
      const codeBlocks = Array.from(responseContent.matchAll(/```(?:\w+)?\s*([\s\S]*?)```/g))
        .map((match) => match[1].trim())
        .filter(Boolean);
      const basicCode = codeBlocks.length >= 2 ? codeBlocks[0] : "";
      const code = codeBlocks.length >= 2
        ? codeBlocks[1]
        : codeBlocks[0] || responseContent;
      
      // Extract thoughts, looking for bullet points or numbered lists
      const thoughtsRegex = /(?:解题思路|思路|关键洞察|推理过程|Thoughts|Key Insights|Reasoning|Approach)\s*[:：]?\s*([\s\S]*?)(?=\n\s*(?:#{1,6}\s*)?(?:\d+\.\s*)?(?:时间复杂度|Time complexity)\s*[:：]?|$)/i;
      const thoughtsMatch = responseContent.match(thoughtsRegex);
      let thoughts: string[] = [];
      
      if (thoughtsMatch && thoughtsMatch[1]) {
        // Extract bullet points or numbered items
        const bulletPoints = thoughtsMatch[1].match(/(?:^|\n)\s*(?:[-*•]|\d+\.)\s*(.*)/g);
        if (bulletPoints) {
          thoughts = bulletPoints.map(point => 
            point.replace(/^\s*(?:[-*•]|\d+\.)\s*/, '').trim()
          ).filter(Boolean);
        } else {
          // If no bullet points found, split by newlines and filter empty lines
          thoughts = thoughtsMatch[1].split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
        }
      }
      
      // Extract complexity information
      const timeComplexityPattern = /(?:时间复杂度|Time complexity)\s*[:：]?\s*([^\n]+(?:\n[^\n]+)*?)(?=\n\s*(?:#{1,6}\s*)?(?:\d+\.\s*)?(?:空间复杂度|Space complexity)|$)/i;
      const spaceComplexityPattern = /(?:空间复杂度|Space complexity)\s*[:：]?\s*([\s\S]*?)\s*$/i;
      
      let timeComplexity = "O(n) - 线性时间复杂度，因为只需遍历输入一次，每个元素只会被处理一次。";
      let spaceComplexity = "O(n) - 线性空间复杂度，因为最坏情况下需要存储与输入规模成正比的辅助数据。";
      
      const timeMatch = responseContent.match(timeComplexityPattern);
      if (timeMatch && timeMatch[1]) {
        timeComplexity = timeMatch[1].trim();
        if (!timeComplexity.match(/O\([^)]+\)/i)) {
          timeComplexity = `O(n) - ${timeComplexity}`;
        } else if (!timeComplexity.includes('-') && !timeComplexity.includes('because') && !timeComplexity.includes('因为')) {
          const notationMatch = timeComplexity.match(/O\([^)]+\)/i);
          if (notationMatch) {
            const notation = notationMatch[0];
            const rest = timeComplexity.replace(notation, '').trim();
            timeComplexity = `${notation} - ${rest}`;
          }
        }
      }
      
      const spaceMatch = responseContent.match(spaceComplexityPattern);
      if (spaceMatch && spaceMatch[1]) {
        spaceComplexity = spaceMatch[1].trim();
        if (!spaceComplexity.match(/O\([^)]+\)/i)) {
          spaceComplexity = `O(n) - ${spaceComplexity}`;
        } else if (!spaceComplexity.includes('-') && !spaceComplexity.includes('because') && !spaceComplexity.includes('因为')) {
          const notationMatch = spaceComplexity.match(/O\([^)]+\)/i);
          if (notationMatch) {
            const notation = notationMatch[0];
            const rest = spaceComplexity.replace(notation, '').trim();
            spaceComplexity = `${notation} - ${rest}`;
          }
        }
      }

      const formattedResponse = {
        basic_code: basicCode,
        code: code,
        thoughts: thoughts.length > 0 ? thoughts : ["基于效率、正确性和可读性设计解题方案"],
        time_complexity: timeComplexity,
        space_complexity: spaceComplexity
      };

      this.setCurrentBasicCode(basicCode);
      this.setCurrentSolutionCode(code);

      return { success: true, data: formattedResponse };
    } catch (error: any) {
      if (axios.isCancel(error)) {
        return {
          success: false,
          error: "Processing was canceled by the user."
        };
      }
      
      if (error?.response?.status === 401) {
        return {
          success: false,
          error: "Invalid OpenAI API key. Please check your settings."
        };
      } else if (error?.response?.status === 429) {
        return {
          success: false,
          error: "OpenAI API rate limit exceeded or insufficient credits. Please try again later."
        };
      }
      
      console.error("Solution generation error:", error);
      return { success: false, error: error.message || "Failed to generate solution" };
    }
  }

  private async processExtraScreenshotsHelper(
    screenshots: Array<{ path: string; data: string }>,
    signal: AbortSignal,
    userRequest = ""
  ) {
    try {
      const problemInfo = this.deps.getProblemInfo();
      const language = await this.getLanguage();
      const config = configHelper.loadConfig();
      const mainWindow = this.deps.getMainWindow();

      if (!problemInfo) {
        throw new Error("No problem info available");
      }

      // Update progress status
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Processing debug screenshots...",
          progress: 30
        });
      }

      // Prepare the images for the API call
      const imageDataList = screenshots.map(screenshot => screenshot.data);

      const debuggingInstructions = `你是面向编程初学者的代码调试助手。你的首要任务是修复用户截图中的原代码，而不是重新设计或替换解法。所有标题、说明、分析和代码注释必须使用简体中文。

必须遵守以下修复原则：
1. 保留用户原有的算法思路、代码结构、类名、函数签名、变量名和已有注释。
2. 只做让代码正确运行并通过当前测试所必需的最小修改。不得擅自改用动态规划、中心扩散、哈希表、递归或其他不同算法。
3. 不得因为另一种算法更快、更标准或更简洁，就重写整份代码。只有用户明确要求优化或原思路无法修复时，才可以另行介绍其他算法；此时也必须先给出原思路的修复版本。
4. 必须给出一份基于截图原代码修正后的完整代码，不能只给片段，也不能输出与用户原代码无关的参考实现。
5. 每一处实际修改都必须在代码附近添加按顺序编号的中文注释，并说明改了什么，例如 Python 使用：
   # 修改1：将 < 改成 <=，跳过长度不超过当前最长值的子串
   # 修改2：退出 while 循环后，再判断整个子串是否为回文
   其他语言使用对应的注释语法。移动代码块时，在移动后的代码块上方添加修改注释；删除代码时，在“具体改进与修正”中明确说明。
6. “具体改进与修正”中的修改编号必须与完整代码里的“修改1、修改2……”逐项对应。
7. 性能优化只能作为可选建议说明，不得把优化算法替换进本次修复代码。
8. 如果截图内容不清晰，必须明确指出无法确认的部分，不得自行编造代码。

必须严格使用以下结构（标题使用 ###）：
### 发现的问题
- 按原代码的位置说明错误及其影响

### 具体改进与修正
- 按“修改1、修改2……”列出最小修改，并与代码注释一一对应

### 修正后的完整代码
- 只提供一份保留用户原思路的完整代码，使用带语言标识的 Markdown 代码块

### 修改原因
用适合初学者的语言解释为什么这些修改能解决问题

### 可选优化建议
- 仅简短说明，不改写本次修复代码；没有必要时写“暂无”

### 关键要点
- 使用项目符号总结最重要的结论

除代码语法、变量名和必要的专有名词外，不得输出英文说明。`;

      const basicCodeForDebugging = this.currentBasicCode.trim()
        ? this.currentBasicCode
        : "未获取到简单解法文本，请以截图中的代码为准。";

      const debuggingRequest = `我正在使用 ${language} 解答这道题：“${problemInfo.problem_statement}”。请根据截图中的原代码、报错、错误输出或测试用例进行调试。

用户本轮补充说明：
${userRequest.trim() || "没有额外文字说明，请重点分析截图。"}

下面是本题之前生成、并被用户摘抄使用的“简单解法”完整代码：

--- 简单解法开始 ---
${basicCodeForDebugging}
--- 简单解法结束 ---

调试对象就是这份简单解法。截图中的代码可能是用户摘抄后修改过的最新版本，因此能看清时以截图为准；简单解法文本用于确认原始结构和截图中看不清的内容。请严格保留这套简单算法，只修复其中的问题，不得改成优化解法。在修正后的完整代码里，每个修改处都要添加“修改1、修改2……”中文注释。`;
      
      let debugContent;
      
      if (config.apiProvider === "openai" || config.apiProvider === "openai-compatible") {
        if (!this.openaiClient) {
          return {
            success: false,
            error: "OpenAI API key not configured. Please check your settings."
          };
        }
        
        const messages = [
          {
            role: "system" as const, 
            content: debuggingInstructions
          },
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const, 
                text: debuggingRequest
              },
              ...imageDataList.map(data => ({
                type: "image_url" as const,
                image_url: { url: `data:image/png;base64,${data}` }
              }))
            ]
          }
        ];

        if (mainWindow) {
          mainWindow.webContents.send("processing-status", {
            message: "Analyzing code and generating debug feedback...",
            progress: 60
          });
        }

        const debugResponse = await this.openaiClient.chat.completions.create({
          model: config.debuggingModel || "gpt-4o",
          messages: messages,
          max_tokens: config.apiProvider === "openai-compatible" ? 32768 : 4000,
          temperature: 0.2
        });
        
        const debugMessage = debugResponse.choices[0]?.message as {
          content: string | null;
          reasoning_content?: string | null;
        };
        debugContent = debugMessage?.content;
        if (!debugContent?.trim()) {
          const finishReason = debugResponse.choices[0]?.finish_reason || "unknown";
          const reasoningLength = debugMessage?.reasoning_content?.length || 0;
          throw new Error(`模型完成了思考但没有返回调试正文（finish_reason=${finishReason}, reasoning_length=${reasoningLength}）。请提高服务端最大输出长度。`);
        }
      } else if (config.apiProvider === "gemini")  {
        if (!this.geminiApiKey) {
          return {
            success: false,
            error: "Gemini API key not configured. Please check your settings."
          };
        }
        
        try {
          const debugPrompt = `${debuggingInstructions}\n\n${debuggingRequest}`;

          const geminiMessages = [
            {
              role: "user",
              parts: [
                { text: debugPrompt },
                ...imageDataList.map(data => ({
                  inlineData: {
                    mimeType: "image/png",
                    data: data
                  }
                }))
              ]
            }
          ];

          if (mainWindow) {
            mainWindow.webContents.send("processing-status", {
              message: "Analyzing code and generating debug feedback with Gemini...",
              progress: 60
            });
          }

          const response = await axios.default.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.debuggingModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
            {
              contents: geminiMessages,
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 4000
              }
            },
            { signal }
          );

          const responseData = response.data as GeminiResponse;
          
          if (!responseData.candidates || responseData.candidates.length === 0) {
            throw new Error("Empty response from Gemini API");
          }
          
          debugContent = responseData.candidates[0].content.parts[0].text;
        } catch (error) {
          console.error("Error using Gemini API for debugging:", error);
          return {
            success: false,
            error: "Failed to process debug request with Gemini API. Please check your API key or try again later."
          };
        }
      } else if (config.apiProvider === "anthropic") {
        if (!this.anthropicClient) {
          return {
            success: false,
            error: "Anthropic API key not configured. Please check your settings."
          };
        }
        
        try {
          const debugPrompt = `${debuggingInstructions}\n\n${debuggingRequest}`;

          const messages = [
            {
              role: "user" as const,
              content: [
                {
                  type: "text" as const,
                  text: debugPrompt
                },
                ...imageDataList.map(data => ({
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: "image/png" as const, 
                    data: data
                  }
                }))
              ]
            }
          ];

          if (mainWindow) {
            mainWindow.webContents.send("processing-status", {
              message: "Analyzing code and generating debug feedback with Claude...",
              progress: 60
            });
          }

          const response = await this.anthropicClient.messages.create({
            model: config.debuggingModel || "claude-3-7-sonnet-20250219",
            max_tokens: 4000,
            messages: messages,
            temperature: 0.2
          });
          
          debugContent = (response.content[0] as { type: 'text', text: string }).text;
        } catch (error: any) {
          console.error("Error using Anthropic API for debugging:", error);
          
          // Add specific handling for Claude's limitations
          if (error.status === 429) {
            return {
              success: false,
              error: "Claude API rate limit exceeded. Please wait a few minutes before trying again."
            };
          } else if (error.status === 413 || (error.message && error.message.includes("token"))) {
            return {
              success: false,
              error: "Your screenshots contain too much information for Claude to process. Switch to OpenAI or Gemini in settings which can handle larger inputs."
            };
          }
          
          return {
            success: false,
            error: "Failed to process debug request with Anthropic API. Please check your API key or try again later."
          };
        }
      }
      
      
      if (mainWindow) {
        mainWindow.webContents.send("processing-status", {
          message: "Debug analysis complete",
          progress: 100
        });
      }

      let extractedCode = "// 调试模式：请查看下方分析";
      const codeMatch = debugContent.match(/```(?:[a-zA-Z]+)?([\s\S]*?)```/);
      if (codeMatch && codeMatch[1]) {
        extractedCode = codeMatch[1].trim();
      }

      let formattedDebugContent = debugContent;
      
      if (!debugContent.includes('# ') && !debugContent.includes('## ')) {
        formattedDebugContent = debugContent
          .replace(/issues identified|problems found|bugs found/i, '## 发现的问题')
          .replace(/code improvements|improvements|suggested changes/i, '## 代码改进')
          .replace(/optimizations|performance improvements/i, '## 优化建议')
          .replace(/explanation|detailed analysis/i, '## 详细说明');
      }

      const bulletPoints = formattedDebugContent.match(/(?:^|\n)[ ]*(?:[-*•]|\d+\.)[ ]+([^\n]+)/g);
      const thoughts = bulletPoints 
        ? bulletPoints.map(point => point.replace(/^[ ]*(?:[-*•]|\d+\.)[ ]+/, '').trim()).slice(0, 5)
        : ["根据截图进行调试分析"];
      
      const response = {
        code: extractedCode,
        debug_analysis: formattedDebugContent,
        thoughts: thoughts,
        time_complexity: "不适用 - 调试模式",
        space_complexity: "不适用 - 调试模式"
      };

      return { success: true, data: response };
    } catch (error: any) {
      console.error("Debug processing error:", error);
      return { success: false, error: error.message || "Failed to process debug request" };
    }
  }

  public async correctVoiceConversation(
    conversation: VoiceConversationTranscript
  ): Promise<VoiceConversationTranscript & { corrected: boolean }> {
    const original = { ...conversation, corrected: false }
    if (!conversation.systemTranscript.trim() && !conversation.microphoneTranscript.trim()) {
      return original
    }

    const config = configHelper.loadConfig()
    if (!this.openaiClient) this.initializeAIClient()
    if (!this.openaiClient) return original

    const enhancement = loadInterviewAsrEnhancement(
      config.interviewContextEnabled,
      config.interviewContextPath
    )
    const correctionPrompt = `请校正下面的实时语音识别文本。

规则：
- 只修正同音错字、中英文技术术语、大小写、标点和明显错误断句。
- 必须保持原意、角色和提问内容，禁止回答问题，禁止补充原文没有的信息。
- 这是双声道面试录音：用户A来自电脑扬声器，是提问方；用户B来自麦克风，是回答方。保持两人的声道归属，只校正文本，不要交换或合并角色。
- 只返回严格 JSON：{"systemTranscript":"...","microphoneTranscript":"..."}。
${enhancement.contextText ? `- 领域术语参考：${enhancement.contextText}` : "- 场景是 Agent 工程师技术面试，注意常见中英文技术术语。"}

原始识别：
${JSON.stringify({
  systemTranscript: conversation.systemTranscript,
  microphoneTranscript: conversation.microphoneTranscript
})}`

    try {
      const correctionRequest: QwenCorrectionRequest = {
          model: config.extractionModel || "gpt-4o",
          messages: [
            {
              role: "system",
              content: "你是低延迟 ASR 文本校正器。只校正识别错误并返回 JSON，不回答对话中的问题。"
            },
            { role: "user", content: correctionPrompt }
          ],
          temperature: 0,
          max_tokens: config.apiProvider === "openai-compatible" ? 2048 : 1200,
          ...(config.apiProvider === "openai-compatible"
            ? { chat_template_kwargs: { enable_thinking: false } }
            : {})
        }
      const response = await this.openaiClient.chat.completions.create(
        correctionRequest,
        { signal: AbortSignal.timeout(10_000) }
      )
      const raw = response.choices[0]?.message?.content
      if (!raw?.trim()) return original
      const parsed = JSON.parse(raw.replace(/```json|```/gi, "").trim()) as {
        systemTranscript?: unknown
        microphoneTranscript?: unknown
      }
      return {
        ...conversation,
        systemTranscript: typeof parsed.systemTranscript === "string"
          ? parsed.systemTranscript.trim()
          : conversation.systemTranscript,
        microphoneTranscript: typeof parsed.microphoneTranscript === "string"
          ? parsed.microphoneTranscript.trim()
          : conversation.microphoneTranscript,
        corrected: true
      }
    } catch (error) {
      console.warn("Voice transcript correction skipped:", error)
      return original
    }
  }

  public async processChatMessage(
    requestId: string,
    message: string
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    const mainWindow = this.deps.getMainWindow()
    const content = message.trim()
    if (!mainWindow || !content) {
      return { success: false, error: "消息不能为空" }
    }

    const config = configHelper.loadConfig()
    const language = await this.getLanguage()
    const problemInfo = this.deps.getProblemInfo()
    const controller = new AbortController()
    this.currentExtraProcessingAbortController = controller
    let interviewContextPrompt = ""
    try {
      interviewContextPrompt = loadInterviewContextPrompt(
        config.interviewContextEnabled,
        config.interviewContextPath
      )
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "面试上下文不可用"
      }
    }
    const isVoiceInterviewRequest =
      content.includes("用户A：") ||
      content.includes("用户B：") ||
      content.includes("用户A（扬声器）") ||
      content.includes("用户B（麦克风）") ||
      content.includes("面试现场可以直接说出口")
    const voiceInterviewStylePrompt = isVoiceInterviewRequest
      ? `这是双声道实时面试语音回答：用户A来自电脑扬声器，是提问方；用户B来自麦克风，是回答方，我们需要以用户B的身份作答。输出必须像用户B现场直接开口说话：
- 两个声道的转写可能包含寒暄、口头禅、重复、插话、没说完的半句话和识别错字，但不要交换用户A和用户B的归属。
- 不要逐句回应，也不要把每句话都当成问题。先结合整段对话，挖掘用户A最近真正向用户B提出、且尚未解决的核心问题；用户B已经说过的话主要作为理解追问和补充回答的上下文。
- 忽略与核心问题无关的杂音和交流。如果问题被停顿或插话拆开，要在理解后合并；“为什么”“具体呢”“然后呢”等短追问要结合前文还原含义。
- 如果没有识别出用户A的明确问题，但用户B明确向 AI 提问，则回答用户B最后提出的问题。除非整段内容确实无法识别出任何问题，否则不要反问用户，也不要复述原始转写。
- 使用大白话，先给结论，再用一个简单例子或关键点说明。
- 若面试背景资料中存在与问题相关的真实项目经历，优先用用户B的第一人称结合项目回答，例如“在我们 PandoraQ 项目里……”，把通用原理落到项目做法上；资料未提供的信息不得编造。
- 默认只输出一个短段落，3～6句话，约20～40秒可以说完。
- 禁止 Markdown 标题、加粗、编号、项目符号、ASCII 图和长篇教程。
- 不要以“好的”“当然”“我分几层讲”开头，不主动解释英文全称。
- 只有用户明确要求详细展开、完整方案或代码时才增加篇幅。`
      : ""
    const chatSystemPrompt = [
      "你是编程解题与技术面试对话助手。保持上下文连续，优先回答用户最后一个问题；所有解释和代码注释使用简体中文。",
      voiceInterviewStylePrompt,
      interviewContextPrompt
    ].filter(Boolean).join("\n\n")

    const contextPrompt = `当前编程语言：${language}

当前题目：
${problemInfo?.problem_statement || "当前没有从截图中识别出的题目，请直接回答用户的问题。"}

当前参考代码：
${this.currentSolutionCode || this.currentBasicCode || "当前没有已生成的代码。"}

用户的新消息：
${content}

请结合当前题目、已有代码和对话上下文回答。若用户要求修改代码，请返回可直接使用的完整代码；若只是提问，请直接解释，不要机械重复整套题解。所有说明和代码注释使用简体中文。`

    const historyMode = config.interviewContextEnabled ? "interview" : "problem"
    const modeHistory = this.chatHistories[historyMode]
    const priorMessages = modeHistory.slice(-10)
    mainWindow.webContents.send("processing-status", {
      stage: "followup",
      requestId,
      message: "正在连接解答模型...",
      progress: 10
    })

    try {
      let responseContent = ""

      if (
        this.solutionOpenAIClient ||
        config.apiProvider === "openai" ||
        config.apiProvider === "openai-compatible"
      ) {
        const client = this.solutionOpenAIClient || this.openaiClient
        if (!client) throw new Error("解答模型尚未配置")

        const chatRequest: DeepSeekStreamingRequest = {
            model: config.solutionModel || "gpt-4o",
            messages: [
              {
                role: "system",
                content: chatSystemPrompt
              },
              ...priorMessages,
              { role: "user", content: contextPrompt }
            ],
            temperature: 0.2,
            max_tokens:
              this.solutionOpenAIClient || config.apiProvider === "openai-compatible"
                ? 32768
                : 4000,
            stream: true
          }
        const chatEndpoint = this.solutionOpenAIClient
          ? config.solutionBaseURL
          : config.baseURL
        if (isOfficialDeepSeekEndpoint(chatEndpoint)) {
          chatRequest.thinking = { type: "enabled" }
          chatRequest.reasoning_effort = "low"
        }
        const stream = await client.chat.completions.create(
          chatRequest,
          { signal: controller.signal }
        )

        mainWindow.webContents.send("processing-status", {
          stage: "followup",
          requestId,
          message: "已连接，正在接收回答...",
          progress: 40
        })

        let lastUpdate = 0
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta as
            | { content?: string | null }
            | undefined
          if (delta?.content) responseContent += delta.content

          const now = Date.now()
          if (now - lastUpdate >= 50 && responseContent) {
            mainWindow.webContents.send("chat-stream", {
              requestId,
              content: responseContent,
              done: false
            })
            lastUpdate = now
          }
        }
      } else if (config.apiProvider === "gemini") {
        if (!this.geminiApiKey) throw new Error("Gemini API key 尚未配置")
        const historyText = priorMessages
          .map((item) => `${item.role === "user" ? "用户" : "助手"}：${item.content}`)
          .join("\n\n")
        const response = await axios.default.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${config.solutionModel || "gemini-2.0-flash"}:generateContent?key=${this.geminiApiKey}`,
          {
            systemInstruction: {
              parts: [{ text: chatSystemPrompt }]
            },
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: `${historyText}\n\n${contextPrompt}`
                  }
                ]
              }
            ],
            generationConfig: { temperature: 0.2, maxOutputTokens: 4000 }
          },
          { signal: controller.signal }
        )
        const data = response.data as GeminiResponse
        responseContent = data.candidates?.[0]?.content?.parts?.[0]?.text || ""
      } else if (config.apiProvider === "anthropic") {
        if (!this.anthropicClient) throw new Error("Anthropic API key 尚未配置")
        const response = await this.anthropicClient.messages.create({
          model: config.solutionModel || "claude-3-7-sonnet-20250219",
          max_tokens: 4000,
          temperature: 0.2,
          system:
            chatSystemPrompt,
          messages: [
            ...priorMessages.map((item) => ({
              role: item.role,
              content: item.content
            })),
            { role: "user" as const, content: contextPrompt }
          ]
        })
        responseContent =
          response.content[0]?.type === "text" ? response.content[0].text : ""
      }

      if (!responseContent.trim()) throw new Error("模型没有返回正文")

      modeHistory.push(
        { role: "user", content },
        { role: "assistant", content: responseContent }
      )
      this.chatHistories[historyMode] = modeHistory.slice(-12)

      mainWindow.webContents.send("chat-stream", {
        requestId,
        content: responseContent,
        done: true
      })
      mainWindow.webContents.send("chat-success", {
        requestId,
        content: responseContent
      })
      return { success: true, content: responseContent }
    } catch (error: any) {
      const errorMessage =
        error?.name === "AbortError" ? "请求已停止" : error?.message || "对话请求失败"
      mainWindow.webContents.send("chat-error", { requestId, error: errorMessage })
      return { success: false, error: errorMessage }
    } finally {
      if (this.currentExtraProcessingAbortController === controller) {
        this.currentExtraProcessingAbortController = null
      }
    }
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
    this.chatHistories = { interview: [], problem: [] }

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
