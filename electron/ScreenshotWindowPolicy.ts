export interface ScreenshotWindowState {
  /** 截图开始前悬浮窗是否可见。 */
  wasVisible: boolean
  /** 截图结束时手机伴随端是否仍处于配对状态。 */
  companionPaired: boolean
}

/**
 * 截图流程会临时隐藏 PC 悬浮窗，避免把窗口自身截进画面。
 * 截图结束后只在“原本可见且手机伴随端未配对”时恢复，
 * 避免用户已经转向手机时窗口又弹回屏幕。手机短暂断线但
 * 仍处于配对状态时也保持隐藏，用户回到电脑后按 Cmd/Ctrl+B 恢复。
 */
export function shouldRestoreWindowAfterScreenshot({
  wasVisible,
  companionPaired
}: ScreenshotWindowState): boolean {
  return wasVisible && !companionPaired
}
