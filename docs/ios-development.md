# iOS 手机相机伴随开发

## 当前能力

- iOS 17.0 及以上，SwiftUI + AVFoundation，后置相机与竖屏界面。运行时识别实际可用的超广角、主摄、长焦实体镜头；取景下方用镜头选择条切换，并记住选择。高亮块连续跟手、松手后以高阻尼 spring 吸附并切换一次镜头，也支持点选；选中名称从 Regular 渐变至 Semibold。所有镜头完整显示，不添加暗示隐藏选项的渐隐边缘。切换时仅预览轻微缩放 1.5%，照片不受影响；遵循系统「减弱动态效果」。拍摄/上传及切换期间禁用镜头选择，切换失败保留原镜头。电脑遥控拍摄使用同一当前镜头，不把数码裁切倍率作为额外镜头。
- 扫描桌面「局域网外设 → iOS 相机端」专用二维码，或粘贴包含 `#配对码` 的完整链接。
- 配对令牌保存在本机 Keychain；模型 API Key 仍由电脑管理。
- App 专注取景与拍照；网页显示端独立配对，两端可在不同设备上同时在线。照片进入电脑现有待发送附件队列。
- 桌面「局域网外设」可选择图片来源；现有采集按钮和 Cmd/Ctrl+H 使用此来源。
- 手机照片方向校正、移除 EXIF、最长边缩至 2400 像素，以 JPEG 上传；电脑校验后转换成 PNG，沿用已有附件生命周期。
- WebSocket 传拍照指令，HTTP 传图片；30 秒拍照请求有效期，15 秒上传空闲超时，8MB / 4096 像素接收限制。
- 请求绑定会话、视图和重置代次；切换会话或重置后拒绝旧照片，重复上传不会重复入队。

## 打开与真机运行

1. 在 Xcode 打开 `mobile/ios/SteamGameCompanion.xcodeproj`。
2. 选择 `SteamGameCompanion` target，打开 **Signing & Capabilities**。
3. 启用 Automatically manage signing，选择自己的 Team。如默认 Bundle Identifier 无法注册，改为自己唯一的标识。
4. 使用 USB 连接 iPhone，在设备上完成信任；按系统提示开启开发者模式。
5. 选择 iPhone 运行目标，点击 Run。首次使用允许相机与局域网访问。

模拟器可用于界面和网络调试，实际相机拍摄必须在 iPhone 上验收。

## 电脑与手机联调

1. 在仓库根目录运行 `npm run dev`（生产源码运行先执行 `npm run build`）。
2. 电脑打开「局域网外设」，开启服务，电脑与手机连接同一可信局域网。
3. 用 **本 App 内的扫码按钮** 扫描「iOS 相机端」二维码；使用系统相机会打开原有网页伴随端。
4. App 显示「电脑已连接」且相机就绪后，可以在手机上点击「拍照并传到电脑」。
5. 电脑要遥控拍照时，在伴随窗口将图片来源设为「iPhone 拍照」，然后使用原有采集按钮或 Cmd/Ctrl+H。
6. 图片出现在电脑附件预览后，按原有流程发送。可以混合添加电脑截图与手机照片。

网页显示端与桌面的采集按钮使用电脑所选来源。桌面来源选择在应用重启后恢复为电脑截图。

## 文件组织

```text
mobile/ios/
  SteamGameCompanion.xcodeproj/       Xcode 工程与共享运行方案
  SteamGameCompanion/
    App/CompanionApp.swift            连接、预览、采集、前后台状态
    Camera/CameraController.swift     串行相机会话、扫码、拍摄、方向校正
    Networking/CompanionClient.swift  配对、事件通道、HTTP 上传
    Networking/CredentialStore.swift  Keychain 配对凭据
    Resources/Info.plist              相机和局域网权限、竖屏配置

electron/capture/PhoneCameraRequests.ts
                                     请求关联、超时、取消与上传去重
electron/CompanionServer.ts           现有认证、相机消息和图片接收接口
electron/ScreenshotHelper.ts          图片校验、落盘与现有队列
docs/companion-camera-protocol.md     首版协议约定
```

## 编译与检查

无需签名的真机目标编译，仅检查构建，产物不能直接安装：

```bash
xcodebuild \
  -project mobile/ios/SteamGameCompanion.xcodeproj \
  -scheme SteamGameCompanion \
  -configuration Debug \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/steamgamecode-ios-build \
  CODE_SIGNING_ALLOWED=NO build
```

桌面类型检查及相关测试：

```bash
npx tsc --noEmit -p tsconfig.electron.json
npx tsc --noEmit -p tsconfig.json
node --test --test-concurrency=1 tests/companion-server.test.cjs tests/screenshot-helper.test.cjs tests/ipc-lifecycle.test.cjs tests/preload-lifecycle-stability.test.cjs
```

## 当前边界与真机验收

- 连接设置中提供「防烧屏模式」开关，默认关闭并保存选择。开启后连接且相机就绪时进入纯黑待机，Connected 提示缓慢移动，亮度最多 10%（原来更低则保持）；轻点返回操作界面，20 秒后自动待机。查看连接设置或照片时不进入待机。退出待机、断线或进入后台时恢复原亮度。待机只移除取景界面，相机会话和遥控拍摄保持运行；前台已连接时禁用自动锁屏。
- 开发预览版沿用已有 **HTTP/WS 明文局域网协议**，配对控制访问，不提供传输加密；正式发布前应升级到 HTTPS/WSS 和证书绑定。
- 网页显示端与 iOS 相机端分别使用独立二维码和令牌，每种角色支持一个在线连接。同角色新连接会替换旧连接；断开一端不影响另一端。只有网页显示端配对影响电脑悬浮窗隐藏策略。
- 拍照时保持 App 在前台。相机运行时暂时禁用自动锁屏；进入后台或相机中断后报告不可用，不会静默回退为电脑截图。
- 前台断线按 1、2、4、8、15 秒间隔自动重连，之后每 15 秒重试；网络恢复或返回前台立即尝试。每 8 秒发送心跳；首次响应超时 12 秒、已连接响应超时 25 秒会重建连接。连接设置中可立即重连。
- 临时断线保留 Keychain 凭据。配对撤销或连接被替换时停止重试并提示重新配对。电脑停止/重启服务会生成新令牌；电脑地址改变也需要重新扫码。
- 断线取消未完成的拍摄请求，恢复后需重新拍摄，不自动补传旧照片。
- 「清除本机配对」只删除手机凭据；电脑仍显示已配对时，要在电脑端断开 iOS 相机端才能重新配对。
- 照片不会写入系统相册；最近照片仅用于 App 内存预览，电脑按已有附件规则保存。
- 2026-10-23 已完成真机签名安装与启动，用户已确认照片传输和模型回答正常。权限拒绝/恢复、小字清晰度、遥控拍照、断网与后台中断仍需专项验收；自动测试使用相机/队列夹具。
