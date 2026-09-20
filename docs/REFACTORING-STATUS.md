# 重构与发布收尾状态

更新时间：2026-09-20

## 阶段总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 基础解耦：公共契约、依赖接口和 IPC 事件常量 | 已完成 |
| 2 | 大型业务拆分：ChatService 和 ProcessingHelper 按职责拆分 | 已完成 |
| 3 | 边界加固：稳定性测试、生命周期释放、崩溃恢复和日志质量 | 已完成 |
| 4 | 发布收尾：性能基线、文档、全量验证和最终提交 | 核心完成，待签名/安装验收 |

## 当前架构

```text
Electron main process
├── main.ts
│   ├── window/lifecycle/crash recovery
│   ├── shortcuts.ts
│   ├── ipcHandlers.ts
│   ├── ChatService
│   └── ProcessingHelper
│       ├── ProcessingAIClientManager
│       ├── ProcessingVisionService
│       ├── ProcessingDebugService
│       ├── ProcessingFollowupService
│       └── ProcessingVoiceCorrectionService
│
├── ChatService
│   ├── ChatStore       会话、附件、持久化和保留策略
│   ├── ChatProvider    OpenAI Compatible / Anthropic 请求和流式响应
│   └── ChatTypes       会话、消息和附件类型
│
└── contracts.ts        跨模块依赖、IPC 事件和处理状态契约
```

### 模块边界

- `ChatService` 负责聊天编排、上下文压缩、会话选择和事件发送。
- `ChatStore` 负责聊天会话与附件的本地持久化、清理和保留上限。
- `ChatProvider` 负责 Provider 差异、请求创建、流式输出和取消信号传递。
- `ProcessingHelper` 负责截图队列、请求协调、取消控制和对外兼容入口。
- `ProcessingAIClientManager` 负责 AI client 初始化、配置变更和退出释放。
- `ProcessingVisionService` 负责截图视觉解题。
- `ProcessingDebugService` 负责调试截图处理。
- `ProcessingFollowupService` 负责文字追问、历史上下文和流式响应。
- `ProcessingVoiceCorrectionService` 负责面试语音转写术语校正。

## 性能基线

以下数据来自本地 macOS 开发环境，Node.js/npm 依赖已安装，时间会随机器和缓存变化：

| 检查项 | 结果 |
|---|---:|
| `npm test` | 约 10.7 s；146 tests，144 pass，0 fail，2 skipped |
| `npm run build` | 约 4.9 s；构建成功 |
| 渲染包 JS | 393.26 kB；gzip 124.66 kB |
| 渲染包 CSS | 29.18 kB；gzip 6.63 kB |
| Electron 主 bundle | 2,149.56 kB；gzip 447.65 kB |
| `dist`（含 sourcemap） | 1.61 MiB |
| `dist-electron`（含 sourcemap） | 5.40 MiB |

当前检查未发现因拆分引入的重复 AI client 初始化或重复配置监听。`ProcessingAIClientManager.dispose()` 已由 `main.ts` 的 `before-quit` 生命周期调用，避免退出时继续响应配置事件。

## 验证命令

发布前至少执行：

```bash
npm test
npm run lint
npx tsc -p tsconfig.electron.json --noEmit
npx tsc -p tsconfig.json --noEmit
npm run build
```

`npm test` 默认包含聊天、配置、IPC 生命周期、启动 smoke、macOS 隐私预检、截图队列、处理服务和语音识别稳定性测试。以下两个跳过项属于环境条件，不是测试失败：

- 未授予 macOS 辅助功能权限时，相关原生能力测试跳过。
- 未设置 `STEAMGAMECODE_RUN_STARTUP_SMOKE=1` 时，生产启动 smoke test 跳过。

如需主动执行生产启动 smoke test：

```bash
npm run test:startup
```

## 发布前检查清单

- [x] `npm test`、lint、两个 TypeScript 类型检查和 production build 全部通过。
- [x] 通过现有回归和稳定性测试确认 API Provider、流式响应、取消请求、session/request 标识行为未发生回归。
- [x] 通过 ChatStore/ChatService 稳定性测试确认聊天会话、图片附件、保留策略和远端文件清理行为正常。
- [x] README 已整理 macOS 屏幕录制、麦克风、辅助功能和输入监控权限说明。
- [x] `npm run package-mac` 已成功生成 arm64/x64 的 DMG 和 ZIP；当前环境未配置 Developer ID，因此产物未签名。
- [ ] 在目标 macOS 版本上安装并启动打包应用，完成签名后的分发验证。
- [ ] 检查 `main.log`、`startup.log` 和崩溃恢复日志可写入且可打开。
- [x] 已使用明确文件列表完成 Git 提交；未提交的发布产物仍保留在 `release/`，不纳入 Git。

## 本次打包结果

`npm run package-mac` 已通过，生成以下本地发布产物（未纳入 Git）：

```text
release/steamgamecode-arm64.dmg
release/steamgamecode-arm64.zip
release/steamgamecode-x64.dmg
release/steamgamecode-x64.zip
```

由于本机没有可用的 `Developer ID Application` 签名身份，electron-builder 跳过了 macOS 代码签名。正式发布前仍需在配置好签名证书和公证权限的环境中重新打包，并安装验证两个架构的应用启动、权限申请和原生模块加载。

## 不可变隐私不变量

以下文件中的 macOS Command 事件拦截算法不属于本次重构范围：

- `native/mac-command-interceptor/src/mac_command_interceptor.mm`
- `electron/MacCommandInterceptor.ts`
- `electron/shortcuts.ts`

任何后续修改都必须继续保证：命中应用快捷键时，浏览器在收到事件前看不到完整组合；未命中时，缓存的 `Command down` 只能在确认后转发；单独按下并释放 `Command` 时也不能泄漏给浏览器。
