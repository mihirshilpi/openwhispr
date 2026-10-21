import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

// Saves a JPEG keyframe of the meeting whenever the picture changes, plus a
// heartbeat frame, so a transcript timestamp can be matched to what was on
// screen. Watches the Teams meeting window normally and switches to the
// display the user is sharing while they present (Teams shrinks to a control
// bar then). Events go to stderr as line-delimited JSON, like the audio tap;
// stdin takes `presenting on|off|auto` and `snapshot` commands from the host.

@available(macOS 14.0, *)
struct Config {
    var outputDir = URL(fileURLWithPath: NSTemporaryDirectory())
    var startEpochMs: Double = Date().timeIntervalSince1970 * 1000
    var intervalMs = 1000
    var heartbeatMs = 60000
    var settleMs = 1500
    // Share of thumbnail pixels that must change for a new keyframe. Small
    // regions (faces moving in video tiles) stay under it.
    var changeThreshold = 0.10
    var maxLongEdge = 1920
    var jpegQuality = 0.8
    var bundleIds = ["com.microsoft.teams2", "com.microsoft.teams"]
    var excludeBundleIds: [String] = []
}

enum PresentingMode: String {
    case auto, on, off
}

enum CaptureSource: String {
    case teamsWindow = "teams_window"
    case display
}

let thumbWidth = 64
let thumbHeight = 36
let pixelDeltaThreshold = 24

@available(macOS 14.0, *)
// State is only touched on `queue`, so the Task hop in tick() is safe.
final class KeyframeRecorder: @unchecked Sendable {
    private let config: Config
    private let queue = DispatchQueue(label: "com.openwhispr.screen-keyframes")
    private var timer: DispatchSourceTimer?
    private var busy = false

    private var presentingMode = PresentingMode.auto
    private var lastSource: CaptureSource?
    private var lastSavedThumb: [UInt8]?
    private var lastSavedAt: Double = 0
    private var candidateThumb: [UInt8]?
    private var candidateSince: Double = 0
    private var forceNext = false
    // Last error code sent to the host; a failure repeats every tick, so it is
    // reported once and again only after a capture succeeds or the code changes.
    private var lastErrorCode: String?

    init(config: Config) {
        self.config = config
    }

