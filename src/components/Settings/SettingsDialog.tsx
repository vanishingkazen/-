import { useState, useEffect } from "react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Settings } from "lucide-react";
import { useToast } from "../../contexts/toast";

type APIProvider = "openai" | "openai-compatible" | "gemini" | "anthropic";
type QuestionMode = "coding" | "iq";

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
    title: 'Problem Extraction',
    description: 'Model used to analyze screenshots and extract problem details',
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
    title: 'Solution Generation',
    description: 'Model used to generate coding solutions',
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
  const [questionMode, setQuestionMode] = useState<QuestionMode>("coding");
  const [apiKey, setApiKey] = useState("");
  const [apiProvider, setApiProvider] = useState<APIProvider>("openai");
  const [baseURL, setBaseURL] = useState("");
  const [extractionModel, setExtractionModel] = useState("gpt-4o");
  const [solutionApiKey, setSolutionApiKey] = useState("");
  const [solutionBaseURL, setSolutionBaseURL] = useState("");
  const [solutionModel, setSolutionModel] = useState("gpt-4o");
  const [debuggingModel, setDebuggingModel] = useState("gpt-4o");
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
        questionMode?: QuestionMode;
        apiKey?: string;
        apiProvider?: APIProvider;
        baseURL?: string;
        extractionModel?: string;
        solutionApiKey?: string;
        solutionBaseURL?: string;
        solutionModel?: string;
        debuggingModel?: string;
        speechApiKey?: string;
        speechWorkspaceId?: string;
        speechRegion?: string;
        speechModel?: string;
      }

      window.electronAPI
        .getConfig()
        .then((config: Config) => {
          setQuestionMode(config.questionMode || "coding");
          setApiKey(config.apiKey || "");
          setApiProvider(config.apiProvider || "openai");
          setBaseURL(config.baseURL || "");
          setExtractionModel(config.extractionModel || "gpt-4o");
          setSolutionApiKey(config.solutionApiKey || "");
          setSolutionBaseURL(config.solutionBaseURL || "");
          setSolutionModel(config.solutionModel || "gpt-4o");
          setDebuggingModel(config.debuggingModel || "gpt-4o");
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

    if (questionMode === "coding" && (solutionBaseURL.trim() || solutionApiKey.trim())) {
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
        questionMode,
        apiKey,
        apiProvider,
        baseURL: baseURL.trim().replace(/\/$/, ""),
        extractionModel,
        solutionApiKey,
        solutionBaseURL: solutionBaseURL.trim().replace(/\/$/, ""),
        solutionModel,
        debuggingModel,
        speechApiKey,
        speechWorkspaceId: speechWorkspaceId.trim(),
        speechRegion,
        speechModel: speechModel.trim(),
      });
      
      if (result) {
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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent 
        className="sm:max-w-md bg-black border border-white/10 text-white settings-dialog"
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
          <DialogDescription className="text-white/70">
            Configure your API key and model preferences. You'll need your own API key to use this application.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-white">题目模式</label>
            <div className="grid grid-cols-2 gap-2">
              {([
                { value: "coding", title: "编程题", description: "识别题目并生成代码" },
                { value: "iq", title: "IQ 测评", description: "视觉模型直接判断答案" }
              ] as const).map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  className={`p-2 rounded-lg text-left transition-colors ${
                    questionMode === mode.value
                      ? "bg-white/10 border border-white/20"
                      : "bg-black/30 border border-white/5 hover:bg-white/5"
                  }`}
                  onClick={() => setQuestionMode(mode.value)}
                >
                  <p className="font-medium text-white text-sm">{mode.title}</p>
                  <p className="text-xs text-white/60">{mode.description}</p>
                </button>
              ))}
            </div>
            {questionMode === "iq" && (
              <p className="text-xs text-white/60">
                IQ 模式直接使用下方“题目识别”模型分析截图；请选择支持图片输入的视觉模型。
              </p>
            )}
          </div>

          {/* API Provider Selection */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-white">API Provider</label>
            <div className="grid grid-cols-2 gap-2">
              <div
                className={`flex-1 p-2 rounded-lg cursor-pointer transition-colors ${
                  apiProvider === "openai"
                    ? "bg-white/10 border border-white/20"
                    : "bg-black/30 border border-white/5 hover:bg-white/5"
                }`}
                onClick={() => handleProviderChange("openai")}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`w-3 h-3 rounded-full ${
                      apiProvider === "openai" ? "bg-white" : "bg-white/20"
                    }`}
                  />
                  <div className="flex flex-col">
                    <p className="font-medium text-white text-sm">OpenAI</p>
                    <p className="text-xs text-white/60">GPT-4o models</p>
                  </div>
                </div>
              </div>
              <div
                className={`flex-1 p-2 rounded-lg cursor-pointer transition-colors ${
                  apiProvider === "openai-compatible"
                    ? "bg-white/10 border border-white/20"
                    : "bg-black/30 border border-white/5 hover:bg-white/5"
                }`}
                onClick={() => handleProviderChange("openai-compatible")}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`w-3 h-3 rounded-full ${
                      apiProvider === "openai-compatible" ? "bg-white" : "bg-white/20"
                    }`}
                  />
                  <div className="flex flex-col">
                    <p className="font-medium text-white text-sm">OpenAI Compatible</p>
                    <p className="text-xs text-white/60">Custom endpoint</p>
                  </div>
                </div>
              </div>
              <div
                className={`flex-1 p-2 rounded-lg cursor-pointer transition-colors ${
                  apiProvider === "gemini"
                    ? "bg-white/10 border border-white/20"
                    : "bg-black/30 border border-white/5 hover:bg-white/5"
                }`}
                onClick={() => handleProviderChange("gemini")}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`w-3 h-3 rounded-full ${
                      apiProvider === "gemini" ? "bg-white" : "bg-white/20"
                    }`}
                  />
                  <div className="flex flex-col">
                    <p className="font-medium text-white text-sm">Gemini</p>
                    <p className="text-xs text-white/60">Gemini 1.5 models</p>
                  </div>
                </div>
              </div>
              <div
                className={`flex-1 p-2 rounded-lg cursor-pointer transition-colors ${
                  apiProvider === "anthropic"
                    ? "bg-white/10 border border-white/20"
                    : "bg-black/30 border border-white/5 hover:bg-white/5"
                }`}
                onClick={() => handleProviderChange("anthropic")}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`w-3 h-3 rounded-full ${
                      apiProvider === "anthropic" ? "bg-white" : "bg-white/20"
                    }`}
                  />
                  <div className="flex flex-col">
                    <p className="font-medium text-white text-sm">Claude</p>
                    <p className="text-xs text-white/60">Claude 3 models</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {apiProvider === "openai-compatible" && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-white" htmlFor="baseURL">
                API Base URL
              </label>
              <Input
                id="baseURL"
                type="url"
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                placeholder="https://api.example.com/v1"
                className="bg-black/50 border-white/10 text-white"
              />
              <p className="text-xs text-white/50">
                Include the API version path when required, for example /v1.
              </p>
            </div>
          )}
          
          <div className="space-y-2">
            <label className="text-sm font-medium text-white" htmlFor="apiKey">
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
              className="bg-black/50 border-white/10 text-white"
            />
            {apiKey && (
              <p className="text-xs text-white/50">
                Current: {maskApiKey(apiKey)}
              </p>
            )}
            <p className="text-xs text-white/50">
              Your API key is stored locally and sent only to {
                apiProvider === "openai-compatible" ? "your configured endpoint" :
                apiProvider === "openai" ? "OpenAI" :
                apiProvider === "gemini" ? "Google" : "Anthropic"
              }.
            </p>
            <div className="mt-2 p-2 rounded-md bg-white/5 border border-white/10">
              <p className="text-xs text-white/80 mb-1">Don't have an API key?</p>
              {apiProvider === "openai-compatible" ? (
                <p className="text-xs text-white/60">
                  Use the API key issued by your OpenAI-compatible service. The endpoint must support Chat Completions and image inputs for screenshot extraction.
                </p>
              ) : apiProvider === "openai" ? (
                <>
                  <p className="text-xs text-white/60 mb-1">1. Create an account at <button 
                    onClick={() => openExternalLink('https://platform.openai.com/signup')} 
                    className="text-blue-400 hover:underline cursor-pointer">OpenAI</button>
                  </p>
                  <p className="text-xs text-white/60 mb-1">2. Go to <button 
                    onClick={() => openExternalLink('https://platform.openai.com/api-keys')} 
                    className="text-blue-400 hover:underline cursor-pointer">API Keys</button> section
                  </p>
                  <p className="text-xs text-white/60">3. Create a new secret key and paste it here</p>
                </>
              ) : apiProvider === "gemini" ?  (
                <>
                  <p className="text-xs text-white/60 mb-1">1. Create an account at <button 
                    onClick={() => openExternalLink('https://aistudio.google.com/')} 
                    className="text-blue-400 hover:underline cursor-pointer">Google AI Studio</button>
                  </p>
                  <p className="text-xs text-white/60 mb-1">2. Go to the <button 
                    onClick={() => openExternalLink('https://aistudio.google.com/app/apikey')} 
                    className="text-blue-400 hover:underline cursor-pointer">API Keys</button> section
                  </p>
                  <p className="text-xs text-white/60">3. Create a new API key and paste it here</p>
                </>
              ) : (
                <>
                  <p className="text-xs text-white/60 mb-1">1. Create an account at <button 
                    onClick={() => openExternalLink('https://console.anthropic.com/signup')} 
                    className="text-blue-400 hover:underline cursor-pointer">Anthropic</button>
                  </p>
                  <p className="text-xs text-white/60 mb-1">2. Go to the <button 
                    onClick={() => openExternalLink('https://console.anthropic.com/settings/keys')} 
                    className="text-blue-400 hover:underline cursor-pointer">API Keys</button> section
                  </p>
                  <p className="text-xs text-white/60">3. Create a new API key and paste it here</p>
                </>
              )}
            </div>
          </div>
          
          <div className="space-y-2 mt-4">
            <label className="text-sm font-medium text-white mb-2 block">Keyboard Shortcuts</label>
            <div className="bg-black/30 border border-white/10 rounded-lg p-3">
              <div className="grid grid-cols-2 gap-y-2 text-xs">
                <div className="text-white/70">Toggle Visibility</div>
                <div className="text-white/90 font-mono">Ctrl+B / Cmd+B</div>
                
                <div className="text-white/70">Take Screenshot</div>
                <div className="text-white/90 font-mono">Ctrl+H / Cmd+H</div>
                
                <div className="text-white/70">Process Screenshots</div>
                <div className="text-white/90 font-mono">Ctrl+Enter / Cmd+Enter</div>

                <div className="text-white/70">Toggle Voice Input</div>
                <div className="text-white/90 font-mono">Ctrl+Shift+M / Cmd+Shift+M</div>
                
                <div className="text-white/70">Delete Last Screenshot</div>
                <div className="text-white/90 font-mono">Ctrl+L / Cmd+L</div>
                
                <div className="text-white/70">Reset View</div>
                <div className="text-white/90 font-mono">Ctrl+R / Cmd+R</div>
                
                <div className="text-white/70">Quit Application</div>
                <div className="text-white/90 font-mono">Ctrl+Q / Cmd+Q</div>
                
                <div className="text-white/70">Move Window</div>
                <div className="text-white/90 font-mono">Ctrl+Arrow Keys</div>
                
                <div className="text-white/70">Decrease Opacity</div>
                <div className="text-white/90 font-mono">Ctrl+[ / Cmd+[</div>
                
                <div className="text-white/70">Increase Opacity</div>
                <div className="text-white/90 font-mono">Ctrl+] / Cmd+]</div>
                
                <div className="text-white/70">Zoom Out</div>
                <div className="text-white/90 font-mono">Ctrl+- / Cmd+-</div>
                
                <div className="text-white/70">Reset Zoom</div>
                <div className="text-white/90 font-mono">Ctrl+0 / Cmd+0</div>
                
                <div className="text-white/70">Zoom In</div>
                <div className="text-white/90 font-mono">Ctrl+= / Cmd+=</div>
              </div>
            </div>
          </div>
          
          <div className="space-y-4 mt-4">
            <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <div>
                <label className="text-sm font-medium text-white">Qwen Realtime Speech Recognition</label>
                <p className="text-xs text-white/60">
                  Optional Alibaba Cloud realtime transcription used by Ctrl+Shift+M.
                </p>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-white/70" htmlFor="speechApiKey">DashScope API Key</label>
                <Input
                  id="speechApiKey"
                  type="password"
                  value={speechApiKey}
                  onChange={(e) => setSpeechApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="bg-black/50 border-white/10 text-white"
                />
                {speechApiKey && <p className="text-xs text-white/50">Current: {maskApiKey(speechApiKey)}</p>}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-xs text-white/70" htmlFor="speechWorkspaceId">Workspace ID（可选）</label>
                  <Input
                    id="speechWorkspaceId"
                    value={speechWorkspaceId}
                    onChange={(e) => setSpeechWorkspaceId(e.target.value)}
                    placeholder="留空使用公共服务入口"
                    className="bg-black/50 border-white/10 text-white font-mono"
                  />
                  <p className="text-[11px] text-white/45">仅填写百炼控制台中的真实业务空间 ID</p>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-white/70" htmlFor="speechRegion">Region</label>
                  <select
                    id="speechRegion"
                    value={speechRegion}
                    onChange={(e) => setSpeechRegion(e.target.value)}
                    className="h-10 w-full rounded-md border border-white/10 bg-black/50 px-3 text-sm text-white"
                  >
                    <option value="cn-beijing">北京 cn-beijing</option>
                    <option value="ap-southeast-1">新加坡 ap-southeast-1</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-white/70" htmlFor="speechModel">Speech Model</label>
                <Input
                  id="speechModel"
                  value={speechModel}
                  onChange={(e) => setSpeechModel(e.target.value)}
                  placeholder="qwen-audio-3.0-asr-flash-streaming"
                  className="bg-black/50 border-white/10 text-white font-mono"
                />
              </div>
            </div>

            {questionMode === "coding" && <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <div>
                <label className="text-sm font-medium text-white">Cloud Solution Endpoint</label>
                <p className="text-xs text-white/60">
                  Optional separate OpenAI-compatible endpoint used only for solution generation.
                </p>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-white/70" htmlFor="solutionBaseURL">
                  Solution Base URL
                </label>
                <Input
                  id="solutionBaseURL"
                  type="url"
                  value={solutionBaseURL}
                  onChange={(e) => setSolutionBaseURL(e.target.value)}
                  placeholder="https://api.deepseek.com"
                  className="bg-black/50 border-white/10 text-white font-mono"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-white/70" htmlFor="solutionApiKey">
                  Solution API Key
                </label>
                <Input
                  id="solutionApiKey"
                  type="password"
                  value={solutionApiKey}
                  onChange={(e) => setSolutionApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="bg-black/50 border-white/10 text-white"
                />
                {solutionApiKey && (
                  <p className="text-xs text-white/50">
                    Current: {maskApiKey(solutionApiKey)}
                  </p>
                )}
              </div>
            </div>}

            <label className="text-sm font-medium text-white">AI Model Selection</label>
            <p className="text-xs text-white/60 -mt-3 mb-2">
              {questionMode === "iq"
                ? "IQ 模式仅使用题目识别模型；该模型必须支持图片输入"
                : "Select which models to use for each stage of the process"}
            </p>
            
            {apiProvider === "openai-compatible" ? (
              <div className="space-y-4">
                {[
                  {
                    id: "customExtractionModel",
                    label: "Problem Extraction",
                    description: "Must support image inputs",
                    value: extractionModel,
                    setter: setExtractionModel,
                  },
                  {
                    id: "customSolutionModel",
                    label: "Solution Generation",
                    description: "Model used to generate coding solutions",
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
                ].filter((field) => questionMode === "coding" || field.id === "customExtractionModel").map((field) => (
                  <div key={field.id} className="space-y-1">
                    <label className="text-sm font-medium text-white" htmlFor={field.id}>
                      {field.label}
                    </label>
                    <p className="text-xs text-white/60">{field.description}</p>
                    <Input
                      id={field.id}
                      value={field.value}
                      onChange={(e) => field.setter(e.target.value)}
                      placeholder="Enter the exact model ID"
                      className="bg-black/50 border-white/10 text-white font-mono"
                    />
                  </div>
                ))}
              </div>
            ) : modelCategories
              .filter((category) => questionMode === "coding" || category.key === "extractionModel")
              .map((category) => {
              // Get the appropriate model list based on selected provider
              const models = 
                apiProvider === "openai" ? category.openaiModels : 
                apiProvider === "gemini" ? category.geminiModels :
                category.anthropicModels;
              
              return (
                <div key={category.key} className="mb-4">
                  <label className="text-sm font-medium text-white mb-1 block">
                    {category.title}
                  </label>
                  <p className="text-xs text-white/60 mb-2">{category.description}</p>
                  
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
                              ? "bg-white/10 border border-white/20"
                              : "bg-black/30 border border-white/5 hover:bg-white/5"
                          }`}
                          onClick={() => setValue(m.id)}
                        >
                          <div className="flex items-center gap-2">
                            <div
                              className={`w-3 h-3 rounded-full ${
                                currentValue === m.id ? "bg-white" : "bg-white/20"
                              }`}
                            />
                            <div>
                              <p className="font-medium text-white text-xs">{m.name}</p>
                              <p className="text-xs text-white/60">{m.description}</p>
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
            className="border-white/10 hover:bg-white/5 text-white"
          >
            Cancel
          </Button>
          <Button
            className="px-4 py-3 bg-white text-black rounded-xl font-medium hover:bg-white/90 transition-colors"
            onClick={handleSave}
            disabled={
              isLoading || !apiKey ||
              (questionMode === "coding" && Boolean(solutionBaseURL.trim()) !== Boolean(solutionApiKey.trim())) ||
              (apiProvider === "openai-compatible" && (
                !baseURL.trim() || !extractionModel.trim() ||
                (questionMode === "coding" && (!solutionModel.trim() || !debuggingModel.trim()))
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
