# Holistic Design: Execution Mode + Agent Fix + Process Resilience

**Date:** 2026-04-02  
**Status:** Design Review  
**Inputs:** `EXECUTION-MODE-RISK-MATRIX.md`, `FR-agent-fix-tool-panel.md`, codebase analysis

---

## 1. The Unified Problem

Two features are being designed in isolation but share the same infrastructure gaps and failure modes:

| Feature | What it does | Core need |
|---------|-------------|-----------|
| **Execution Mode Extension** | Keeps LLMs executing multi-phase plans autonomously | Persistent state that survives crashes, compaction, and restarts |
| **Agent Fix Panel** | Surfaces automated service-fix sessions in the UI | Visibility into autonomous agent sessions + ability to intervene |

Both are instances of the same abstract problem: **autonomous agent sessions that must be observable, steerable, and crash-resilient**. The Agent Fix panel is literally a concrete use case of what Execution Mode manages — an agent executing a plan (diagnose → fix → verify → restart) without human hand-holding.

Designing them separately creates:
- Duplicated state persistence mechanisms (sidecar files vs. status JSON files)
- Duplicated crash recovery logic
- Inconsistent UI patterns for observing/steering autonomous agents
- Two different answers to the same "what happens when the process dies?" question

---

## 2. Architecture: Three Layers

```
┌─────────────────────────────────────────────────────────────────────┐
│                    LAYER 3: UI (Browser)                            │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Agent Fix     │  │ Session View │  │ Execution Mode Widget    │  │
│  │ Panel         │  │ (watch live) │  │ (progress, stop, resume) │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────────┘  │
│         │                  │                      │                  │
└─────────┼──────────────────┼──────────────────────┼──────────────────┘
          │                  │                      │
          ▼                  ▼                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│                LAYER 2: Pi-Relay (Node.js)                          │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │            Autonomous Session Manager (NEW)                  │   │
│  │                                                              │   │
│  │  - Tracks all sessions with autonomous work in progress      │   │
│  │  - Persists state to disk (survives crash/restart)           │   │
│  │  - Provides /api/autonomous-sessions endpoint                │   │
│  │  - Manages push notification suppression/batching            │   │
│  │  - Detects interrupted sessions on startup                   │   │
│  └──────────────────────────┬──────────────────────────────────┘   │
│                              │                                      │
│  ┌──────────────┐  ┌────────┴──────┐  ┌────────────────────────┐   │
│  │ sessions.js   │  │ pi-bridge.js  │  │ relay-bridge.ts        │   │
│  │ (now persists │  │ (now persists │  │ (fleet process monitor │   │
│  │  piSessionFile│  │  session link)│  │  → relay sessions)     │   │
│  │  in meta)     │  │               │  │                        │   │
│  └──────────────┘  └───────────────┘  └────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
          │                                          │
          ▼                                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│              LAYER 1: Persistent State (Filesystem)                 │
│                                                                     │
│  ~/.claude-relay/                                                   │
│  ├── sessions/{project}/                                            │
│  │   └── {sessionId}.jsonl          # relay session history         │
│  │       └── meta.piSessionFile     # ← NEW: link to pi session    │
│  │                                                                  │
│  └── autonomous-state/              # ← NEW: crash-resilient state  │
│      └── {project}.json             # active autonomous sessions    │
│                                                                     │
│  {project}/.pi/                                                     │
│  ├── session files (pi SDK)         # conversation tree + entries   │
│  └── execution-mode.lock            # multi-session guard           │
│                                                                     │
│  {fleet-manager}/state/                                             │
│  └── agent-fix-status.json          # fleet process monitor state   │
│  └── incidents.jsonl                # historical incidents          │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Layer 1: Persistent State (The Foundation)

Everything else depends on state surviving process death. There are **four categories** of process death, and each demands a different response:

### 3.1 Process Death Taxonomy

| Kill Type | Signal | Handler Runs? | State Window | Recovery Strategy |
|-----------|--------|---------------|--------------|-------------------|
| **Graceful** (PM2 reload, SIGTERM) | SIGTERM | Yes — `gracefulShutdown()` fires, ~5s window | Can flush all in-memory state to disk | Write final state → clean shutdown marker |
| **Hard kill** (OOM, SIGKILL, `kill -9`) | SIGKILL | No | Zero — process evaporates | Rely on pre-persisted state. Detect stale PID on restart |
| **Crash** (uncaught exception, segfault) | N/A | Partial — `uncaughtException` handler may fire | Brief — handler writes crash.json then exits | crash.json + pre-persisted state |
| **Resource exhaustion** (disk full, fd limit) | Varies | Unpredictable — writes may fail | Corrupted — appendFileSync may half-write | Validate JSON on read. Atomic writes (write-then-rename) for critical state |

### 3.2 The piSessionFile Fix (P0 — ~10 lines)

**Problem confirmed by code review:** `sessions.js:saveSessionFile()` writes a `meta` object with `localId`, `cliSessionId`, `title`, `createdAt` — but **not** `piSessionFile`. When the process restarts, `loadSessions()` reconstructs relay sessions from disk but `piSessionFile` is null. `pi-bridge.js:createPiSession()` then creates a brand new pi SDK session, orphaning the old one.

**Fix:**

```javascript
// sessions.js — saveSessionFile()
var metaObj = {
  type: "meta",
  localId: session.localId,
  cliSessionId: session.cliSessionId,
  title: session.title,
  createdAt: session.createdAt,
  piSessionFile: session.piSessionFile || null,     // ← ADD
  piSessionId: session.piSessionId || null,          // ← ADD
};

