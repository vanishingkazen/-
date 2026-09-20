# steamgamecode

steamgamecode 是一个面向技术面试和题目解答场景的 macOS 桌面辅助工具。应用以透明、无边框、始终置顶的窗口运行，可以通过截图将题目直接交给视觉多模态模型，并在聊天窗口中继续追问。

## 主要功能

- 单阶段视觉解题：截图直接发送给视觉模型，不再执行“题目提取 -> 解答”双阶段调用
- 自动识别编程题、选择题、IQ 题等不同题型
- 支持 OpenAI Compatible、Anthropic
- 支持文字追问、代码讨论和历史记录
- 支持双声道实时语音上下文采集，并在确认后显式发送给 AI 生成面试回答
- 支持面试上下文文件，自动补充个人项目与技术术语
- 支持全局快捷键、鼠标晃动检测和界面透明度调节
- macOS 支持原生 Command 事件拦截
- 应用窗口默认启用内容保护，降低被屏幕录制或截图捕获的风险
- 渲染进程或主进程异常退出时自动恢复，避免频繁崩溃导致应用不可用

## 运行环境

推荐环境：

- macOS 13 或更高版本
- Node.js 20 或更高版本
- npm
- Xcode Command Line Tools

Windows 和 Linux 可运行大部分功能，但以下功能仅针对 macOS：

- Command 键原生拦截
- macOS 辅助功能和输入监控权限集成

如果原生 macOS 模块无法构建，应用会自动回退到 Electron `globalShortcut`。

## 安装依赖

```bash
cd "/Users/kk/Desktop/代码文件/steamgamecode-source-1.0.19"
npm install
```

安装时会自动构建 macOS Command 拦截模块。也可以单独执行：

```bash
npm run build:native:mac
```

## 从源码运行

开发模式：

```bash
npm run dev
```

开发模式默认不打开 DevTools。需要调试时执行：

```bash
OPEN_DEVTOOLS=1 npm run dev
```

生产模式：

```bash
npm run build
npm run run-prod
```

也可以使用：

```bash
npm run build && npm run run-prod
```

打包 macOS 应用：

```bash
npm run package-mac
```

## 首次启动权限

根据使用功能，macOS 可能会请求以下权限：

- 屏幕录制：用于截取题目屏幕
- 麦克风：用于实时语音识别
- 辅助功能：用于全局快捷键和 Command 拦截
- 输入监控：用于原生键盘事件拦截和鼠标晃动检测

开发模式下权限通常绑定到 `Electron.app`；打包模式下绑定到 `steamgamecode.app`，两种模式需要分别授权。

授权位置：

```text
系统设置 -> 隐私与安全性
```

## 解题流程

截图统一使用单阶段流程：

```text
截图
  -> 视觉多模态模型
  -> 判断题型和语言
  -> 分析题干
  -> 直接返回解答
```

截图解题使用设置中的 `Visual Solving (Screenshots)` 模型，该模型必须支持图片输入。

文字追问使用 `Follow-up Chat` 模型，调试截图使用 `Debugging` 模型。

## API 设置

点击右上角设置按钮，可以配置：

- API Provider
- API Key
- Base URL
- 视觉解题模型
- 文字追问模型
- 调试模型
- DeepSeek 流式输出
- 界面透明度
- 面试上下文文件路径

API 配置默认保存在：

```text
~/Library/Application Support/steamgamecode/config.json
```

开发模式和生产源码模式共用同一份配置。

## 面试上下文文件

默认路径：

```text
~/Library/Application Support/steamgamecode/interview-context.md
```

在设置页的“面试上下文文件”区域可以：

- 查看或修改文件路径
- 点击“打开文件”用默认文本编辑器编辑
- 文件不存在时自动创建空白文件

可以填写：

- 简历摘要
- 项目经历
- 技术栈
- 目标岗位
- 常用技术术语
- 希望模型优先使用的真实项目案例

如果文件为空：

- 仍然可以开启面试上下文
- 不会注入任何背景资料
- 后续填写内容后，会随下一次请求自动读取

当前面试上下文用于：

- 文字追问
- 实时语音识别术语校正
- 面试模式下的独立聊天历史

截图直接解题目前使用图片本身和通用视觉提示词，不读取面试上下文文件。

## 快捷键

