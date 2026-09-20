# 实时语音识别（ASR）接入文档

本文档描述本项目内置的“实时语音识别”功能所对接的语音服务：**阿里云百炼 DashScope 实时语音识别 WebSocket API（双工 streaming）**。语音采集只能通过聊天窗口中的 UI 按钮开始或停止，在设置页（`Qwen Realtime Speech Recognition`）中配置。

> 说明：文档中的接入格式与报文示例，均以本仓库实际代码为准，核心实现在 `electron/VoiceRecognitionHelper.ts`。

## 1. 总体流程

1. 客户端（主进程）建立一条 WebSocket 连接（Bearer Token 鉴权）。
2. 连接建立后发送一条 JSON 的 `run-task` 指令，声明“音频→ASR”任务（`task_group: audio`、`task: asr`、`function: recognition`）。
3. 服务端返回 `task-started` 后，客户端开始持续向 WebSocket 发送 **二进制 PCM 音频帧**（小端 16bit、单声道、16kHz）。
4. 服务端在识别过程中持续推送 `result-generated` 事件：未断句为中间结果（partial），`sentence_end: true` 为最终结果（final）。
5. 采集结束时客户端发送 `finish-task`，服务端推送 `task-finished` 后关闭连接。

## 2. 服务端地址与鉴权

### 2.1 连接地址（WSS）

项目按以下优先级选择入口（见 `VoiceRecognitionHelper.start()`）：

| 条件 | 地址 |
| --- | --- |
| 配置了 `speechWorkspaceId` | `wss://<workspaceId>.<region>.maas.aliyuncs.com/api-ws/v1/inference` |
| `speechRegion = ap-southeast-1`（国际站） | `wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference` |
| 其他情况（默认国内站） | `wss://dashscope.aliyuncs.com/api-ws/v1/inference` |

其中 `<workspaceId>` 为百炼控制台中的业务空间 ID，`<region>` 为 `speechRegion`（如 `cn-beijing`）。

### 2.2 鉴权

WebSocket 握手时携带 HTTP Header：

```text
Authorization: Bearer <DashScope API Key>
```

即设置中的 `speechApiKey`（形如 `sk-...`）。

### 2.3 模型

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `speechModel` | `qwen-audio-3.0-asr-flash-streaming` | 在设置中可改为其他已开通的实时 ASR 模型 |

模型名会原样放入 `run-task` 报文的 `payload.model` 字段，由服务端决定是否可用。

## 3. 建连与任务启动

WebSocket `open` 后立即发送如下 JSON（`streaming: "duplex"` 表示双向流式任务）：

```json
{
  "header": {
    "action": "run-task",
    "task_id": "4d9c1b1a-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "streaming": "duplex"
  },
  "payload": {
    "task_group": "audio",
    "task": "asr",
    "function": "recognition",
    "model": "qwen-audio-3.0-asr-flash-streaming",
    "parameters": {
      "format": "pcm",
      "sample_rate": 16000,
      "max_sentence_silence": 1000,
      "semantic_punctuation_enabled": false,
      "heartbeat": true
    },
    "input": {}
  }
}
```

### 3.1 `payload.parameters` 说明

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `format` | `pcm` | 音频编码格式，当前只发 PCM |
| `sample_rate` | `16000` | 采样率 16kHz，与采集端重采样一致 |
| `max_sentence_silence` | `1000` | 断句静音阈值（毫秒） |
| `semantic_punctuation_enabled` | `false` | 是否启用语义标点 |
| `heartbeat` | `true` | 开启服务端心跳句（用于保活/判断无语音） |
| `vocabulary` | 可选 | 热词表，见第 7 节 |

### 3.2 `payload.input` 说明

- 默认发送空对象 `{}`。
- 当启用“面试上下文增强”且上下文文件可用时，会携带 `context` 内容提示服务端，格式如下：

```json
{
  "context": [
    {
      "role": "user",
      "content": [
        { "type": "input_text", "text": "<面试上下文/题目文本>" }
      ]
    }
  ]
}
```

## 4. 发送音频

服务端返回 `task-started` 事件后，客户端开始发送音频。每个音频块直接以 **二进制 WebSocket 帧** 发送：

```js
socket.send(pcmBytes, { binary: true })
```

音频规格必须与服务端声明一致：

- 编码：PCM 有符号 16bit 小端（S16LE）
- 声道：单声道（mono）
- 采样率：16000 Hz

采集端（渲染进程 `src/_pages/Chat.tsx`）通过 `AudioContext` 的 `ScriptProcessor` 采集，用 `downsampleToPcm16()` 把浏览器音频重采样为上述格式，再经 IPC（`sendVoiceAudio`）转发给主进程，由 `VoiceRecognitionHelper.appendAudio()` 直接 `socket.send(binary)`。

