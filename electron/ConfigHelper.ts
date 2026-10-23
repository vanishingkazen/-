// ConfigHelper.ts
import fs from "node:fs"
import path from "node:path"
import { app } from "electron"
import { EventEmitter } from "events"
import { OpenAI } from "openai"
import { DEFAULT_INTERVIEW_CONTEXT_PATH } from "./InterviewContextHelper"

export type APIProvider = "openai-compatible" | "anthropic";
export type QuestionMode = "coding" | "iq";

export interface Config {
  questionMode: QuestionMode;
  fallbackEnabled: boolean;
  fallbackApiProvider: APIProvider;
  fallbackApiKey: string;
  fallbackBaseURL: string;
  fallbackModel: string;
  llmTimeoutSeconds: number;
  apiKey: string;
  apiProvider: APIProvider;
  baseURL: string;
  extractionModel: string;
  solutionApiKey: string;
  solutionBaseURL: string;
  solutionModel: string;
  debuggingModel: string;
  streamingEnabled: boolean;
  maxOutputTokens: number;
  contextMessageLimit: number;
  contextWindowTokens: number;
  speechApiKey: string;
  speechWorkspaceId: string;
  speechRegion: string;
  speechModel: string;
  interviewContextEnabled: boolean;
  interviewContextPath: string;
  language: string;
  languageDetectionSource?: "auto" | "detected";
  opacity: number;
}

export class ConfigHelper extends EventEmitter {
  private configPath: string;
  private defaultConfig: Config = {
    questionMode: "coding",
    fallbackEnabled: false,
    fallbackApiProvider: "openai-compatible",
    fallbackApiKey: "",
    fallbackBaseURL: "",
    fallbackModel: "",
    llmTimeoutSeconds: 90,
    apiKey: "",
    apiProvider: "openai-compatible",
    baseURL: "",
    extractionModel: "gpt-4o",
    solutionApiKey: "",
    solutionBaseURL: "",
    solutionModel: "gpt-4o",
    debuggingModel: "gpt-4o",
    streamingEnabled: true,
    maxOutputTokens: 65536,
    contextMessageLimit: 30,
    contextWindowTokens: 128000,
    speechApiKey: "",
    speechWorkspaceId: "",
    speechRegion: "cn-beijing",
    speechModel: "qwen-audio-3.0-asr-flash-streaming",
    interviewContextEnabled: false,
    interviewContextPath: DEFAULT_INTERVIEW_CONTEXT_PATH,
    // The language is inferred from the screenshot/model response.  Keep
    // `auto` as the persisted default so a previous session cannot silently
    // force all new screenshots to Python.
    language: "auto",
    languageDetectionSource: "auto",
    opacity: 1.0
  };

  constructor() {
    super();
    // Use the app's user data directory to store the config
    try {
      const appDataPath = app.getPath('appData')

      // Keep the same config regardless of how Electron resolves userData in
      // development, production source runs, and packaged builds.
      this.configPath = path.join(appDataPath, 'steamgamecode', 'config.json')

      const legacyConfigPaths = [
        path.join(appDataPath, 'interview-coder-v1', 'config.json'),
        // Older source runs that resolved userData before app.setName() used
        // the generic Electron directory.
        path.join(appDataPath, 'Electron', 'config.json')
      ]

      const readApiKey = (candidatePath: string): string => {
        try {
          const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'))
          return typeof candidate.apiKey === 'string' ? candidate.apiKey.trim() : ''
        } catch {
          return ''
        }
      }

      // Preserve endpoint settings from old locations only when the stable
      // config is missing or has no API key.
      let shouldMigrateLegacyConfig = !fs.existsSync(this.configPath)
      if (!shouldMigrateLegacyConfig) {
        shouldMigrateLegacyConfig = !readApiKey(this.configPath)
      }

      if (shouldMigrateLegacyConfig) {
        const legacyConfigPath = legacyConfigPaths
          .filter((candidatePath) => fs.existsSync(candidatePath))
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
          .find((candidatePath) => Boolean(readApiKey(candidatePath)))

        if (legacyConfigPath) {
          fs.mkdirSync(path.dirname(this.configPath), { recursive: true })
          fs.copyFileSync(legacyConfigPath, this.configPath)
          console.log(`Migrated legacy API configuration from ${legacyConfigPath}`)
        }
      }

      console.log('Config path:', this.configPath)
    } catch (err) {
      console.warn('Could not access user data path, using fallback')
      this.configPath = path.join(process.cwd(), 'config.json')
    }
    
    // Ensure the initial config file exists
    this.ensureConfigExists();
  }

