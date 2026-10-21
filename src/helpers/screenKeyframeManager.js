const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const {
  FRAME_INDEX_FILE,
  addFrame,
  buildFrameIndex,
  toFrameEntry,
} = require("./screenKeyframeIndex");

const BINARY_NAME = "macos-screen-keyframes";
const APP_BUNDLE_ID = "com.gizmolabs.openwhispr";
const STOP_TIMEOUT_MS = 3000;

// Runs the macos-screen-keyframes helper for one meeting at a time. The helper
// saves a JPEG whenever the Teams window (or the display being shared) changes;
// this side keeps frames.json beside the images so a transcript timestamp can
// be matched to what was on screen.
class ScreenKeyframeManager {
  constructor() {
    this.session = null;
  }

  isSupported() {
    return process.platform === "darwin" && this.resolveBinary() !== null;
  }

  framesRoot() {
    const { app } = require("electron");
    return path.join(app.getPath("userData"), "meeting-frames");
  }

  outputDirFor({ sessionId, noteId }) {
    const name = noteId != null ? `note-${noteId}` : `session-${sessionId}`;
    return path.join(this.framesRoot(), name);
  }

  start({ sessionId, noteId = null, startEpochMs = Date.now() }) {
    if (!this.isSupported()) return { started: false, reason: "unsupported" };
    if (this.session) {
      if (this.session.sessionId === sessionId) return { started: true };
      this.stop(this.session.sessionId);
    }

    const outputDir = this.outputDirFor({ sessionId, noteId });
    fs.mkdirSync(outputDir, { recursive: true });

    const binaryPath = this.resolveBinary();
    try {
      fs.accessSync(binaryPath, fs.constants.X_OK);
    } catch {
      fs.chmodSync(binaryPath, 0o755);
    }

    const child = spawn(
      binaryPath,
      [
        "--output-dir",
        outputDir,
        "--start-epoch-ms",
        String(startEpochMs),
        "--exclude-bundle-id",
        APP_BUNDLE_ID,
      ],
      { stdio: ["pipe", "ignore", "pipe"] }
    );

    const session = {
      sessionId,
      noteId,
      startEpochMs,
      outputDir,
      child,
      frames: [],
      stderrBuffer: "",
    };
    this.session = session;
    this._writeIndex(session);

    child.stderr.on("data", (chunk) => this._consumeStderr(session, chunk));
    child.on("error", (error) => {
      debugLogger.warn("[ScreenKeyframes] Helper failed", { error: error.message }, "meeting");
    });
    child.on("exit", (code, signal) => {
      debugLogger.debug("[ScreenKeyframes] Helper exited", { code, signal }, "meeting");
      if (this.session === session) this.session = null;
    });

    debugLogger.debug("[ScreenKeyframes] Started", { sessionId, noteId, outputDir }, "meeting");
    return { started: true, outputDir };
  }

  // `mode` is "on" (the user says they are presenting), "off" or "auto".
  setPresenting(mode) {
    this._send(`presenting ${mode === "on" || mode === "off" ? mode : "auto"}`);
  }

  snapshot() {
    this._send("snapshot");
  }

  stop(sessionId) {
    const session = this.session;
    if (!session || (sessionId != null && session.sessionId !== sessionId)) {
      return Promise.resolve(null);
    }
    this.session = null;
    this._writeIndex(session);

    return new Promise((resolve) => {
      const done = () => resolve({ outputDir: session.outputDir, frames: session.frames.length });
      if (session.child.exitCode !== null) return done();
      const timer = setTimeout(() => {
        session.child.kill("SIGKILL");
        done();
      }, STOP_TIMEOUT_MS);
      session.child.once("exit", () => {
        clearTimeout(timer);
        done();
      });
      session.child.kill("SIGTERM");
    });
  }

  _send(line) {
    const child = this.session?.child;
    if (!child || !child.stdin.writable) return;
    child.stdin.write(`${line}\n`);
  }

  _consumeStderr(session, chunk) {
    session.stderrBuffer += chunk.toString();
    let newlineIndex = session.stderrBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = session.stderrBuffer.slice(0, newlineIndex).trim();
      session.stderrBuffer = session.stderrBuffer.slice(newlineIndex + 1);
      if (line) this._handleLine(session, line);
      newlineIndex = session.stderrBuffer.indexOf("\n");
    }
  }

  _handleLine(session, line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      debugLogger.warn("[ScreenKeyframes] Non-JSON stderr output", { line }, "meeting");
      return;
    }

    if (event.type === "frame") {
      const entry = toFrameEntry(event);
      if (!entry) return;
      session.frames = addFrame(session.frames, entry);
      this._writeIndex(session);
    } else if (event.type === "error") {
      debugLogger.warn("[ScreenKeyframes] Helper error", event, "meeting");
    }
  }

  _writeIndex(session) {
    const index = buildFrameIndex(session);
    const target = path.join(session.outputDir, FRAME_INDEX_FILE);
    const temp = `${target}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(index, null, 2));
      fs.renameSync(temp, target);
    } catch (error) {
      debugLogger.warn(
        "[ScreenKeyframes] Could not write frame index",
        { error: error.message },
        "meeting"
      );
    }
  }

  resolveBinary() {
    const candidates = new Set([path.join(__dirname, "..", "..", "resources", "bin", BINARY_NAME)]);
    if (process.resourcesPath) {
      candidates.add(path.join(process.resourcesPath, "bin", BINARY_NAME));
      candidates.add(path.join(process.resourcesPath, "resources", "bin", BINARY_NAME));
      candidates.add(
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", BINARY_NAME)
      );
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }
}

module.exports = ScreenKeyframeManager;
