# FR: Agent Fix Tool Panel

**Feature Request** · Pi Relay  
**Date:** 2026-03-30  
**Priority:** Medium  
**Area:** UI — Sidebar Tools

---

## Summary

Add an **"Agent Fix"** entry to the **Tools** section of the left sidebar (alongside Resume CLI, File Browser, Terminal, and Teams). This panel provides a live view into the fleet process monitor's automated fix sessions — letting you watch, steer, and interact with the AI agent as it diagnoses and repairs service failures.

## Motivation

The fleet process monitor (`fleet-manager/src/process-monitor`) now routes its Tier 2 (agentic) fix attempts through pi-relay via WebSocket (`relay-bridge.ts`). When a service crashes and deterministic fixes fail, the monitor creates a new pi-relay session in the `fleet-manager` project and sends a diagnostic prompt. The agent then uses bash/read/edit/write tools to investigate and fix the issue.

**Problem:** These automated sessions are invisible unless you happen to be looking at the fleet-manager project and notice a new session appear. There's no dedicated UI to:
- See that an automated fix is in progress
- See the history of recent automated fixes
- Jump into an active fix session to steer the agent
- See a summary of fix outcomes (resolved / failed / escalated)

## Design

### 1. Sidebar Button

Add a new button to `#session-actions` in `index.html`:

```html
<button id="agent-fix-sidebar-btn">
  <i data-lucide="wrench"></i> <span>Agent Fix</span>
</button>
```

Position it after the Teams button. Use the `wrench` Lucide icon (alternatives: `bot`, `shield-check`, `activity`).

### 2. Panel

A sliding panel (same pattern as Teams panel) that shows:

#### Active Fix Session (top section)
When the process monitor is currently running a fix:
- **Status badge**: `🔧 Fixing...` with a spinner
- **Service name + machine**: e.g. `pi-relay @ vps5`
- **Problem type**: e.g. `crashed`, `crash_loop`, `endpoint_timeout`
- **Elapsed time**: live counter
- **"Watch Live" button**: Switches to the relay session where the agent is working. This is the key interaction — it takes you directly into the conversation so you can see tool calls streaming and type a message to steer the agent.
- **"Stop" button**: Sends an abort to the agent session

#### Recent Fix History (scrollable list below)
Each entry shows:
- Service name + machine
- Problem type
- Outcome: ✅ Resolved / ❌ Failed / 🚨 Escalated
- Duration
- Timestamp (relative: "2m ago", "1h ago")
- Tier (1 = deterministic, 2 = agentic)
- Expandable diagnosis snippet (for Tier 2)
- Click to jump to the session (if it still exists)

### 3. Data Source: `/api/agent-fix` endpoint

Add a new project-scoped API endpoint that reads from the process monitor's state:

```
GET /p/fleet-manager/api/agent-fix
```

Returns:

```json
{
  "active": {
    "service": "pi-relay",
    "machine": "vps5",
    "type": "crashed",
    "tier": 2,
    "startedAt": "2026-03-30T22:15:00.000Z",
    "sessionId": "abc123"
  },
  "history": [
    {
      "id": "vps5:pi-relay:crashed:1711836900000",
      "service": "pi-relay",
      "machine": "vps5",
      "type": "crashed",
      "tier": 2,
      "resolved": true,
      "diagnosis": "OOM kill due to memory leak in...",
      "duration": 45000,
      "timestamp": "2026-03-30T21:30:00.000Z",
      "sessionId": "abc122"
    }
  ]
}
```

**Data source options** (pick one during implementation):

**Option A — Read from `state/incidents.jsonl`** (simplest)  
The process monitor already writes incidents to `state/incidents.jsonl`. The API endpoint reads and parses this file. No inter-process communication needed.

**Option B — Shared state file** (better for active status)  
The relay-bridge writes a small `state/agent-fix-status.json` file that the API reads:
```json
{
  "active": { ... } | null,
  "recentHistory": [ ... ]
}
```
Updated by `relay-bridge.ts` on fix start/end. This gives real-time "active fix" status without parsing logs.

**Option C — WebSocket subscription** (richest but most complex)  
The Agent Fix panel connects to the same relay WS and listens for session events tagged with `[agent-fix]`. Overkill for v1.

**Recommendation: Option B** — simple file-based IPC, gives real-time active status, and the process monitor already writes state files.

### 4. Sidebar Badge (notification dot)

When an automated fix is in progress, show a small colored dot on the Agent Fix sidebar button (like an unread indicator). This makes active fixes visible even when the panel is closed.

```css
#agent-fix-sidebar-btn.has-active::after {
  content: '';
  width: 6px;
  height: 6px;
  background: var(--color-warning);
  border-radius: 50%;
  position: absolute;
  top: 4px;
  right: 4px;
}
```

