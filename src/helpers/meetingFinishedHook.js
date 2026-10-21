// Pure pieces of the "meeting finished" hook: the export written beside a
// meeting's screenshots (meeting.json for tools, meeting.md for an AI to read)
// and the checks on the user's hook settings. Electron-free so it can be unit
// tested; ipcHandlers.js reads the note, writes the files and fires the hook.

import { frameAt } from "./screenKeyframeIndex.js";

export const MEETING_JSON_FILE = "meeting.json";
export const MEETING_MARKDOWN_FILE = "meeting.md";
export const MEETING_PAYLOAD_VERSION = 1;
export const MEETING_FINISHED_EVENT = "meeting.finished";

// Stored transcripts are a JSON array of segments; older notes hold plain text.
export function parseStoredTranscript(raw) {
  if (typeof raw !== "string" || !raw.startsWith("[")) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => s && typeof s.text === "string") : [];
  } catch {
    return [];
  }
}

export function speakerLabel(segment) {
  if (segment.speakerName && !segment.speakerIsPlaceholder) return segment.speakerName;
  if (segment.source === "mic") return "Me";
  return segment.speakerName || segment.speaker || "Speaker";
}

// Segment timestamps are epoch milliseconds in stored transcripts; anything
// smaller is a relative time we can't line up with the frame clock.
function segmentEpochMs(segment) {
  const value = Number(segment.timestamp);
  return Number.isFinite(value) && value > 1e12 ? value : null;
}

export function formatOffset(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function buildMeetingPayload({ note, frameIndex, exportDir }) {
  const frames = Array.isArray(frameIndex?.frames) ? frameIndex.frames : [];
  const segments = parseStoredTranscript(note?.transcript);
  const firstEpoch = segments.map(segmentEpochMs).find((value) => value != null) ?? null;
  const startEpochMs = Number.isFinite(frameIndex?.startEpochMs)
    ? frameIndex.startEpochMs
    : firstEpoch;

  const transcript = segments.map((segment) => {
    const epoch = segmentEpochMs(segment);
    const offsetMs =
      epoch != null && startEpochMs != null ? Math.max(0, epoch - startEpochMs) : null;
    const frame = offsetMs != null ? frameAt(frames, offsetMs) : null;
    return {
      offsetMs,
      speaker: speakerLabel(segment),
      source: segment.source === "mic" ? "mic" : "system",
      text: segment.text,
      frame: frame ? frame.file : null,
    };
  });

  return {
    event: MEETING_FINISHED_EVENT,
    version: MEETING_PAYLOAD_VERSION,
    noteId: note?.id ?? null,
    title: note?.title || "Untitled meeting",
    createdAt: note?.created_at ?? null,
    startEpochMs,
    exportDir,
    files: {
      json: MEETING_JSON_FILE,
      markdown: MEETING_MARKDOWN_FILE,
      frameIndex: frames.length > 0 ? "frames.json" : null,
    },
    summary: note?.enhanced_content || null,
    notes: note?.content || null,
    // Plain-text transcripts from before segments were stored.
    plainTranscript: segments.length === 0 && note?.transcript ? note.transcript : null,
    transcript,
    frames: frames.map((frame) => ({
      offsetMs: frame.offsetMs,
      file: frame.file,
      source: frame.source,
      reason: frame.reason,
    })),
  };
}

// One line per speaker turn, with a screenshot link whenever the frame on
// screen changes, so an AI reading top-down sees what was shown as it was said.
export function renderMeetingMarkdown(payload) {
  const lines = [`# ${payload.title}`, ""];
  if (payload.createdAt) lines.push(`Recorded: ${payload.createdAt}`, "");
  if (payload.summary) lines.push("## Summary", "", payload.summary.trim(), "");
  if (payload.notes) lines.push("## Notes", "", payload.notes.trim(), "");

  lines.push("## Transcript", "");
  if (payload.transcript.length === 0 && payload.plainTranscript) {
    lines.push(payload.plainTranscript.trim(), "");
  }
  let lastFrame = null;
  for (const turn of payload.transcript) {
    if (turn.frame && turn.frame !== lastFrame) {
      const at = turn.offsetMs != null ? formatOffset(turn.offsetMs) : "";
      lines.push(`![screen ${at}](${turn.frame})`, "");
      lastFrame = turn.frame;
    }
    const stamp = turn.offsetMs != null ? `[${formatOffset(turn.offsetMs)}] ` : "";
    lines.push(`${stamp}**${turn.speaker}:** ${turn.text.trim()}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

// Returns a cleaned hook config, or null when nothing is configured. Only
// http(s) URLs are accepted, so a typo can't point the hook at a file: URL.
export function normalizeHookConfig(config) {
  const url = typeof config?.url === "string" ? config.url.trim() : "";
  const command = typeof config?.command === "string" ? config.command.trim() : "";
  let validUrl = null;
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") validUrl = parsed.toString();
    } catch {
      validUrl = null;
    }
  }
  if (!validUrl && !command) return null;
  return { url: validUrl, command: command || null };
}
