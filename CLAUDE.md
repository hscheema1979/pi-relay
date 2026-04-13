# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Pi-relay is a web UI relay for the **pi coding agent** (`@mariozechner/pi-coding-agent`). It wraps pi's `AgentSession` SDK in a WebSocket server so any browser (desktop/mobile) can interact with the agent. Forked from [clay](https://github.com/chadbyte/clay) (claude-relay v2.4.2), rewired to use pi's SDK instead of Claude Agent SDK.

## Commands

```bash
# Development (port 2635 in dev, 2633 in prod)
node bin/cli.js --dev

# Production
node lib/daemon.js

# PM2
pm2 start ecosystem.config.cjs
pm2 save
```

No test suite exists. No linter configured.

## Architecture

### Request Flow

```
Browser ←WebSocket→ server.js ←→ project.js ←→ pi-bridge.js ←→ @mariozechner/pi-coding-agent SDK
```

1. **daemon.js** — Entry point. Loads config from `~/.pi-relay/daemon.json`, creates TLS, starts HTTP/WS server, registers projects, runs IPC server for CLI commands.
2. **server.js** — Multi-project HTTP/WS server. Routes `/p/{slug}/...` to per-project contexts. Handles auth (PIN-based), static files, push subscriptions, TTS proxy, Tailscale discovery, remote project proxying.
3. **project.js** — Per-project context. Owns the WebSocket message handler for one project directory. Creates session manager, pi-bridge, terminal manager, autonomous manager. Dispatches incoming WS messages (`query`, `abort`, `set_model`, `rewind`, file ops, terminal ops, etc.).
4. **pi-bridge.js** — The SDK integration layer. Creates `AgentSession` instances via pi's SDK, subscribes to pi events, and translates them to relay WS protocol messages. Manages per-relay-session state, model switching, extension UI context (dialogs forwarded to browser), and autonomous/execution-mode detection via sidecar files.
5. **sessions.js** — Multi-session state. Tracks sessions per project (localId → session object), persists message history as `.jsonl` files in `~/.pi-relay/sessions/`, handles session create/switch/rename/delete.

### Key SDK Integration Points (pi-bridge.js)

The bridge translates pi SDK events to relay WebSocket messages:

| Pi SDK Event | Relay WS Message |
|---|---|
| `message_update` → `text_delta` | `delta` |
| `thinking_start/delta/end` | `thinking_start/delta/stop` |
| `tool_execution_start` | `tool_start` + `tool_executing` |
| `tool_execution_end` | `tool_result` |
| `agent_end` | `result` + `done` |

SDK classes used: `AuthStorage`, `ModelRegistry`, `SessionManager`, `createAgentSession`, `DefaultResourceLoader`, `SettingsManager`.

### Multi-Project & Remote Projects

- Local projects: registered in `daemon.json` → `project.js` contexts
- Remote projects: proxy contexts (`remote-project.js`) that forward WS messages to remote relay instances over Tailscale
- Projects addressed by slug: `/p/{slug}/ws`, `/p/{slug}/api/...`

### Extension UI Context

`pi-bridge.js` creates a relay-compatible `ExtensionUIContext` that forwards extension calls (notify, select, confirm, input, editor) over WebSocket to the browser. Dialog methods use promise-based round-trips with timeout support.

### Autonomous/Execution Mode

Tracks autonomous agent sessions via sidecar files (`.pi/execution-mode.json`). The autonomous manager (`autonomous.js`) persists state to `~/.pi-relay/autonomous-state/` for crash recovery. Push notifications are suppressed during autonomous work and sent once on plan completion/failure.

### Frontend

- Vanilla JS SPA in `lib/public/` (no build step)
- `app.js` is the main frontend (~1400 lines) — handles WS connection, chat rendering, sessions, file browser, themes, push notifications
- CSS modules in `lib/public/css/`, JS modules in `lib/public/modules/`

## Config

Config lives at `~/.pi-relay/daemon.json`:
```json
{
  "port": 3010,
  "pinHash": null,
  "projects": [{ "path": "/home/ubuntu", "slug": "home", "title": "Home" }],
  "remoteProjects": [{ "remoteHost": "100.x.x.x", "remotePort": 3010, "remoteSlug": "app", "slug": "vps1-app" }]
}
```

Environment variables: `PI_RELAY_HOME` or `CLAUDE_RELAY_HOME` (config dir override), `LITELLM_HOST`, `LITELLM_PORT`, `LITELLM_KEY`.

## Important Conventions

- All server-side code is CommonJS (`require`/`module.exports`), except the pi SDK which is ESM and loaded via dynamic `import()`.
- No TypeScript, no build step for backend.
- Frontend is vanilla JS with no bundler.
- Session history stored as `.jsonl` files (one JSON object per line).
- The pi SDK filters out litellm-provided Claude models (they fail with 401) but keeps other litellm models (Gemini, DeepSeek, Qwen, etc.).
