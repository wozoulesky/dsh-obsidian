# DSH Bridge

Embed your locally running [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh) into Obsidian as an AI collaborator: your vault becomes its working directory, and DSH can read, write, and search your notes directly.

[中文文档](./README.zh.md)

## Prerequisites

- A running DSH instance on your machine (default `http://127.0.0.1:3080`)
- Your vault must be inside DSH's accessible directory scope (decided by DSH's sandbox / workspace config)
- Obsidian ≥ 1.7.2, desktop only

## Features

- **Chat sidebar** — streamed responses, tool-call cards, approval/question popups (retryable), session switching and creation, "load older" pagination, and automatic re-sync after reconnects
- **Inline edit** — select text + hotkey → instruction → word-level diff preview → apply (editor selection is re-validated before applying; large selections degrade to a plain confirm dialog)
- **@mentions** — type `@` to pick vault files (`@file:path`, content injected) or folders (`@folder:path`, directory tree injected), with truncation and missing-file notices
- **Slash commands & plan mode** — `/plan`, `/compact`, `/feedback`, `/goal` with autocomplete; `Shift+Tab` toggles plan mode with a status banner

## Screenshots

| Chat sidebar | @ Mention picker |
| --- | --- |
| ![Chat sidebar with streamed conversation](https://raw.githubusercontent.com/wozoulesky/dsh-obsidian/master/docs/screenshots/01-chat-panel.png) | ![@ mention file picker](https://raw.githubusercontent.com/wozoulesky/dsh-obsidian/master/docs/screenshots/02-mention-picker.png) |

| Inline edit diff preview | Approval popup |
| --- | --- |
| ![Inline edit word-level diff preview](https://raw.githubusercontent.com/wozoulesky/dsh-obsidian/master/docs/screenshots/03-inline-edit-diff.png) | ![DSH tool approval popup](https://raw.githubusercontent.com/wozoulesky/dsh-obsidian/master/docs/screenshots/04-approval.png) |

## Installation (Community Plugins)

1. Settings → Third-party plugins → Browse → search **DSH Bridge** → Install → Enable (desktop only)
2. Make sure DSH is running locally (default `http://127.0.0.1:3080`)

Prefer a manual install? Grab the latest artifacts from the [GitHub releases page](https://github.com/wozoulesky/dsh-obsidian/releases) and extract them into `vault/.obsidian/plugins/dsh-bridge/`.

## Installation (local / dev)

1. `npm install && npm run build`
2. Copy `main.js`, `manifest.json`, and `styles.css` into `vault/.obsidian/plugins/dsh-bridge/`
3. Settings → Community plugins → enable "DSH Bridge"

## Privacy

All data flows through your local DSH to its configured model providers, using the same policy as the DSH Web GUI. The plugin sends no telemetry.

## Translations / Localization

The plugin ships with all UI strings in a key-value table (built-in default: Chinese). To switch the UI to another language:

1. In the plugin settings tab, click **Export i18n template** — this creates `dsh-bridge.i18n.json` at the **root of your vault** (visible in Obsidian's file explorer).
2. Replace the values with your translations (or hand the file to your local DSH / any translator).
3. Reload Obsidian (or disable/enable the plugin) to apply — repeatable.

The vault-root file takes priority; a legacy `i18n.json` inside the plugin directory (`.obsidian/plugins/dsh-bridge/`) is still read as a fallback. Missing keys or invalid JSON silently fall back to the built-in defaults. In v0.1.x, model-facing instructions (inline-edit prompt, @mention expansion) intentionally remain in Chinese; the UI-only string table is safe to translate.

## Development

```bash
npm install
npm run dev    # watch build
npm test       # unit tests (92)
```

## Architecture

Transport: unary RPC over Node `http` (`POST /api/<namespace>/<method>` with `{args}` payload + self-signed browser-session cookie); live streams over a bundled `ws` WebSocket (`/api/remote.mux` — `session/follow`, `session/control`, `$events`). A core layer folds session events into view models; a UI layer renders the sidebar and modals.

**Requires DSH ≥ 0.1.2-rc.1.** Older DSH versions (e.g. 0.1.0-rc.6) return 401/404 — upgrade DSH, or downgrade the plugin to 0.1.4.

## Related

- [obsidian-project-management](https://github.com/wozoulesky/obsidian-project-management) — the Obsidian-based project management skill that governs this plugin's development workflow (project records are tracked in a local Obsidian vault).
