import type { BrowserWindow } from "electron"
import { configHelper, type Config } from "./ConfigHelper"
import type { ProblemInfo } from "./contracts"
import type { ProcessingAIClientManager } from "./ProcessingAIClientManager"

function errorMessageFrom(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export interface ProcessingDebugServiceDeps {
  getProblemInfo: () => ProblemInfo | null
  getMainWindow: () => BrowserWindow | null
  getLanguage: () => Promise<string>
  getCurrentBasicCode: () => string
  getMaxOutputTokens: (config: Config) => number
}

export class ProcessingDebugService {
  constructor(
    private readonly clients: ProcessingAIClientManager,
    private readonly deps: ProcessingDebugServiceDeps
  ) {}

  private get openaiClient() {
    return this.clients.openaiClient
  }

  private get anthropicClient() {
    return this.clients.anthropicClient
  }

  private get currentBasicCode(): string {
    return this.deps.getCurrentBasicCode()
  }

  private getLanguage(): Promise<string> {
    return this.deps.getLanguage()
  }

  private getMaxOutputTokens(config: Config): number {
    return this.deps.getMaxOutputTokens(config)
  }

  public async process(
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
      
      let debugContent = "";
      
      if (config.apiProvider === "openai-compatible") {
        if (!this.openaiClient) {
          return {
            success: false,
            error: "OpenAI-compatible API key not configured. Please check your settings."
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
          max_tokens: this.getMaxOutputTokens(config),
          temperature: 0.2
        });
        
        const debugMessage = debugResponse.choices[0]?.message as {
          content: string | null;
          reasoning_content?: string | null;
        };
        debugContent = debugMessage?.content || "";
        if (!debugContent?.trim()) {
          const finishReason = debugResponse.choices[0]?.finish_reason || "unknown";
          const reasoningLength = debugMessage?.reasoning_content?.length || 0;
          throw new Error(`模型完成了思考但没有返回调试正文（finish_reason=${finishReason}, reasoning_length=${reasoningLength}）。请提高服务端最大输出长度。`);
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
            max_tokens: this.getMaxOutputTokens(config),
            messages: messages,
            temperature: 0.2
          });
          
          const textBlock = response.content.find((block) => block.type === "text")
          debugContent = textBlock?.type === "text" ? textBlock.text : "";
          if (!debugContent.trim()) throw new Error("模型没有返回调试正文");
        } catch (error: unknown) {
          console.error("Error using Anthropic API for debugging:", error);
          const status = typeof error === "object" && error !== null && "status" in error
            ? Number((error as { status?: unknown }).status)
            : undefined;
          const message = error instanceof Error ? error.message : "";

          // Add specific handling for Claude's limitations
          if (status === 429) {
            return {
              success: false,
              error: "Claude API rate limit exceeded. Please wait a few minutes before trying again."
            };
          } else if (status === 413 || message.includes("token")) {
            return {
              success: false,
              error: "Your screenshots contain too much information for Claude to process. Please reduce the number or size of screenshots, or use an OpenAI-compatible endpoint with a larger context window."
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
    } catch (error: unknown) {
      console.error("Debug processing error:", error);
      return { success: false, error: errorMessageFrom(error, "Failed to process debug request") };
    }
  }

}
