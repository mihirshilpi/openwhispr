// Pure bookkeeping for meeting screen keyframes: which helper events count as
// frames, the index written beside them, and which frame was on screen at a
// transcript timestamp. Electron-free so it can be unit-tested and reused by
// the CLI bridge.

export const FRAME_INDEX_FILE = "frames.json";
export const FRAME_INDEX_VERSION = 1;

// Turns one parsed helper `frame` event into an index entry, or null when the
// event is malformed (the host drops it rather than indexing a bad path).
export function toFrameEntry(event) {
  if (!event || event.type !== "frame") return null;
  if (typeof event.path !== "string" || event.path.length === 0) return null;
  const offsetMs = Number(event.offsetMs);
  if (!Number.isFinite(offsetMs) || offsetMs < 0) return null;
  return {
    offsetMs: Math.round(offsetMs),
    file: event.path.split(/[\\/]/).pop(),
    source: event.source === "display" ? "display" : "teams_window",
    reason: typeof event.reason === "string" ? event.reason : "change",
    changeScore: Number.isFinite(Number(event.changeScore)) ? Number(event.changeScore) : null,
    width: Number(event.width) || null,
    height: Number(event.height) || null,
  };
}

// Keeps frames sorted by time; a second frame at the same offset replaces the
// first, matching the helper's file naming (one file per millisecond offset).
export function addFrame(frames, entry) {
  if (!entry) return frames;
  const next = frames.filter((frame) => frame.offsetMs !== entry.offsetMs);
  next.push(entry);
  next.sort((a, b) => a.offsetMs - b.offsetMs);
  return next;
}

export function buildFrameIndex({ sessionId, noteId, startEpochMs, frames }) {
  return {
    version: FRAME_INDEX_VERSION,
    sessionId: sessionId ?? null,
    noteId: noteId ?? null,
    startEpochMs,
    frames,
  };
}

// The frame that was on screen at `offsetMs`: the latest one at or before it.
// A timestamp before the first frame gets the first frame, since nothing
// earlier was captured.
export function frameAt(frames, offsetMs) {
  if (!Array.isArray(frames) || frames.length === 0) return null;
  const target = Number(offsetMs);
  if (!Number.isFinite(target)) return null;

  let low = 0;
  let high = frames.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (frames[mid].offsetMs <= target) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return frames[found === -1 ? 0 : found];
}

// Parses "1:02:03", "12:34", "754" (seconds) or "754000ms" into milliseconds.
export function parseTimestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?ms$/.test(text)) return Number(text.slice(0, -2));
  const parts = text.split(":");
  if (parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) return null;
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  return Math.round(seconds * 1000);
}
