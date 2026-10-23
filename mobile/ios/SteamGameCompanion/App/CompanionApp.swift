import SwiftUI

@main
struct CompanionApp: App {
    var body: some Scene { WindowGroup { CompanionView() } }
}

struct CompanionView: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var camera = CameraController()
    @StateObject private var client = CompanionClient()
    @State private var pairingLink = ""
    @State private var scanning = false
    @State private var showConnection = false
    @State private var showPhoto = false
    @AppStorage("camera.burnInProtection") private var burnInProtection = false
    @State private var standbyRequested = true
    @State private var originalBrightness: CGFloat?
    @State private var previewScale: CGFloat = 1
    private let accent = Color(red: 0.70, green: 0.85, blue: 0.47)
    private var canCapture: Bool { client.connected && camera.ready && !client.busy && !scanning }
    private var standbyEligible: Bool { burnInProtection && client.connected && camera.ready && scenePhase == .active }
    private var standbyActive: Bool { standbyEligible && standbyRequested && !showConnection && !showPhoto && !scanning && camera.errorMessage == nil && client.errorMessage == nil }

    var body: some View {
        ZStack {
            Color(red: 0.055, green: 0.065, blue: 0.075).ignoresSafeArea()
            if !standbyActive {
                VStack(spacing: 18) {
                    header
                    viewfinder
                    captureControls
                }
                .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 8)
            }
            if standbyActive { standbyScreen }
        }
        .preferredColorScheme(.dark)
        .statusBarHidden(standbyActive)
        .task {
            camera.onQRCode = { code in
                guard scanning, !client.busy else { return }
                scanning = false
                Task { await pair(code) }
            }
            client.onRemoteCapture = { id in Task { await client.acquire(camera: camera, requestId: id) } }
            activate(scenePhase == .active)
        }
        .onChange(of: scenePhase) { _, phase in activate(phase == .active) }
        .onChange(of: camera.ready) { _, ready in
            client.updateCameraReady(ready)
            updateIdleTimer()
        }
        .onChange(of: client.connected) { _, _ in
            standbyRequested = true
            updateIdleTimer()
        }
        .onChange(of: burnInProtection) { _, _ in standbyRequested = true }
        .onChange(of: camera.switchingLens) { _, switching in
            withAnimation(reduceMotion ? nil : .easeInOut(duration: switching ? 0.12 : 0.22)) {
                previewScale = switching && !reduceMotion ? 1.015 : 1
            }
        }
        .onChange(of: standbyActive) { _, active in updateBrightness(dimmed: active) }
        .task(id: standbyEligible && !standbyRequested) {
            guard standbyEligible && !standbyRequested else { return }
            do { try await Task.sleep(for: .seconds(20)) } catch { return }
            guard !Task.isCancelled else { return }
            standbyRequested = true
        }
        .onDisappear {
            updateBrightness(dimmed: false)
            UIApplication.shared.isIdleTimerDisabled = false
        }
        .sheet(isPresented: $showConnection) { connectionSheet }
        .sheet(isPresented: $showPhoto) {
            NavigationStack {
                if let data = client.lastPhoto, let image = UIImage(data: data) {
                    Image(uiImage: image).resizable().scaledToFit().padding()
                        .navigationTitle(client.lastPhotoUploaded ? "已传输的照片" : "最近拍摄的照片")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar { Button("完成") { showPhoto = false } }
                }
            }.preferredColorScheme(.dark)
        }
    }

    private var standbyScreen: some View {
        GeometryReader { geometry in
            TimelineView(.animation(minimumInterval: 1)) { context in
                let time = context.date.timeIntervalSinceReferenceDate
                VStack(spacing: 10) {
                    Text("Connected").font(.system(size: 23, weight: .light, design: .rounded))
                    Text("轻点屏幕返回").font(.system(size: 11))
                }
                .foregroundStyle(Color(white: 0.38))
                .position(
                    x: geometry.size.width / 2 + sin(time * 2 * .pi / 67) * max(0, (geometry.size.width - 200) / 2),
                    y: geometry.size.height / 2 + sin(time * 2 * .pi / 89) * max(0, (geometry.size.height - 180) / 2)
                )
            }
        }
        .background(.black).ignoresSafeArea().contentShape(Rectangle())
        .onTapGesture { standbyRequested = false }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Connected，防烧屏待机，轻点返回操作界面")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { standbyRequested = false }
    }

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 5) {
                Text("局域网相机").font(.system(size: 23, weight: .semibold, design: .rounded))
                Text("iPhone 拍摄外设").font(.caption).foregroundStyle(.white.opacity(0.45))
            }
            Spacer()
            Button { showConnection = true } label: {
                HStack(spacing: 7) {
                    Circle().fill(client.connected ? accent : Color.orange).frame(width: 6, height: 6)
                    Text(client.connected ? "已连接" : client.needsPairing ? "需要配对" : client.waitingForNetwork ? "等待网络" : client.nextRetryAt != nil || client.reconnectAttempt > 0 ? "重连中" : client.paired ? "连接中" : "连接电脑")
                        .font(.system(size: 12, weight: .medium))
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
                }.padding(.horizontal, 13).padding(.vertical, 11)
                    .background(.white.opacity(0.07), in: Capsule())
                    .foregroundStyle(.white.opacity(0.85))
            }.accessibilityLabel("连接设置")
        }
    }

    private var viewfinder: some View {
        GeometryReader { geometry in
            ZStack {
                CameraPreview(session: camera.session)
                    .scaleEffect(previewScale)
                // Composition grid stays visible without covering the subject.
                Path { path in
                    for fraction in [CGFloat(1.0 / 3), CGFloat(2.0 / 3)] {
                        path.move(to: CGPoint(x: geometry.size.width * fraction, y: 0))
                        path.addLine(to: CGPoint(x: geometry.size.width * fraction, y: geometry.size.height))
                        path.move(to: CGPoint(x: 0, y: geometry.size.height * fraction))
                        path.addLine(to: CGPoint(x: geometry.size.width, y: geometry.size.height * fraction))
                    }
                }.stroke(.white.opacity(0.13), lineWidth: 0.5).allowsHitTesting(false)
                LinearGradient(colors: [.black.opacity(0.28), .clear, .clear, .black.opacity(0.55)], startPoint: .top, endPoint: .bottom).allowsHitTesting(false)
                VStack {
                    HStack {
                        Label(scanning ? "扫码连接" : camera.selectedLensName, systemImage: scanning ? "qrcode.viewfinder" : "camera")
                            .font(.system(size: 11, weight: .medium)).padding(.horizontal, 11).padding(.vertical, 7)
                            .background(.black.opacity(0.35), in: Capsule())
                        Spacer()
                        if scanning {
                            Button { scanning = false } label: { Image(systemName: "xmark").font(.system(size: 12, weight: .semibold)).padding(10).background(.black.opacity(0.35), in: Circle()) }
                                .accessibilityLabel("取消扫码")
                        }
                    }
                    Spacer()
                    if scanning {
                        RoundedRectangle(cornerRadius: 22)
                            .stroke(accent, style: StrokeStyle(lineWidth: 2, dash: [16, 8]))
                            .frame(width: min(geometry.size.width - 48, 250), height: min(geometry.size.height * 0.6, 250))
                        Spacer()
                    }
                    if let message = camera.errorMessage {
                        VStack(spacing: 12) {
                            Image(systemName: "camera.fill").font(.title)
                            Text(message).font(.footnote).multilineTextAlignment(.center)
                            HStack {
                                Button("重试") { camera.start() }
                                Button("系统设置") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
                            }.font(.footnote).buttonStyle(.bordered)
                        }.padding(20).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
                        Spacer()
                    }
                    Text(scanning ? "扫描电脑「iOS 相机端」的二维码" : "保持文字清晰、画面平稳")
                        .font(.system(size: 12)).foregroundStyle(.white.opacity(0.8)).padding(.bottom, 4)
                }.padding(16)
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .background(.black).clipped().clipShape(RoundedRectangle(cornerRadius: 26))
        }.accessibilityLabel("相机实时取景")
    }

    private var captureControls: some View {
        VStack(spacing: 16) {
            if !scanning && !camera.lenses.isEmpty { lensSelector }
            HStack(spacing: 8) {
                if client.busy { ProgressView().controlSize(.small).tint(accent) }
                else { Image(systemName: client.lastPhotoUploaded ? "checkmark.circle.fill" : "wifi").foregroundStyle(client.connected ? accent : .white.opacity(0.4)) }
                Text(client.capturePhase ?? client.status).font(.system(size: 12)).foregroundStyle(.white.opacity(0.7)).lineLimit(2)
            }.frame(minHeight: 32)
            HStack {
                Button { if client.lastPhoto != nil { showPhoto = true } } label: {
                    ZStack(alignment: .bottomTrailing) {
                        RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.06)).frame(width: 58, height: 68)
                        if let data = client.lastPhoto, let image = UIImage(data: data) {
                            Image(uiImage: image).resizable().scaledToFill().frame(width: 58, height: 68).clipped().clipShape(RoundedRectangle(cornerRadius: 14))
                            if client.lastPhotoUploaded { Image(systemName: "checkmark.circle.fill").foregroundStyle(accent).background(.black, in: Circle()).offset(x: 4, y: 4) }
                        } else { Image(systemName: "photo").foregroundStyle(.white.opacity(0.25)).frame(width: 58, height: 68) }
                    }
                }.disabled(client.lastPhoto == nil).accessibilityLabel("查看最近照片")
                Spacer()
                Button {
                    if !client.paired { showConnection = true }
                    else { Task { await client.acquire(camera: camera) } }
                } label: {
                    ZStack {
                        Circle().stroke((canCapture || !client.paired) ? .white : .white.opacity(0.2), lineWidth: 3).frame(width: 82, height: 82)
                        Circle().fill((canCapture || !client.paired) ? .white : .white.opacity(0.18)).frame(width: 68, height: 68)
                        if client.busy { ProgressView().tint(.black) }
                        else if !client.paired { Image(systemName: "link").font(.title2).foregroundStyle(.black) }
                    }
                }.disabled(client.paired && !canCapture).accessibilityLabel(client.paired ? "拍照并传输" : "连接电脑")
                Spacer()
                Button { showConnection = true } label: {
                    VStack(spacing: 7) {
                        Image(systemName: "slider.horizontal.3").font(.system(size: 20))
                        Text("连接").font(.system(size: 10))
                    }.foregroundStyle(.white.opacity(0.65)).frame(width: 58, height: 68)
                }.accessibilityLabel("管理相机连接")
            }
            HStack(spacing: 6) {
                Text(client.uploadedCount > 0 ? "已传输 \(client.uploadedCount) 张" : "拍摄后自动传到电脑")
                Text("·")
                Text("在电脑或网页显示端提交")
            }.font(.system(size: 10)).foregroundStyle(.white.opacity(0.35))
            if let error = client.errorMessage {
                Text(error).font(.caption).foregroundStyle(.orange).multilineTextAlignment(.center).lineLimit(3)
            }
        }.padding(.horizontal, 8)
    }

    private var lensSelector: some View {
        VStack(spacing: 7) {
            HStack {
                Text("已识别 \(camera.lenses.count) 个后置镜头")
                Spacer()
                Text(camera.switchingLens ? "正在切换…" : "当前：\(camera.selectedLensName)")
                    .foregroundStyle(accent)
            }.font(.system(size: 11)).foregroundStyle(.secondary)
            if camera.lenses.count > 1 {
                LensSelectionStrip(lenses: camera.lenses, selectedID: camera.selectedLensID,
                                   switching: camera.switchingLens, accent: accent) { id in
                    camera.selectLens(id)
                }
            }
            if let error = camera.lensError { Text(error).font(.caption).foregroundStyle(.orange) }
        }
        .disabled(client.busy || camera.switchingLens || !camera.ready)
    }

    private var connectionSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("把 iPhone 连接为拍摄外设").font(.title3.weight(.semibold))
                        Text("网页显示端可以使用另一台手机或平板。此 App 负责取景和拍摄，照片通过电脑同步。")
                            .font(.subheadline).foregroundStyle(.secondary).lineSpacing(4)
                    }
                    if client.paired {
                        VStack(alignment: .leading, spacing: 12) {
                            Label(client.desktopAddress, systemImage: "desktopcomputer").font(.headline)
                            Text(client.status).font(.footnote).foregroundStyle(.secondary)
                            if let retryAt = client.nextRetryAt {
                                TimelineView(.periodic(from: .now, by: 1)) { context in
                                    Text("\(max(0, Int(ceil(retryAt.timeIntervalSince(context.date))))) 秒后进行第 \(client.reconnectAttempt) 次重连")
                                        .font(.caption).foregroundStyle(accent)
                                }
                            }
                            HStack {
                                if client.needsPairing {
                                    Button("重新配对", systemImage: "qrcode.viewfinder") { client.forget() }.buttonStyle(.bordered)
                                } else {
                                    Button("立即重连", systemImage: "arrow.clockwise") { client.reconnect() }.buttonStyle(.bordered)
                                }
                                Spacer()
                                Button("更换电脑", role: .destructive) { client.forget() }
                            }.font(.footnote).disabled(client.busy)
                        }.padding().frame(maxWidth: .infinity, alignment: .leading).background(.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 18))
                    } else {
                        VStack(alignment: .leading, spacing: 14) {
                            Label("电脑 → 局域网外设 → iOS 相机端", systemImage: "qrcode").font(.subheadline.weight(.medium))
                            Button {
                                showConnection = false
                                scanning = true
                            } label: { Label("扫描相机端二维码", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity).padding(.vertical, 7) }
                                .buttonStyle(.borderedProminent).tint(accent).foregroundStyle(.black).disabled(!camera.ready || client.busy)
                            DisclosureGroup("使用配对链接") {
                                VStack(spacing: 12) {
                                    SecureField("粘贴完整的相机配对链接", text: $pairingLink)
                                        .textInputAutocapitalization(.never).autocorrectionDisabled().textFieldStyle(.roundedBorder)
                                    Button("连接电脑") { Task { await pair(pairingLink) } }.disabled(pairingLink.isEmpty || client.busy)
                                }.padding(.top, 12)
                            }.font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        Toggle("防烧屏模式", isOn: $burnInProtection).tint(accent)
                        Text("连接后以低亮度显示缓慢移动的 Connected。轻点返回操作界面，20 秒后自动待机；相机保持可用，电脑可随时拍摄。离开待机或进入后台时恢复原亮度。")
                            .font(.footnote).foregroundStyle(.secondary).lineSpacing(4)
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        Label("自动恢复连接", systemImage: "arrow.triangle.2.circlepath").font(.subheadline.weight(.medium))
                        Text("短暂断网会保留配对，网络恢复后自动重连。请保持 App 在前台；电脑撤销相机授权后需要重新扫码。")
                            .font(.footnote).foregroundStyle(.secondary).lineSpacing(4)
                    }
                    if let error = client.errorMessage { Text(error).font(.footnote).foregroundStyle(.orange) }
                    Text("当前使用局域网 HTTP 连接，请连接可信 Wi-Fi。照片不会保存到系统相册。")
                        .font(.caption).foregroundStyle(.secondary)
                }.padding(24)
            }
            .navigationTitle("相机连接").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showConnection = false } } }
        }.preferredColorScheme(.dark).presentationDetents([.large]).presentationDragIndicator(.visible)
    }

    private func pair(_ link: String) async {
        scanning = false
        await client.pair(link)
        pairingLink = ""
        showConnection = !client.paired || client.errorMessage != nil
    }
    private func activate(_ active: Bool) {
        client.setForeground(active)
        if active { camera.start() }
        else { camera.stop(); updateBrightness(dimmed: false) }
        updateIdleTimer()
    }

    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled = scenePhase == .active && (client.connected || camera.ready)
    }

    private func updateBrightness(dimmed: Bool) {
        if dimmed {
            if originalBrightness == nil { originalBrightness = UIScreen.main.brightness }
            UIScreen.main.brightness = min(originalBrightness ?? 0.1, 0.1)
        } else if let brightness = originalBrightness {
            UIScreen.main.brightness = brightness
            originalBrightness = nil
        }
    }
}

