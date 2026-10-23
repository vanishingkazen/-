# 手机相机协议（开发预览版）

本版本扩展现有 CompanionServer，保留现有网页配对与认证规则。客户端仅连接二维码内的局域网 IPv4 地址。

## 配对与认证

二维码内容：`http://<LAN-IP>:<port>/companion#<one-time-token>`，现有配对码有效期两分钟。

`POST /api/pair`，JSON `{ "token": "<one-time-token>" }`，响应 `{ "success": true, "token": "<session-token>" }`。

原生 App 沿用现有来源规则，发送 `Origin: http://<LAN-IP>:<port>`；API 请求还发送 `Authorization: Bearer <session-token>`。Origin 只是网页来源检查，设备身份由配对令牌验证。

WebSocket：`ws://<LAN-IP>:<port>/api/events`，同样设置 Origin，连接后五秒内发送：

```json
{ "type": "auth", "token": "<session-token>" }
```

收到现有 `snapshot` 事件后，发送相机能力状态；前后台或相机会话变化时更新：

```json
{ "type": "camera.ready", "ready": true }
```

保活沿用 `ping` / `pong`。当前仅支持一个已配对手机连接。

## 电脑遥控拍照

电脑选中手机来源后，服务通过该手机的已认证 WebSocket 发送：

```json
{
  "type": "capture.request",
  "requestId": "<uuid>",
  "expiresAt": 1790000000000
}
```

`expiresAt` 为 Unix 毫秒时间。手机拒绝已过期命令，同一时刻只处理一次拍摄。

失败时发送：

```json
{ "type": "capture.failed", "requestId": "<uuid>" }
```

## 手机主动拍照

先发送 `POST /api/camera/request`，电脑分配请求 ID 并绑定当前会话与视图：

```json
{ "success": true, "requestId": "<uuid>", "expiresAt": 1790000000000 }
```

未报告相机就绪、服务未初始化、存在其他拍照请求时返回 409。

## 照片上传

`POST /api/camera/photo/<requestId>`，Content-Type 必须为 `image/jpeg`，请求体为 JPEG 原始字节，最多 8MB。不要通过 JSON/Base64 或 WebSocket 上传照片。

手机输出最长边 2400 像素的 JPEG，移除 EXIF。电脑在解码前读取 JPEG 尺寸，拒绝超过 4096×4096 的图片，并验证可解码性，转换为 PNG 后入队。

- 成功：200 `{ "success": true }`，广播现有 `refresh` 事件。
- 未授权：401。
- 请求过期、会话/视图/重置代次变化、上传中、格式不符：409。
- 拍照请求有效期 30 秒；上传空闲超时 15 秒。
- 60 秒内重复上传已完成的同一请求，返回成功，不重复入队。
- 断开设备、停止服务、相机不可用或新连接替换旧连接时取消未完成请求。

## 显式电脑截图

App 的「电脑截图」调用原有 `POST /api/screenshot`。此接口始终截取电脑屏幕，不跟随桌面采集来源，避免手机等待 HTTP 响应时又被要求执行同一个拍照请求。

## 后续协议升级

正式版本应增加 HTTPS/WSS 与证书绑定、独立设备身份、协议版本/能力协商，并在需要原生相机与网页同时在线时拆分设备连接与查看连接。当前版本不声明这些能力已实现。