    func start() throws {
        try FileManager.default.createDirectory(at: config.outputDir, withIntermediateDirectories: true)
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(config.intervalMs))
        timer.setEventHandler { [weak self] in self?.tick() }
        timer.resume()
        self.timer = timer
        emit(event: ["type": "ready", "outputDir": config.outputDir.path])
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    func handleCommand(_ line: String) {
        let parts = line.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: " ")
        queue.async {
            if parts.first == "presenting", parts.count > 1, let mode = PresentingMode(rawValue: String(parts[1])) {
                self.presentingMode = mode
                emit(event: ["type": "presenting_mode", "mode": mode.rawValue])
            } else if parts.first == "snapshot" {
                self.forceNext = true
            }
        }
    }

    private func nowOffsetMs() -> Double {
        Date().timeIntervalSince1970 * 1000 - config.startEpochMs
    }

    private func tick() {
        guard !busy else { return }
        busy = true
        Task {
            defer { queue.async { self.busy = false } }
            do {
                guard let (image, source) = try await captureCurrentTarget() else { return }
                queue.sync {
                    self.lastErrorCode = nil
                    self.consider(image: image, source: source)
                }
            } catch {
                let code = isPermissionError(error) ? "permission_denied" : "capture_failed"
                queue.sync {
                    guard self.lastErrorCode != code else { return }
                    self.lastErrorCode = code
                    emit(event: ["type": "error", "code": code, "message": error.localizedDescription])
                }
            }
        }
    }

    // MARK: - Choosing what to capture

    private func captureCurrentTarget() async throws -> (CGImage, CaptureSource)? {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let teamsWindows = content.windows.filter { window in
            guard let bundleId = window.owningApplication?.bundleIdentifier else { return false }
            return config.bundleIds.contains(bundleId) && window.isOnScreen && window.windowLayer == 0
        }
        let excluded = content.applications.filter { config.excludeBundleIds.contains($0.bundleIdentifier) }

        if let display = presentingDisplay(content: content) {
            let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
            let image = try await capture(filter: filter, width: display.width, height: display.height)
            return (image, .display)
        }

        // The meeting window is the largest Teams window; the main chat
        // window is usually behind it or smaller.
        guard let meeting = teamsWindows.max(by: { area($0.frame) < area($1.frame) }),
              meeting.frame.width >= 320, meeting.frame.height >= 240
        else {
            return nil
        }
        let filter = SCContentFilter(desktopIndependentWindow: meeting)
        let image = try await capture(filter: filter, width: Int(meeting.frame.width), height: Int(meeting.frame.height))
        return (image, .teamsWindow)
    }

    // While presenting, Teams shows a small always-on-top sharing toolbar on
    // the shared display. TODO: confirm the toolbar's layer and size on a
    // real call; the manual `presenting on` command covers the gap until then.
    private func presentingDisplay(content: SCShareableContent) -> SCDisplay? {
        switch presentingMode {
        case .off:
            return nil
        case .on:
            return displayUnderCursor(content: content) ?? content.displays.first
        case .auto:
            let toolbar = content.windows.first { window in
                guard let bundleId = window.owningApplication?.bundleIdentifier,
                      config.bundleIds.contains(bundleId)
                else { return false }
                return window.windowLayer > 0 && window.frame.height <= 120 && window.frame.width >= 200
            }
            guard let toolbar else { return nil }
            return content.displays.first { $0.frame.intersects(toolbar.frame) }
        }
    }

    private func displayUnderCursor(content: SCShareableContent) -> SCDisplay? {
        guard let event = CGEvent(source: nil) else { return nil }
        let point = event.location
        return content.displays.first { $0.frame.contains(point) }
    }

    private func capture(filter: SCContentFilter, width: Int, height: Int) async throws -> CGImage {
        let scale = min(1.0, Double(config.maxLongEdge) / Double(max(width, height, 1)))
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, Int(Double(width) * scale * Double(filter.pointPixelScale)))
        configuration.height = max(1, Int(Double(height) * scale * Double(filter.pointPixelScale)))
        if max(configuration.width, configuration.height) > config.maxLongEdge {
            let shrink = Double(config.maxLongEdge) / Double(max(configuration.width, configuration.height))
            configuration.width = Int(Double(configuration.width) * shrink)
            configuration.height = Int(Double(configuration.height) * shrink)
        }
        configuration.showsCursor = false
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    }

    // MARK: - Change detection

    private func consider(image: CGImage, source: CaptureSource) {
        guard let thumb = thumbnail(image) else { return }
        let now = nowOffsetMs()

        if lastSavedThumb == nil || source != lastSource || forceNext {
            let reason = lastSavedThumb == nil ? "first" : (forceNext ? "manual" : "source_switch")
            save(image: image, thumb: thumb, source: source, reason: reason, score: 1)
            forceNext = false
            return
        }

        let changeScore = changedFraction(lastSavedThumb!, thumb)
        if changeScore >= config.changeThreshold {
            // Wait for the picture to settle (slide transitions, scrolling)
            // before keeping it, so one change saves one frame.
            if let candidate = candidateThumb, changedFraction(candidate, thumb) < config.changeThreshold / 2 {
                if now - candidateSince >= Double(config.settleMs) {
                    save(image: image, thumb: thumb, source: source, reason: "change", score: changeScore)
                }
            } else {
                candidateThumb = thumb
                candidateSince = now
            }
            return
        }

        candidateThumb = nil
        if now - lastSavedAt >= Double(config.heartbeatMs) {
            save(image: image, thumb: thumb, source: source, reason: "heartbeat", score: changeScore)
        }
    }

    private func save(image: CGImage, thumb: [UInt8], source: CaptureSource, reason: String, score: Double) {
        let offsetMs = max(0, Int(nowOffsetMs().rounded()))
        let url = config.outputDir.appendingPathComponent(String(format: "frame-%09d.jpg", offsetMs))
        guard writeJPEG(image, to: url, quality: config.jpegQuality) else {
            emit(event: ["type": "error", "code": "write_failed", "message": "Could not write \(url.path)"])
            return
        }
        lastSavedThumb = thumb
        lastSavedAt = Double(offsetMs)
        lastSource = source
        candidateThumb = nil
        emit(event: [
            "type": "frame",
            "path": url.path,
            "offsetMs": offsetMs,
            "source": source.rawValue,
            "reason": reason,
            "changeScore": (score * 1000).rounded() / 1000,
            "width": image.width,
            "height": image.height,
        ])
    }
}

