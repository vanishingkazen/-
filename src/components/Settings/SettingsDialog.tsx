import { useState, useEffect, useRef, type CSSProperties } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { useToast } from "../../contexts/toast";
import { COMMAND_KEY } from "../../utils/platform";

type APIProvider = "openai" | "openai-compatible" | "gemini" | "anthropic";

type AIModel = {
  id: string;
  name: string;
  description: string;
};

type ModelCategory = {
  key: 'extractionModel' | 'solutionModel' | 'debuggingModel';
  title: string;
  description: string;
  openaiModels: AIModel[];
  geminiModels: AIModel[];
  anthropicModels: AIModel[];
};

// Define available models for each category
const modelCategories: ModelCategory[] = [
  {
    key: 'extractionModel',
    title: 'Visual Solving (Screenshots)',
    description: 'Vision model used to analyze screenshots and solve the problem directly',
    openaiModels: [
      {
        id: "gpt-4o",
        name: "gpt-4o",
        description: "Best overall performance for problem extraction"
      },
      {
        id: "gpt-4o-mini",
        name: "gpt-4o-mini",
        description: "Faster, more cost-effective option"
      }
    ],
    geminiModels: [
      {
        id: "gemini-1.5-pro",
        name: "Gemini 1.5 Pro",
        description: "Best overall performance for problem extraction"
      },
      {
        id: "gemini-2.0-flash",
        name: "Gemini 2.0 Flash",
        description: "Faster, more cost-effective option"
      }
    ],
    anthropicModels: [
      {
        id: "claude-3-7-sonnet-20250219",
        name: "Claude 3.7 Sonnet",
        description: "Best overall performance for problem extraction"
      },
      {
        id: "claude-3-5-sonnet-20241022",
        name: "Claude 3.5 Sonnet",
        description: "Balanced performance and speed"
      },
      {
        id: "claude-3-opus-20240229",
        name: "Claude 3 Opus",
        description: "Top-level intelligence, fluency, and understanding"
      }
    ]
  },
  {
    key: 'solutionModel',
    title: 'Follow-up Chat',
    description: 'Model used for text follow-up and code discussion',
    openaiModels: [
      {
        id: "gpt-4o",
        name: "gpt-4o",
        description: "Strong overall performance for coding tasks"
      },
      {
        id: "gpt-4o-mini",
        name: "gpt-4o-mini",
        description: "Faster, more cost-effective option"
      }
    ],
    geminiModels: [
      {
        id: "gemini-1.5-pro",
        name: "Gemini 1.5 Pro",
        description: "Strong overall performance for coding tasks"
      },
      {
        id: "gemini-2.0-flash",
        name: "Gemini 2.0 Flash",
        description: "Faster, more cost-effective option"
      }
    ],
    anthropicModels: [
      {
        id: "claude-3-7-sonnet-20250219",
        name: "Claude 3.7 Sonnet",
        description: "Strong overall performance for coding tasks"
      },
      {
        id: "claude-3-5-sonnet-20241022",
        name: "Claude 3.5 Sonnet",
        description: "Balanced performance and speed"
      },
      {
        id: "claude-3-opus-20240229",
        name: "Claude 3 Opus",
        description: "Top-level intelligence, fluency, and understanding"
      }
    ]
  },
  {
    key: 'debuggingModel',
    title: 'Debugging',
    description: 'Model used to debug and improve solutions',
    openaiModels: [
      {
        id: "gpt-4o",
        name: "gpt-4o",
        description: "Best for analyzing code and error messages"
      },
      {
        id: "gpt-4o-mini",
        name: "gpt-4o-mini",
        description: "Faster, more cost-effective option"
      }
    ],
    geminiModels: [
      {
        id: "gemini-1.5-pro",
        name: "Gemini 1.5 Pro",
        description: "Best for analyzing code and error messages"
      },
      {
        id: "gemini-2.0-flash",
        name: "Gemini 2.0 Flash",
        description: "Faster, more cost-effective option"
      }
    ],
    anthropicModels: [
      {
        id: "claude-3-7-sonnet-20250219",
        name: "Claude 3.7 Sonnet",
        description: "Best for analyzing code and error messages"
      },
      {
        id: "claude-3-5-sonnet-20241022",
        name: "Claude 3.5 Sonnet",
        description: "Balanced performance and speed"
      },
      {
        id: "claude-3-opus-20240229",
        name: "Claude 3 Opus",
        description: "Top-level intelligence, fluency, and understanding"
      }
    ]
  }
];

