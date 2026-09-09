# Chat Window 源码迁移报告

- 来源：`pandoraq/gui/src/pages/gui/Chat.tsx`、`pandoraq/gui/src/components/mainInput/TipTapEditor.tsx`
- 迁移方式：用户明确要求基于现有源码复刻，未使用 CDP 抓取源应用运行态样式。
- 还原结论：完成源码级轻量复刻，不声明为 CDP 像素级 1:1。
- 结构覆盖：会话头、历史入口、设置入口、新建会话、内部滚动消息轨、用户/助手消息、代码块、附件条、固定输入框、发送与停止按钮。
- 交互覆盖：截图附件、Enter 发送、Shift+Enter 换行、Ctrl/Cmd+K 聚焦输入、Escape 停止、语言选择、流式正文、处理阶段状态、文本追问。
- 后端适配：保留原截图识别与解答链路；新增单次文本追问 IPC；补充截图会携带输入框中的文字说明。
- 修改范围：`src/_pages/Chat.tsx`、`src/_pages/SubscribedApp.tsx`、`src/index.css`、`electron/ProcessingHelper.ts`、`electron/ipcHandlers.ts`、`electron/preload.ts`、相关 Electron API 类型文件。
- 结构化验证：通过 Electron CDP 对本地构建执行可访问性树检查；输入框、语言菜单、历史、设置、新建会话、截图、发送、复制按钮均可识别。
- 视觉验证：本地 Electron 截图确认固定头部、内部消息滚动区、代码块和底部输入框布局正常。
- 构建验证：`npm run build` 通过。
- ESLint 验证：新增 React 页面 `Chat.tsx`、`SubscribedApp.tsx` 通过；项目既有 Electron 文件仍存在历史 lint 问题，不由本次迁移引入。
- 残留差异：未迁移 PandoraQ 的 Redux Agent Runtime、TipTap 扩展、工具调用、会话分叉、自动压缩、语音输入及 IDE 上下文系统。
- 临时产物：本次未在仓库保存源/目标快照；测试生成的本地 `config.json` 已清理。
