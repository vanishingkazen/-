// ConfigHelper.ts
import fs from "node:fs"
import path from "node:path"
import { app } from "electron"
import { EventEmitter } from "events"
import { OpenAI } from "openai"
import { DEFAULT_INTERVIEW_CONTEXT_PATH } from "./InterviewContextHelper"

export type APIProvider = "openai" | "openai-compatible" | "gemini" | "anthropic";
export type QuestionMode = "coding" | "iq";

export interface Config {
  questionMode: QuestionMode;
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
  opacity: number;
}

export class ConfigHelper extends EventEmitter {
  private configPath: string;
  private defaultConfig: Config = {
    questionMode: "coding",
    apiKey: "",
    apiProvider: "gemini", // Default to Gemini
    baseURL: "",
    extractionModel: "gemini-2.0-flash", // Default to Flash for faster responses
    solutionApiKey: "",
    solutionBaseURL: "",
    solutionModel: "gemini-2.0-flash",
    debuggingModel: "gemini-2.0-flash",
    streamingEnabled: true,
    maxOutputTokens: 32768,
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

    if (provider === "openai") {
      // Only allow gpt-4o and gpt-4o-mini for OpenAI
      const allowedModels = ['gpt-4o', 'gpt-4o-mini'];
      if (!allowedModels.includes(model)) {
        console.warn(`Invalid OpenAI model specified: ${model}. Using default model: gpt-4o`);
        return 'gpt-4o';
      }
      return model;
    } else if (provider === "gemini")  {
      // Only allow gemini-1.5-pro and gemini-2.0-flash for Gemini
      const allowedModels = ['gemini-1.5-pro', 'gemini-2.0-flash'];
      if (!allowedModels.includes(model)) {
        console.warn(`Invalid Gemini model specified: ${model}. Using default model: gemini-2.0-flash`);
        return 'gemini-2.0-flash'; // Changed default to flash
      }
      return model;
    }  else if (provider === "anthropic") {
      // Only allow Claude models
      const allowedModels = ['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-3-opus-20240229'];
      if (!allowedModels.includes(model)) {
        console.warn(`Invalid Anthropic model specified: ${model}. Using default model: claude-3-7-sonnet-20250219`);
        return 'claude-3-7-sonnet-20250219';
      }
      return model;
    }
    // Default fallback
    return model;
  }