Poll the status file every ~10s (same as Teams panel auto-refresh).

### 5. Toast Notifications

When a fix completes or fails, show a toast:
- ✅ `Agent fixed pi-relay @ vps5 (45s)`
- ❌ `Agent fix failed for pi-relay @ vps5 — escalated`

Use the existing `showToast()` from `utils.js`.

### 6. "Watch Live" Behavior

The most important UX: clicking "Watch Live" on an active fix should:
1. Switch to the relay session where the agent is running (send `{ type: "switch_session", id: sessionId }`)
2. Close the Agent Fix panel
3. Scroll to the bottom of the conversation
4. The user can now type a message to steer the agent

## Implementation Files

| File | Changes |
|------|---------|
| `lib/public/index.html` | Add sidebar button + panel HTML |
| `lib/public/modules/agent-fix.js` | New module — panel logic, polling, rendering |
| `lib/public/app.js` | Import and init `agent-fix` module |
| `lib/public/css/agent-fix.css` | Panel styles |
| `lib/public/style.css` | Import agent-fix.css |
| `lib/project.js` | Add `/api/agent-fix` HTTP handler |
| `fleet-manager/src/process-monitor/relay-bridge.ts` | Write `state/agent-fix-status.json` on fix start/end |

## Relay-Bridge Status File

Update `relay-bridge.ts` to write status:

```typescript
// On fix start:
writeFileSync('state/agent-fix-status.json', JSON.stringify({
  active: {
    service: problem.service,
    machine: problem.machine,
    type: problem.type,
    tier: 2,
    startedAt: new Date().toISOString(),
    sessionId: conn.sessionId,
  },
  lastUpdated: new Date().toISOString(),
}));

// On fix end:
const history = readExistingHistory(); // from state/agent-fix-status.json
history.unshift({
  id: problem.id,
  service: problem.service,
  machine: problem.machine,
  type: problem.type,
  tier: 2,
  resolved,
  diagnosis,
  duration: Date.now() - start,
  timestamp: new Date().toISOString(),
  sessionId: conn.sessionId,
});
writeFileSync('state/agent-fix-status.json', JSON.stringify({
  active: null,
  history: history.slice(0, 50), // keep last 50
  lastUpdated: new Date().toISOString(),
}));
```

## Scope & Non-Goals

### In Scope
- Sidebar button with notification dot
- Sliding panel with active fix + history
- "Watch Live" session switching
- Status file IPC from relay-bridge
- API endpoint to serve status
- Toast notifications on fix completion

### Out of Scope (future)
- Manual "trigger fix" button (force re-check a service)
- Configuration panel (change thresholds, enable/disable services)
- Log viewer (tailing process-monitor logs in the panel)
- Multi-project awareness (only works for the fleet-manager project)
- Tier 1 (deterministic) fix detail view

## Mockup

```
┌─ Sidebar ─────────────────────────┐
│                                   │
│ Tools                             │
│ ▸ Resume CLI                      │
│ ▸ File browser                    │
│ ▸ Terminal                        │
│ ▸ Teams                           │
│ ▸ 🔧 Agent Fix  ●                │  ← new button with active dot
│                                   │
│ Sessions                          │
│ ...                               │
└───────────────────────────────────┘

┌─ Agent Fix Panel ─────────────────┐
│ Agent Fix              ↻    ✕     │
│───────────────────────────────────│
│ 🔧 ACTIVE FIX                    │
│ ┌───────────────────────────────┐ │
│ │ pi-relay @ vps5               │ │
│ │ crashed · Tier 2 · 1m 23s    │ │
│ │                               │ │
│ │ [Watch Live]     [Stop]       │ │
│ └───────────────────────────────┘ │
│───────────────────────────────────│
│ Recent History                    │
│                                   │
│ ✅ pi-relay @ vps5     2m ago     │
│    crashed · Tier 1 · 3s          │
│                                   │
│ ❌ litellm @ vps5      1h ago     │
│    crash_loop · Tier 2 · 4m 52s   │
│    > Memory leak in proxy pool... │
│                                   │
│ ✅ myhealthteam @ vps2  3h ago    │
│    endpoint_timeout · Tier 1 · 5s │
└───────────────────────────────────┘
```

## References

- Teams panel implementation: `lib/public/modules/teams.js` (pattern to follow)
- Relay bridge: `fleet-manager/src/process-monitor/relay-bridge.ts`
- Process monitor state: `fleet-manager/src/process-monitor/state.ts`
- Incident types: `fleet-manager/src/process-monitor/types.ts`