// sessions.js — loadSessions(), inside the loop:
var session = {
  // ...existing fields...
  piSessionFile: m.piSessionFile || null,            // ← ADD
  piSessionId: m.piSessionId || null,                // ← ADD
};
```

```javascript
// pi-bridge.js — createPiSession(), existing code already handles it:
if (session.piSessionFile) {
  sessionMgr = sdk.SessionManager.open(session.piSessionFile);
} else {
  sessionMgr = sdk.SessionManager.create(cwd);
}
```

The pi-bridge already checks `session.piSessionFile` — the bug is simply that sessions.js never persists it. The fix is 4 lines.

**Also needed:** When `createPiSession` sets `session.piSessionFile`, save it immediately:

```javascript
// pi-bridge.js — after setting session.piSessionFile:
if (state.piSession.sessionFile) {
  session.piSessionFile = state.piSession.sessionFile;
  session.piSessionId = state.piSession.sessionId;
  sm.saveSessionFile(session);  // ← ADD: persist the link immediately
}
```

### 3.3 Autonomous State File (P0)

A single, project-scoped JSON file that tracks all autonomous work. Written atomically (write to `.tmp` then rename). Read on startup to detect interrupted work.

**Location:** `~/.claude-relay/autonomous-state/{encoded-project}.json`

**Why here and not in `{project}/.pi/`?**
- The project dir might be on a different filesystem (SSHFS mount) that's slower or unreliable
- `~/.claude-relay/` is guaranteed local, fast, and already used for relay state
- The sidecar file from the risk matrix (`{project}/.pi/execution-mode.json`) is fine for the pi extension's own state, but the relay-level autonomous tracking should live with relay state

**Schema:**

```json
{
  "version": 1,
  "updatedAt": "2026-04-02T23:15:00Z",
  "sessions": {
    "relay-session-id-abc": {
      "type": "execution-mode",
      "status": "active",
      "pid": 12345,
      "piSessionFile": "/home/ubuntu/.pi/sessions/abc.jsonl",
      "plan": {
        "id": "plan-uuid",
        "text": "Full plan text...",
        "phases": [
          { "name": "Phase 1: Setup", "status": "completed", "completedAt": "..." },
          { "name": "Phase 2: Implement", "status": "in_progress" },
          { "name": "Phase 3: Test", "status": "pending" }
        ],
        "currentPhase": 2,
        "deadline": "2026-04-03T13:30:00Z"
      },
      "safetyCounters": {
        "continuations": 3,
        "maxContinuations": 10,
        "lastResponseTokens": 850
      },
      "lastCheckpoint": "git-commit-abc123",
      "startedAt": "2026-04-02T22:00:00Z"
    },
    "relay-session-id-xyz": {
      "type": "agent-fix",
      "status": "active",
      "pid": 12345,
      "service": "pi-relay",
      "machine": "vps5",
      "problemType": "crashed",
      "tier": 2,
      "startedAt": "2026-04-02T23:10:00Z",
      "sessionId": "relay-session-id-xyz"
    }
  }
}
```

**Key design decisions:**
- **Both execution-mode and agent-fix sessions are tracked in the same file.** They're both "autonomous sessions" — the UI and recovery logic can be unified.
- **PID is stored** so on restart we can detect stale entries (PID no longer running = process died mid-work).
- **Atomic writes** via `writeFileSync(path + '.tmp', data)` then `renameSync(path + '.tmp', path)`. This prevents corruption from SIGKILL mid-write.
- **Updated on every phase transition**, not every turn. Minimizes disk I/O while keeping meaningful checkpoints.

### 3.4 Atomic Write Helper

```javascript
function atomicWriteJSON(filePath, data) {
  var tmp = filePath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (e) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

function safeReadJSON(filePath, defaultValue) {
  try {
    var raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    // File missing, corrupted, or unreadable
    return defaultValue;
  }
}
```

### 3.5 Resource Exhaustion Handling

The risk matrix identifies disk-full (F5) as a cascading failure. When `appendFileSync` throws `ENOSPC`:

1. The session JSONL may have a partial line → **validate on read** by wrapping each `JSON.parse(line)` in try/catch (already done in `loadSessions`)
2. The autonomous state file may be corrupted → **atomic writes** prevent this (rename is atomic on POSIX)
3. The extension's `appendEntry` may fail → **sidecar file is the primary**, appendEntry is backup

**Memory exhaustion (OOM):** Node.js gets SIGKILL with no warning. The only defense is:
- Pre-persisted state (autonomous state file, updated on phase transitions)
- Keep the relay process lean — the risk matrix notes 12GB box with multiple services
- PM2 `max_memory_restart` config to kill before the OOM killer does (at least PM2 sends SIGTERM first)

**File descriptor exhaustion:** Rare, but `openSync` would throw. Mitigated by not holding files open — use `readFileSync`/`writeFileSync` (open-use-close).

---

## 4. Layer 2: Pi-Relay Server Changes

### 4.1 Autonomous Session Manager (NEW module: `lib/autonomous.js`)

A server-side module that:
1. Reads/writes the autonomous state file
2. Detects interrupted sessions on startup (stale PIDs)
3. Provides a unified API for both execution-mode and agent-fix tracking
4. Manages the lifecycle: register → update → complete/fail → cleanup

```javascript
// lib/autonomous.js — API surface

module.exports = {
  // Lifecycle
  registerSession(projectSlug, sessionId, entry),   // start tracking
  updateSession(projectSlug, sessionId, updates),    // phase transition, status change
  completeSession(projectSlug, sessionId, outcome),  // resolved/failed/escalated
  removeSession(projectSlug, sessionId),             // cleanup

  // Queries
  getActive(projectSlug),                            // all active sessions for a project
  getHistory(projectSlug, limit),                    // recent completed sessions
  getAll(projectSlug),                               // everything

  // Recovery
  detectInterrupted(projectSlug),                    // find stale-PID entries
  markInterrupted(projectSlug, sessionId, reason),   // update status to 'interrupted'
};
```

**Startup flow in `daemon.js`:**

```
1. Load autonomous state for each project
2. For each active session:
   a. Check if PID matches current process → impossible (new PID), so it's stale
   b. Mark as "interrupted" with reason
   c. Queue notification for when first client connects
3. On first WebSocket client connect:
   a. Send toast/notification about interrupted sessions
   b. "Execution was interrupted at Phase 2/4. Type /exec resume to continue."
```

### 4.2 API Endpoint: `/p/{project}/api/autonomous-sessions`

**Replaces the FR's `/p/fleet-manager/api/agent-fix`** with a general-purpose endpoint that serves both execution-mode and agent-fix data:

```
GET /p/{project}/api/autonomous-sessions
```

```json
{
  "active": [
    {
      "sessionId": "abc123",
      "type": "execution-mode",
      "status": "active",
      "plan": { "currentPhase": 2, "totalPhases": 4, "phaseName": "Implement auth" },
      "startedAt": "2026-04-02T22:00:00Z",
      "elapsed": 4500000
    },
    {
      "sessionId": "xyz789",
      "type": "agent-fix",
      "status": "active",
      "service": "pi-relay",
      "machine": "vps5",
      "problemType": "crashed",
      "startedAt": "2026-04-02T23:10:00Z",
      "elapsed": 83000
    }
  ],
  "interrupted": [
    {
      "sessionId": "old456",
      "type": "execution-mode",
      "status": "interrupted",
      "reason": "process_death",
      "plan": { "currentPhase": 2, "totalPhases": 4 },
      "interruptedAt": "2026-04-02T21:00:00Z"
    }
  ],
  "recent": [
    {
      "sessionId": "done111",
      "type": "agent-fix",
      "status": "resolved",
      "service": "litellm",
      "machine": "vps5",
      "duration": 45000,
      "completedAt": "2026-04-02T20:30:00Z"
    }
  ]
}
```

**Agent Fix panel reads from this same endpoint** — it just filters for `type === "agent-fix"`. The panel doesn't need its own `/api/agent-fix` endpoint.

### 4.3 Fleet Process Monitor Integration

The `relay-bridge.ts` currently writes to `state/agent-fix-status.json` (Option B from the FR). Instead, it should register with pi-relay's autonomous session manager:

**Option 1 (simple, recommended for v1):** `relay-bridge.ts` continues to write `state/agent-fix-status.json`, and pi-relay's `/api/autonomous-sessions` handler reads BOTH the autonomous state file AND the fleet's status file, merging them.

**Option 2 (cleaner, v2):** `relay-bridge.ts` uses a REST call to pi-relay to register/update/complete the session:

```typescript
// relay-bridge.ts — on fix start:
await fetch(`http://localhost:${RELAY_PORT}/p/fleet-manager/api/autonomous-sessions`, {
  method: 'POST',
  body: JSON.stringify({
    sessionId: conn.sessionId,
    type: 'agent-fix',
    service: problem.service,
    machine: problem.machine,
    problemType: problem.type,
    tier: 2,
  }),
});
```

**Recommendation: Option 1 for now.** The fleet process monitor is a separate process and shouldn't have a hard dependency on pi-relay's internal API. File-based IPC is robust and the fleet already uses this pattern.

### 4.4 Push Notification Batching

The risk matrix identifies E1 (push spam from auto-continuation). The fix is simple:

```javascript
// pi-bridge.js — in agent_end handler:
case "agent_end":
  session.isProcessing = false;
  // ...existing result/done sending...

  // Suppress push for autonomous sessions — they'll push on plan completion
  if (!isAutonomousSession(session)) {
    if (pushModule) {
      pushModule.sendPush({ /* existing */ });
    }
  }
  break;
```

Autonomous sessions send a single push when the plan completes or fails, not on every agent turn.

### 4.5 Graceful Shutdown Updates

```javascript
// daemon.js — gracefulShutdown():
function gracefulShutdown() {
  // NEW: Mark all active autonomous sessions as "shutting_down"
  // so on restart we know it was graceful, not a crash
  for (var slug in relays) {
    var autonomous = relays[slug].autonomous;
    if (autonomous) {
      autonomous.markAllGracefulShutdown();
    }
  }

  // ...existing shutdown logic...
  relay.destroyAll();
}
```

This lets the restart handler distinguish between:
- **Graceful shutdown** → "Server was restarted. Autonomous work was paused."
- **Crash/OOM** → "Server crashed unexpectedly. Autonomous work was interrupted at Phase 2."

---

## 5. Layer 3: UI (Browser)

### 5.1 Unified "Autonomous Work" Panel (replaces "Agent Fix" as standalone)

The Agent Fix FR describes a sidebar panel. Instead of a single-purpose "Agent Fix" panel, build an **"Autonomous Work" panel** that shows ALL autonomous sessions:

```
┌─ Sidebar ─────────────────────────┐
│                                   │
│ Tools                             │
│ ▸ Resume CLI                      │
│ ▸ File browser                    │
│ ▸ Terminal                        │
│ ▸ Teams                           │
│ ▸ 🤖 Autonomous  ●               │  ← unified button
│                                   │
└───────────────────────────────────┘

┌─ Autonomous Work Panel ───────────┐
│ Autonomous Work        ↻    ✕     │
│───────────────────────────────────│
│ ▶ ACTIVE                          │
│ ┌───────────────────────────────┐ │
│ │ 📋 Execution: Auth Refactor   │ │
│ │ Phase 2/4 · Implement · 1h 15m│ │
│ │ Next auto-continue in 3s      │ │
│ │                               │ │
│ │ [Watch]   [Pause]   [Stop]    │ │
│ └───────────────────────────────┘ │
│ ┌───────────────────────────────┐ │
│ │ 🔧 Fix: pi-relay @ vps5       │ │
│ │ crashed · Tier 2 · 1m 23s     │ │
│ │                               │ │
│ │ [Watch]            [Stop]     │ │
│ └───────────────────────────────┘ │
│───────────────────────────────────│
│ ⚠ INTERRUPTED                     │
│ ┌───────────────────────────────┐ │
│ │ 📋 Data Migration Plan        │ │
│ │ Phase 3/5 · Server crashed    │ │
│ │ Interrupted 2h ago            │ │
│ │                               │ │
│ │ [Resume]         [Dismiss]    │ │
│ └───────────────────────────────┘ │
│───────────────────────────────────│
│ ✓ RECENT                          │
│                                   │
│ ✅ Fix: pi-relay @ vps5   2m ago  │
│    crashed · Tier 1 · 3s          │
│                                   │
│ ✅ Exec: DB Schema     30m ago    │
│    4/4 phases · 12m               │
│                                   │
│ ❌ Fix: litellm @ vps5   1h ago   │
│    crash_loop · Tier 2 · 4m 52s   │
│    > Memory leak in proxy pool... │
└───────────────────────────────────┘
```

**Key differences from the original Agent Fix FR:**
- Shows execution-mode plans alongside agent-fix sessions
- Has an "INTERRUPTED" section for crash recovery
- "Resume" button for interrupted execution plans
- Same "Watch Live" behavior (switches to the relay session)

### 5.2 Execution Mode Widget (in-session)

When viewing a session that has execution mode active, show an inline widget (via `ext_widget`):

```
┌─ Execution Mode ──────────────────────────────────┐
│ Phase 2/4: Implement Authentication               │
│ ████████░░░░░░░░ 50%  |  Elapsed: 1h 15m          │
│ Continuations: 3/10  |  Auto-continue in 3s       │
│                                                    │
│ ⏸ Pause   ⏹ Stop   ⏭ Skip Phase                  │
└────────────────────────────────────────────────────┘
```

**Limitation noted in risk matrix:** Pi-relay widgets are text-only, not interactive. The buttons above would be rendered as text; actual controls come from:
- `/exec pause` — slash command (works on mobile)
- `/exec stop` — slash command
- `/exec skip` — slash command  
- `Ctrl+Shift+E` — keyboard shortcut (desktop only)

The widget is informational; commands are the control plane.

### 5.3 Toast Notifications

Unified toast system for both types:

```
✅ Execution complete: Auth Refactor (4/4 phases, 45m)
❌ Execution failed at Phase 3: Auth Refactor — see session
🔧 Agent fixing pi-relay @ vps5...
✅ Agent fixed pi-relay @ vps5 (45s)
❌ Agent fix failed for pi-relay @ vps5 — escalated
⚠️ Execution interrupted: Data Migration — server restarted
```

### 5.4 Notification Badge

Same concept as the FR but for the unified panel:

```css
#autonomous-sidebar-btn.has-active::after {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  position: absolute;
  top: 4px;
  right: 4px;
}
/* Active work = pulsing blue */
#autonomous-sidebar-btn.has-active::after { background: var(--color-info); animation: pulse 2s infinite; }
/* Interrupted = solid warning orange */
#autonomous-sidebar-btn.has-interrupted::after { background: var(--color-warning); }
/* Failed = solid red */
#autonomous-sidebar-btn.has-failed::after { background: var(--color-error); }
```

---

## 6. Execution Mode Extension Design

The extension runs inside the pi SDK process (spawned by pi-bridge). It hooks into the agent lifecycle.

### 6.1 State Model

```
                    ┌──────────┐
                    │  IDLE    │
                    └────┬─────┘
                         │ /exec start or plan registered
                         ▼
                    ┌──────────┐
            ┌──────│ PLANNING │
            │      └────┬─────┘
            │           │ plan approved (register_plan tool)
            │           ▼
            │      ┌──────────┐
            │  ┌───│ RUNNING  │◄──────────────────────┐
            │  │   └────┬─────┘                        │
            │  │        │                              │
            │  │   ┌────┴─────────────┐                │
            │  │   │                  │                │
            │  │   ▼                  ▼                │
            │  │ ┌──────────┐  ┌───────────┐          │
            │  │ │ PAUSED   │  │ CONTINUING│──────────┘
            │  │ │(user req)│  │(agent_end,│  (auto-send "continue")
            │  │ └────┬─────┘  │ plan not  │
            │  │      │        │ done)     │
            │  │      │        └───────────┘
            │  │      │ /exec resume
            │  │      ▼
            │  │  back to RUNNING
            │  │
            │  │   ┌──────────────┐
            │  └───│ INTERRUPTED  │ (process death detected on restart)
            │      └────┬─────┘
            │           │ /exec resume OR auto-resume
            │           ▼
            │      back to RUNNING (with full plan re-injection)
            │
            │      ┌──────────┐
            └──────│ COMPLETED│
                   └──────────┘
