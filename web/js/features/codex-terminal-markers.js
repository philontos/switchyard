// Codex's PTY stream has no semantic role metadata, and tmux repaints the pane
// instead of forwarding Codex's original ANSI bytes verbatim. The rollout
// transcript confirms WHAT the person submitted; these xterm cells only locate
// WHERE that confirmed message is currently painted:
//
//   historical user row: bold+dim `›`, then a blank cell
//   current user row:    bold `›`, then a BOLD blank cell
//   live composer:       bold `›`, then a NORMAL blank cell
//
// A submitted message may continue across wrapped/indented rows and may contain
// empty rows. Empty rows belong to the message only when another continuation
// follows them; the blank space between a user turn and the assistant does not.

function chars(cell) { return cell?.getChars?.() ?? ""; }
function bold(cell) { return !!cell?.isBold?.(); }
function dim(cell) { return !!cell?.isDim?.(); }
function blank(cell) { return chars(cell).trim() === ""; }

function lineLength(line) {
  return Number.isFinite(line?.length) ? line.length : 0;
}

function hasNormalContent(line, start = 0) {
  for (let x = start; x < lineLength(line); x++) {
    const cell = line.getCell(x);
    if (chars(cell) && !dim(cell)) return true;
  }
  return false;
}

function isBlankLine(line) {
  if (!line) return false;
  for (let x = 0; x < lineLength(line); x++) {
    if (!blank(line.getCell(x))) return false;
  }
  return true;
}

function cellsText(line, start = 0) {
  let text = "";
  for (let x = start; x < lineLength(line); x++) text += chars(line.getCell(x));
  return text.trimEnd();
}

// Terminal wrapping inserts visual whitespace that is absent from the submitted
// prompt (especially around CJK text), so compare the exact non-whitespace text.
// The strict Codex row signature remains part of the decision; this normalization
// is validation, not a general text search.
export function normalizeCodexUserMessage(text) {
  return String(text ?? "").normalize("NFC").replace(/\s+/gu, "");
}

export function isCodexUserMessageLine(line) {
  if (!line) return false;
  const arrow = line.getCell(0);
  const gap = line.getCell(1);
  const body = line.getCell(2);
  if (chars(arrow) !== "›" || !bold(arrow) || !blank(gap)) return false;
  if (chars(body) && dim(body)) return false;

  // The body may be empty when a submitted prompt starts with a newline. The
  // styled gap (current row) or dim arrow (history) is the role signature; the
  // composer has neither and remains excluded.
  return dim(arrow) || bold(gap);
}

// This is deliberately not a standalone role signature. It is accepted only
// after a positively identified user row by codexUserMessageBlocks().
export function isCodexUserMessageContinuationLine(line) {
  if (!line) return false;
  if (line.isWrapped) return hasNormalContent(line);
  return blank(line.getCell(0)) && blank(line.getCell(1)) && hasNormalContent(line, 2);
}

function messageEnd(buffer, first, limit) {
  let last = first;
  let row = first + 1;

  while (row < limit) {
    const line = buffer.getLine(row);
    if (isCodexUserMessageContinuationLine(line)) {
      last = row++;
      continue;
    }
    if (!isBlankLine(line)) break;

    // Blank rows in the middle of a prompt are followed by another indented or
    // wrapped prompt row. Look past the entire run before deciding whether it is
    // message content or merely Codex's turn separator.
    while (row < limit && isBlankLine(buffer.getLine(row))) row++;
    if (row >= limit || !isCodexUserMessageContinuationLine(buffer.getLine(row))) break;
    last = row++;
  }
  return last;
}

function messageText(buffer, first, last) {
  const rows = [];
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row);
    if (row === first) rows.push(cellsText(line, 2));
    else if (isBlankLine(line)) rows.push("");
    else rows.push(cellsText(line, line.isWrapped ? 0 : 2));
  }
  return rows.join("\n");
}

function bufferLength(buffer, fallback) {
  return Number.isFinite(buffer?.length) ? buffer.length : fallback;
}

