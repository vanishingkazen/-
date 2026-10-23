# iOS 手机相机伴随开发

## 当前能力

- iOS 17.0 及以上，SwiftUI + AVFoundation，后置相机与竖屏界面。
- 扫描现有桌面伴随二维码，或粘贴包含 `#配对码` 的完整链接。
- 配对令牌保存在本机 Keychain；模型 API Key 仍由电脑管理。
- App 内选择 iPhone 拍照或电脑截图，图片进入电脑现有待发送附件队列。
- 桌面「手机伴随与相机」可选择图片来源；现有采集按钮和 Cmd/Ctrl+H 使用此来源。
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
2. 电脑打开「手机伴随与相机」，开启服务，电脑与手机连接同一可信局域网。
3. 用 **本 App 内的扫码按钮** 扫描二维码；使用系统相机会打开原有网页伴随端。
4. App 显示「电脑已连接」且相机就绪后，可以在手机上点击「拍照并传到电脑」。
5. 电脑要遥控拍照时，在伴随窗口将图片来源设为「iPhone 拍照」，然后使用原有采集按钮或 Cmd/Ctrl+H。
6. 图片出现在电脑附件预览后，按原有流程发送。可以混合添加电脑截图与手机照片。

App 内「电脑截图」始终截取电脑屏幕；桌面来源设置只影响桌面按钮和快捷键。桌面来源选择在应用重启后恢复为电脑截图。

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

- 开发预览版沿用已有 **HTTP/WS 明文局域网协议**，配对控制访问，不提供传输加密；正式发布前应升级到 HTTPS/WSS 和证书绑定。
- 当前沿用一个手机会话。原生 App 与网页伴随端共用配对，新连接会替换旧连接，不支持二者同时在线。
- 拍照时保持 App 在前台。相机运行时暂时禁用自动锁屏；进入后台或相机中断后报告不可用，不会静默回退为电脑截图。
- 后台回来会尝试连接；其他断线可点击「重新连接」。电脑停止服务、撤销配对或重启后，应重新扫码。
- 「清除本机配对」只删除手机凭据；电脑仍显示已配对时，要在电脑端断开手机才能重新配对。
- 照片不会写入系统相册；最近照片仅用于 App 内存预览，电脑按已有附件规则保存。
- 2026-10-23 已完成真机签名安装与启动，用户已确认照片传输和模型回答正常。权限拒绝/恢复、小字清晰度、遥控拍照、断网与后台中断仍需专项验收；自动测试使用相机/队列夹具。
