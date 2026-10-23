import AVFoundation
import SwiftUI
import UIKit

// Session configuration and capture state are confined to queue; UI state is published on main.
final class CameraController: NSObject, ObservableObject, AVCapturePhotoCaptureDelegate, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    @Published private(set) var ready = false
    @Published private(set) var errorMessage: String?
    var onQRCode: ((String) -> Void)?

    private let queue = DispatchQueue(label: "companion.camera")
    private let output = AVCapturePhotoOutput()
    private var configured = false
    private var wantsRunning = false
    private var activeCaptureID: Int64?
    private var photoCompletion: ((Result<Data, Error>) -> Void)?
    private var observers: [NSObjectProtocol] = []

    override init() {
        super.init()
        for name in [AVCaptureSession.wasInterruptedNotification, AVCaptureSession.runtimeErrorNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: session, queue: .main) { [weak self] _ in
                self?.ready = false
                self?.errorMessage = "相机被中断，请返回前台后重新开启相机"
                self?.queue.async { [weak self] in self?.finish(.failure(CameraError.unavailable)) }
            })
        }
        observers.append(NotificationCenter.default.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: session, queue: .main) { [weak self] _ in
            self?.queue.async { [weak self] in
                guard let self, self.wantsRunning else { return }
                self.configureAndStart()
            }
        })
    }

    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

    func start() {
        queue.async { [weak self] in self?.wantsRunning = true }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: configureAndStart()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                if granted { self?.configureAndStart() }
                else { self?.report("请在系统设置中允许相机访问") }
            }
        default: report("请在系统设置中允许相机访问")
        }
    }

    func stop() {
        ready = false
        queue.async { [weak self] in
            guard let self else { return }
            self.wantsRunning = false
            if self.session.isRunning { self.session.stopRunning() }
            self.finish(.failure(CameraError.unavailable))
            DispatchQueue.main.async { self.ready = false }
        }
    }

    private func configureAndStart() {
        queue.async { [weak self] in
            guard let self, self.wantsRunning else { return }
            do {
                if !self.configured {
                    self.session.beginConfiguration()
                    defer { self.session.commitConfiguration() }
                    self.session.sessionPreset = .photo
                    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else { throw CameraError.unavailable }
                    let input = try AVCaptureDeviceInput(device: device)
                    guard self.session.canAddInput(input), self.session.canAddOutput(self.output) else { throw CameraError.unavailable }
                    self.session.addInput(input)
                    self.session.addOutput(self.output)
                    let metadata = AVCaptureMetadataOutput()
                    if self.session.canAddOutput(metadata) {
                        self.session.addOutput(metadata)
                        metadata.setMetadataObjectsDelegate(self, queue: .main)
                        if metadata.availableMetadataObjectTypes.contains(.qr) { metadata.metadataObjectTypes = [.qr] }
                    }
                    self.configured = true
                }
                if !self.session.isRunning { self.session.startRunning() }
                let running = self.session.isRunning
                DispatchQueue.main.async { self.ready = running; self.errorMessage = running ? nil : "相机启动失败" }
            } catch { self.report(error.localizedDescription) }
        }
    }

    func capture() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { [weak self] in
                guard let self, self.session.isRunning, self.photoCompletion == nil else {
                    continuation.resume(throwing: CameraError.unavailable)
                    return
                }
                self.photoCompletion = { continuation.resume(with: $0) }
                if let connection = self.output.connection(with: .video), connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
                let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
                self.activeCaptureID = settings.uniqueID
                let captureID = settings.uniqueID
                self.queue.asyncAfter(deadline: .now() + 15) { [weak self] in
                    guard let self, self.activeCaptureID == captureID else { return }
                    self.finish(.failure(CameraError.unavailable))
                }
                settings.flashMode = .off
                self.output.capturePhoto(with: settings, delegate: self)
            }
        }
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        queue.async { [weak self] in
            guard self?.activeCaptureID == photo.resolvedSettings.uniqueID else { return }
            if let error { self?.finish(.failure(error)); return }
            guard let bytes = photo.fileDataRepresentation(), let image = UIImage(data: bytes) else {
                self?.finish(.failure(CameraError.invalidImage)); return
            }
            // Drawing applies orientation and drops location/EXIF metadata.
            let scale = min(1, 2400 / max(image.size.width, image.size.height))
            let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            format.opaque = true
            let normalized = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
            guard let jpeg = normalized.jpegData(compressionQuality: 0.9), jpeg.count <= 8 * 1024 * 1024 else {
                self?.finish(.failure(CameraError.invalidImage)); return
            }
            self?.finish(.success(jpeg))
        }
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: Error?) {
        if let error {
            queue.async { [weak self] in
                guard self?.activeCaptureID == resolvedSettings.uniqueID else { return }
                self?.finish(.failure(error))
            }
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let code = metadataObjects.compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }).first else { return }
        onQRCode?(code)
    }

    private func finish(_ result: Result<Data, Error>) {
        let callback = photoCompletion
        photoCompletion = nil
        activeCaptureID = nil
        callback?(result)
    }

    private func report(_ message: String) {
        DispatchQueue.main.async { self.errorMessage = message; self.ready = false }
    }

    enum CameraError: LocalizedError {
        case unavailable, invalidImage
        var errorDescription: String? {
            switch self {
            case .unavailable: return "相机未就绪或正在拍摄，请保持 App 在前台"
            case .invalidImage: return "无法生成照片，请重新拍摄"
            }
        }
    }
}

struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
        override func layoutSubviews() {
            super.layoutSubviews()
            if let connection = previewLayer.connection, connection.isVideoRotationAngleSupported(90) { connection.videoRotationAngle = 90 }
        }
    }
    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }
    func updateUIView(_ view: PreviewView, context: Context) {}
}