// Return one entry per visible message block, not one per row. The absolute
// firstBufferRow is a stable DOM identity while row/rowCount are viewport-relative.
export function codexUserMessageBlocks(buffer, viewportY, rowCount, confirmedMessages = new Set()) {
  if (!buffer || rowCount <= 0) return [];
  const visibleFirst = Math.max(0, viewportY);
  const visibleEnd = Math.min(bufferLength(buffer, visibleFirst + rowCount), visibleFirst + rowCount);
  if (visibleFirst >= visibleEnd) return [];

  // A long message may begin above the viewport. Walk back through only shapes
  // that can belong to a user block; the first assistant/tool row stops the walk.
  let scanFirst = visibleFirst;
  while (scanFirst > 0) {
    const previous = buffer.getLine(scanFirst - 1);
    if (isCodexUserMessageLine(previous) ||
        isCodexUserMessageContinuationLine(previous) ||
        isBlankLine(previous)) {
      scanFirst--;
      continue;
    }
    break;
  }

  const limit = bufferLength(buffer, visibleEnd);
  const blocks = [];
  for (let row = scanFirst; row < visibleEnd; row++) {
    if (!isCodexUserMessageLine(buffer.getLine(row))) continue;
    const last = messageEnd(buffer, row, limit);
    const normalizedText = normalizeCodexUserMessage(messageText(buffer, row, last));
    const confirmed = confirmedMessages.has(normalizedText);
    if (last >= visibleFirst) {
      const firstVisible = Math.max(row, visibleFirst);
      const lastVisible = Math.min(last, visibleEnd - 1);
      blocks.push({
        firstBufferRow: row,
        row: firstVisible - visibleFirst,
        rowCount: lastVisible - firstVisible + 1,
        normalizedText,
        confirmed,
      });
    }
    row = last;
  }
  return blocks;
}

// tmux puts the outer terminal in xterm's alternate buffer, where xterm line
// decorations are not painted. A pointer-transparent DOM overlay is therefore
// still required, but each user message is represented by one stable element.
export function createCodexUserMarkerOverlay(term, { onUnconfirmed } = {}) {
  let layer = null;
  let scanFrame = null;
  let scanFrameOwner = null;
  const markers = new Map(); // absolute first buffer row -> overlay element
  const subscriptions = [];
  let confirmedMessages = new Set();

  function ensureLayer() {
    const screen = term.element?.querySelector?.(".xterm-screen");
    if (!screen) return null;
    if (layer?.parentNode === screen) return { screen, layer };
    layer?.remove?.();
    markers.clear();
    layer = screen.ownerDocument.createElement("div");
    layer.className = "codex-user-marker-layer";
    layer.setAttribute?.("aria-hidden", "true");
    screen.appendChild(layer);
    return { screen, layer };
  }

  function scan() {
    const mounted = ensureLayer();
    const buffer = term.buffer?.active;
    if (!mounted || !buffer || !term.rows || !term.cols) return;
    const rect = mounted.screen.getBoundingClientRect();
    if (!rect.width || !rect.height) return; // hidden pane; showPane schedules again
    const cellHeight = rect.height / term.rows;
    const viewportY = Number.isFinite(buffer.viewportY) ? buffer.viewportY : 0;
    const wanted = new Set();

    for (const block of codexUserMessageBlocks(buffer, viewportY, term.rows, confirmedMessages)) {
      if (!block.confirmed) {
        if (block.normalizedText) onUnconfirmed?.(block.normalizedText);
        continue;
      }
      wanted.add(block.firstBufferRow);
      let marker = markers.get(block.firstBufferRow);
      if (!marker) {
        marker = mounted.screen.ownerDocument.createElement("div");
        marker.className = "codex-user-marker";
        mounted.layer.appendChild(marker);
        markers.set(block.firstBufferRow, marker);
      }
      marker.style.top = `${block.row * cellHeight}px`;
      marker.style.height = `${block.rowCount * cellHeight}px`;
    }

    for (const [firstBufferRow, marker] of [...markers]) {
      if (wanted.has(firstBufferRow)) continue;
      marker.remove();
      markers.delete(firstBufferRow);
    }
  }

  // PTY repaint bursts often arrive as several WebSocket writes. Commit at most
  // one overlay reconciliation per animation frame so the user never sees the
  // intermediate half-repainted buffer states.
  function schedule() {
    if (scanFrame != null) return;
    const owner = term.element?.ownerDocument?.defaultView ?? globalThis;
    if (typeof owner.requestAnimationFrame !== "function") {
      scan();
      return;
    }
    scanFrameOwner = owner;
    scanFrame = owner.requestAnimationFrame(() => {
      scanFrame = null;
      scanFrameOwner = null;
      scan();
    });
  }

  function setUserMessages(messages) {
    confirmedMessages = new Set(
      Array.from(messages ?? [], normalizeCodexUserMessage).filter(Boolean),
    );
    schedule();
  }

  function dispose() {
    for (const subscription of subscriptions.splice(0)) subscription?.dispose?.();
    if (scanFrame != null) scanFrameOwner?.cancelAnimationFrame?.(scanFrame);
    scanFrame = null;
    scanFrameOwner = null;
    markers.clear();
    layer?.remove?.();
    layer = null;
  }

  // Scrolling changes which buffer line occupies each screen row without a PTY
  // write. Resize likewise changes wrapping, so both paths schedule a rescan.
  if (typeof term.onScroll === "function") subscriptions.push(term.onScroll(schedule));
  if (typeof term.onResize === "function") subscriptions.push(term.onResize(schedule));

  return { scan, schedule, setUserMessages, dispose };
}
