import SwiftUI
import WebKit

/// Hosts the Sylvestere web app and hands it native speech (SFSpeechRecognizer + AVSpeechSynthesizer),
/// because WKWebView does not expose the Web Speech API.
struct TutorWebView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(context.coordinator, name: "sly")

        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0.102, green: 0.059, blue: 0.180, alpha: 1)
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.uiDelegate = context.coordinator
        web.navigationDelegate = context.coordinator
        context.coordinator.speech.webView = web
        web.load(URLRequest(url: url, cachePolicy: .reloadRevalidatingCacheData))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate {
        let speech = SpeechBridge()

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "listen":
                speech.startListening()
            case "stopListen":
                speech.stopListening()
            case "speak":
                speech.speak(body["text"] as? String ?? "", lang: body["lang"] as? String ?? "en-US")
            case "stopSpeak":
                speech.stopSpeaking()
            default:
                break
            }
        }

        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(.grant)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            showOffline(webView, error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            showOffline(webView, error)
        }

        private func showOffline(_ webView: WKWebView, _ error: Error) {
            let html = """
            <meta name=viewport content='width=device-width,initial-scale=1'>
            <body style='margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#1a0f2e;color:#fff;font-family:-apple-system;text-align:center;padding:24px'>
            <div><h2>Sylvestere needs the internet</h2><p style='opacity:.7'>\(error.localizedDescription)</p>
            <button onclick="location.href='\(ContentView.appURL.absoluteString)'" style='margin-top:16px;padding:14px 22px;border-radius:14px;border:0;background:#6c3df4;color:#fff;font-size:17px;font-weight:700'>Try again</button></div></body>
            """
            webView.loadHTMLString(html, baseURL: nil)
        }
    }
}
