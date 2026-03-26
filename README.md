# pi-relay

Web UI for [pi coding agent](https://github.com/mariozechner/pi-coding-agent). Any device.

Based on [clay](https://github.com/chadbyte/clay) (claude-relay), rewired to use pi's SDK instead of the Claude Agent SDK.

## Features

- **Chat UI** — Full web chat interface for pi agent
- **Streaming** — Real-time streaming of agent responses, tool calls, thinking
- **Multi-session** — Create, switch, rename sessions
- **Terminal** — Built-in web terminal with multiple tabs
- **File browser** — Browse and view project files
- **Themes** — Customizable themes
- **Mobile** — Works on phone/tablet, push notifications
- **Multi-project** — Manage multiple project directories

## Quick Start

```bash
# Configure
mkdir -p ~/.pi-relay
cat > ~/.pi-relay/daemon.json << 'EOF'
{
  "port": 3010,
  "pinHash": null,
  "projects": [
    { "path": "/home/ubuntu", "slug": "home", "title": "Home" }
  ]
}
EOF

# Install dependencies
cd pi-relay
npm install

# Start
node lib/daemon.js
```

Open http://localhost:3010

## PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

## How it works

Pi-relay creates an `AgentSession` via pi's SDK (`@mariozechner/pi-coding-agent`) and subscribes to its event stream. Events are translated to the relay's WebSocket protocol and rendered in the browser.

| Pi SDK Event | Relay Message |
|---|---|
| `message_update` → `text_delta` | `delta` |
| `thinking_start/delta/end` | `thinking_start/delta/stop` |
| `tool_execution_start` | `tool_start` + `tool_executing` |
| `tool_execution_end` | `tool_result` |
| `agent_end` | `result` + `done` |

## Differences from clay (claude-relay)

- Uses pi's SDK instead of Claude Agent SDK
- No permission system (pi tools run without permission gates)
- No `dangerouslySkipPermissions` needed
- Rewind not yet implemented (pi uses tree-based session branching)
- Session management uses pi's `SessionManager`

## License

MIT (forked from clay 2.4.2)