  /**
   * Ensure config file exists
   */
  private ensureConfigExists(): void {
    try {
      if (!fs.existsSync(this.configPath)) {
        this.saveConfig(this.defaultConfig);
      }
    } catch (err) {
      console.error("Error ensuring config exists:", err);
    }
  }

  /**
   * Validate and sanitize model selection to ensure only allowed models are used
   */
  private sanitizeModelSelection(model: string, provider: APIProvider): string {
    if (provider === "openai-compatible") {
      return model.trim() || "gpt-4o";
    }
    if (provider === "anthropic") {
      // Only allow Claude models
      const allowedModels = ['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-3-opus-20240229'];
      if (!allowedModels.includes(model)) {
        console.warn(`Invalid Anthropic model specified: ${model}. Using default model: claude-3-7-sonnet-20250219`);
        return 'claude-3-7-sonnet-20250219';
      }
      return model;
    }
    return model;
  }

  public loadConfig(): Config {
    try {
      if (fs.existsSync(this.configPath)) {
        const configData = fs.readFileSync(this.configPath, 'utf8');
        const config = JSON.parse(configData);
        
        // Normalize legacy providers. Native OpenAI is folded into the
        // OpenAI-compatible protocol; Gemini is no longer supported.
        if (config.apiProvider === "openai") {
          config.apiProvider = "openai-compatible";
          if (!config.baseURL) {
            config.baseURL = "https://api.openai.com/v1";
          }
        } else if (config.apiProvider !== "openai-compatible" && config.apiProvider !== "anthropic") {
          config.apiProvider = "openai-compatible";
          config.apiKey = "";
          config.baseURL = "";
          config.extractionModel = "gpt-4o";
          config.solutionModel = "gpt-4o";
          config.debuggingModel = "gpt-4o";
        }
        if (config.questionMode !== "coding" && config.questionMode !== "iq") {
          config.questionMode = "coding";
        }
        config.fallbackEnabled = config.fallbackEnabled === true;
        config.fallbackApiProvider = config.fallbackApiProvider === "anthropic" ? "anthropic" : "openai-compatible";
        for (const key of ["fallbackApiKey", "fallbackBaseURL", "fallbackModel"] as const) {
          config[key] = typeof config[key] === "string" ? config[key].trim() : "";
        }
        config.llmTimeoutSeconds = Math.min(180, Math.max(15, Math.floor(Number(config.llmTimeoutSeconds) || 90)));

        // Older versions persisted the manually selected language directly
        // in `language`. That value must not become a hidden default now that
        // language selection has been removed from the UI. A detected value
        // is explicitly marked by updateConfig below; unmarked legacy values
        // are migrated back to automatic detection once.
        if (config.languageDetectionSource !== "detected") {
          config.language = "auto";
          config.languageDetectionSource = "auto";
        }
        
        // Sanitize model selections to ensure only allowed models are used
        if (config.extractionModel) {
          config.extractionModel = this.sanitizeModelSelection(config.extractionModel, config.apiProvider);
        }
        if (config.solutionModel) {
          config.solutionModel = this.sanitizeModelSelection(config.solutionModel, config.apiProvider);
        }
        if (config.debuggingModel) {
          config.debuggingModel = this.sanitizeModelSelection(config.debuggingModel, config.apiProvider);
        }
        config.maxOutputTokens = Math.min(
          65536,
          Math.max(1024, Number(config.maxOutputTokens) || this.defaultConfig.maxOutputTokens)
        )
        config.contextMessageLimit = Math.min(
          100,
          Math.max(4, Math.floor(Number(config.contextMessageLimit) || this.defaultConfig.contextMessageLimit))
        )
        config.contextWindowTokens = Math.min(
          1000000,
          Math.max(8192, Math.floor(Number(config.contextWindowTokens) || this.defaultConfig.contextWindowTokens))
        )
        
        return {
          ...this.defaultConfig,
          ...config
        };
      }
      
      // If no config exists, create a default one
      this.saveConfig(this.defaultConfig);
      return this.defaultConfig;
    } catch (err) {
      console.error("Error loading config:", err);
      return this.defaultConfig;
    }
  }

  /**
   * Save configuration to disk
   */
  public saveConfig(config: Config): void {
    try {
      // Ensure the directory exists
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      // Write the config file
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    } catch (err) {
      console.error("Error saving config:", err);
    }
  }