| 快捷键 | 功能 |
|---|---|
| `Cmd+B` | 显示或隐藏窗口 |
| 快速左右晃动鼠标 4 次 | 显示或隐藏窗口 |
| `Cmd+N` | 新建会话，仅 macOS |
| `Cmd+H` | 截图 |
| `Cmd+Enter` | 提交截图或执行当前阶段；不会提交语音上下文 |
| `Cmd+K` | 聚焦聊天输入框 |
| `Cmd+L` | 删除最后一张截图 |
| `Cmd+R` | 重置当前任务和截图队列 |
| `Cmd+方向键` | 移动窗口 |
| `Cmd+Shift+0` | 重置窗口位置 |
| `Cmd+[` / `Cmd+]` | 降低或提高透明度 |
| `Cmd+-` | 缩小界面 |
| `Cmd+0` | 重置缩放 |
| `Cmd+=` | 放大界面 |
| `Cmd+Q` | 退出应用 |

## macOS Command 拦截

在 macOS 上，应用会优先尝试加载原生 `CGEventTap`：

### 快捷键隐私边界

这是隐私软件的强制约束，不是可选的体验优化：

- 当前焦点应用是受支持的浏览器时，必须在浏览器收到事件前暂存 `Command down`。
- 命中应用快捷键时，必须消费完整的按键链路，包括 `Command down`、快捷键主键 `keyDown`、快捷键主键 `keyUp` 和 `Command up`。
- 浏览器不得通过 `flagsChanged`、`keyDown` 或 `keyUp` 观察到应用已注册快捷键的完整组合。
- 只有确认未命中任何应用快捷键后，才允许把缓存的 `Command down` 转发给浏览器，以便浏览器继续执行非应用快捷键，例如 `Cmd+C` 或 `Cmd+V`。
- 如果只按下并释放 `Command`，则按下和释放事件都应在浏览器捕获前隐藏。

上述规则用于防止浏览器菜单、网页脚本或浏览器扩展抢先处理应用快捷键。任何对原生事件拦截逻辑的修改都必须保持这一隐私不变量。

受支持的浏览器包括 Chrome、Safari、Edge、Brave、Arc、Opera、Vivaldi 和 Firefox。

如果原生模块未构建、权限未授予或 event tap 启动失败，应用会记录警告并回退到 Electron `globalShortcut`。

原生拦截需要：

```text
系统设置 -> 隐私与安全性 -> 辅助功能
系统设置 -> 隐私与安全性 -> 输入监控
```

## 隐私与屏幕捕获保护

主窗口创建后立即调用：

```ts
setContentProtection(true)
```

应用还会：

- 对所有新建 BrowserWindow 自动启用内容保护
- 拒绝创建远程 Electron 子窗口
- 禁止挂载 WebView
- DevTools 仅在 `OPEN_DEVTOOLS=1` 时打开
- 自带截图功能会先隐藏应用窗口，再截取屏幕

这些措施可以降低被普通录屏和截图工具捕获的风险，但不能保证绝对安全：

- 外接采集卡、相机拍摄无法阻止
- 有特殊系统权限的安全软件可能绕过
- macOS 系统工具和不同捕获 API 的行为可能不同
- 显式打开 DevTools 后，调试窗口可能被捕获
- Linux 通常没有与 macOS 等价的窗口内容保护

## 日志

主进程（后端）和渲染进程（前端）的日志会写入同一个日志文件。每次启动都会生成一个 `runId`，日志行按 `main:<runId>`、`renderer:<runId>`、`event:<runId>` 作用域区分，方便按启动批次对齐前后端日志。

日志文件：

```text
macOS:   ~/Library/Logs/steamgamecode/main.log
Windows: %APPDATA%\steamgamecode\logs\main.log
Linux:   ~/.local/state/steamgamecode/logs/main.log
```

启动索引（每次启动追加一行，含 runId、版本、运行模式、pid、Electron 版本）：

```text
macOS:   ~/Library/Logs/steamgamecode/startup.log
Windows: %APPDATA%\steamgamecode\logs\startup.log
Linux:   ~/.local/state/steamgamecode/logs/startup.log
```

说明：

- 启动时会打印一条启动横幅，包含版本、Electron/Chrome/Node 版本、平台、启动参数和日志路径。
- 开发模式记录 `debug` 及以上，打包后记录 `info` 及以上；主日志超过 2MB 会自动滚动为 `main.old.log`，启动索引保留最近 200 次启动记录。
- 前端未捕获错误、Promise 拒绝、页面卸载，以及渲染进程崩溃、页面加载失败、preload 报错、主进程未捕获异常都会写入日志。
- 设置面板中的「运行日志 → 打开日志目录」可以直接打开日志文件所在目录。
- 需要自定义日志目录时，设置环境变量 `STEAMGAMECODE_LOG_DIR`（例如 `STEAMGAMECODE_LOG_DIR=./logs npm run dev`）。

