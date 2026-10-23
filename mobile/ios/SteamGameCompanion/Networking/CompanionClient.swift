import Foundation

private final class LocalTransportDelegate: NSObject, URLSessionTaskDelegate {
    // Never forward a paired token to a redirect destination.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor
final class CompanionClient: ObservableObject {
    @Published private(set) var connected = false
    @Published private(set) var paired = false
    @Published private(set) var status = "尚未配对"
    @Published private(set) var busy = false
    @Published private(set) var lastPhoto: Data?
    @Published private(set) var pendingCount = 0
    @Published var errorMessage: String?
    var onRemoteCapture: ((String) -> Void)?

    private var credential: PairingCredential?
    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var foreground = false
    private var cameraReady = false
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
        if paired { status = "已保存配对，等待连接" }
    }

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
                throw ClientError.message("请扫描电脑伴随窗口的二维码，或粘贴完整的局域网配对链接（包含 # 后的配对码）")
            }
            let base = URL(string: "http://\(host):\(port)")!
            let response = try await call(path: "/api/pair", json: ["token": pairingToken], base: base, authenticated: false)
            guard let token = response["token"] as? String else { throw ClientError.message("配对响应无效") }
            let value = PairingCredential(baseURL: base, token: token)
            try CredentialStore.save(value)
            credential = value
            paired = true
            connect()
        } catch { errorMessage = error.localizedDescription }
    }

    func setForeground(_ active: Bool) {
        foreground = active
        if active { connect() }
        else { closeSocket(); status = paired ? "App 已进入后台，拍照暂停" : "尚未配对" }
    }

    func updateCameraReady(_ ready: Bool) {
        cameraReady = ready
        sendReady()
    }

    func reconnect() { closeSocket(); connect() }

    func forget() {
        closeSocket()
        CredentialStore.clear()
        credential = nil
        paired = false
        pendingCount = 0
        lastPhoto = nil
        status = "尚未配对；如电脑仍显示已配对，请先在电脑端断开手机"
    }

    private func closeSocket() {
        receiver?.cancel()
        heartbeat?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        connected = false
    }

    private func connect() {
        guard foreground, let credential, socket == nil else { return }
        var components = URLComponents(url: credential.baseURL, resolvingAgainstBaseURL: false)!
        components.scheme = "ws"
        components.path = "/api/events"
        var request = URLRequest(url: components.url!)
        request.setValue(credential.baseURL.absoluteString, forHTTPHeaderField: "Origin")
        let connection = session.webSocketTask(with: request)
        socket = connection
        connection.resume()
        status = "正在连接电脑…"
        receiver = Task { [weak self] in
            guard let self else { return }
            do {
                let auth = try JSONSerialization.data(withJSONObject: ["type": "auth", "token": credential.token])
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
                    if type == "snapshot" {
                        self.connected = true
                        self.status = "电脑已连接"
                        self.updateSnapshot(event["state"] as? [String: Any])
                        self.sendReady()
                        self.startHeartbeat(connection)
                    } else if type == "refresh" {
                        let state = try await self.call(path: "/api/state", method: "GET")
                        self.updateSnapshot(state["state"] as? [String: Any])
                    } else if type == "capture.request", let id = event["requestId"] as? String {
                        guard let expiresAt = event["expiresAt"] as? Double, expiresAt > Date().timeIntervalSince1970 * 1000 else { continue }
                        self.onRemoteCapture?(id)
                    }
                }
            } catch {
                guard self.socket === connection else { return }
                self.closeSocket()
                self.status = "连接已断开，请确认电脑服务仍开启后点击重连"
                self.errorMessage = error.localizedDescription
            }
        }
    }

    private func startHeartbeat(_ connection: URLSessionWebSocketTask) {
        heartbeat?.cancel()
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(10))
                    guard let self, self.socket === connection else { return }
                    try await connection.send(.string("{\"type\":\"ping\"}"))
                } catch { return }
            }
        }
    }

    private func sendReady() { send(["type": "camera.ready", "ready": cameraReady && foreground]) }
    private func send(_ object: [String: Any]) {
        guard connected, let socket, let bytes = try? JSONSerialization.data(withJSONObject: object) else { return }
        Task { try? await socket.send(.string(String(decoding: bytes, as: UTF8.self))) }
    }

    func acquire(camera: CameraController, requestId: String? = nil) async {
        guard !busy, connected, camera.ready else {
            if let requestId { send(["type": "capture.failed", "requestId": requestId]) }
            errorMessage = "请先连接电脑并等待相机就绪"
            return
        }
        busy = true
        errorMessage = nil
        var id = requestId
        defer { busy = false }
        do {
            if id == nil {
                let result = try await call(path: "/api/camera/request", json: [:])
                guard let value = result["requestId"] as? String else { throw ClientError.message("无法创建拍照请求") }
                id = value
            }
            let photo = try await camera.capture()
            lastPhoto = photo
            status = "正在上传照片…"
            _ = try await call(path: "/api/camera/photo/\(id!)", image: photo)
            status = "照片已加入电脑待发送附件"
        } catch {
            if let id { send(["type": "capture.failed", "requestId": id]) }
            errorMessage = error.localizedDescription
            status = connected ? "上传或拍照失败，可重新拍摄" : "电脑连接已断开"
        }
    }

    func screenshot() async {
        guard !busy, connected else { return }
        busy = true
        errorMessage = nil
        defer { busy = false }
        do {
            _ = try await call(path: "/api/screenshot", json: [:])
            status = "图片已加入电脑待发送附件"
        } catch { errorMessage = error.localizedDescription }
    }

    private func updateSnapshot(_ state: [String: Any]?) {
        if let images = state?["pendingScreenshots"] as? [Any] { pendingCount = images.count }
    }

    private func call(path: String, method: String = "POST", json: [String: Any]? = nil, image: Data? = nil, base: URL? = nil, authenticated: Bool = true) async throws -> [String: Any] {
        guard let base = base ?? credential?.baseURL else { throw ClientError.message("请先配对电脑") }
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = method
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
