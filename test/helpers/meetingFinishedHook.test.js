const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/meetingFinishedHook.js");

const START = 1_760_000_000_000;

const note = (segments, extra = {}) => ({
  id: 7,
  title: "Weekly sync",
  created_at: "2026-10-21 14:00:00",
  content: "",
  enhanced_content: null,
  transcript: JSON.stringify(segments),
  ...extra,
});

const frameIndex = {
  startEpochMs: START,
  frames: [
    { offsetMs: 0, file: "frame-000000000.jpg", source: "teams_window", reason: "first" },
    { offsetMs: 60000, file: "frame-000060000.jpg", source: "display", reason: "change" },
  ],
};

test("each turn gets its speaker, its offset and the frame on screen", async () => {
  const { buildMeetingPayload } = await load();

  const payload = buildMeetingPayload({
    note: note([
      { text: "Morning all", source: "mic", timestamp: START + 5000 },
      {
        text: "Here are the numbers",
        source: "system",
        timestamp: START + 61000,
        speakerName: "Priya",
      },
      {
        text: "Who is this",
        source: "system",
        timestamp: START + 62000,
        speaker: "speaker_2",
        speakerName: "Speaker 2",
        speakerIsPlaceholder: true,
      },
    ]),
    frameIndex,
    exportDir: "/tmp/note-7",
  });

  assert.deepEqual(
    payload.transcript.map((t) => [t.offsetMs, t.speaker, t.frame]),
    [
      [5000, "Me", "frame-000000000.jpg"],
      [61000, "Priya", "frame-000060000.jpg"],
      [62000, "Speaker 2", "frame-000060000.jpg"],
    ]
  );
  assert.equal(payload.event, "meeting.finished");
  assert.equal(payload.noteId, 7);
  assert.equal(payload.frames.length, 2);
});

test("without screenshots, offsets count from the first segment", async () => {
  const { buildMeetingPayload } = await load();

  const payload = buildMeetingPayload({
    note: note([
      { text: "a", source: "mic", timestamp: START + 1000 },
      { text: "b", source: "system", timestamp: START + 4000 },
    ]),
    frameIndex: null,
    exportDir: "/tmp/note-7",
  });

  assert.deepEqual(
    payload.transcript.map((t) => [t.offsetMs, t.frame]),
    [
      [0, null],
      [3000, null],
    ]
  );
  assert.equal(payload.files.frameIndex, null);
});

test("a plain-text transcript is carried as is", async () => {
  const { buildMeetingPayload, renderMeetingMarkdown } = await load();

  const payload = buildMeetingPayload({
    note: note([], { transcript: "We agreed to ship Friday." }),
    frameIndex: null,
    exportDir: "/tmp/note-7",
  });

  assert.equal(payload.transcript.length, 0);
  assert.equal(payload.plainTranscript, "We agreed to ship Friday.");
  assert.match(renderMeetingMarkdown(payload), /We agreed to ship Friday\./);
});

test("markdown links a screenshot only when the frame changes", async () => {
  const { buildMeetingPayload, renderMeetingMarkdown } = await load();

  const markdown = renderMeetingMarkdown(
    buildMeetingPayload({
      note: note(
        [
          { text: "one", source: "mic", timestamp: START + 1000 },
          { text: "two", source: "mic", timestamp: START + 2000 },
          { text: "three", source: "system", timestamp: START + 61000, speakerName: "Priya" },
        ],
        { enhanced_content: "Shipped the plan." }
      ),
      frameIndex,
      exportDir: "/tmp/note-7",
    })
  );

  assert.equal(markdown.match(/!\[screen/g).length, 2);
  assert.match(markdown, /## Summary\n\nShipped the plan\./);
  assert.match(markdown, /\[01:01\] \*\*Priya:\*\* three/);
});

test("formatOffset switches to hours past one hour", async () => {
  const { formatOffset } = await load();

  assert.equal(formatOffset(754000), "12:34");
  assert.equal(formatOffset(3723000), "1:02:03");
});

test("hook config keeps only http(s) URLs and non-empty commands", async () => {
  const { normalizeHookConfig } = await load();

  assert.equal(normalizeHookConfig({ url: "", command: "  " }), null);
  assert.equal(normalizeHookConfig({ url: "file:///etc/passwd" }), null);
  assert.deepEqual(normalizeHookConfig({ url: " http://localhost:8787/meeting " }), {
    url: "http://localhost:8787/meeting",
    command: null,
  });
  assert.deepEqual(normalizeHookConfig({ command: "harness ingest" }), {
    url: null,
    command: "harness ingest",
  });
});