  public loadConfig(): Config {
    try {
      if (fs.existsSync(this.configPath)) {
        const configData = fs.readFileSync(this.configPath, 'utf8');
        const config = JSON.parse(configData);
        
        // Ensure apiProvider is a valid value
        if (config.apiProvider !== "openai" && config.apiProvider !== "openai-compatible" && config.apiProvider !== "gemini"  && config.apiProvider !== "anthropic") {
          config.apiProvider = "gemini"; // Default to Gemini if invalid
        }
        if (config.questionMode !== "coding" && config.questionMode !== "iq") {
          config.questionMode = "coding";
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
        // If API key starts with "sk-", it's likely an OpenAI key
        if (updates.apiKey.trim().startsWith('sk-')) {
          provider = "openai";
          console.log("Auto-detected OpenAI API key format");
        } else if (updates.apiKey.trim().startsWith('sk-ant-')) {
          provider = "anthropic";
          console.log("Auto-detected Anthropic API key format");
        } else {
          provider = "gemini";
          console.log("Using Gemini API key format (default)");
        }
        
        // Update the provider in the updates object
        updates.apiProvider = provider;
      }
      
      // If provider is changing, reset models to the default for that provider
      if (updates.apiProvider && updates.apiProvider !== currentConfig.apiProvider) {
        if (updates.apiProvider === "openai") {
          updates.extractionModel ||= "gpt-4o";
          updates.solutionModel ||= "gpt-4o";
          updates.debuggingModel ||= "gpt-4o";
        } else if (updates.apiProvider === "openai-compatible") {
          updates.extractionModel ||= "gpt-4o";
          updates.solutionModel ||= "gpt-4o";
          updates.debuggingModel ||= "gpt-4o";
        } else if (updates.apiProvider === "anthropic") {
          updates.extractionModel ||= "claude-3-7-sonnet-20250219";
          updates.solutionModel ||= "claude-3-7-sonnet-20250219";
          updates.debuggingModel ||= "claude-3-7-sonnet-20250219";
        } else {
          updates.extractionModel ||= "gemini-2.0-flash";
          updates.solutionModel ||= "gemini-2.0-flash";
          updates.debuggingModel ||= "gemini-2.0-flash";
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
      this.saveConfig(newConfig);
      
      // Only emit update event for changes other than opacity
      // This prevents re-initializing the AI client when only opacity changes
      if (updates.questionMode !== undefined || updates.apiKey !== undefined || updates.apiProvider !== undefined || updates.baseURL !== undefined ||
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
      if (apiKey.trim().startsWith('sk-')) {
        if (apiKey.trim().startsWith('sk-ant-')) {
          provider = "anthropic";
        } else {
          provider = "openai";
        }
      } else {
        provider = "gemini";
      }
    }
    
    if (provider === "openai-compatible") {
      return apiKey.trim().length > 0;
    } else if (provider === "openai") {
      // Basic format validation for OpenAI API keys
      return /^sk-[a-zA-Z0-9]{32,}$/.test(apiKey.trim());
    } else if (provider === "gemini") {
      // Basic format validation for Gemini API keys (usually alphanumeric with no specific prefix)
      return apiKey.trim().length >= 10; // Assuming Gemini keys are at least 10 chars
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
      if (apiKey.trim().startsWith('sk-')) {
        if (apiKey.trim().startsWith('sk-ant-')) {
          provider = "anthropic";
          console.log("Auto-detected Anthropic API key format for testing");
        } else {
          provider = "openai";
          console.log("Auto-detected OpenAI API key format for testing");
        }
      } else {
        provider = "gemini";
        console.log("Using Gemini API key format for testing (default)");
      }
    }
    
    if (provider === "openai-compatible") {
      return this.testOpenAIKey(apiKey, baseURL);
    } else if (provider === "openai") {
      return this.testOpenAIKey(apiKey);
    } else if (provider === "gemini") {
      return this.testGeminiKey(apiKey);
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
    } catch (error: any) {
      console.error('OpenAI API key test failed:', error);
      
      // Determine the specific error type for better error messages
      let errorMessage = 'Unknown error validating OpenAI API key';
      
      if (error.status === 401) {
        errorMessage = 'Invalid API key. Please check your OpenAI key and try again.';
      } else if (error.status === 429) {
        errorMessage = 'Rate limit exceeded. Your OpenAI API key has reached its request limit or has insufficient quota.';
      } else if (error.status === 500) {
        errorMessage = 'OpenAI server error. Please try again later.';
      } else if (error.message) {
        errorMessage = `Error: ${error.message}`;
      }
      
      return { valid: false, error: errorMessage };
    }
  }
  
  /**
   * Test Gemini API key
   * Note: This is a simplified implementation since we don't have the actual Gemini client
   */
  private async testGeminiKey(apiKey: string): Promise<{valid: boolean, error?: string}> {
    try {
      // For now, we'll just do a basic check to ensure the key exists and has valid format
      // In production, you would connect to the Gemini API and validate the key
      if (apiKey && apiKey.trim().length >= 20) {
        // Here you would actually validate the key with a Gemini API call
        return { valid: true };
      }
      return { valid: false, error: 'Invalid Gemini API key format.' };
    } catch (error: any) {
      console.error('Gemini API key test failed:', error);
      let errorMessage = 'Unknown error validating Gemini API key';
      
      if (error.message) {
        errorMessage = `Error: ${error.message}`;
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
    } catch (error: any) {
      console.error('Anthropic API key test failed:', error);
      let errorMessage = 'Unknown error validating Anthropic API key';
      
      if (error.message) {
        errorMessage = `Error: ${error.message}`;
      }
      
      return { valid: false, error: errorMessage };
    }
  }
}

// Export a singleton instance
export const configHelper = new ConfigHelper();