  /**
   * Update specific configuration values
   */
  public updateConfig(updates: Partial<Config>): Config {
    try {
      const currentConfig = this.loadConfig();
      let provider = updates.apiProvider || currentConfig.apiProvider;
      
      // Auto-detect provider based on API key format if a new key is provided
      if (updates.apiKey && !updates.apiProvider) {
        provider = updates.apiKey.trim().startsWith('sk-ant-')
          ? "anthropic"
          : "openai-compatible";
        console.log(`Auto-detected API provider: ${provider}`);
        updates.apiProvider = provider;
      }

      // If provider is changing, reset models to the default for that provider
      if (updates.apiProvider && updates.apiProvider !== currentConfig.apiProvider) {
        if (updates.apiProvider === "openai-compatible") {
          updates.extractionModel ||= "gpt-4o";
          updates.solutionModel ||= "gpt-4o";
          updates.debuggingModel ||= "gpt-4o";
        } else if (updates.apiProvider === "anthropic") {
          updates.extractionModel ||= "claude-3-7-sonnet-20250219";
          updates.solutionModel ||= "claude-3-7-sonnet-20250219";
          updates.debuggingModel ||= "claude-3-7-sonnet-20250219";
        }
      }

      // Sanitize model selections in the updates
      if (updates.extractionModel) {
        updates.extractionModel = this.sanitizeModelSelection(updates.extractionModel, provider);
      }
      if (updates.solutionModel) {
        const solutionProvider = (updates.solutionBaseURL ?? currentConfig.solutionBaseURL)
          ? "openai-compatible"
          : provider;
        updates.solutionModel = this.sanitizeModelSelection(updates.solutionModel, solutionProvider);
      }
      if (updates.debuggingModel) {
        updates.debuggingModel = this.sanitizeModelSelection(updates.debuggingModel, provider);
      }
      if (updates.maxOutputTokens !== undefined) {
        updates.maxOutputTokens = Math.min(
          65536,
          Math.max(1024, Math.floor(Number(updates.maxOutputTokens) || this.defaultConfig.maxOutputTokens))
        )
      }
      if (updates.contextMessageLimit !== undefined) {
        updates.contextMessageLimit = Math.min(
          100,
          Math.max(4, Math.floor(Number(updates.contextMessageLimit) || this.defaultConfig.contextMessageLimit))
        )
      }
      if (updates.contextWindowTokens !== undefined) {
        updates.contextWindowTokens = Math.min(
          1000000,
          Math.max(8192, Math.floor(Number(updates.contextWindowTokens) || this.defaultConfig.contextWindowTokens))
        )
      }
      
      const newConfig = { ...currentConfig, ...updates };
      if (updates.language !== undefined) {
        newConfig.languageDetectionSource = updates.language === "auto" ? "auto" : "detected";
      }
      newConfig.fallbackEnabled = newConfig.fallbackEnabled === true;
      newConfig.fallbackApiProvider = newConfig.fallbackApiProvider === "anthropic" ? "anthropic" : "openai-compatible";
      for (const key of ["fallbackApiKey", "fallbackBaseURL", "fallbackModel"] as const) {
        newConfig[key] = typeof newConfig[key] === "string" ? newConfig[key].trim() : "";
      }
      newConfig.llmTimeoutSeconds = Math.min(180, Math.max(15, Math.floor(Number(newConfig.llmTimeoutSeconds) || 90)));
      if (newConfig.fallbackEnabled) {
        if (!newConfig.fallbackApiKey || !newConfig.fallbackModel) throw new Error("备用线路的 Key 和模型不能为空");
        if (newConfig.fallbackApiProvider === "openai-compatible") {
          const endpoint = new URL(newConfig.fallbackBaseURL);
          if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("备用线路地址必须为 HTTP(S)");
          if (endpoint.username || endpoint.password) throw new Error("请在 API Key 字段填写凭据");
        }
      }
      this.saveConfig(newConfig);
      
      // Only emit update event for changes other than opacity
      // This prevents re-initializing the AI client when only opacity changes
      if (updates.fallbackEnabled !== undefined || updates.fallbackApiProvider !== undefined || updates.fallbackApiKey !== undefined || updates.fallbackBaseURL !== undefined || updates.fallbackModel !== undefined || updates.llmTimeoutSeconds !== undefined || updates.questionMode !== undefined || updates.apiKey !== undefined || updates.apiProvider !== undefined || updates.baseURL !== undefined ||
          updates.extractionModel !== undefined || updates.solutionApiKey !== undefined ||
          updates.solutionBaseURL !== undefined || updates.solutionModel !== undefined ||
          updates.debuggingModel !== undefined || updates.streamingEnabled !== undefined ||
          updates.maxOutputTokens !== undefined || updates.contextMessageLimit !== undefined || updates.contextWindowTokens !== undefined ||
          updates.language !== undefined ||
          updates.speechApiKey !== undefined || updates.speechWorkspaceId !== undefined ||
          updates.speechRegion !== undefined || updates.speechModel !== undefined) {
        this.emit('config-updated', newConfig);
      }
      
      return newConfig;
    } catch (error) {
      console.error('Error updating config:', error);
      return this.defaultConfig;
    }
  }

