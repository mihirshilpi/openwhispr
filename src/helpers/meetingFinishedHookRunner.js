const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { FRAME_INDEX_FILE } = require("./screenKeyframeIndex");
const {
  MEETING_JSON_FILE,
  MEETING_MARKDOWN_FILE,
  buildMeetingPayload,
  normalizeHookConfig,
  renderMeetingMarkdown,
} = require("./meetingFinishedHook");

// The stop path's final transcript write can land after diarization reports
// back, so the export waits this long before reading the note.
const SETTLE_DELAY_MS = 5000;
const WEBHOOK_TIMEOUT_MS = 15000;
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const FRAME_FILE_PATTERN = /^frame-\d+\.jpg$/;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeFileAtomic(filePath, contents) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

// Screenshots, the export and the hook for finished meetings. The renderer
// asks for the hook once diarization has been merged into the note.
class MeetingFinishedHookRunner {
  constructor({ databaseManager, screenKeyframes }) {
    this.databaseManager = databaseManager;
    this.screenKeyframes = screenKeyframes;
    this.handledSessions = new Set();
    this.timers = new Map();
  }

  // The note's folder, or the session's when recording started before the
  // note existed.
  framesDirFor({ noteId, sessionId = null }) {
    const noteDir = this.screenKeyframes.outputDirFor({ noteId });
    if (fs.existsSync(noteDir) || !sessionId) return noteDir;
    const sessionDir = this.screenKeyframes.outputDirFor({ sessionId, noteId: null });
    return fs.existsSync(sessionDir) ? sessionDir : noteDir;
  }

  listFrames(noteId) {
    const dir = this.framesDirFor({ noteId });
    const index = readJson(path.join(dir, FRAME_INDEX_FILE));
    return {
      dir,
      startEpochMs: index?.startEpochMs ?? null,
      frames: Array.isArray(index?.frames) ? index.frames : [],
    };
  }

  readFrame(noteId, file) {
    if (typeof file !== "string" || !FRAME_FILE_PATTERN.test(file)) return null;
    const filePath = path.join(this.framesDirFor({ noteId }), file);
    try {
      return `data:image/jpeg;base64,${fs.readFileSync(filePath).toString("base64")}`;
    } catch {
      return null;
    }
  }

  schedule({ noteId, sessionId = null, url, command }) {
    const config = normalizeHookConfig({ url, command });
    if (!config || !Number.isInteger(noteId)) return { scheduled: false };
    if (sessionId && this.handledSessions.has(sessionId)) return { scheduled: false };
    if (sessionId) this.handledSessions.add(sessionId);

    clearTimeout(this.timers.get(noteId));
    const timer = setTimeout(() => {
      this.timers.delete(noteId);
      this.run({ noteId, sessionId, config }).catch((error) => {
        debugLogger.warn("[MeetingHook] Failed", { noteId, error: error.message }, "meeting");
      });
    }, SETTLE_DELAY_MS);
    this.timers.set(noteId, timer);
    return { scheduled: true };
  }

  // Writes meeting.json and meeting.md beside the screenshots and returns
  // their paths, without firing anything.
  async exportMeeting({ noteId, sessionId = null }) {
    const note = await this.databaseManager.getNote(noteId);
    if (!note || note.deleted_at) return null;

    const exportDir = this.framesDirFor({ noteId, sessionId });
    fs.mkdirSync(exportDir, { recursive: true });
    const frameIndex = readJson(path.join(exportDir, FRAME_INDEX_FILE));
    const payload = buildMeetingPayload({ note, frameIndex, exportDir });

    const jsonPath = path.join(exportDir, MEETING_JSON_FILE);
    const markdownPath = path.join(exportDir, MEETING_MARKDOWN_FILE);
    writeFileAtomic(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
    writeFileAtomic(markdownPath, renderMeetingMarkdown(payload));
    return { payload, exportDir, jsonPath, markdownPath };
  }

  async run({ noteId, sessionId, config }) {
    const exported = await this.exportMeeting({ noteId, sessionId });
    if (!exported) return;
    debugLogger.info(
      "[MeetingHook] Exported meeting",
      { noteId, frames: exported.payload.frames.length },
      "meeting"
    );

    await Promise.all([
      config.url ? this.postWebhook(config.url, exported.payload) : null,
      config.command ? this.runCommand(config.command, exported) : null,
    ]);
  }

  async postWebhook(url, payload) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "OpenWhispr" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      debugLogger.info(
        "[MeetingHook] Webhook answered",
        { status: response.status, noteId: payload.noteId },
        "meeting"
      );
    } catch (error) {
      debugLogger.warn(
        "[MeetingHook] Webhook failed",
        { error: error.message, noteId: payload.noteId },
        "meeting"
      );
    }
  }

  // Runs in a login shell, since an app opened from the Dock gets a bare PATH
  // and the user's own tools would not be found.
  runCommand(command, { payload, exportDir, jsonPath, markdownPath }) {
    return new Promise((resolve) => {
      const shell = process.env.SHELL || "/bin/zsh";
      const child = spawn(shell, ["-lc", command], {
        cwd: exportDir,
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          OPENWHISPR_MEETING_DIR: exportDir,
          OPENWHISPR_MEETING_JSON: jsonPath,
          OPENWHISPR_MEETING_MD: markdownPath,
          OPENWHISPR_NOTE_ID: String(payload.noteId),
        },
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-2000);
      });
      const timer = setTimeout(() => child.kill("SIGTERM"), COMMAND_TIMEOUT_MS);
      const finish = (fields) => {
        clearTimeout(timer);
        debugLogger.info("[MeetingHook] Command finished", fields, "meeting");
        resolve();
      };
      child.on("error", (error) => finish({ error: error.message }));
      child.on("exit", (code, signal) =>
        finish({ code, signal, noteId: payload.noteId, stderr: code ? stderr : undefined })
      );
    });
  }

  registerIpc(ipcMain, shell) {
    ipcMain.handle("meeting-finished-hook-run", (_event, request = {}) => this.schedule(request));
    // Same export and hook, right now, for a note picked by hand.
    ipcMain.handle("meeting-finished-hook-run-now", async (_event, request = {}) => {
      const config = normalizeHookConfig(request);
      if (!config || !Number.isInteger(request.noteId)) return { success: false };
      await this.run({ noteId: request.noteId, sessionId: null, config });
      return { success: true };
    });
    ipcMain.handle("meeting-frames-list", (_event, noteId) =>
      Number.isInteger(noteId) ? this.listFrames(noteId) : { dir: null, frames: [] }
    );
    ipcMain.handle("meeting-frame-read", (_event, noteId, file) =>
      Number.isInteger(noteId) ? this.readFrame(noteId, file) : null
    );
    ipcMain.handle("meeting-frames-open-folder", async (_event, noteId) => {
      if (!Number.isInteger(noteId)) return { success: false };
      const exported = await this.exportMeeting({ noteId }).catch(() => null);
      const dir = exported?.exportDir ?? this.framesDirFor({ noteId });
      if (!fs.existsSync(dir)) return { success: false };
      const error = await shell.openPath(dir);
      return { success: !error };
    });
  }
}

module.exports = MeetingFinishedHookRunner;
