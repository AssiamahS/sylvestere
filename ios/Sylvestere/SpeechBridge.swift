import Foundation
import AVFoundation
import Speech
import WebKit

/// Native speech for the web app: recognition via SFSpeechRecognizer, synthesis via AVSpeechSynthesizer.
/// Events go back to JS through window.__sly.onSpeech / window.__sly.onSpeak.
final class SpeechBridge: NSObject, AVSpeechSynthesizerDelegate {
    weak var webView: WKWebView?

    private let synth = AVSpeechSynthesizer()
    private let audioEngine = AVAudioEngine()
    private var recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var silenceTimer: Timer?
    private var lastTranscript = ""
    private var finished = false

    // Apple's recognizer is pinned to one locale and mangles a mixed sentence ("how do I say... un té por
    // favor"), so the same audio is also written to a wav and sent to the worker's Whisper, which is
    // multilingual. Whisper's text wins; the recognizer's text is the fallback.
    private static let sttBase = "https://sylvestere-api.sylvesterassiamahpm.workers.dev/stt?lang="
    private var sttLang = "en"
    private var audioFile: AVAudioFile?
    private var audioURL: URL?
    private var sttTask: URLSessionDataTask?

    override init() {
        super.init()
        synth.delegate = self
    }

    // MARK: - JS callbacks

    private func emit(_ fn: String, _ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async {
            self.webView?.evaluateJavaScript("window.__sly && window.__sly.\(fn)(\(json))", completionHandler: nil)
        }
    }

    // MARK: - Recognition

    func startListening(lang: String = "en-US") {
        stopSpeaking()
        stopListening(emitFinal: false)
        finished = false
        lastTranscript = ""
        // Recognizer locale follows the language being learned (es-ES / fr-FR / de-DE / en-US).
        if recognizer?.locale.identifier.replacingOccurrences(of: "_", with: "-") != lang {
            recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang))
        }
        sttLang = String(lang.prefix(2))

        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard let self else { return }
            guard status == .authorized else {
                self.emit("onSpeech", ["state": "error", "message": "not-allowed"])
                return
            }
            AVAudioApplication.requestRecordPermission { granted in
                guard granted else {
                    self.emit("onSpeech", ["state": "error", "message": "not-allowed"])
                    return
                }
                DispatchQueue.main.async { self.beginRecognition() }
            }
        }
    }

    private func beginRecognition() {
        guard let recognizer, recognizer.isAvailable else {
            emit("onSpeech", ["state": "error", "message": "speech recognizer unavailable"])
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let req = SFSpeechAudioBufferRecognitionRequest()
            req.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = false }
            request = req

            let input = audioEngine.inputNode
            let format = input.outputFormat(forBus: 0)
            sttTask?.cancel(); sttTask = nil
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("sly-\(UUID().uuidString).wav")
            audioURL = url
            audioFile = try? AVAudioFile(forWriting: url, settings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: format.sampleRate,
                AVNumberOfChannelsKey: format.channelCount,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false,
            ], commonFormat: format.commonFormat, interleaved: format.isInterleaved)
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                self?.request?.append(buffer)
                try? self?.audioFile?.write(from: buffer)
            }
            audioEngine.prepare()
            try audioEngine.start()

            task = recognizer.recognitionTask(with: req) { [weak self] result, error in
                guard let self else { return }
                if let result {
                    let text = result.bestTranscription.formattedString
                    if text != self.lastTranscript {
                        self.lastTranscript = text
                        self.emit("onSpeech", ["state": "partial", "text": text])
                        self.restartSilenceTimer()
                    }
                    if result.isFinal { self.finish(with: text) }
                }
                if let error, !self.finished {
                    // A cancelled task after we already have text is a normal stop.
                    if self.lastTranscript.isEmpty {
                        self.emit("onSpeech", ["state": "error", "message": error.localizedDescription])
                        self.finished = true
                        self.teardownAudio()
                    } else {
                        self.finish(with: self.lastTranscript)
                    }
                }
            }
            restartSilenceTimer(initial: true)
        } catch {
            emit("onSpeech", ["state": "error", "message": error.localizedDescription])
            teardownAudio()
        }
    }

    private func restartSilenceTimer(initial: Bool = false) {
        silenceTimer?.invalidate()
        let wait: TimeInterval = initial ? 7.0 : 1.8
        silenceTimer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.finish(with: self.lastTranscript)
        }
    }

    func stopListening(emitFinal: Bool = true) {
        guard request != nil || task != nil else { return }
        if emitFinal { finish(with: lastTranscript) } else { teardownAudio() }
    }

    private func finish(with text: String) {
        guard !finished else { return }
        finished = true
        teardownAudio()
        guard let url = audioURL,
              let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? Int,
              size > 40_000,   // under ~0.4s of audio = nothing was said
              let data = try? Data(contentsOf: url) else {
            emit("onSpeech", ["state": "final", "text": text])
            return
        }
        emit("onSpeech", ["state": "transcribing", "text": text])
        var req = URLRequest(url: URL(string: Self.sttBase + sttLang)!)
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 15
        sttTask = URLSession.shared.uploadTask(with: req, from: data) { [weak self] body, resp, _ in
            try? FileManager.default.removeItem(at: url)
            var whisper = ""
            if let body,
               (resp as? HTTPURLResponse)?.statusCode == 200,
               let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
               let t = (obj["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) {
                whisper = t
            }
            // Recognizer text is primary (right for the target language); Whisper rides along as the
            // alternate and the tutor reconciles the two. Whisper only leads when the recognizer got nothing.
            let primary = text.isEmpty ? whisper : text
            let alt = text.isEmpty ? "" : whisper
            self?.emit("onSpeech", ["state": "final", "text": primary, "alt": alt])
        }
        sttTask?.resume()
    }

    private func teardownAudio() {
        silenceTimer?.invalidate(); silenceTimer = nil
        audioFile = nil   // closes the wav
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
    }

    // MARK: - Synthesis

    func speak(_ text: String, lang: String) {
        stopSpeaking()
        guard !text.isEmpty else { emit("onSpeak", ["state": "end"]); return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
        } catch {}
        let u = AVSpeechUtterance(string: text)
        u.voice = Self.bestVoice(for: lang)
        u.rate = AVSpeechUtteranceDefaultSpeechRate * 0.95
        u.pitchMultiplier = 1.05
        synth.speak(u)
    }

    func stopSpeaking() {
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
    }

    private static func bestVoice(for lang: String) -> AVSpeechSynthesisVoice? {
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == lang }
        let preferred = ["Ava", "Zoe", "Samantha", "Allison", "Nicky", "Joelle",          // en
                         "Mónica", "Monica", "Paulina", "Marisol", "Jorge",                // es
                         "Amélie", "Amelie", "Audrey", "Aurélie", "Thomas",                // fr
                         "Anna", "Petra", "Helena", "Markus"]                              // de
        if let v = voices.first(where: { $0.quality == .premium && preferred.contains(where: $0.name.contains) }) { return v }
        if let v = voices.first(where: { $0.quality == .enhanced && preferred.contains(where: $0.name.contains) }) { return v }
        if let v = voices.first(where: { preferred.contains(where: $0.name.contains) }) { return v }
        return voices.first(where: { $0.quality != .default }) ?? AVSpeechSynthesisVoice(language: lang)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        emit("onSpeak", ["state": "start"])
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange, utterance: AVSpeechUtterance) {
        emit("onSpeak", ["state": "word"])
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        emit("onSpeak", ["state": "end"])
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        emit("onSpeak", ["state": "cancel"])
    }
}
