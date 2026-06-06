# Light Mode — Design

**Date:** 2026-06-06
**Branch:** feat/12-light-mode
**Status:** Approved, ready for implementation plan

## Problem

The web UI ships a single hardcoded warm dark theme. Long sessions are tiring on
the eyes. We want a light mode the user can switch to and have remembered.

## Decisions (locked)

- **Palette:** "Warm Paper" — a warm, low-glare off-white that stays in the same
  family as the existing warm dark theme (chosen over a neutral white and a soft
  warm-gray variant via visual preview).
- **Default:** Dark, unchanged. Light is **opt-in** via a header toggle. Existing
  users see zero change on first load.
- **Persistence:** The user's explicit choice is saved to `localStorage` under
  `theme`, mirroring how `lang` works in `i18n.js`.
- **No system-preference following** (`prefers-color-scheme` is not consulted).
- **One palette only** — the neutral and warm-gray options previewed during
  brainstorming are not shipped.

## Warm Paper palette

Light values for the token set (dark values shown for reference; these are today's
hardcoded colors):

| Token            | Role                         | Dark (current) | Light (warm paper) |
|------------------|------------------------------|----------------|--------------------|
| `--bg`           | base background, inputs, code, term, boot | `#1a1613` | `#f5f0e8` |
| `--surface`      | panels: header, cards, menus, modals, chips | `#221d18` | `#fbf8f2` |
| `--surface-2`    | raised: buttons, dividers, rename field    | `#2a241e` | `#efe9df` |
| `--surface-3`    | button hover                 | `#352d24`      | `#e7e0d2`          |
| `--border`       | primary border               | `#352e27`      | `#e3d9c9`          |
| `--border-faint` | faint divider / row hairline | `#2a241e`      | `#ece5d8`          |
| `--border-hover` | trigger hover border         | `#473d33`      | `#d6c9b4`          |
| `--text`         | primary text                 | `#ece6dd`      | `#2c2620`          |
| `--term-fg`      | terminal foreground          | `#ddd4c8`      | `#3a322a`          |
| `--muted`        | secondary text               | `#a89e90`      | `#6f665a`          |
| `--faint`        | faint text / icons           | `#7d7367`      | `#9a9081`          |
| `--faint-2`      | fainter hints                | `#6b6356`      | `#a89e95`          |
| `--placeholder`  | input placeholder            | `#5f574c`      | `#b3a795`          |
| `--accent`       | focus border, primary glyphs | `#d97757`      | `#c2603f`          |
| `--accent-strong`| primary button bg            | `#c2603f`      | `#b65737`          |
| `--accent-strong-hover` | primary button hover  | `#cf6b4a`      | `#a44d2f`          |
| `--accent-text`  | accent label/link text (the salmon family `#e09a7d`/`#e0906f`/`#ecae93`) | `#e09a7d` | `#b1572f` |
| `--green`        | ready / live status          | `#8aaa66`      | `#5f8a3e`          |
| `--amber`        | waiting / cloning status     | `#e0b341`      | `#bb8410`          |
| `--red`          | error / danger solid         | `#f85149`      | `#cf3b30`          |
| `--shadow`       | menu / modal drop shadow     | `#000000bb`    | `#5b4a3540` (softer)|

Exact light hex values may be nudged ±a few points during implementation while
checking real contrast; the table is the target, not a contract.

## Approach

### CSS: tokenize opaque colors, keep translucent washes literal

The single source of truth is `web/css/app.css`. The change is:

1. Define the token set above on `:root` (dark values become the defaults).
2. Add `:root[data-theme="light"] { … }` redefining each token to its warm-paper
   value, plus flip `color-scheme` to `light`.
3. Replace each hardcoded **opaque** hex in the rules with the matching `var(--…)`.

**Translucent accent / red / green washes are left as literal `rgba`-style hex**
(e.g. `#d977571f`, `#f8514914`, `#8aaa6699` glows). They are semi-transparent, so
they layer correctly over either background — a faint terracotta tint on cream
reads the same way it reads on near-black. This keeps the diff focused on the
opaque structural colors and the one genuinely background-dependent value: the
salmon **accent text**, which is too light on a pale background and therefore
*is* tokenized (`--accent-text`).

`color-scheme` on `:root` (currently `dark`) becomes `light` under the light theme
so native scrollbars and form controls match.

### Theme switching: a global `Theme` module mirroring `i18n.js`

A standalone script (loaded as a plain `<script>` before the app modules, like
`i18n.js`) exposing a global `Theme`:

- `Theme.init()` — read `localStorage.theme` (default `"dark"`), set
  `document.documentElement.dataset.theme`.
- `Theme.set(next)` / `Theme.toggle()` — set the attribute, persist, update the
  toggle button's icon/label, and invoke `Theme.onChange(theme)` so the terminal
  layer can re-skin (parallels `I18N.onChange`).
- `get theme()` accessor.

**No-flash init:** a tiny inline `<script>` in `<head>` (before the stylesheet)
reads `localStorage.theme` and sets `data-theme` before first paint. Default is
dark, so existing users never flash; users who picked light won't briefly see dark
either. The existing `#boot` overlay remains as a second layer of cover.

**Header toggle:** a `☀️/🌙` button beside `#lang-toggle` in the header,
`onclick="Theme.toggle()"`, label/title via i18n.

### Terminal (xterm)

The terminal's colors live in a JS theme object in `web/js/terminal.js`
(`{ background, foreground, cursor, cursorAccent, selectionBackground }`), which
CSS variables cannot reach. Plan:

- Define a light terminal theme (warm-paper background, warm-brown foreground,
  same terracotta cursor/selection family).
- Pick the theme by current `Theme.theme` when a terminal is created.
- On `Theme.onChange`, **re-skin already-open terminals** live by updating their
  xterm `theme` option (no reconnect).

### i18n

Add a key pair (e.g. `theme.toggle` / or `theme.light` + `theme.dark` for the
title) to **both** `zh` and `en` in `i18n.js`, keeping the dev-time lockstep check
happy. The button is icon-first; the localized string is its `title`/aria label.

## Scope

**In:** `web/css/app.css` (tokenize + light overrides), new `Theme` module + head
init + header button (`index.html`), light terminal theme + live re-skin
(`web/js/terminal.js`, wiring in `web/js/main.js`), i18n keys (`web/i18n.js`).

**Out:** system-preference following; the neutral/warm-gray palettes; per-task or
per-machine themes; any automated test harness for CSS.

## Verification

No automated tests apply (the suite is `server/*.test.ts`; this is a frontend
visual change). Verify by running the app and toggling, checking each surface in
**both** themes:

- header + toggle button, machine rail (chips, status dots)
- task list: machine header, repo groups (open/closed), task cards
  (hover/selected/waiting), local "shell" tag
- custom `<select>` dropdown (trigger, menu, options, hover/selected)
- every modal (task / repo / host / preset / skills) and the confirm dialog
- toasts (success / error / info), empty states, loading + boot overlays
- terminal: bar, body, cursor, selection — and live re-skin when toggling with a
  terminal open
- no dark flash on reload when light is the saved choice; existing dark users
  unchanged.
