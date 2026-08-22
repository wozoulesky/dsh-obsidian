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

## Installation (local)

1. `npm install && npm run build`
2. Copy `main.js`, `manifest.json`, and `styles.css` into `vault/.obsidian/plugins/dsh-bridge/`
3. Settings → Community plugins → enable "DSH Bridge"

## Privacy

All data flows through your local DSH to its configured model providers, using the same policy as the DSH Web GUI. The plugin sends no telemetry.

## Development

```bash
npm install
npm run dev    # watch build
npm test       # unit tests (92)
```

## Architecture

Transport: unary RPC over Node `http` (`POST /api/<method>`, `/api/respond`); live events over a bundled `ws` WebSocket (`/api/events.mux` — the server rejects plain SSE with 426). A core layer folds session events into view models; a UI layer renders the sidebar and modals. See `docs/superpowers/specs/2026-08-13-dsh-obsidian-design.md`.
