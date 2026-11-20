// Agent Bubble — bong bóng nổi luôn nằm trên mọi cửa sổ (kiểu chat head).
//   • Kéo để di chuyển, thả ra tự dính mép màn hình gần nhất, nhớ vị trí.
//   • Bấm: bung/thu "văn phòng" (panel nổi). Chuột phải: menu.
//   • Có ở mọi Desktop/Space, kể cả cạnh app đang toàn màn hình. Không chiếm Dock.
// Nội dung là trang web của server Agent Office (http://127.0.0.1:47321).
//   • Thông báo macOS: trang bubble.html nhận sự kiện từ server rồi gọi handler "notify";
//     bấm vào thông báo → mở đúng chat (hoặc copy lệnh resume nếu phiên chạy ở terminal).

import Cocoa
import UserNotifications
import WebKit

let SERVER = "http://127.0.0.1:47321"
let BUBBLE: CGFloat = 72

/// WKWebView nhận cú click đầu tiên dù app không active.
final class HomeWebView: WKWebView {
    var home: URL!
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    func goHome() { load(URLRequest(url: home)) }
}

/// Server chưa lên / bị khởi động lại → thử tải lại sau 3 giây.
final class RetryNav: NSObject, WKNavigationDelegate {
    private func retry(_ w: WKWebView) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { (w as? HomeWebView)?.goHome() }
    }
    func webView(_ w: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { retry(w) }
    func webView(_ w: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { retry(w) }
    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { retry(w) }
}

/// Lớp phủ trong suốt trên bong bóng: kéo = di chuyển, bấm = bung văn phòng, chuột phải = menu.
final class DragView: NSView {
    var onClick: (() -> Void)?
    var onMoved: (() -> Void)?
    var onMenu: ((NSEvent) -> Void)?
    private var start = NSPoint.zero
    private var origin = NSPoint.zero
    private var moved = false

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        start = NSEvent.mouseLocation
        origin = window?.frame.origin ?? .zero
        moved = false
    }
    override func mouseDragged(with event: NSEvent) {
        let p = NSEvent.mouseLocation
        let dx = p.x - start.x, dy = p.y - start.y
        if abs(dx) + abs(dy) > 3 { moved = true }
        window?.setFrameOrigin(NSPoint(x: origin.x + dx, y: origin.y + dy))
    }
    override func mouseUp(with event: NSEvent) { moved ? onMoved?() : onClick?() }
    override func rightMouseDown(with event: NSEvent) { onMenu?(event) }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    var bubble: NSPanel!
    var office: NSPanel?
    let nav = RetryNav()
    let behavior: NSWindow.CollectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]

    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self

        bubble = NSPanel(contentRect: NSRect(x: 0, y: 0, width: BUBBLE, height: BUBBLE),
                         styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        bubble.isOpaque = false
        bubble.backgroundColor = .clear
        bubble.hasShadow = false
        bubble.level = .floating
        bubble.collectionBehavior = behavior
        bubble.hidesOnDeactivate = false

        let content = bubble.contentView!
        content.addSubview(makeWeb(path: "/bubble.html", frame: content.bounds, notify: true))
        let drag = DragView(frame: content.bounds)
        drag.autoresizingMask = [.width, .height]
        drag.onClick = { [weak self] in self?.toggleOffice() }
        drag.onMoved = { [weak self] in self?.snapAndSave() }
        drag.onMenu = { [weak self, weak drag] e in
            guard let self = self, let drag = drag else { return }
            self.showMenu(e, in: drag)
        }
        content.addSubview(drag)

        bubble.setFrameOrigin(savedOrigin())
        bubble.orderFrontRegardless()
    }

    /// Bấm icon app lần nữa (vd. từ Spotlight) → bung văn phòng.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        toggleOffice(forceOpen: true)
        return true
    }

    func makeWeb(path: String, frame: NSRect, notify: Bool = false) -> HomeWebView {
        let config = WKWebViewConfiguration()
        if notify { config.userContentController.add(self, name: "notify") }
        let w = HomeWebView(frame: frame, configuration: config)
        w.home = URL(string: SERVER + path)!
        w.setValue(false, forKey: "drawsBackground")
        w.autoresizingMask = [.width, .height]
        w.navigationDelegate = nav
        w.goHome()
        return w
    }

    // ---------- vị trí ----------

    func savedOrigin() -> NSPoint {
        if let s = UserDefaults.standard.string(forKey: "bubbleOrigin") {
            let p = NSPointFromString(s)
            let center = NSPoint(x: p.x + BUBBLE / 2, y: p.y + BUBBLE / 2)
            if NSScreen.screens.contains(where: { $0.visibleFrame.insetBy(dx: -8, dy: -8).contains(center) }) { return p }
        }
        let vf = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
        return NSPoint(x: vf.maxX - BUBBLE - 6, y: vf.minY + vf.height * 0.3)
    }

    /// Thả ra → dính vào mép trái/phải gần nhất, lưu vị trí.
    func snapAndSave() {
        guard let screen = bubble.screen ?? NSScreen.main else { return }
        let vf = screen.visibleFrame
        var f = bubble.frame
        f.origin.x = f.midX < vf.midX ? vf.minX + 6 : vf.maxX - f.width - 6
        f.origin.y = min(max(f.origin.y, vf.minY + 4), vf.maxY - f.height - 4)
        bubble.setFrame(f, display: true, animate: true)
        UserDefaults.standard.set(NSStringFromPoint(f.origin), forKey: "bubbleOrigin")
        if office?.isVisible == true { positionOffice() }
    }

    // ---------- văn phòng (panel nổi) ----------

    func toggleOffice(forceOpen: Bool = false) {
        if let o = office, o.isVisible, !forceOpen {
            o.orderOut(nil)
            return
        }
        if office == nil {
            let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 400, height: 680),
                            styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel],
                            backing: .buffered, defer: false)
            p.title = "Agent Office"
            p.level = .floating
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            p.isReleasedWhenClosed = false
            p.hidesOnDeactivate = false
            p.acceptsMouseMovedEvents = true
            p.minSize = NSSize(width: 320, height: 360)
            p.contentView = makeWeb(path: "/", frame: NSRect(x: 0, y: 0, width: 400, height: 680))
            if let s = UserDefaults.standard.string(forKey: "officeSize") {
                let size = NSSizeFromString(s)
                if size.width >= 320 && size.height >= 360 { p.setContentSize(size) }
            }
            NotificationCenter.default.addObserver(forName: NSWindow.didEndLiveResizeNotification, object: p, queue: .main) { _ in
                UserDefaults.standard.set(NSStringFromSize(p.contentLayoutRect.size), forKey: "officeSize")
            }
            office = p
        }
        positionOffice()
        office!.orderFrontRegardless()
    }

    /// Đặt văn phòng cạnh bong bóng, phía còn chỗ.
    func positionOffice() {
        guard let o = office, let screen = bubble.screen ?? NSScreen.main else { return }
        let vf = screen.visibleFrame
        let b = bubble.frame
        var f = o.frame
        f.origin.x = b.midX > vf.midX ? b.minX - f.width - 6 : b.maxX + 6
        f.origin.x = min(max(f.origin.x, vf.minX), vf.maxX - f.width)
        f.origin.y = min(max(b.maxY - f.height, vf.minY + 4), vf.maxY - f.height)
        o.setFrame(f, display: true)
    }

    // ---------- menu chuột phải ----------

    func showMenu(_ event: NSEvent, in view: NSView) {
        let m = NSMenu()
        let toggle = office?.isVisible == true ? "Thu văn phòng lại" : "Mở văn phòng"
        m.addItem(withTitle: toggle, action: #selector(menuToggle), keyEquivalent: "").target = self
        m.addItem(withTitle: "Mở cửa sổ lớn", action: #selector(openBig), keyEquivalent: "").target = self
        m.addItem(withTitle: "Tải lại", action: #selector(reloadAll), keyEquivalent: "").target = self
        m.addItem(.separator())
        m.addItem(withTitle: "Tắt bong bóng", action: #selector(quit), keyEquivalent: "").target = self
        NSMenu.popUpContextMenu(m, with: event, for: view)
    }

    @objc func menuToggle() { toggleOffice() }

    @objc func openBig() {
        guard let dir = Bundle.main.object(forInfoDictionaryKey: "AgentOfficeDir") as? String else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [dir + "/open.sh"]
        try? p.run()
    }

    @objc func reloadAll() {
        for w in [bubble, office].compactMap({ $0 }) {
            (w.contentView as? HomeWebView)?.goHome()
            for v in w.contentView?.subviews ?? [] { (v as? HomeWebView)?.goHome() }
        }
    }

    @objc func quit() { NSApp.terminate(nil) }

    // ---------- thông báo macOS ----------

    /// Tin nhắn từ bubble.html: "hello" (hỏi có được báo không) hoặc "notify" (hiện một thông báo).
    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        if type == "hello" {
            let web = message.webView
            notifyReady { ok in
                web?.evaluateJavaScript("window.nativeReady && window.nativeReady(\(ok))", completionHandler: nil)
            }
        } else if type == "notify" {
            post(id: body["id"] as? String ?? UUID().uuidString,
                 title: body["title"] as? String ?? "Agent Office",
                 body: body["body"] as? String ?? "",
                 session: body["session"] as? String ?? "")
        }
    }

    /// Đã được phép thì báo true; chưa hỏi thì hỏi macOS một lần.
    func notifyReady(_ done: @escaping (Bool) -> Void) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { s in
            switch s.authorizationStatus {
            case .authorized, .provisional:
                DispatchQueue.main.async { done(true) }
            case .notDetermined:
                center.requestAuthorization(options: [.alert, .sound]) { granted, err in
                    if let err = err { NSLog("agent-bubble: xin quyền thông báo lỗi: \(err)") }
                    DispatchQueue.main.async { done(granted) }
                }
            default:
                NSLog("agent-bubble: thông báo đang bị tắt trong Cài đặt hệ thống")
                DispatchQueue.main.async { done(false) }
            }
        }
    }

    func post(id: String, title: String, body: String, session: String) {
        let c = UNMutableNotificationContent()
        c.title = title
        c.body = body
        c.sound = .default
        if !session.isEmpty {
            c.userInfo = ["session": session]
            c.threadIdentifier = session
        }
        let req = UNNotificationRequest(identifier: id, content: c, trigger: nil)
        UNUserNotificationCenter.current().add(req) { err in
            if let err = err { NSLog("agent-bubble: gửi thông báo lỗi: \(err)") }
        }
    }

    /// App đang chạy (bong bóng luôn "active" kiểu accessory) vẫn hiện banner.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    /// Bấm vào thông báo → mở chat của phiên.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let s = response.notification.request.content.userInfo["session"] as? String, !s.isEmpty { openSession(s) }
        completionHandler()
    }

    func openSession(_ id: String) {
        var comps = URLComponents(string: SERVER + "/open")!
        comps.queryItems = [URLQueryItem(name: "session", value: id)]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "POST"
        req.setValue("1", forHTTPHeaderField: "x-agent-office")
        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let data = data,
                  let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let copy = j["copy"] as? String else { return }
            // phiên chạy ở terminal: copy lệnh resume
            DispatchQueue.main.async {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(copy, forType: .string)
                self.post(id: UUID().uuidString, title: "Đã copy lệnh mở phiên", body: copy, session: "")
            }
        }.resume()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
