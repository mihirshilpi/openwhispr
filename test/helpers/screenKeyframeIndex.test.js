const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/screenKeyframeIndex.js");

const frame = (offsetMs, extra = {}) => ({
  type: "frame",
  path: `/tmp/frames/frame-${String(offsetMs).padStart(9, "0")}.jpg`,
  offsetMs,
  source: "teams_window",
  reason: "change",
  changeScore: 0.4,
  width: 1920,
  height: 1080,
  ...extra,
});

test("a helper frame event becomes an index entry with a bare file name", async () => {
  const { toFrameEntry } = await load();

  assert.deepEqual(toFrameEntry(frame(754000, { source: "display" })), {
    offsetMs: 754000,
    file: "frame-000754000.jpg",
    source: "display",
    reason: "change",
    changeScore: 0.4,
    width: 1920,
    height: 1080,
  });
});

test("malformed or non-frame events are not indexed", async () => {
  const { toFrameEntry } = await load();

  assert.equal(toFrameEntry({ type: "ready" }), null);
  assert.equal(toFrameEntry(frame(-5)), null);
  assert.equal(toFrameEntry(frame(1000, { path: "" })), null);
  assert.equal(toFrameEntry(null), null);
});

test("frames stay sorted and a repeated offset replaces the earlier entry", async () => {
  const { toFrameEntry, addFrame } = await load();

  let frames = [];
  frames = addFrame(frames, toFrameEntry(frame(5000)));
  frames = addFrame(frames, toFrameEntry(frame(1000)));
  frames = addFrame(frames, toFrameEntry(frame(5000, { reason: "heartbeat" })));

  assert.deepEqual(
    frames.map((f) => [f.offsetMs, f.reason]),
    [
      [1000, "change"],
      [5000, "heartbeat"],
    ]
  );
});

test("frameAt returns the frame on screen at a timestamp", async () => {
  const { toFrameEntry, addFrame, frameAt } = await load();

  const frames = [0, 60000, 75400, 135400].reduce(
    (list, offset) => addFrame(list, toFrameEntry(frame(offset))),
    []
  );

  assert.equal(frameAt(frames, 75399).offsetMs, 60000);
  assert.equal(frameAt(frames, 75400).offsetMs, 75400);
  assert.equal(frameAt(frames, 999999).offsetMs, 135400);
  assert.equal(frameAt([], 1000), null);
});

test("a timestamp before the first frame gets the first frame", async () => {
  const { toFrameEntry, addFrame, frameAt } = await load();

  const frames = addFrame([], toFrameEntry(frame(2000)));
  assert.equal(frameAt(frames, 0).offsetMs, 2000);
});

test("parseTimestamp reads clock times, seconds and milliseconds", async () => {
  const { parseTimestamp } = await load();

  assert.equal(parseTimestamp("12:34"), 754000);
  assert.equal(parseTimestamp("1:02:03"), 3723000);
  assert.equal(parseTimestamp("90"), 90000);
  assert.equal(parseTimestamp("1500ms"), 1500);
  assert.equal(parseTimestamp(2500), 2500);
  assert.equal(parseTimestamp("12:xx"), null);
  assert.equal(parseTimestamp("1:2:3:4"), null);
});