interface SettingsDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SettingsDialog({ open: externalOpen, onOpenChange }: SettingsDialogProps) {
  const [open, setOpen] = useState(externalOpen || false);
  const [apiKey, setApiKey] = useState("");
  const [apiProvider, setApiProvider] = useState<APIProvider>("openai");
  const [baseURL, setBaseURL] = useState("");
  const [extractionModel, setExtractionModel] = useState("gpt-4o");
  const [solutionApiKey, setSolutionApiKey] = useState("");
  const [solutionBaseURL, setSolutionBaseURL] = useState("");
  const [solutionModel, setSolutionModel] = useState("gpt-4o");
  const [debuggingModel, setDebuggingModel] = useState("gpt-4o");
  const [streamingEnabled, setStreamingEnabled] = useState(true);
  const [maxOutputTokens, setMaxOutputTokens] = useState(32768);
  const [contextMessageLimit, setContextMessageLimit] = useState(30);
  const [contextWindowTokens, setContextWindowTokens] = useState(128000);
  const [opacity, setOpacity] = useState(1);
  const savedOpacityRef = useRef(1);
  const [interviewContextPath, setInterviewContextPath] = useState("");
  const [speechApiKey, setSpeechApiKey] = useState("");
  const [speechWorkspaceId, setSpeechWorkspaceId] = useState("");
  const [speechRegion, setSpeechRegion] = useState("cn-beijing");
  const [speechModel, setSpeechModel] = useState("qwen-audio-3.0-asr-flash-streaming");
  const [isLoading, setIsLoading] = useState(false);
  const { showToast } = useToast();

  // Sync with external open state
  useEffect(() => {
    if (externalOpen !== undefined) {
      setOpen(externalOpen);
    }
  }, [externalOpen]);

