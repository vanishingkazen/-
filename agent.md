# Agent Instructions

## 不可破坏的快捷键隐私约束

本项目属于隐私软件。macOS 浏览器场景下的快捷键拦截属于强制隐私不变量，不能在重构、兼容性处理或体验优化中被削弱。

- 当受支持的浏览器处于前台时，必须在浏览器收到事件前缓存或扣住 `Command down`，不能先让浏览器观察后再尝试撤回。
- 命中应用注册的快捷键时，必须消费完整按键链路：`Command down`、快捷键主键 `keyDown`、快捷键主键 `keyUp`、`Command up` 都不得传给浏览器。
- “浏览器捕获不到快捷键”必须覆盖 `kCGEventFlagsChanged`、`kCGEventKeyDown` 和 `kCGEventKeyUp`，不能只拦截主键或只拦截按下事件。
- 只有确认当前组合未命中任何应用快捷键后，才允许回放缓存的 `Command down`，恢复浏览器的普通组合键行为；无法确认时必须选择不泄漏，而不是先转发。
- 不得把原生事件 Tap 改为 listen-only 模式，也不得移除或绕过 `kCGHeadInsertEventTap`、`kCGEventTapOptionDefault` 或等价的主动消费机制。
- 修改快捷键注册、原生拦截或浏览器白名单时，必须验证应用快捷键不会通过浏览器菜单、网页脚本、扩展或部分按键事件被观察。
- 如果原生模块、辅助功能权限或输入监控权限不可用，而 Electron `globalShortcut` 回退无法提供同等拦截保证，必须明确提示隐私保护降级，不能宣称该约束仍然满足。
- 如果快捷键行为发生变化，必须同步更新 `README.md` 中的“快捷键隐私边界”；任何实现都不得与本节约束冲突。

## 浏览器快捷键验收场景

至少验证以下按键序列不会到达浏览器：

```text
Command down -> shortcut key down -> shortcut key up -> Command up
```

重点覆盖 `Cmd+B`、`Cmd+H`、`Cmd+R`、`Cmd+L` 等浏览器自身已有菜单或页面行为的快捷键。其中 `Cmd+B` 用于显示或隐藏窗口，浏览器不得观察到 `Command down`、`B down`、`B up` 或 `Command up` 中的任何事件。未命中应用快捷键的普通组合键只有在完成判定后才允许转发给浏览器。