```

### 6.2 Hooks Used

| Hook | Purpose | Runs when |
|------|---------|-----------|
| `session_start` | Read sidecar file, detect interrupted plans, re-inject state | Session created |
| `before_agent_start` | Inject system prompt: time, execution authority, plan state | Every agent turn |
| `agent_end` | Detect incomplete plan, auto-continue or mark complete | Agent finishes a turn |
| `turn_end` | Scan for phase completion markers, update state | Each LLM turn |
| `session_before_compact` | Inject plan state into compaction context | Before auto-compaction |
| `session_shutdown` | Write final state to sidecar, update autonomous state file | Graceful shutdown |

### 6.3 Auto-Continuation Logic (agent_end handler)

```
ON agent_end:
  1. Is execution mode active? No → return
  2. Is plan complete (all phases done)? 
     Yes → mark complete, send notification, exit execution mode
  3. Safety checks:
     a. Continuation count >= max? → STOP, notify "Max continuations reached"
     b. Last response < 50 tokens? → STOP, notify "Agent produced minimal output"
     c. Last response identical to previous? → STOP, notify "Agent is looping"
     d. hasPendingMessages()? → STOP, user wants to intervene
     e. Error detected in last turn AND error is ambiguous? → STOP, ask user
  4. All checks pass:
     a. Wait configurable delay (default 3s) with countdown in widget
     b. Re-check hasPendingMessages() (user may have typed during delay)
     c. Git checkpoint: commit current state before continuing
     d. Inject: "Continue to Phase {N}: {name}. Verify previous phase was correct."
     e. sendUserMessage(continuation prompt)
     f. Increment continuation counter
     g. Update sidecar file + autonomous state file
