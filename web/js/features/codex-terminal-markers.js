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

// tmux itself puts the outer terminal in xterm's alternate buffer, where xterm
// line decorations are not painted. Use a pointer-transparent DOM overlay on
// the rendered screen instead. It follows viewport rows on every scan and still
// changes no terminal cell or byte.
export function createCodexUserMarkerOverlay(term) {
  let layer = null;
  const markers = new Map(); // visible row -> overlay element

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
    const cellWidth = rect.width / term.cols;
    const cellHeight = rect.height / term.rows;
    const viewportY = Number.isFinite(buffer.viewportY) ? buffer.viewportY : 0;
    const wanted = new Set();

    for (let row = 0; row < term.rows; row++) {
      if (!isCodexUserMessageLine(buffer.getLine(viewportY + row))) continue;
      wanted.add(row);
      let marker = markers.get(row);
      if (!marker) {
        marker = mounted.screen.ownerDocument.createElement("div");
        marker.className = "codex-user-marker";
        mounted.layer.appendChild(marker);
        markers.set(row, marker);
      }
      marker.style.top = `${row * cellHeight}px`;
      marker.style.width = `${2 * cellWidth}px`;
      marker.style.height = `${cellHeight}px`;
    }

    for (const [row, marker] of [...markers]) {
      if (wanted.has(row)) continue;
      marker.remove();
      markers.delete(row);
    }
  }

  function dispose() {
    markers.clear();
    layer?.remove?.();
    layer = null;
  }

  return { scan, dispose };
}
