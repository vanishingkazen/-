# 稳定性测试报告

- 日期：2026-09-18
- 分支：`main`
- 基线提交：`b194a3635e159ddeecb386a769511480cb60a566 feat: use privacy-safe Cmd+B window toggle`
- 测试范围：ChatService、配置持久化、IPC 生命周期、快捷键注册与回退、Electron 启动 smoke test、macOS 原生拦截预检
- 约束：本轮为测试任务，只新增或修改测试代码、测试脚本和报告，不修复功能代码

## 1. 结论

当前 ChatService、配置容错、基础 IPC 和 Electron 启动链路表现稳定，但还不能对 macOS 快捷键隐私约束给出完整通过结论。

主要结论：

1. `npm test`：51/51 通过。
2. `npm run build`：通过。
3. `npm run test:startup`：通过，生产构建可以启动主窗口和渲染进程，未复现 `__ELECTRON_LOG__` 重复注册。
4. `npx tsc --noEmit -p tsconfig.json`：失败，共 26 个类型错误。
5. `npm run test:privacy:mac`：当前跳过。该测试运行在普通 Node 进程中，`AXIsProcessTrusted=false`，不能代表 Electron 应用自身的权限状态。
6. Electron 启动日志显示原生 event tap 已成功启动并进入 `macOS Command interception enabled` 分支，但尚未执行真实的浏览器不可见性验证。
7. 代码审查和类型检查确认存在多个窗口空指针、配置校验和错误处理风险。