```

### 6.4 Crash Recovery (session_start handler)

```
ON session_start:
  1. Read sidecar file ({project}/.pi/execution-mode.json)
  2. If no sidecar → check appendEntry as fallback → if nothing, fresh session
  3. If sidecar exists AND status is "active" or "running":
     a. Check if stored PID matches current process → NO (it's a new process)
     b. This means the plan was interrupted by process death
     c. Read plan text, phase status, last checkpoint from sidecar
     d. Update sidecar: status = "interrupted", interruptedAt = now
     e. Update autonomous state file (relay-level)
     f. Show notification: "Execution was interrupted at Phase {N}/{total}"
     g. If auto-resume enabled in config:
        - Inject full plan context via before_agent_start
        - Send: "You were executing a plan that was interrupted by a system restart.
                 Here is the plan: {plan text}
                 Phases 1-{N-1} are complete. Resume from Phase {N}.
                 First, check git log and git diff to verify what was completed."
     h. If auto-resume disabled:
        - Show widget: "Plan interrupted at Phase {N}. Type /exec resume to continue."
```

### 6.5 System Prompt Injection (before_agent_start)

```
[EXECUTION MODE — ACTIVE]
Time: Thursday April 2, 2026 11:15 PM EDT
Deadline: Friday April 3, 2026 9:30 AM EDT (10h 15m remaining)
Urgency: MODERATE — maintain steady pace

You are executing a plan autonomously. You have full authority to proceed.
Do not ask for confirmation. Do not describe what you would do — do the work.
If you encounter an error, diagnose and fix it. If truly blocked, document the blocker and continue with the next phase.

PLAN STATUS:
Phase 1: Setup database schema ✅ DONE
Phase 2: Implement auth endpoints ◄ CURRENT (in progress)
Phase 3: Write integration tests — PENDING
Phase 4: Deploy to staging — PENDING

When you complete the current phase, end your response clearly.
The system will automatically continue to the next phase.
```

**Token budget:** ~150-200 tokens. Negligible in a 200K context window.

### 6.6 Tools Registered

| Tool | Purpose |
|------|---------|
| `register_plan` | Model calls this to register a structured plan with phases |
| `mark_phase_complete` | Model explicitly signals phase completion |
| `update_plan_status` | Model can add notes, mark blockers |

The model is instructed to use these tools. Fallback: the extension also scans `turn_end` messages for patterns like `[DONE:2]` or `## Phase 2 Complete`.

---

## 7. Unified Recovery Matrix

What happens when things go wrong — every scenario, one table:

| Scenario | Detection | Recovery | User Experience |
|----------|-----------|----------|-----------------|
| **OOM kill mid-execution** | Stale PID in sidecar file | Read sidecar on restart, mark interrupted | Toast: "Execution interrupted at Phase 2 — server ran out of memory" + interrupted entry in panel |
| **PM2 restart (graceful)** | `session_shutdown` fires, writes graceful marker | On restart, detect graceful shutdown | Toast: "Server restarted. Execution paused at Phase 2." |
| **Disk full during write** | `appendFileSync` throws ENOSPC | Autonomous state file uses atomic write (rename), so it's intact. Session JSONL may have partial line → skipped on parse | Minimal data loss — last turn may be lost |
| **Node crash (exception)** | crash.json written by handler | Same as OOM recovery + crash.json details shown | Toast: "Server crashed (reason). Execution interrupted at Phase 2." |
| **Agent fix mid-repair + crash** | Stale PID in autonomous state | Fleet monitor will re-detect the problem on next poll cycle, create new fix attempt | Toast: "Fix attempt for pi-relay was interrupted. Monitor will retry." |
| **LLM API hang (no response)** | No direct detection — no timeout in pi SDK | PM2 health check may kill → becomes PM2 restart case. Extension could implement a watchdog timer | Future: watchdog in extension that triggers abort after N minutes of no events |
| **Network partition (to LLM)** | API call throws/hangs | Same as API hang. The pi SDK should have request timeouts | Depends on SDK timeout behavior |
| **Two sessions executing in same project** | Lock file with PID check | Second session reads lock, sees active PID, refuses to enter execution mode | Error: "Execution mode is already active in another session" |
| **Compaction mid-execution** | `session_before_compact` hook | Extension injects plan state into compaction summary | Transparent — plan state survives compaction |
| **User closes browser tab** | No effect — relay session continues server-side | Agent keeps executing. User reconnects later, sees progress | Seamless — this is the whole point of pi-relay |
| **Agent goes off-plan** | Difficult to detect automatically | Git checkpoint before each phase allows revert. Phase validation prompt helps | If detected: `/exec stop` then `git reset --hard {checkpoint}` |
| **Infinite continuation loop** | Counter hits max (default 10) | Stop auto-continuing, notify user | Toast: "Execution paused — max continuations reached (10). Review progress." |
| **Stale plan (approved hours ago)** | Timestamp comparison | If plan > configurable threshold old AND no activity, prompt for re-confirmation | Widget: "This plan was approved 8h ago. Continue? [Yes] [Re-plan]" |

---

## 8. Implementation Files

### New Files

| File | Purpose | Priority |
|------|---------|----------|
| `lib/autonomous.js` | Autonomous session manager — state persistence, stale detection, API | P0 |
| `lib/public/modules/autonomous.js` | Browser panel — renders active/interrupted/recent | P1 |
| `lib/public/css/autonomous.css` | Panel styles | P1 |

### Modified Files

| File | Changes | Priority |
|------|---------|----------|
| `lib/sessions.js` | Persist `piSessionFile` and `piSessionId` in meta | P0 (4 lines) |
| `lib/pi-bridge.js` | Call `saveSessionFile` after setting piSessionFile; integrate with autonomous manager; suppress push for autonomous sessions | P0 |
| `lib/daemon.js` | On startup: detect interrupted autonomous sessions. On shutdown: mark all as gracefully stopped | P0 |
| `lib/project.js` | Add `/api/autonomous-sessions` HTTP handler | P1 |
| `lib/server.js` | Wire autonomous manager into relay lifecycle | P1 |
| `lib/public/index.html` | Add sidebar button + panel HTML | P1 |
| `lib/public/app.js` | Import and init autonomous module | P1 |
| `fleet-manager/src/process-monitor/relay-bridge.ts` | Write `state/agent-fix-status.json` (already planned in FR, no change) | P1 |

### Extension Files (separate repo/package)

| File | Purpose | Priority |
|------|---------|----------|
| `execution-mode/index.ts` | Main extension — all hooks, tools, state management | P0 |
| `execution-mode/sidecar.ts` | Sidecar file read/write with atomic operations | P0 |
| `execution-mode/prompts.ts` | System prompt templates (time, authority, plan state) | P0 |
| `execution-mode/safety.ts` | Loop detection, response length checks, cooldown | P0 |

---

## 9. Implementation Order

### Sprint 1: Foundation (P0) — Crash Resilience

**Goal:** No more orphaned sessions. State survives any kind of process death.

1. **Fix `sessions.js`** — persist `piSessionFile` in meta (4 lines)
2. **Fix `pi-bridge.js`** — call `saveSessionFile` after creating pi session (1 line)
3. **Build `lib/autonomous.js`** — atomic JSON state file, PID tracking, stale detection
4. **Update `daemon.js`** — detect interrupted sessions on startup, graceful shutdown marking
5. **Test:** Kill the process mid-session. Restart. Verify pi session is reconnected and interrupted state is detected.

### Sprint 2: Execution Mode Extension (P0) — Core Loop

**Goal:** Agent executes multi-phase plans autonomously with safety limits.

1. **Build extension** — `session_start`, `before_agent_start`, `agent_end`, `turn_end` hooks
2. **Sidecar file** — write plan state to `{project}/.pi/execution-mode.json`
3. **System prompt injection** — time, urgency, authority, plan state
4. **Auto-continuation** — with delay, safety checks, git checkpoints
5. **Slash commands** — `/exec start`, `/exec pause`, `/exec stop`, `/exec resume`, `/exec status`
6. **Integration with `autonomous.js`** — extension calls relay API to register/update/complete
7. **Test:** Run a multi-phase plan. Kill process mid-phase. Restart. Verify recovery.

### Sprint 3: UI Panel (P1) — Visibility

**Goal:** See all autonomous work at a glance, intervene when needed.

1. **Build `autonomous.js` browser module** — panel rendering, polling, session switching
2. **API endpoint** — `/api/autonomous-sessions` serving merged state
3. **Fleet integration** — read `state/agent-fix-status.json` into the unified view
4. **Toast notifications** — on completion, failure, interruption
5. **Sidebar badge** — active/interrupted/failed indicators
6. **Test:** Start execution mode + trigger fleet fix simultaneously. Verify both appear in panel.

### Sprint 4: Hardening (P2) — Edge Cases

1. **Proactive compaction** — monitor context usage, compact before overflow
2. **Custom compaction handler** — preserve plan state in summary
3. **Multi-session lock file** with stale PID detection
4. **Deadline escalation** — approaching → passed → damage control
5. **Push notification batching** — single push on plan completion, not per-turn

---

## 10. What This Design Does NOT Solve

These are acknowledged limitations that can't be fixed at the framework level:

| Limitation | Why | Mitigation Available |
|-----------|-----|---------------------|
| **Model going in the wrong direction** | No way to verify code correctness without running tests | Git checkpoints for rollback. Phase validation prompts. User can `/exec pause` and review |
| **Lost tool call history after crash** | New pi session = fresh context. Sidecar has plan text but not the 50 tool calls that built up the implementation | Re-inject plan text + "check git log and git diff". Model can re-derive state from git, but it's lossy |
| **Model quality** | Auto-continuation makes bad models fail faster | This is a feature — you find out sooner. Git checkpoints limit blast radius |
| **True temporal awareness** | Models architecturally cannot perceive time (UMD: 65% alignment at best) | Urgency language injection. 8x improvement (Penn) is best available |
| **Interactive stop button on mobile** | Pi-relay widgets are text-only | `/exec stop` command in chat. Future: add interactive widget support to pi-relay |
| **Transactional filesystem operations** | If process dies mid-`write` tool, file may be half-written | Git checkpoint before each phase is the only safety net |
| **Cross-session learning** | Corrections in one session don't transfer to the next | Extension re-injects execution mode directives every session. But the model itself resets to baseline RLHF behavior |

---

## 11. Key Design Decisions Summary

| Decision | Rationale |
|----------|-----------|
| **Unified autonomous session tracking** (not separate agent-fix and execution-mode) | Same problem, same recovery logic, same UI pattern. DRY. |
| **Relay-level state file** (`~/.claude-relay/autonomous-state/`) for cross-concern tracking | Lives with relay state, survives project dir issues, single source of truth for the UI |
| **Extension-level sidecar file** (`{project}/.pi/execution-mode.json`) for plan details | Lives with the project, accessible to the pi extension without relay dependency |
| **Atomic writes** (write-tmp-then-rename) for state files | Prevents corruption from SIGKILL mid-write |
| **PID-based stale detection** (not timestamps alone) | PIDs are definitive — if the PID is dead, the session was interrupted. Timestamps are ambiguous. |
| **Auto-continue with delay** (default 3s countdown) | Gives user a window to intervene. `hasPendingMessages()` check catches typed-but-not-sent messages |
| **Git checkpoint before each phase** (not each turn) | Per-turn would be noisy and slow. Per-phase gives meaningful rollback points |
| **Push suppression for autonomous sessions** | Prevents notification spam. Single push on plan completion |
| **Option B (file IPC) for fleet → relay communication** | Simple, robust, no coupling. Fleet writes a file, relay reads it. Works even if relay was restarted between write and read |
| **Extension registers tools** (`register_plan`, `mark_phase_complete`) instead of parsing freeform text | Reliable structured input > regex parsing. Model is instructed to use tools; freeform scanning is fallback |