// MARK: - Image helpers

func area(_ rect: CGRect) -> CGFloat {
    rect.width * rect.height
}

func thumbnail(_ image: CGImage) -> [UInt8]? {
    var pixels = [UInt8](repeating: 0, count: thumbWidth * thumbHeight)
    let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
        guard let context = CGContext(
            data: buffer.baseAddress,
            width: thumbWidth,
            height: thumbHeight,
            bitsPerComponent: 8,
            bytesPerRow: thumbWidth,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return false }
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: thumbWidth, height: thumbHeight))
        return true
    }
    return drawn ? pixels : nil
}

func changedFraction(_ a: [UInt8], _ b: [UInt8]) -> Double {
    guard a.count == b.count, !a.isEmpty else { return 1 }
    var changed = 0
    for i in 0..<a.count where abs(Int(a[i]) - Int(b[i])) > pixelDeltaThreshold {
        changed += 1
    }
    return Double(changed) / Double(a.count)
}

func writeJPEG(_ image: CGImage, to url: URL, quality: Double) -> Bool {
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
        return false
    }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    return CGImageDestinationFinalize(destination)
}

func isPermissionError(_ error: Error) -> Bool {
    let nsError = error as NSError
    return nsError.domain == SCStreamErrorDomain && nsError.code == SCStreamError.userDeclined.rawValue
}

// MARK: - Process plumbing

let emitQueue = DispatchQueue(label: "com.openwhispr.screen-keyframes.emit")

func emit(event: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(event),
          let data = try? JSONSerialization.data(withJSONObject: event)
    else { return }
    emitQueue.sync {
        FileHandle.standardError.write(data)
        FileHandle.standardError.write(Data([0x0a]))
    }
}

@available(macOS 14.0, *)
func parseConfig() -> Config {
    var config = Config()
    let args = Array(CommandLine.arguments.dropFirst())
    var index = 0
    func next() -> String? {
        index += 1
        return index < args.count ? args[index] : nil
    }
    while index < args.count {
        switch args[index] {
        case "--output-dir": if let v = next() { config.outputDir = URL(fileURLWithPath: v) }
        case "--start-epoch-ms": if let v = next(), let n = Double(v) { config.startEpochMs = n }
        case "--interval-ms": if let v = next(), let n = Int(v) { config.intervalMs = max(250, n) }
        case "--heartbeat-ms": if let v = next(), let n = Int(v) { config.heartbeatMs = max(5000, n) }
        case "--settle-ms": if let v = next(), let n = Int(v) { config.settleMs = max(0, n) }
        case "--threshold": if let v = next(), let n = Double(v) { config.changeThreshold = min(1, max(0.01, n)) }
        case "--max-long-edge": if let v = next(), let n = Int(v) { config.maxLongEdge = max(640, n) }
        case "--bundle-id": if let v = next() { config.bundleIds = v.split(separator: ",").map(String.init) }
        case "--exclude-bundle-id": if let v = next() { config.excludeBundleIds.append(v) }
        default: break
        }
        index += 1
    }
    return config
}

if #available(macOS 14.0, *) {
    let recorder = KeyframeRecorder(config: parseConfig())
    var signalSources: [DispatchSourceSignal] = []

    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    for signalValue in [SIGINT, SIGTERM] {
        let source = DispatchSource.makeSignalSource(signal: signalValue, queue: .main)
        source.setEventHandler {
            recorder.stop()
            exit(0)
        }
        source.resume()
        signalSources.append(source)
    }

    Thread.detachNewThread {
        while let line = readLine() {
            recorder.handleCommand(line)
        }
        // Host closed stdin: it is gone, so stop with it.
        recorder.stop()
        exit(0)
    }

    do {
        try recorder.start()
        dispatchMain()
    } catch {
        emit(event: ["type": "error", "code": "start_failed", "message": error.localizedDescription])
        exit(1)
    }
} else {
    emit(event: ["type": "error", "code": "unsupported_os", "message": "macOS 14.0 or later is required"])
    exit(1)
}
