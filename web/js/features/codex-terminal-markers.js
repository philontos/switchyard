// Codex's PTY stream has no semantic "role" metadata.  Its submitted user
// messages do, however, have a deliberately narrow terminal signature:
//
//   historical  \x1b[1;2m› \x1b[0m<message>
//   current     \x1b[1m› \x1b[0m<message>
//
// The live composer is close but importantly different (the space is outside
// the bold span), and assistant rows use a dim bullet instead.  Match only the
// two complete signatures at a logical line start.  If Codex changes them, the
// enhancer fails closed and the original bytes pass through untouched.
//
// Reversing the existing two cells makes the turn boundary easy to spot without
// inserting a printable character, changing wrapping, or desynchronizing xterm
// from tmux.  This module is a streaming transform because WebSocket frames may
// split an ANSI sequence at any byte.

const HISTORICAL_USER_MARKER = "\x1b[1;2m› \x1b[0m";
const CURRENT_USER_MARKER = "\x1b[1m› \x1b[0m";
const EMPHASIZED_USER_MARKER = "\x1b[1;7m› \x1b[0m";
const USER_MARKERS = [HISTORICAL_USER_MARKER, CURRENT_USER_MARKER];

function movementAmount(raw, fallback = 1) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function csiParams(sequence) {
  const body = sequence.slice(2, -1).replace(/^[?=>!]+/, "");
  return body.split(";");
}

// Return one complete ANSI escape sequence, or null when the frame ended in
// the middle of it.  CSI is enough for cursor/SGR tracking; OSC/DCS strings are
// consumed too so their payload can never be mistaken for terminal text.
function escapeLength(input, start) {
  if (start + 1 >= input.length) return null;
  const kind = input[start + 1];
  if (kind === "[") {
    for (let i = start + 2; i < input.length; i++) {
      const code = input.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i - start + 1;
    }
    return null;
  }
  if ("]P_X^".includes(kind)) {
    for (let i = start + 2; i < input.length; i++) {
      if (input.charCodeAt(i) === 0x07) return i - start + 1;
      if (input[i] === "\x1b" && input[i + 1] === "\\") return i - start + 2;
    }
    return null;
  }
  // ESC intermediates (for example charset selection) end at the first final
  // byte.  The common two-byte ESC 7/8/D/E forms naturally end immediately.
  for (let i = start + 1; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 0x30 && code <= 0x7e) return i - start + 1;
  }
  return null;
}

function isWide(code) {
  return code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

function printableWidth(code) {
  // Combining marks, variation selectors, and the zero-width joiner do not
  // advance the cursor.  Exact grapheme width is unnecessary here; this keeps
  // line-start tracking sound across the scripts commonly present in prompts.
  if (code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f) ||
      (code >= 0x300 && code <= 0x36f) || (code >= 0x1ab0 && code <= 0x1aff) ||
      (code >= 0x1dc0 && code <= 0x1dff) || (code >= 0x20d0 && code <= 0x20ff) ||
      (code >= 0xfe20 && code <= 0xfe2f)) return 0;
  return isWide(code) ? 2 : 1;
}

export function createCodexUserMarkerHighlighter() {
  let pending = "";
  let column = 0;
  let savedColumn = 0;

  function trackEscape(sequence) {
    if (sequence[1] === "[") {
      const final = sequence.at(-1);
      const params = csiParams(sequence);
      const first = movementAmount(params[0]);
      if (final === "H" || final === "f") column = Math.max(0, movementAmount(params[1]) - 1);
      else if (final === "G" || final === "`") column = Math.max(0, first - 1);
      else if (final === "C" || final === "a") column += first;
      else if (final === "D") column = Math.max(0, column - first);
      else if (final === "E" || final === "F") column = 0;
      else if (final === "I") column = (Math.floor(column / 8) + first) * 8;
      else if (final === "Z") column = Math.max(0, column - first * 8);
      else if (final === "s") savedColumn = column;
      else if (final === "u") column = savedColumn;
      return;
    }
    if (sequence === "\x1b7") savedColumn = column;
    else if (sequence === "\x1b8") column = savedColumn;
    else if (sequence === "\x1bE" || sequence === "\x1bc") column = 0;
  }

  function transform(chunk, final) {
    const input = pending + String(chunk ?? "");
    pending = "";
    let output = "";
    let i = 0;

    while (i < input.length) {
      if (column === 0) {
        const marker = USER_MARKERS.find((candidate) => input.startsWith(candidate, i));
        if (marker) {
          output += EMPHASIZED_USER_MARKER;
          column = 2; // the replacement has exactly the same two printable cells: `› `
          i += marker.length;
          continue;
        }
        const rest = input.slice(i);
        if (!final && USER_MARKERS.some((candidate) => candidate.startsWith(rest))) {
          pending = rest;
          break;
        }
      }

      const ch = input[i];
      if (ch === "\x1b") {
        const length = escapeLength(input, i);
        if (length == null) {
          if (!final) { pending = input.slice(i); break; }
          output += input.slice(i);
          break;
        }
        const sequence = input.slice(i, i + length);
        output += sequence;
        trackEscape(sequence);
        i += length;
        continue;
      }

      const code = input.codePointAt(i);
      const width = code > 0xffff ? 2 : 1;
      const text = input.slice(i, i + width);
      output += text;
      if (ch === "\r" || ch === "\n") column = 0;
      else if (ch === "\b") column = Math.max(0, column - 1);
      else if (ch === "\t") column = (Math.floor(column / 8) + 1) * 8;
      else if (code >= 0x20 && code !== 0x7f) column += printableWidth(code);
      i += width;
    }
    return output;
  }

  return {
    push(chunk) { return transform(chunk, false); },
    flush() { return transform("", true); },
  };
}

export const CODEX_USER_MARKER_FOR_TEST = {
  historical: HISTORICAL_USER_MARKER,
  current: CURRENT_USER_MARKER,
  emphasized: EMPHASIZED_USER_MARKER,
};
