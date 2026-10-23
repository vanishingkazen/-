import SwiftUI

@main
struct CompanionApp: App {
    var body: some Scene {
        WindowGroup { CompanionView() }
    }
}

struct CompanionView: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var camera = CameraController()
    @StateObject private var client = CompanionClient()
    @State private var pairingLink = ""
    @State private var scanning = false
    @State private var source = "phone"
    @State private var showPhoto = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    HStack(spacing: 10) {
                        Circle().fill(client.connected ? Color.green : Color.orange).frame(width: 9, height: 9)
                        Text(client.status).font(.subheadline)
                        Spacer()
                        if client.busy { ProgressView() }
                    }
                    .padding().background(.quaternary, in: RoundedRectangle(cornerRadius: 14))

                    ZStack(alignment: .bottom) {
                        CameraPreview(session: camera.session)
                            .frame(height: 330).clipped()
                        if scanning {
                            RoundedRectangle(cornerRadius: 12).stroke(.white, style: StrokeStyle(lineWidth: 2, dash: [8]))
                                .frame(width: 210, height: 210).padding(.bottom, 60)
                        }
                        Text(scanning ? "对准电脑上的配对二维码" : camera.ready ? "后置相机 · 请保持 App 在前台" : "等待相机就绪")
                            .font(.caption).padding(10).frame(maxWidth: .infinity)
                            .background(.black.opacity(0.6)).foregroundStyle(.white)
                    }
                    .background(.black).clipShape(RoundedRectangle(cornerRadius: 20))
                    .accessibilityLabel("相机实时预览")

                    if let error = camera.errorMessage {
                        VStack(spacing: 10) {
                            Text(error).font(.footnote).foregroundStyle(.red)
                            HStack {
                                Button("重新开启相机") { camera.start() }
                                Button("系统设置") {
                                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                                }
                            }.font(.footnote)
                        }
                    }

                    if !client.paired {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("连接电脑").font(.headline)
                            Text("在电脑打开「手机伴随与相机」，开启服务后，用此 App 扫描二维码。")
                                .font(.footnote).foregroundStyle(.secondary)
                            Button(scanning ? "停止扫码" : "扫描配对二维码", systemImage: "qrcode.viewfinder") { scanning.toggle() }
                                .buttonStyle(.bordered).disabled(!camera.ready || client.busy)
                            SecureField("或粘贴完整配对链接", text: $pairingLink)
                                .textContentType(.none).textInputAutocapitalization(.never).autocorrectionDisabled()
                                .textFieldStyle(.roundedBorder)
                            Button("配对电脑") { Task { await pair(pairingLink) } }
                                .buttonStyle(.borderedProminent).disabled(pairingLink.isEmpty || client.busy)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        Picker("图片来源", selection: $source) {
                            Text("iPhone 拍照").tag("phone")
                            Text("电脑截图").tag("screen")
                        }.pickerStyle(.segmented)

                        Button {
                            Task {
                                if source == "phone" { await client.acquire(camera: camera) }
                                else { await client.screenshot() }
                            }
                        } label: {
                            Label(source == "phone" ? "拍照并传到电脑" : "截取电脑屏幕", systemImage: source == "phone" ? "camera.fill" : "desktopcomputer")
                                .frame(maxWidth: .infinity).padding(.vertical, 8)
                        }.buttonStyle(.borderedProminent)
                            .disabled(client.busy || !client.connected || (source == "phone" && !camera.ready))

                        Text("待发送附件：\(client.pendingCount) 张 · 请在电脑中预览和发送")
                            .font(.footnote).foregroundStyle(.secondary)
                        if let data = client.lastPhoto, let image = UIImage(data: data) {
                            Button { showPhoto = true } label: {
                                HStack {
                                    Image(uiImage: image).resizable().scaledToFit().frame(width: 54, height: 60)
                                    Text("查看最近拍摄的照片").font(.footnote)
                                    Spacer()
                                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                                }
                            }
                        }
                        HStack {
                            Button("重新连接") { client.reconnect() }
                            Spacer()
                            Button("清除本机配对", role: .destructive) { client.forget() }
                        }.font(.footnote).disabled(client.busy)
                    }

                    if let error = client.errorMessage {
                        Text(error).font(.footnote).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Text("开发预览版：沿用电脑伴随服务的 HTTP 明文连接，请仅在可信局域网使用。照片不会写入手机相册。")
                        .font(.caption).foregroundStyle(.secondary)
                }.padding()
            }
            .navigationTitle("手机相机伴随")
            .navigationBarTitleDisplayMode(.inline)
        }
        .task {
            camera.onQRCode = { code in
                guard scanning, !client.busy, !client.paired else { return }
                scanning = false
                Task { await pair(code) }
            }
            client.onRemoteCapture = { id in Task { await client.acquire(camera: camera, requestId: id) } }
            activate(scenePhase == .active)
        }
        .onChange(of: scenePhase) { _, phase in activate(phase == .active) }
        .onChange(of: camera.ready) { _, ready in
            client.updateCameraReady(ready)
            UIApplication.shared.isIdleTimerDisabled = ready && scenePhase == .active
        }
        .sheet(isPresented: $showPhoto) {
            NavigationStack {
                if let data = client.lastPhoto, let image = UIImage(data: data) {
                    Image(uiImage: image).resizable().scaledToFit()
                        .toolbar { Button("完成") { showPhoto = false } }
                }
            }
        }
    }

    private func pair(_ link: String) async {
        scanning = false
        await client.pair(link)
        pairingLink = ""
    }
    private func activate(_ active: Bool) {
        client.setForeground(active)
        if active { camera.start() }
        else { camera.stop(); UIApplication.shared.isIdleTimerDisabled = false }
    }
}