## 2. 执行结果

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm test` | PASS | 51 个测试全部通过 |
| `npm run build` | PASS | 渲染进程、主进程、preload 和原生模块构建成功 |
| `npm run test:startup` | PASS | 主窗口创建、preload 加载、渲染页挂载均成功 |
| `npx eslint tests/*.cjs` | PASS | 新增测试文件通过 ESLint |
| `npx tsc --noEmit -p tsconfig.json` | FAIL | 26 个 TypeScript 错误 |
| `npm run test:privacy:mac` | SKIP | Node 进程没有辅助功能权限 |
| `STEAMGAMECODE_REQUIRE_PRIVACY=1 npm run test:privacy:mac` | FAIL | 严格门禁正确阻止把未验证状态标记为通过 |

## 3. 新增测试

| 文件 | 覆盖内容 |
| --- | --- |
| `tests/shortcuts.test.cjs` | 快捷键注册、原生模式、权限回退、`Cmd+B` keyCode、原生 tap 源码不变量 |
| `tests/config-stability.test.cjs` | 损坏配置、异常字段、不可读/不可写配置路径 |
| `tests/ipc-lifecycle.test.cjs` | IPC handler 唯一性、空窗口、销毁窗口、缺失 helper |
| `tests/electron-startup-smoke.test.cjs` | 生产构建完整启动、无重复 IPC handler、主窗口和渲染进程加载 |
| `tests/macos-privacy-preflight.test.cjs` | 原生模块导出、辅助功能权限、event tap 启停预检 |

## 4. 问题定位

### P0-1：真实浏览器不可见性尚未验收

状态：未通过，等待 macOS 人工验收。

已有测试只能验证：

- 原生模块可以加载。
- 在 Electron 进程中 event tap 可以启动。
- `Cmd+B` 被转换为 keyCode `11`。
- 原生 tap 使用主动消费模式，并监听 `flagsChanged`、`keyDown`、`keyUp`。

尚不能验证：

- 浏览器是否观察到 `Command down`。
- 浏览器是否观察到 `B down`。
- 浏览器是否观察到 `B up`。
- 浏览器是否观察到 `Command up`。
- 未命中的普通组合键是否按原顺序且仅一次转发。

相关代码：

- `native/mac-command-interceptor/src/mac_command_interceptor.mm:153-258`
- `electron/shortcuts.ts:78-97`
- `tests/macos-privacy-preflight.test.cjs:31-47`

问题点：`tests/macos-privacy-preflight.test.cjs` 由普通 Node 进程执行，因此检查的是 Node 可执行文件的辅助功能权限，不是 Electron 应用的权限。该测试不能作为 Electron 隐私门禁，需要 Electron 驱动的真实事件序列测试。

### P0-2：隐私保护降级只写控制台，没有用户可见警告

位置：

- `electron/shortcuts.ts:81-91`
- `electron/MacCommandInterceptor.ts:75-80`
- `README.md:211`

当原生模块不可用、权限缺失或 event tap 启动失败时，代码只执行 `console.warn`，随后回退到 Electron `globalShortcut`。当前没有 IPC 事件、Toast、设置页状态或启动阻断机制通知用户隐私能力已经降级。

风险：用户可能继续认为“浏览器捕获不到快捷键”的保护生效，但 `globalShortcut` 回退不满足 `agent.md` 中定义的完整 Command 链路消费要求。

### P1-1：窗口空指针保护条件写反

位置：

- `electron/main.ts:388`
- `electron/main.ts:497-506`
- `electron/main.ts:509-535`
- `electron/main.ts:586-592`
- `electron/main.ts:596-609`

问题代码模式：

```ts
if (!state.mainWindow?.isDestroyed()) {
  state.mainWindow.getBounds()
}
```

当 `state.mainWindow` 为 `null` 时：

```text
state.mainWindow?.isDestroyed() === undefined
!undefined === true
```

因此代码会进入本应跳过的分支，然后访问 `null.getBounds()`、`setOpacity()`、`setPosition()` 或其他窗口方法。

影响：

- 窗口关闭后，`Cmd+B` 可能无法重新显示窗口。
- 截图流程调用隐藏/显示窗口时可能抛出异常。
- 渲染进程发送 `update-content-dimensions` 时可能产生 rejected IPC。
- 开发服务器加载失败且窗口已关闭时，fallback 可能再次访问空窗口。

类型检查已经对相关行报告 `TS18047: state.mainWindow is possibly null`。

### P1-2：`update-config` 没有校验和限制 opacity

位置：

- `electron/ipcHandlers.ts:40-51`
- `electron/ipcHandlers.ts:53-66`
- `electron/ConfigHelper.ts:331-335`

`set-opacity` 会把值限制在 `0.1..1`，但 `update-config` 只要收到 number 就直接持久化并调用：

```ts
mainWindow.setOpacity(newConfig.opacity)
```

影响：负数、大于 1、`NaN` 等值可能进入配置和窗口 API。`set-opacity` 与 `update-config` 的行为不一致。

### P1-3：TypeScript 检查失败，且 CI 不阻止错误

失败命令：

```bash
npx tsc --noEmit -p tsconfig.json
```

错误总数：26。

错误分布：

| 文件 | 数量 | 代表位置 |
| --- | ---: | --- |
| `electron/main.ts` | 15 | `388`、`499`、`598` 等空窗口访问 |
| `electron/ProcessingHelper.ts` | 7 | `114`、`526`、`530`、`951`、`958`、`959`、`966` |
| `electron/ScreenshotHelper.ts` | 2 | 对 `unknown` 直接访问 `.message` |
| `electron/InterviewContextHelper.ts` | 1 | 返回 `path: string \| undefined`，接口要求 `string` |

CI 位置：

- `.github/workflows/ci.yml:34-36`
- `.github/workflows/ci.yml:38-40`

Lint 和 Type Check 都设置了 `continue-on-error: true`，因此类型错误不会阻止构建和测试。

### P2-1：销毁窗口后打开设置可能抛出

位置：

- `electron/ipcHandlers.ts:229-236`

`open-settings-portal` 只检查：

```ts
if (mainWindow)
```

没有检查 `mainWindow.isDestroyed()`，也没有 `try/catch`。如果窗口已经销毁但对象仍非空，`mainWindow.webContents.send()` 可能抛出。

### P2-2：损坏配置只回退默认值，不主动恢复文件

位置：

- `electron/ConfigHelper.ts:173-232`
- `electron/ConfigHelper.ts:238-249`

`loadConfig()` 遇到截断或非法 JSON 时会记录错误并返回默认配置，但不会：

- 备份损坏文件。
- 重写有效配置。
- 向调用方返回“配置已损坏”的状态。

因此后续每次读取都可能重复报错。写配置失败也只记录日志，调用方仍会收到内存中的新配置，无法知道持久化失败。

### P2-3：Electron smoke test 不能完全隔离真实数据目录

位置：

- `electron/main.ts:633-648`

测试使用 `--user-data-dir` 启动 Electron，但应用随后根据 `app.getPath('appData')` 固定设置：

- `userData`
- `sessionData`
- `temp`
- `cache`

因此 smoke test 仍会访问真实 `~/Library/Application Support/interview-coder-v1`，并产生 Chromium cache 警告。这会影响测试隔离和污染判定。

### P3-1：快捷键注册不是幂等操作

位置：

- `electron/shortcuts.ts:177-180`
- `electron/shortcuts.ts:392-398`

每次调用 `registerGlobalShortcuts()` 都会：

- 重新启动原生 action timer。
- 追加新的 `will-quit` listener。
- 再次尝试注册 shortcuts。

当前正常启动只调用一次，因此不是已触发问题；如果未来支持重新初始化、热重载或恢复流程，会产生重复 timer 和重复 listener。

## 5. 当前未覆盖的稳定性范围

1. 渲染层流式滚动抖动行为。
2. React 组件卸载后的事件监听器清理。
3. 200 次以上崩溃恢复和重启节流。
4. 自动更新下载失败、安装失败和重复初始化。
5. 语音 WebSocket 重连、半包、异常关闭和长时间静音。
6. 1000 个流式 chunk、500 轮对话和长期运行内存增长。
7. 打包后的 DMG/ZIP 启动与升级路径。

## 6. 验证命令

```bash
npm test
npm run build
npm run test:startup
npx tsc --noEmit -p tsconfig.json
STEAMGAMECODE_REQUIRE_PRIVACY=1 npm run test:privacy:mac
```

## 7. 本轮变更边界

本报告只记录测试结果和问题定位，不修复任何功能代码。

本轮测试任务新增：

- `tests/shortcuts.test.cjs`
- `tests/config-stability.test.cjs`
- `tests/ipc-lifecycle.test.cjs`
- `tests/electron-startup-smoke.test.cjs`
- `tests/macos-privacy-preflight.test.cjs`
- `docs/test-report-2026-09-18.md`
- `package.json` 中对应的测试脚本

未修改：

- `electron/**`
- `src/**`
- `native/**`