  // Handle open state changes
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      void window.electronAPI.setOpacity(savedOpacityRef.current);
    }
    setOpen(newOpen);
    // Only call onOpenChange when there's actually a change
    if (onOpenChange && newOpen !== externalOpen) {
      onOpenChange(newOpen);
    }
  };
  
  // Load current config on dialog open
  useEffect(() => {
    if (open) {
      setIsLoading(true);
      interface Config {
        apiKey?: string;
        apiProvider?: APIProvider;
        baseURL?: string;
        extractionModel?: string;
        solutionApiKey?: string;
        solutionBaseURL?: string;
        solutionModel?: string;
        debuggingModel?: string;
        streamingEnabled?: boolean;
        maxOutputTokens?: number;
        contextMessageLimit?: number;
        contextWindowTokens?: number;
        opacity?: number;
        interviewContextPath?: string;
        speechApiKey?: string;
        speechWorkspaceId?: string;
        speechRegion?: string;
        speechModel?: string;
      }

      window.electronAPI
        .getConfig()
        .then((config: Config) => {
          setApiKey(config.apiKey || "");
          setApiProvider(config.apiProvider || "openai");
          setBaseURL(config.baseURL || "");
          setExtractionModel(config.extractionModel || "gpt-4o");
          setSolutionApiKey(config.solutionApiKey || "");
          setSolutionBaseURL(config.solutionBaseURL || "");
          setSolutionModel(config.solutionModel || "gpt-4o");
          setDebuggingModel(config.debuggingModel || "gpt-4o");
          setStreamingEnabled(config.streamingEnabled !== false);
          setMaxOutputTokens(config.maxOutputTokens || 32768);
          setContextMessageLimit(config.contextMessageLimit || 30);
          setContextWindowTokens(config.contextWindowTokens || 128000);
          const loadedOpacity = Math.min(1, Math.max(0.1, config.opacity ?? 1));
          setOpacity(loadedOpacity);
          savedOpacityRef.current = loadedOpacity;
          setInterviewContextPath(config.interviewContextPath || "");
          setSpeechApiKey(config.speechApiKey || "");
          setSpeechWorkspaceId(config.speechWorkspaceId || "");
          setSpeechRegion(config.speechRegion || "cn-beijing");
          setSpeechModel(config.speechModel || "qwen-audio-3.0-asr-flash-streaming");
        })
        .catch((error: unknown) => {
          console.error("Failed to load config:", error);
          showToast("Error", "Failed to load settings", "error");
        })
        .finally(() => {
          setIsLoading(false);
        });
    }
  }, [open, showToast]);

  // Handle API provider change
  const handleProviderChange = (provider: APIProvider) => {
    setApiProvider(provider);
    
    // Reset models to defaults when changing provider
    if (provider === "openai") {
      setExtractionModel("gpt-4o");
      setSolutionModel("gpt-4o");
      setDebuggingModel("gpt-4o");
    } else if (provider === "openai-compatible") {
      setExtractionModel("gpt-4o");
      setSolutionModel("gpt-4o");
      setDebuggingModel("gpt-4o");
    } else if (provider === "gemini") {
      setExtractionModel("gemini-1.5-pro");
      setSolutionModel("gemini-1.5-pro");
      setDebuggingModel("gemini-1.5-pro");
    } else if (provider === "anthropic") {
      setExtractionModel("claude-3-7-sonnet-20250219");
      setSolutionModel("claude-3-7-sonnet-20250219");
      setDebuggingModel("claude-3-7-sonnet-20250219");
    }
  };

  const handleSave = async () => {
    if (apiProvider === "openai-compatible") {
      try {
        const url = new URL(baseURL.trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new Error("Unsupported protocol");
        }
      } catch {
        showToast("Error", "Enter a valid HTTP(S) API Base URL", "error");
        return;
      }
    }

    if (solutionBaseURL.trim() || solutionApiKey.trim()) {
      try {
        const url = new URL(solutionBaseURL.trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new Error("Unsupported protocol");
        }
        if (!solutionApiKey.trim() || !solutionModel.trim()) {
          throw new Error("Incomplete solution endpoint");
        }
      } catch {
        showToast("Error", "Complete the cloud solution URL, API key, and model", "error");
        return;
      }
    }

    setIsLoading(true);
    try {
      const result = await window.electronAPI.updateConfig({
        apiKey,
        apiProvider,
        baseURL: baseURL.trim().replace(/\/$/, ""),
        extractionModel,
        solutionApiKey,
        solutionBaseURL: solutionBaseURL.trim().replace(/\/$/, ""),
        solutionModel,
        debuggingModel,
        streamingEnabled,
        maxOutputTokens,
        contextMessageLimit,
        contextWindowTokens,
        opacity,
        interviewContextPath,
        speechApiKey,
        speechWorkspaceId: speechWorkspaceId.trim(),
        speechRegion,
        speechModel: speechModel.trim(),
      });
      
      if (result) {
        savedOpacityRef.current = opacity;
        showToast("Success", "Settings saved successfully", "success");
        handleOpenChange(false);
        
        // Force reload the app to apply the API key
        setTimeout(() => {
          window.location.reload();
        }, 1500);
      }
    } catch (error) {
      console.error("Failed to save settings:", error);
      showToast("Error", "Failed to save settings", "error");
    } finally {
      setIsLoading(false);
    }
  };

  // Mask API key for display
  const maskApiKey = (key: string) => {
    if (!key || key.length < 10) return "";
    return `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;
  };

  // Open external link handler
  const openExternalLink = (url: string) => {
    window.electronAPI.openLink(url);
  };

  const openInterviewContextFile = async () => {
    const targetPath = interviewContextPath.trim();
    if (targetPath) {
      await window.electronAPI.updateConfig({ interviewContextPath: targetPath });
    }
    const result = await window.electronAPI.openInterviewContextFile();
    if (!result.success) {
      showToast("无法打开上下文文件", result.error || "请检查文件路径", "error");
      return;
    }
    if (result.path) setInterviewContextPath(result.path);
  };

  const opacityProgress = `${((opacity - 0.1) / 0.9) * 100}%`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent 
        className="sm:max-w-md bg-white/[0.90] border border-black/10 text-black settings-dialog"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(450px, 90vw)',
          height: 'auto',
          minHeight: '400px',
          maxHeight: '90vh',
          overflowY: 'auto',
          zIndex: 9999,
          margin: 0,
          padding: '20px',
          transition: 'opacity 0.25s ease, transform 0.25s ease',
          animation: 'fadeIn 0.25s ease forwards',
          opacity: 0.98
        }}
      >        
        <DialogHeader>
          <DialogTitle>API Settings</DialogTitle>
          <DialogDescription className="text-black/65">
            Configure your API key and model preferences. You'll need your own API key to use this application.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 rounded-lg border border-black/10 bg-white/[0.52] p-3">
          <div className="flex items-center justify-between gap-3">
            <label className="text-sm font-medium text-black" htmlFor="ui-opacity">界面透明度</label>
            <span className="rounded-md bg-black/[0.06] px-2 py-1 text-xs font-medium tabular-nums text-black/75">
              {Math.round(opacity * 100)}%
            </span>
          </div>
          <input
            id="ui-opacity"
            type="range"
            min="0.1"
            max="1"
            step="0.01"
            value={opacity}
            onChange={(event) => {
              const nextOpacity = Math.min(1, Math.max(0.1, Number(event.target.value)));
              setOpacity(nextOpacity);
              void window.electronAPI.setOpacity(nextOpacity);
            }}
            className="opacity-slider"
            style={{ "--opacity-progress": opacityProgress } as CSSProperties}
          />
          <p className="text-xs text-black/50">拖动时实时预览，点击保存后永久生效。</p>
        </div>
        <div className="space-y-4 py-4">
          <div className="space-y-2 rounded-lg border border-black/10 bg-white/[0.52] p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <label className="text-sm font-medium text-black" htmlFor="interviewContextPath">面试上下文文件</label>
                <p className="mt-1 text-xs text-black/60">
                  填入简历、项目经历和岗位资料。留空时使用默认路径，文件不存在会自动创建。
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 border-black/15 text-black hover:bg-black/[0.05]"
                onClick={() => void openInterviewContextFile()}
              >
                打开文件
              </Button>
            </div>
            <Input
              id="interviewContextPath"
              value={interviewContextPath}
              onChange={(event) => setInterviewContextPath(event.target.value)}
              placeholder="留空使用默认路径"
              className="bg-white/[0.68] border-black/10 text-black font-mono"
            />
            <p className="text-[11px] text-black/50">
              默认：~/Library/Application Support/steamgamecode/interview-context.md
            </p>
          </div>

          {/* API Provider Selection */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-black">API Provider</label>
            <div className="grid grid-cols-2 gap-2">
              <div
                className={`flex-1 p-2 rounded-lg cursor-pointer transition-colors ${
                  apiProvider === "openai"
                    ? "bg-black/[0.06] border border-black/20"
                    : "bg-white/[0.48] border border-black/5 hover:bg-black/[0.04]"
                }`}
                onClick={() => handleProviderChange("openai")}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`w-3 h-3 rounded-full ${
                      apiProvider === "openai" ? "bg-black" : "bg-black/20"
                    }`}
                  />
                  <div className="flex flex-col">
                    <p className="font-medium text-black text-sm">OpenAI</p>
                    <p className="text-xs text-black/60">GPT-4o models</p>
                  </div>
                </div>
              </div>
              <div
                className={`flex-1 p-2 rounded-lg cursor-pointer transition-colors ${
                  apiProvider === "openai-compatible"
                    ? "bg-black/[0.06] border border-black/20"
                    : "bg-white/[0.48] border border-black/5 hover:bg-black/[0.04]"
                }`}
                onClick={() => handleProviderChange("openai-compatible")}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`w-3 h-3 rounded-full ${
                      apiProvider === "openai-compatible" ? "bg-black" : "bg-black/20"
                    }`}
                  />
                  <div className="flex flex-col">
                    <p className="font-medium text-black text-sm">OpenAI Compatible</p>
                    <p className="text-xs text-black/60">Custom endpoint</p>
                  </div>
                </div>
              </div>
              <div
                className={`flex-1 p-2 rounded-lg cursor-pointer transition-colors ${
                  apiProvider === "gemini"
                    ? "bg-black/[0.06] border border-black/20"
                    : "bg-white/[0.48] border border-black/5 hover:bg-black/[0.04]"
                }`}
                onClick={() => handleProviderChange("gemini")}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`w-3 h-3 rounded-full ${
                      apiProvider === "gemini" ? "bg-black" : "bg-black/20"
                    }`}
                  />
                  <div className="flex flex-col">
                    <p className="font-medium text-black text-sm">Gemini</p>
                    <p className="text-xs text-black/60">Gemini 1.5 models</p>
                  </div>
                </div>
              </div>
              <div
                className={`flex-1 p-2 rounded-lg cursor-pointer transition-colors ${
                  apiProvider === "anthropic"
                    ? "bg-black/[0.06] border border-black/20"
                    : "bg-white/[0.48] border border-black/5 hover:bg-black/[0.04]"
                }`}
                onClick={() => handleProviderChange("anthropic")}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`w-3 h-3 rounded-full ${
                      apiProvider === "anthropic" ? "bg-black" : "bg-black/20"
                    }`}
                  />
                  <div className="flex flex-col">
                    <p className="font-medium text-black text-sm">Claude</p>
                    <p className="text-xs text-black/60">Claude 3 models</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {apiProvider === "openai-compatible" && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-black" htmlFor="baseURL">
                API Base URL
              </label>
              <Input
                id="baseURL"
                type="url"
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                placeholder="https://api.example.com/v1"
                className="bg-white/[0.68] border-black/10 text-black"
              />
              <p className="text-xs text-black/50">
                Include the API version path when required, for example /v1.
              </p>
              <div className="flex items-center justify-between rounded-lg border border-black/10 bg-white/[0.52] p-3">
                <div className="pr-3">
                  <p className="text-sm font-medium text-black">流式输出（Streaming）</p>
                  <p className="text-xs text-black/60">
                    目前仅 DeepSeek 官方接口（api.deepseek.com）支持流式输出
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={streamingEnabled}
                  onClick={() => setStreamingEnabled(!streamingEnabled)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                    streamingEnabled ? "bg-blue-500" : "bg-black/15"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                      streamingEnabled ? "translate-x-5" : ""
                    }`}
                  />
                </button>
              </div>
            </div>
          )}

          <div className="space-y-3 rounded-lg border border-black/10 bg-white/[0.52] p-3">
            <div>
              <label className="text-sm font-medium text-black" htmlFor="context-message-limit">
                上下文消息数
              </label>
              <p className="mt-1 text-xs text-black/55">
                每次追问会携带最近 N 条对话消息；数值越大，上下文越完整，但请求也越大。
              </p>
              <Input
                id="context-message-limit"
                type="number"
                min={4}
                max={100}
                value={contextMessageLimit}
                onChange={(event) => setContextMessageLimit(Number(event.target.value))}
                className="mt-2 bg-white/[0.68] border-black/10 text-black"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-black" htmlFor="context-window-tokens">
                模型上下文窗口 Tokens
              </label>
              <p className="mt-1 text-xs text-black/55">
                当前模型可接收的最大上下文长度，用于判断何时压缩历史对话。
              </p>
              <Input
                id="context-window-tokens"
                type="number"
                min={8192}
                max={1000000}
                step={1024}
                value={contextWindowTokens}
                onChange={(event) => setContextWindowTokens(Number(event.target.value))}
                className="mt-2 bg-white/[0.68] border-black/10 text-black"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-black" htmlFor="max-output-tokens">
                单次最大输出 Tokens
              </label>
              <p className="mt-1 text-xs text-black/55">
                截图解题、文字追问和调试模式共用的最大输出长度。范围 1024～65536。
              </p>
              <Input
                id="max-output-tokens"
                type="number"
                min={1024}
                max={65536}
                step={1024}
                value={maxOutputTokens}
                onChange={(event) => setMaxOutputTokens(Number(event.target.value))}
                className="mt-2 bg-white/[0.68] border-black/10 text-black"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-black" htmlFor="apiKey">
            {apiProvider === "openai-compatible" ? "Compatible API Key" :
             apiProvider === "openai" ? "OpenAI API Key" :
             apiProvider === "gemini" ? "Gemini API Key" : 
             "Anthropic API Key"}
            </label>
            <Input
              id="apiKey"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                apiProvider === "openai-compatible" ? "Enter the key required by your endpoint" :
                apiProvider === "openai" ? "sk-..." : 
                apiProvider === "gemini" ? "Enter your Gemini API key" :
                "sk-ant-..."
              }
              className="bg-white/[0.68] border-black/10 text-black"
            />
            {apiKey && (
              <p className="text-xs text-black/50">
                Current: {maskApiKey(apiKey)}
              </p>
            )}
            <p className="text-xs text-black/50">
              Your API key is stored locally and sent only to {
                apiProvider === "openai-compatible" ? "your configured endpoint" :
                apiProvider === "openai" ? "OpenAI" :
                apiProvider === "gemini" ? "Google" : "Anthropic"
              }.
            </p>
            <div className="mt-2 p-2 rounded-md bg-white/[0.52] border border-black/10">
              <p className="text-xs text-black/75 mb-1">Don't have an API key?</p>
              {apiProvider === "openai-compatible" ? (
                <p className="text-xs text-black/60">
                  Use the API key issued by your OpenAI-compatible service. The endpoint must support Chat Completions and image inputs for screenshot extraction.
                </p>
              ) : apiProvider === "openai" ? (
                <>
                  <p className="text-xs text-black/60 mb-1">1. Create an account at <button 
                    onClick={() => openExternalLink('https://platform.openai.com/signup')} 
                    className="text-blue-600 hover:underline cursor-pointer">OpenAI</button>
                  </p>
                  <p className="text-xs text-black/60 mb-1">2. Go to <button 
                    onClick={() => openExternalLink('https://platform.openai.com/api-keys')} 
                    className="text-blue-600 hover:underline cursor-pointer">API Keys</button> section
                  </p>
                  <p className="text-xs text-black/60">3. Create a new secret key and paste it here</p>
                </>
              ) : apiProvider === "gemini" ?  (
                <>
                  <p className="text-xs text-black/60 mb-1">1. Create an account at <button 
                    onClick={() => openExternalLink('https://aistudio.google.com/')} 
                    className="text-blue-600 hover:underline cursor-pointer">Google AI Studio</button>
                  </p>
                  <p className="text-xs text-black/60 mb-1">2. Go to the <button 
                    onClick={() => openExternalLink('https://aistudio.google.com/app/apikey')} 
                    className="text-blue-600 hover:underline cursor-pointer">API Keys</button> section
                  </p>
                  <p className="text-xs text-black/60">3. Create a new API key and paste it here</p>
                </>
              ) : (
                <>
                  <p className="text-xs text-black/60 mb-1">1. Create an account at <button 
                    onClick={() => openExternalLink('https://console.anthropic.com/signup')} 
                    className="text-blue-600 hover:underline cursor-pointer">Anthropic</button>
                  </p>
                  <p className="text-xs text-black/60 mb-1">2. Go to the <button 
                    onClick={() => openExternalLink('https://console.anthropic.com/settings/keys')} 
                    className="text-blue-600 hover:underline cursor-pointer">API Keys</button> section
                  </p>
                  <p className="text-xs text-black/60">3. Create a new API key and paste it here</p>
                </>
              )}
            </div>
          </div>
          
          <div className="space-y-2 mt-4">
            <label className="text-sm font-medium text-black mb-2 block">Keyboard Shortcuts</label>
            <div className="bg-white/[0.48] border border-black/10 rounded-lg p-3">
              <div className="grid grid-cols-2 gap-y-2 text-xs">
                <div className="text-black/65">Toggle Visibility</div>
                <div className="text-black/80 font-mono">/</div>
                
                <div className="text-black/65">Mouse Shake</div>
                <div className="text-black/80">快速左右晃动 4 次</div>
                
                <div className="text-black/65">New Session</div>
                <div className="text-black/80 font-mono">{COMMAND_KEY}+N</div>
                
                <div className="text-black/65">Take Screenshot</div>
                <div className="text-black/80 font-mono">{COMMAND_KEY}+H</div>
                
                <div className="text-black/65">Process Screenshots</div>
                <div className="text-black/80 font-mono">{COMMAND_KEY}+Enter</div>

                <div className="text-black/65">Toggle Voice Input</div>
                <div className="text-black/80 font-mono">{COMMAND_KEY}+Shift+M</div>
                
                <div className="text-black/65">Delete Last Screenshot</div>
                <div className="text-black/80 font-mono">{COMMAND_KEY}+L</div>
                
                <div className="text-black/65">Reset View</div>
                <div className="text-black/80 font-mono">{COMMAND_KEY}+R</div>
                
                <div className="text-black/65">Quit Application</div>
                <div className="text-black/80 font-mono">{COMMAND_KEY}+Q</div>
                
                <div className="text-black/65">Move Window</div>
                <div className="text-black/80 font-mono">{COMMAND_KEY}+Arrow Keys</div>
                
                <div className="text-black/65">Decrease Opacity</div>
                <div className="text-black/80 font-mono">{COMMAND_KEY}+[</div>
                
                <div className="text-black/65">Increase Opacity</div>
                <div className="text-black/80 font-mono">{COMMAND_KEY}+]</div>
                
                <div className="text-black/65">Zoom Out</div>
                <div className="text-black/80 font-mono">{COMMAND_KEY}+-</div>
                
                <div className="text-black/65">Reset Zoom</div>
                <div className="text-black/80 font-mono">{COMMAND_KEY}+0</div>
                
                <div className="text-black/65">Zoom In</div>
                <div className="text-black/80 font-mono">{COMMAND_KEY}+=</div>
              </div>
            </div>
          </div>
          
          <div className="space-y-4 mt-4">
            <div className="space-y-3 rounded-lg border border-black/10 bg-white/[0.52] p-3">
              <div>
                <label className="text-sm font-medium text-black">Qwen Realtime Speech Recognition</label>
                <p className="text-xs text-black/60">
                  Optional Alibaba Cloud realtime transcription used by Ctrl+Shift+M.
                </p>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-black/65" htmlFor="speechApiKey">DashScope API Key</label>
                <Input
                  id="speechApiKey"
                  type="password"
                  value={speechApiKey}
                  onChange={(e) => setSpeechApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="bg-white/[0.68] border-black/10 text-black"
                />
                {speechApiKey && <p className="text-xs text-black/50">Current: {maskApiKey(speechApiKey)}</p>}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-xs text-black/65" htmlFor="speechWorkspaceId">Workspace ID（可选）</label>
                  <Input
                    id="speechWorkspaceId"
                    value={speechWorkspaceId}
                    onChange={(e) => setSpeechWorkspaceId(e.target.value)}
                    placeholder="留空使用公共服务入口"
                    className="bg-white/[0.68] border-black/10 text-black font-mono"
                  />
                  <p className="text-[11px] text-black/[0.45]">仅填写百炼控制台中的真实业务空间 ID</p>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-black/65" htmlFor="speechRegion">Region</label>
                  <select
                    id="speechRegion"
                    value={speechRegion}
                    onChange={(e) => setSpeechRegion(e.target.value)}
                    className="h-10 w-full rounded-md border border-black/10 bg-white/[0.68] px-3 text-sm text-black"
                  >
                    <option value="cn-beijing">北京 cn-beijing</option>
                    <option value="ap-southeast-1">新加坡 ap-southeast-1</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-black/65" htmlFor="speechModel">Speech Model</label>
                <Input
                  id="speechModel"
                  value={speechModel}
                  onChange={(e) => setSpeechModel(e.target.value)}
                  placeholder="qwen-audio-3.0-asr-flash-streaming"
                  className="bg-white/[0.68] border-black/10 text-black font-mono"
                />
              </div>
            </div>

            <div className="space-y-3 rounded-lg border border-black/10 bg-white/[0.52] p-3">
              <div>
                <label className="text-sm font-medium text-black">Cloud Solution Endpoint</label>
                <p className="text-xs text-black/60">
                  Optional separate OpenAI-compatible endpoint used only for solution generation.
                </p>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-black/65" htmlFor="solutionBaseURL">
                  Solution Base URL
                </label>
                <Input
                  id="solutionBaseURL"
                  type="url"
                  value={solutionBaseURL}
                  onChange={(e) => setSolutionBaseURL(e.target.value)}
                  placeholder="https://api.deepseek.com"
                  className="bg-white/[0.68] border-black/10 text-black font-mono"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-black/65" htmlFor="solutionApiKey">
                  Solution API Key
                </label>
                <Input
                  id="solutionApiKey"
                  type="password"
                  value={solutionApiKey}
                  onChange={(e) => setSolutionApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="bg-white/[0.68] border-black/10 text-black"
                />
                {solutionApiKey && (
                  <p className="text-xs text-black/50">
                    Current: {maskApiKey(solutionApiKey)}
                  </p>
                )}
              </div>
            </div>

            <label className="text-sm font-medium text-black">AI Model Selection</label>
            <p className="text-xs text-black/60 -mt-3 mb-2">
              截图由视觉模型直接解题；文字追问和调试使用对应的独立模型。
            </p>
            
            {apiProvider === "openai-compatible" ? (
              <div className="space-y-4">
                {[
                  {
                    id: "customExtractionModel",
                    label: "Visual Solving (Screenshots)",
                    description: "Must support image inputs and direct problem solving",
                    value: extractionModel,
                    setter: setExtractionModel,
                  },
                  {
                    id: "customSolutionModel",
                    label: "Follow-up Chat",
                    description: "Model used for text follow-up and code discussion",
                    value: solutionModel,
                    setter: setSolutionModel,
                  },
                  {
                    id: "customDebuggingModel",
                    label: "Debugging",
                    description: "Model used to debug and improve solutions",
                    value: debuggingModel,
                    setter: setDebuggingModel,
                  },
                ].map((field) => (
                  <div key={field.id} className="space-y-1">
                    <label className="text-sm font-medium text-black" htmlFor={field.id}>
                      {field.label}
                    </label>
                    <p className="text-xs text-black/60">{field.description}</p>
                    <Input
                      id={field.id}
                      value={field.value}
                      onChange={(e) => field.setter(e.target.value)}
                      placeholder="Enter the exact model ID"
                      className="bg-white/[0.68] border-black/10 text-black font-mono"
                    />
                  </div>
                ))}
              </div>
            ) : modelCategories
              .map((category) => {
              // Get the appropriate model list based on selected provider
              const models = 
                apiProvider === "openai" ? category.openaiModels : 
                apiProvider === "gemini" ? category.geminiModels :
                category.anthropicModels;
              
              return (
                <div key={category.key} className="mb-4">
                  <label className="text-sm font-medium text-black mb-1 block">
                    {category.title}
                  </label>
                  <p className="text-xs text-black/60 mb-2">{category.description}</p>
                  
                  <div className="space-y-2">
                    {models.map((m) => {
                      // Determine which state to use based on category key
                      const currentValue = 
                        category.key === 'extractionModel' ? extractionModel :
                        category.key === 'solutionModel' ? solutionModel :
                        debuggingModel;
                      
                      // Determine which setter function to use
                      const setValue = 
                        category.key === 'extractionModel' ? setExtractionModel :
                        category.key === 'solutionModel' ? setSolutionModel :
                        setDebuggingModel;
                        
                      return (
                        <div
                          key={m.id}
                          className={`p-2 rounded-lg cursor-pointer transition-colors ${
                            currentValue === m.id
                              ? "bg-black/[0.06] border border-black/20"
                              : "bg-white/[0.48] border border-black/5 hover:bg-black/[0.04]"
                          }`}
                          onClick={() => setValue(m.id)}
                        >
                          <div className="flex items-center gap-2">
                            <div
                              className={`w-3 h-3 rounded-full ${
                                currentValue === m.id ? "bg-black" : "bg-black/20"
                              }`}
                            />
                            <div>
                              <p className="font-medium text-black text-xs">{m.name}</p>
                              <p className="text-xs text-black/60">{m.description}</p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <DialogFooter className="flex justify-between sm:justify-between">
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-black/10 hover:bg-black/[0.04] text-black"
          >
            Cancel
          </Button>
          <Button
            className="px-4 py-3 bg-black text-white rounded-xl font-medium hover:bg-black/80 transition-colors"
            onClick={handleSave}
            disabled={
              isLoading || !apiKey ||
              Boolean(solutionBaseURL.trim()) !== Boolean(solutionApiKey.trim()) ||
              (apiProvider === "openai-compatible" && (
                !baseURL.trim() || !extractionModel.trim() ||
                (!solutionModel.trim() || !debuggingModel.trim())
              ))
            }
          >
            {isLoading ? "Saving..." : "Save Settings"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