## 5. 结束任务

停止采集时发送：

```json
{
  "header": {
    "action": "finish-task",
    "task_id": "4d9c1b1a-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "streaming": "duplex"
  },
  "payload": {
    "input": {}
  }
}
```

发送后客户端等待服务端 `task-finished`（或最多 3 秒）后主动 `close` 连接。`finish-task` 后服务端会把剩余未断句的音频补齐为最终结果。

## 6. 服务端事件

服务端消息均为 JSON，事件名在 `header.event`。本项目主要处理以下事件：

### 6.1 `task-started`

任务启动成功，此后可以开始发送音频。客户端收到该事件后才进入“listening”状态。

### 6.2 `result-generated`

识别结果，消息结构如下：

```json
{
  "header": { "event": "result-generated" },
  "payload": {
    "output": {
      "sentence": {
        "text": "识别出的文字",
        "sentence_end": true,
        "heartbeat": false
      }
    }
  }
}
```

- `sentence.heartbeat === true`：心跳句，忽略，不展示。
- `sentence.sentence_end === false`：中间结果（partial），用于实时展示。
- `sentence.sentence_end === true` 且 `text` 非空：最终句子，追加进完整转写（按换行拼接）并作为一段存入会话。

### 6.3 `task-finished`

任务正常结束，客户端收到后关闭 WebSocket。

### 6.4 `task-failed`

任务失败，`header.error_message` 为错误描述；在启动阶段收到则直接判定启动失败。

## 7. 热词/上下文增强（可选）

当开启面试上下文（`interviewContextEnabled` + `interviewContextPath`）时，项目会从上下文文本中提取专有词，写入 `parameters.vocabulary`，权重为 4 或 5：

```json
{
  "parameters": {
    "vocabulary": {
      "PandoraQ": 5,
      "LangChain": 5,
      "MVCC": 4
    }
  }
}
```

同时把全文放到 `input.context`（见 3.2 节），用于提升专业术语识别率。相关实现：`electron/InterviewContextHelper.ts`。

## 8. 工程内配置与接入点

### 8.1 配置项（设置 → Qwen Realtime Speech Recognition，存储于 `config.json`）

| 配置键 | 含义 | 默认值 |
| --- | --- | --- |
| `speechApiKey` | DashScope（百炼）API Key | 空 |
| `speechWorkspaceId` | 百炼业务空间 ID（可选，留空走公共入口） | 空 |
| `speechRegion` | 区域：`cn-beijing` / `ap-southeast-1` | `cn-beijing` |
| `speechModel` | 实时 ASR 模型名 | `qwen-audio-3.0-asr-flash-streaming` |

### 8.2 主要代码位置

| 文件 | 作用 |
| --- | --- |
| `electron/VoiceRecognitionHelper.ts` | WebSocket 建连、`run-task`/`finish-task`、音频转发、结果解析 |
| `electron/ipcHandlers.ts` | `voice-start` / `voice-audio` / `voice-stop` / `voice-clear` 等 IPC |
| `electron/preload.ts` | 向渲染进程暴露 `startVoiceRecognition` / `sendVoiceAudio` 等 API |
| `electron/ChatService.ts` | 接收显式发送的语音上下文，注入面试官/面试者角色提示和完整面试背景资料 |
| `electron/shortcuts.ts` | 不再注册语音开关快捷键；`Ctrl/Cmd + Enter` 只保留截图提交流程 |
| `src/_pages/Chat.tsx` | 通过 UI 采集系统音频（面试官）+ 麦克风（面试者），重采样为 16kHz PCM，并维护待发送对话队列 |
| `src/components/Settings/SettingsDialog.tsx` | 语音服务设置表单 |

### 8.3 双声道说明

- `system` 源：系统扬声器音频（`getDisplayMedia`），对应“面试官”；
- `microphone` 源：麦克风（`getUserMedia`），对应“面试者”。

两路各自维护独立 WebSocket 会话与转写，并按完成时间合并为有顺序的待发送队列。停止录音不会自动生成回答，用户需要在 UI 中显式点击“发送给 AI”。发送时会整理为：

```text
面试官：...
面试者：...
```

## 9. 注意事项

- 连接 12 秒内未收到 `task-started` 判定为超时并关闭。
- 若握手返回非 101（`unexpected-response`），会读取响应体中的 `message` 展示错误（如 Key 无效、模型未开通）。
- `speechApiKey` 为空时直接拒绝启动并提示“请先在设置中填写百炼语音 API Key”。
- 音频必须与服务端声明一致（PCM S16LE / mono / 16kHz），否则可能出现无声或乱码识别。
- 服务端模型、区域是否开通，请以百炼控制台实际开通情况为准；模型名可直接在设置中更换。
