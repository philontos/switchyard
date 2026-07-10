// tmux does not forward Codex's original ANSI bytes verbatim. It repaints the
// pane with equivalent cursor/style commands, so matching the source escape
// sequence is inherently brittle. Inspect xterm's rendered cells instead:
//
//   historical user row: bold+dim `›`, then a bold/dim blank cell
//   current user row:    bold `›`, then a bold blank cell
//   live composer:       bold `›`, then a NORMAL blank cell
//
// Requiring the arrow, a blank second cell, normal non-empty message text, and
// either the historical dim bit or the submitted-row bold gap keeps this
// intentionally fail-closed. A Codex rendering change simply removes the
// enhancement; Claude, shells, tool output, and the composer are untouched.

function chars(cell) { return cell?.getChars?.() ?? ""; }
function bold(cell) { return !!cell?.isBold?.(); }
function dim(cell) { return !!cell?.isDim?.(); }
function blank(cell) { return chars(cell).trim() === ""; }

function hasNormalContent(line, start = 0) {
  const length = Number.isFinite(line?.length) ? line.length : 3;
  for (let x = start; x < length; x++) {
    const cell = line.getCell(x);
    if (chars(cell) && !dim(cell)) return true;
  }
  return false;
}

export function isCodexUserMessageLine(line) {
  if (!line) return false;
  const arrow = line.getCell(0);
  const gap = line.getCell(1);
  const body = line.getCell(2);
  if (chars(arrow) !== "›" || !bold(arrow)) return false;
  if (chars(gap).trim() !== "") return false;
  if (!chars(body) || dim(body)) return false;
  return dim(arrow) || bold(gap);
}

// Codex wraps a submitted message onto subsequent rows with either xterm's
// wrapped-line bit or a two-cell indent (`  message`). This is deliberately NOT
// a standalone role signature: callers may accept it only immediately after a
// positively identified user row. That lets a long user message receive one
// continuous treatment without classifying arbitrary indented tool output.
export function isCodexUserMessageContinuationLine(line) {
  if (!line) return false;
  if (line.isWrapped) return hasNormalContent(line);
  return blank(line.getCell(0)) && blank(line.getCell(1)) && hasNormalContent(line, 2);
}

export function codexUserMessageRows(buffer, viewportY, rowCount) {
  const result = [];
  for (let row = 0; row < rowCount; row++) {
    if (!isCodexUserMessageLine(buffer.getLine(viewportY + row))) continue;
    let last = row;
    while (last + 1 < rowCount &&
           isCodexUserMessageContinuationLine(buffer.getLine(viewportY + last + 1))) {
      last++;
    }
    for (let current = row; current <= last; current++) {
      result.push({ row: current, first: current === row, last: current === last });
    }
    row = last;
  }
  return result;
}

// tmux itself puts the outer terminal in xterm's alternate buffer, where xterm
// line decorations are not painted. Use a pointer-transparent DOM overlay on
// the rendered screen instead. It follows viewport rows on every scan and still
// changes no terminal cell or byte.
export function createCodexUserMarkerOverlay(term) {
  let layer = null;
  const markers = new Map(); // visible row -> overlay element
  const subscriptions = [];

  function ensureLayer() {
    const screen = term.element?.querySelector?.(".xterm-screen");
    if (!screen) return null;
    if (layer?.parentNode === screen) return { screen, layer };
    layer?.remove?.();
    markers.clear();
    layer = screen.ownerDocument.createElement("div");
    layer.className = "codex-user-marker-layer";
    screen.appendChild(layer);
    return { screen, layer };
  }

  function scan() {
    const mounted = ensureLayer();
    const buffer = term.buffer?.active;
    if (!mounted || !buffer || !term.rows || !term.cols) return;
    const rect = mounted.screen.getBoundingClientRect();
    if (!rect.width || !rect.height) return; // hidden pane; showPane scans again
    const cellHeight = rect.height / term.rows;
    const viewportY = Number.isFinite(buffer.viewportY) ? buffer.viewportY : 0;
    const wanted = new Set();

    for (const { row, first, last } of codexUserMessageRows(buffer, viewportY, term.rows)) {
      wanted.add(row);
      let marker = markers.get(row);
      if (!marker) {
        marker = mounted.screen.ownerDocument.createElement("div");
        mounted.layer.appendChild(marker);
        markers.set(row, marker);
      }
      marker.className = `codex-user-marker${first ? " is-first" : ""}${last ? " is-last" : ""}`;
      marker.style.top = `${row * cellHeight}px`;
      marker.style.width = `${rect.width}px`;
      marker.style.height = `${cellHeight}px`;
    }

    for (const [row, marker] of [...markers]) {
      if (wanted.has(row)) continue;
      marker.remove();
      markers.delete(row);
    }
  }

  function dispose() {
    for (const subscription of subscriptions.splice(0)) subscription?.dispose?.();
    markers.clear();
    layer?.remove?.();
    layer = null;
  }

  // Raw/live mode is specifically used for browsing terminal history. A viewport
  // scroll changes which buffer line occupies each screen row without writing any
  // new PTY bytes, so a write-only scan would leave highlights attached to the
  // wrong visible content. Resize is registered here as a second safety net for
  // xterm-driven fits; terminal.js also scans after its own coalesced fit.
  if (typeof term.onScroll === "function") subscriptions.push(term.onScroll(scan));
  if (typeof term.onResize === "function") subscriptions.push(term.onResize(scan));

  return { scan, dispose };
}