private struct LensSelectionStrip: View {
    let lenses: [CameraController.Lens]
    let selectedID: String?
    let switching: Bool
    let accent: Color
    let onSelect: (String) -> Void
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var position = 0.0
    @State private var dragging = false

    private var selectedIndex: Int { lenses.firstIndex(where: { $0.id == selectedID }) ?? 0 }
    private var lastIndex: Double { Double(max(0, lenses.count - 1)) }
    private var followAnimation: Animation? { reduceMotion ? nil : .interactiveSpring(response: 0.22, dampingFraction: 0.9, blendDuration: 0.08) }
    private var settleAnimation: Animation? { reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.88) }

    var body: some View {
        GeometryReader { geometry in
            let cellWidth = max(1, (geometry.size.width - 8) / CGFloat(max(1, lenses.count)))
            ZStack(alignment: .leading) {
                Capsule().fill(.white.opacity(0.045))
                Capsule()
                    .fill(accent.opacity(0.13))
                    .overlay(Capsule().strokeBorder(accent.opacity(0.2), lineWidth: 0.5))
                    .frame(width: cellWidth, height: 38)
                    .offset(x: 4 + CGFloat(position) * cellWidth)
                HStack(spacing: 0) {
                    ForEach(Array(lenses.enumerated()), id: \.element.id) { index, lens in
                        let strength = max(0, 1 - abs(position - Double(index)))
                        ZStack {
                            Text(lens.name).font(.system(size: 13, weight: .regular))
                                .foregroundStyle(.white.opacity(0.5)).opacity(1 - strength)
                            Text(lens.name).font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(accent).opacity(strength)
                        }.frame(width: cellWidth, height: 46)
                    }
                }.padding(.horizontal, 4)
            }
            .contentShape(Capsule())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { value in
                    guard isEnabled else { return }
                    dragging = true
                    // Keep a continuous position while dragging; never reconfigure a camera here.
                    let next = min(max(Double((value.location.x - 4) / cellWidth) - 0.5, 0), lastIndex)
                    withAnimation(followAnimation) { position = next }
                }
                .onEnded { value in
                    guard isEnabled else { dragging = false; synchronize(); return }
                    let next = min(max(Double((value.location.x - 4) / cellWidth) - 0.5, 0), lastIndex)
                    commit(Int(next.rounded()))
                })
        }
        .frame(height: 46)
        .allowsHitTesting(isEnabled)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("后置镜头")
        .accessibilityValue(lenses.first(where: { $0.id == selectedID })?.name ?? "未选择")
        .accessibilityAdjustableAction { direction in
            guard isEnabled else { return }
            switch direction {
            case .increment: commit(min(selectedIndex + 1, lenses.count - 1))
            case .decrement: commit(max(selectedIndex - 1, 0))
            @unknown default: break
            }
        }
        .onAppear { position = Double(selectedIndex) }
        .onChange(of: selectedID) { _, _ in if !dragging { synchronize() } }
        .onChange(of: switching) { _, active in if !active { synchronize() } }
        .onChange(of: isEnabled) { _, enabled in
            if !enabled && dragging { dragging = false; synchronize() }
        }
    }

    private func synchronize() {
        withAnimation(settleAnimation) { position = Double(selectedIndex) }
    }

    private func commit(_ index: Int) {
        guard lenses.indices.contains(index) else { return }
        dragging = false
        withAnimation(settleAnimation) { position = Double(index) }
        if index != selectedIndex { onSelect(lenses[index].id) }
    }
}
