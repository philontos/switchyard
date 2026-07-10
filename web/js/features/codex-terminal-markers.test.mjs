import test from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_USER_MARKER_FOR_TEST as marker,
  createCodexUserMarkerHighlighter,
} from "./codex-terminal-markers.js";

function render(...chunks) {
  const h = createCodexUserMarkerHighlighter();
  return chunks.map((chunk) => h.push(chunk)).join("") + h.flush();
}

test("strictly emphasizes current and historical Codex user markers", () => {
  assert.equal(render(marker.historical + "older"), marker.emphasized + "older");
  assert.equal(render(marker.current + "current"), marker.emphasized + "current");
  assert.equal(
    render(marker.current + "one\r\n" + marker.historical + "two"),
    marker.emphasized + "one\r\n" + marker.emphasized + "two",
  );
});

test("does not generalize to composer, assistant, generic dim, or literal arrows", () => {
  const nearMisses = [
    "\x1b[1m›\x1b[0m \x1b[2mUse /skills\x1b[0m", // live composer: space is outside bold
    "\x1b[2m• \x1b[0massistant",                  // assistant row
    "\x1b[1;2mdim but not a user marker\x1b[0m",
    "plain › user-authored text",
    "\x1b[2;1m› \x1b[0mreordered SGR parameters",
    "\x1b[1m› missing-reset",
  ];
  for (const input of nearMisses) assert.equal(render(input), input);
});

test("requires the exact marker to begin at a logical line start", () => {
  const embedded = "prefix " + marker.current + "not-a-boundary";
  assert.equal(render(embedded), embedded);

  assert.equal(
    render("prefix\r\n" + marker.current + "real-boundary"),
    "prefix\r\n" + marker.emphasized + "real-boundary",
  );
  assert.equal(
    render("prefix\x1b[4;1H" + marker.historical + "cursor-home"),
    "prefix\x1b[4;1H" + marker.emphasized + "cursor-home",
  );

  const columnTwo = "prefix\x1b[4;2H" + marker.current + "still-embedded";
  assert.equal(render(columnTwo), columnTwo);
});

test("recognizes a marker across every possible WebSocket frame split", () => {
  const input = "\x1b[2J\x1b[H" + marker.historical + "你好\r\nnext";
  const expected = "\x1b[2J\x1b[H" + marker.emphasized + "你好\r\nnext";

  for (let i = 1; i < input.length; i++) {
    assert.equal(render(input.slice(0, i), input.slice(i)), expected, `split at ${i}`);
  }

  assert.equal(render(...input.split("")), expected, "one UTF-16 code unit per frame");
});

test("flush passes an unfinished possible marker through unchanged", () => {
  const incomplete = "\x1b[1;2m› ";
  assert.equal(render(incomplete), incomplete);
});
