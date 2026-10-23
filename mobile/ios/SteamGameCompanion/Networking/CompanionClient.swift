import Foundation
import Network

private final class LocalTransportDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor
final class CompanionClient: ObservableObject {
    @Published private(set) var connected = false
    @Published private(set) var paired = false
    @Published private(set) var status = "连接电脑后，即可作为拍摄外设使用"
    @Published private(set) var busy = false
    @Published private(set) var capturePhase: String?
    @Published private(set) var lastPhoto: Data?
    @Published private(set) var lastPhotoUploaded = false
    @Published private(set) var uploadedCount = 0
    @Published private(set) var pendingCount = 0
    @Published private(set) var reconnectAttempt = 0
    @Published private(set) var nextRetryAt: Date?
    @Published private(set) var waitingForNetwork = false
    @Published private(set) var needsPairing = false
    @Published var errorMessage: String?
    var onRemoteCapture: ((String) -> Void)?
    var desktopAddress: String { credential?.baseURL.host ?? "尚未连接电脑" }

    private var credential: PairingCredential?
    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    private var foreground = false
    private var cameraReady = false
    private var automaticReconnect = true
    private var lastMessageAt = Date()
    private let pathMonitor = NWPathMonitor()
    private let session: URLSession
    private let transportDelegate = LocalTransportDelegate()

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 25
        configuration.timeoutIntervalForResource = 30
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.waitsForConnectivity = true
        session = URLSession(configuration: configuration, delegate: transportDelegate, delegateQueue: nil)
        credential = CredentialStore.load()
        paired = credential != nil
        if paired { status = "已保存相机配对，等待连接电脑" }
        pathMonitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.waitingForNetwork = path.status != .satisfied
                guard self.foreground, self.paired, self.automaticReconnect else { return }
                if self.waitingForNetwork {
                    self.closeSocket()
                    self.cancelRetry()
                    self.status = "网络不可用，恢复后自动重连"
                } else if self.socket == nil {
                    self.cancelRetry()
                    self.connect()
                }
            }
        }
        pathMonitor.start(queue: DispatchQueue(label: "companion.network-path"))
    }

    deinit { pathMonitor.cancel() }

    func pair(_ text: String) async {
        guard !busy else { return }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            guard let components = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
                  components.scheme == "http", components.user == nil, components.password == nil,
                  let host = components.host, Self.isPrivateIPv4(host), let port = components.port,
                  port > 0, port <= 65535, components.path == "/companion",
                  let pairingToken = components.fragment, !pairingToken.isEmpty else {
                throw ClientError.message("请扫描电脑「局域网外设 → iOS 相机端」中的二维码")
            }
            guard components.queryItems?.contains(where: { $0.name == "role" && $0.value == "camera" }) == true else {
                throw ClientError.message("这是网页显示端的配对码，请扫描「iOS 相机端」的二维码")
            }
            let base = URL(string: "http://\(host):\(port)")!
            let response = try await call(path: "/api/pair", json: ["token": pairingToken, "role": "camera"], base: base, authenticated: false)
            guard let token = response["token"] as? String, response["role"] as? String == "camera" else { throw ClientError.message("电脑版本不支持独立相机配对，请更新电脑端") }
            let value = PairingCredential(baseURL: base, token: token)
            try CredentialStore.save(value)
            closeSocket()
            cancelRetry()
            credential = value
            paired = true
            automaticReconnect = true
            needsPairing = false
            reconnectAttempt = 0
            connect()
        } catch { errorMessage = error.localizedDescription }
    }

    func setForeground(_ active: Bool) {
        foreground = active
        if active {
            if automaticReconnect { cancelRetry(); connect() }
        } else {
            cancelRetry()
            closeSocket()
            status = paired ? "拍摄已暂停，返回 App 后自动连接" : "连接电脑后，即可作为拍摄外设使用"
        }
    }

    func updateCameraReady(_ ready: Bool) { cameraReady = ready; sendReady() }

    func reconnect() {
        automaticReconnect = true
        needsPairing = false
        reconnectAttempt = 0
        errorMessage = nil
        cancelRetry()
        closeSocket()
        connect()
    }

    func forget() {
        automaticReconnect = false
        cancelRetry()
        closeSocket()
        CredentialStore.clear()
        credential = nil
        paired = false
        needsPairing = false
        reconnectAttempt = 0
        pendingCount = 0
        lastPhoto = nil
        lastPhotoUploaded = false
        status = "已清除本机配对，请扫描相机端二维码连接"
        errorMessage = nil
    }

    private func cancelRetry() { retryTask?.cancel(); retryTask = nil; nextRetryAt = nil }
    private func closeSocket() {
        receiver?.cancel()
        heartbeat?.cancel()
        watchdog?.cancel()
        let previous = socket
        socket = nil
        connected = false
        previous?.cancel(with: .goingAway, reason: nil)
    }

    private func scheduleReconnect() {
        guard foreground, paired, automaticReconnect, retryTask == nil else { return }
        guard !waitingForNetwork else { status = "网络不可用，恢复后自动重连"; return }
        reconnectAttempt += 1
        let delay = min(pow(2.0, Double(min(reconnectAttempt - 1, 4))), 15.0)
        nextRetryAt = Date().addingTimeInterval(delay)
        status = "连接中断，正在自动重连"
        retryTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self, !Task.isCancelled else { return }
            self.retryTask = nil
            self.nextRetryAt = nil
            self.connect()
        }
    }

    private func connectionFailed(_ connection: URLSessionWebSocketTask) {
        guard socket === connection else { return }
        let code = connection.closeCode.rawValue
        closeSocket()
        if code == 4001 || code == 4003 {
            automaticReconnect = false
            needsPairing = true
            reconnectAttempt = 0
            cancelRetry()
            status = "相机授权已撤销或连接已被替换"
            errorMessage = "请重新配对相机；网页显示端的连接不受影响。"
            // A replaced camera must not repeatedly reconnect and displace the new device.
            return
        }
        scheduleReconnect()
    }

    private func connect() {
        guard foreground, automaticReconnect, let credential, socket == nil else { return }
        guard !waitingForNetwork else { status = "网络不可用，恢复后自动重连"; return }
        var components = URLComponents(url: credential.baseURL, resolvingAgainstBaseURL: false)!
        components.scheme = "ws"
        components.path = "/api/events"
        var request = URLRequest(url: components.url!)
        request.setValue(credential.baseURL.absoluteString, forHTTPHeaderField: "Origin")
        let connection = session.webSocketTask(with: request)
        socket = connection
        lastMessageAt = Date()
        connection.resume()
        status = reconnectAttempt > 0 ? "正在重连电脑 · 第 \(reconnectAttempt) 次" : "正在连接电脑…"
        startWatchdog(connection)
        receiver = Task { [weak self] in
            guard let self else { return }
            do {
                let auth = try JSONSerialization.data(withJSONObject: ["type": "auth", "token": credential.token, "role": "camera"])
                try await connection.send(.string(String(decoding: auth, as: UTF8.self)))
                while !Task.isCancelled {
                    let message = try await connection.receive()
                    guard self.socket === connection else { return }
                    let data: Data
                    switch message {
                    case .data(let value): data = value
                    case .string(let value): data = Data(value.utf8)
                    @unknown default: continue
                    }
                    guard let event = try JSONSerialization.jsonObject(with: data) as? [String: Any], let type = event["type"] as? String else { continue }
                    self.lastMessageAt = Date()
                    if type == "camera.snapshot" {
                        let firstSnapshot = !self.connected
                        self.connected = true
                        self.reconnectAttempt = 0
                        self.nextRetryAt = nil
                        if firstSnapshot {
                            self.errorMessage = nil
                            self.status = "已连接，可从电脑或此处触发拍摄"
                            self.sendReady()
                            self.startHeartbeat(connection)
                        }
                        if let state = event["state"] as? [String: Any] { self.pendingCount = state["pendingCount"] as? Int ?? 0 }
                    } else if type == "capture.request", let id = event["requestId"] as? String {
                        guard let expiresAt = event["expiresAt"] as? Double, expiresAt > Date().timeIntervalSince1970 * 1000 else { continue }
                        self.onRemoteCapture?(id)
                    }
                }
            } catch { self.connectionFailed(connection) }
        }
    }

    private func startWatchdog(_ connection: URLSessionWebSocketTask) {
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
                guard let self, self.socket === connection else { return }
                if Date().timeIntervalSince(self.lastMessageAt) > (self.connected ? 25 : 12) {
                    self.connectionFailed(connection)
                    return
                }
            }
        }
    }

    private func startHeartbeat(_ connection: URLSessionWebSocketTask) {
        heartbeat?.cancel()
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(8))
                    guard let self, self.socket === connection else { return }
                    try await connection.send(.string("{\"type\":\"ping\"}"))
                } catch { self?.connectionFailed(connection); return }
            }
        }
    }

    private func sendReady() { send(["type": "camera.ready", "ready": cameraReady && foreground]) }
    private func send(_ object: [String: Any]) {
        guard connected, let connection = socket, let bytes = try? JSONSerialization.data(withJSONObject: object) else { return }
        Task { [weak self] in
            do { try await connection.send(.string(String(decoding: bytes, as: UTF8.self))) }
            catch { self?.connectionFailed(connection) }
        }
    }

    func acquire(camera: CameraController, requestId: String? = nil) async {
        guard !busy, connected, camera.ready else {
            if let requestId { send(["type": "capture.failed", "requestId": requestId]) }
            errorMessage = "请等待相机和电脑连接就绪"
            return
        }
        busy = true
        capturePhase = "准备拍摄"
        errorMessage = nil
        var id = requestId
        defer { busy = false; capturePhase = nil }
        do {
            if id == nil {
                let result = try await call(path: "/api/camera/request", json: [:])
                guard let value = result["requestId"] as? String else { throw ClientError.message("无法创建拍照请求") }
                id = value
            }
            capturePhase = "正在拍摄"
            let photo = try await camera.capture()
            lastPhoto = photo
            lastPhotoUploaded = false
            capturePhase = "正在传到电脑"
            _ = try await call(path: "/api/camera/photo/\(id!)", image: photo)
            lastPhotoUploaded = true
            uploadedCount += 1
            status = "照片已传到电脑和网页显示端"
        } catch {
            if let id { send(["type": "capture.failed", "requestId": id]) }
            errorMessage = error.localizedDescription
            if connected { status = "本次拍摄未完成，请重新拍摄" }
        }
    }

    private func call(path: String, json: [String: Any]? = nil, image: Data? = nil, base: URL? = nil, authenticated: Bool = true) async throws -> [String: Any] {
        guard let base = base ?? credential?.baseURL else { throw ClientError.message("请先配对电脑") }
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue(base.absoluteString, forHTTPHeaderField: "Origin")
        if authenticated {
            guard let token = credential?.token else { throw ClientError.message("请先配对电脑") }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let image { request.httpBody = image; request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type") }
        else if let json { request.httpBody = try JSONSerialization.data(withJSONObject: json); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ClientError.message("电脑响应无效") }
        let result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if authenticated && (http.statusCode == 401 || http.statusCode == 403) {
            automaticReconnect = false
            needsPairing = true
            reconnectAttempt = 0
            cancelRetry()
            closeSocket()
            status = "配对授权已失效，请重新连接相机"
        }
        guard (200..<300).contains(http.statusCode), result["success"] as? Bool != false else {
            throw ClientError.message(result["error"] as? String ?? "请求失败（\(http.statusCode)）")
        }
        return result
    }

    private static func isPrivateIPv4(_ host: String) -> Bool {
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return false }
        return parts[0] == 10 || (parts[0] == 172 && (16...31).contains(parts[1])) || (parts[0] == 192 && parts[1] == 168)
    }
    enum ClientError: LocalizedError {
        case message(String)
        var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
    }
}
