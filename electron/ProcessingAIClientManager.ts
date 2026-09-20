import { OpenAI } from "openai"
import Anthropic from "@anthropic-ai/sdk"
import { configHelper } from "./ConfigHelper"

export class ProcessingAIClientManager {
  public openaiClient: OpenAI | null = null
  public solutionOpenAIClient: OpenAI | null = null
  public anthropicClient: Anthropic | null = null
  private readonly handleConfigUpdated = (): void => {
    this.initialize()
  }

  constructor() {
    this.initialize()
    configHelper.on("config-updated", this.handleConfigUpdated)
  }

  public dispose(): void {
    configHelper.removeListener("config-updated", this.handleConfigUpdated)
    this.openaiClient = null
    this.solutionOpenAIClient = null
    this.anthropicClient = null
  }

  public initialize(): void {
    try {
      const config = configHelper.loadConfig()

      if (config.apiProvider === "openai-compatible") {
        if (config.apiKey) {
          this.openaiClient = new OpenAI({
            apiKey: config.apiKey,
            ...(config.baseURL ? { baseURL: config.baseURL.replace(/\/$/, "") } : {}),
            timeout: 180000,
            maxRetries: 0
          })
          this.anthropicClient = null
          console.log("OpenAI-compatible client initialized successfully")
        } else {
          this.openaiClient = null
          this.anthropicClient = null
          console.warn("No API key available, OpenAI-compatible client not initialized")
        }
      } else if (config.apiProvider === "anthropic") {
        this.openaiClient = null
        if (config.apiKey) {
          this.anthropicClient = new Anthropic({
            apiKey: config.apiKey,
            timeout: 180000,
            maxRetries: 0
          })
          console.log("Anthropic client initialized successfully")
        } else {
          this.openaiClient = null
          this.anthropicClient = null
          console.warn("No API key available, Anthropic client not initialized")
        }
      }

      if (config.solutionApiKey && config.solutionBaseURL) {
        this.solutionOpenAIClient = new OpenAI({
          apiKey: config.solutionApiKey,
          baseURL: config.solutionBaseURL.replace(/\/$/, ""),
          timeout: 180000,
          maxRetries: 0
        })
        console.log("Separate solution client initialized successfully")
      } else {
        this.solutionOpenAIClient = null
      }
    } catch (error) {
      console.error("Failed to initialize AI client:", error)
      this.openaiClient = null
      this.solutionOpenAIClient = null
      this.anthropicClient = null
    }
  }
}