## 数据目录

配置：

```text
~/Library/Application Support/steamgamecode/config.json
```

面试上下文：

```text
~/Library/Application Support/steamgamecode/interview-context.md
```

聊天会话和附件：

```text
~/Library/Application Support/steamgamecode/chat-sessions.json
~/Library/Application Support/steamgamecode/chat-attachments
```

- 删除聊天会话会同时删除本地附件；应用启动时也会清理已经不在会话列表中的遗留附件目录。
- 使用 DeepSeek 官方接口时，聊天图片会先上传到 Files API 并复用 `file_id`；删除会话或会话超出保留上限（最近 50 个）后会回收远端文件，本地会话仍可继续使用并按需重新上传。
- 旧版 `history/` 题解目录不再由当前版本创建或写入；如果本机已有旧数据，不会自动删除。

崩溃恢复日志：

```text
~/Library/Application Support/steamgamecode/crash-recovery.log
```

自动重启状态：

```text
~/Library/Application Support/steamgamecode/crash-restarts.json
```

## 项目结构

```text
electron/
  main.ts                         Electron 主进程和窗口管理
  shortcuts.ts                    全局快捷键注册
  MacCommandInterceptor.ts        macOS 原生 Command 拦截封装
  MouseShakeDetector.ts           鼠标晃动检测
  ProcessingHelper.ts             处理流程协调、截图队列和请求取消
  ProcessingAIClientManager.ts    AI client 初始化、配置变更和释放
  ProcessingVisionService.ts      截图视觉解题
  ProcessingDebugService.ts       调试截图处理
  ProcessingFollowupService.ts      文字追问和流式响应
  ProcessingVoiceCorrectionService.ts 语音转写术语校正
  ChatService.ts                  聊天编排、上下文和事件发送
  ChatStore.ts                    会话、附件和持久化
  ChatProvider.ts                 OpenAI Compatible / Anthropic 请求
  ChatTypes.ts                    聊天类型定义
  contracts.ts                    跨模块契约和处理事件常量
  InterviewContextHelper.ts       面试上下文文件创建和读取
  ConfigHelper.ts                 配置读写和迁移
  CrashRecovery.ts                 崩溃恢复和自动重启
  logger.ts                       日志初始化、启动索引和前端日志落盘

native/
  mac-command-interceptor/        macOS CGEventTap 原生模块

src/
  App.tsx
  _pages/Chat.tsx                 主聊天界面
  components/Settings/            设置界面
  components/History/             历史记录界面
  lib/logger.ts                   前端日志转发和错误捕获
  index.css                       全局样式和主题
```

## 重构与发布验证

当前代码已完成基础解耦、大型业务拆分和稳定性加固，正在进行发布收尾。完整的阶段状态、架构边界、性能基线和发布前检查清单见 [`docs/REFACTORING-STATUS.md`](docs/REFACTORING-STATUS.md)。

发布前执行：

```bash
npm test
npm run lint
npx tsc -p tsconfig.electron.json --noEmit
npx tsc -p tsconfig.json --noEmit
npm run build
```

本次重构不改变 macOS Command 事件拦截的隐私不变量；原生拦截算法和其 Electron 封装仍需按原有边界维护。

## 常见问题

### 修改 API 后没有生效

重新执行：

```bash
npm run build
npm run run-prod
```

配置文件和开发模式共用，不需要重复填写 API Key。

### 原生 Command 拦截没有生效

1. 确认当前系统是 macOS
2. 执行 `npm run build:native:mac`
3. 检查“辅助功能”和“输入监控”权限
4. 开发模式和打包模式需要分别授权

### `/` 或鼠标晃动无法恢复隐藏窗口

确认应用仍在运行，并检查全局快捷键或输入监控权限。

### 截图无法获取页面内容

确认已授予屏幕录制权限。应用自己的窗口在截图前会临时隐藏，因此不会被包含在结果中。

### 应用异常退出后没有自动恢复

检查崩溃日志：

```text
~/Library/Application Support/steamgamecode/crash-recovery.log
```

应用在 5 分钟内最多自动恢复 3 次。超过限制后会停止自动重启，避免无限崩溃循环。

## License

AGPL-3.0-or-later