  /**
   * Check if the API key is configured
   */
  public hasApiKey(): boolean {
    const config = this.loadConfig();
    return !!config.apiKey && config.apiKey.trim().length > 0;
  }
  
  /**
   * Validate the API key format
   */
  public isValidApiKeyFormat(apiKey: string, provider?: APIProvider): boolean {
    // If provider is not specified, attempt to auto-detect
    if (!provider) {
      provider = apiKey.trim().startsWith('sk-ant-')
        ? "anthropic"
        : "openai-compatible";
    }

    if (provider === "openai-compatible") {
      return apiKey.trim().length > 0;
    } else if (provider === "anthropic") {
      // Basic format validation for Anthropic API keys
      return /^sk-ant-[a-zA-Z0-9]{32,}$/.test(apiKey.trim());
    }

    return false;
  }
  
  /**
   * Get the stored opacity value
   */
  public getOpacity(): number {
    const config = this.loadConfig();
    return config.opacity !== undefined ? config.opacity : 1.0;
  }

  /**
   * Set the window opacity value
   */
  public setOpacity(opacity: number): void {
    // Ensure opacity is between 0.1 and 1.0
    const validOpacity = Math.min(1.0, Math.max(0.1, opacity));
    this.updateConfig({ opacity: validOpacity });
  }  
  
  /**
   * Get the preferred programming language
   */
  public getLanguage(): string {
    const config = this.loadConfig();
    return config.language || "auto";
  }

  /**
   * Set the preferred programming language
   */
  public setLanguage(language: string): void {
    this.updateConfig({ language });
  }
  
  /**
   * Test API key with the selected provider
   */
  public async testApiKey(apiKey: string, provider?: APIProvider, baseURL?: string): Promise<{valid: boolean, error?: string}> {
    // Auto-detect provider based on key format if not specified
    if (!provider) {
      provider = apiKey.trim().startsWith('sk-ant-')
        ? "anthropic"
        : "openai-compatible";
      console.log(`Auto-detected API provider for testing: ${provider}`);
    }

    if (provider === "openai-compatible") {
      return this.testOpenAIKey(apiKey, baseURL);
    } else if (provider === "anthropic") {
      return this.testAnthropicKey(apiKey);
    }

    return { valid: false, error: "Unknown API provider" };
  }
  
  /**
   * Test OpenAI API key
   */
  private async testOpenAIKey(apiKey: string, baseURL?: string): Promise<{valid: boolean, error?: string}> {
    try {
      const openai = new OpenAI({ apiKey, ...(baseURL ? { baseURL: baseURL.replace(/\/$/, "") } : {}) });
      // Make a simple API call to test the key
      await openai.models.list();
      return { valid: true };
    } catch (error: unknown) {
      console.error('OpenAI-compatible API key test failed:', error);
      
      const status = typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status?: unknown }).status)
        : undefined;
      const message = error instanceof Error ? error.message : "";

      // Determine the specific error type for better error messages
      let errorMessage = 'Unknown error validating OpenAI-compatible API key';

      if (status === 401) {
        errorMessage = 'Invalid API key. Please check your OpenAI-compatible endpoint key and try again.';
      } else if (status === 429) {
        errorMessage = 'Rate limit exceeded. Your OpenAI-compatible endpoint key has reached its request limit or has insufficient quota.';
      } else if (status === 500) {
        errorMessage = 'OpenAI-compatible endpoint server error. Please try again later.';
      } else if (message) {
        errorMessage = `Error: ${message}`;
      }
      return { valid: false, error: errorMessage };
    }
  }
  

  /**
   * Test Anthropic API key
   * Note: This is a simplified implementation since we don't have the actual Anthropic client
   */
  private async testAnthropicKey(apiKey: string): Promise<{valid: boolean, error?: string}> {
    try {
      // For now, we'll just do a basic check to ensure the key exists and has valid format
      // In production, you would connect to the Anthropic API and validate the key
      if (apiKey && /^sk-ant-[a-zA-Z0-9]{32,}$/.test(apiKey.trim())) {
        // Here you would actually validate the key with an Anthropic API call
        return { valid: true };
      }
      return { valid: false, error: 'Invalid Anthropic API key format.' };
    } catch (error: unknown) {
      console.error('Anthropic API key test failed:', error);
      const message = error instanceof Error ? error.message : "";
      let errorMessage = 'Unknown error validating Anthropic API key';
      if (message) {
        errorMessage = `Error: ${message}`;
      }
      return { valid: false, error: errorMessage };
    }
  }
}

// Export a singleton instance
export const configHelper = new ConfigHelper();
