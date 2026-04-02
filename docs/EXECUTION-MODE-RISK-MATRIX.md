# Execution Mode Extension — Risk Matrix

## The Core Problem

LLMs stop working and ask "should I continue?" when you've already told them to execute a plan. This wastes hours, misses deadlines, and shifts the burden of project management back onto the human.

## Three Root Causes (Research-Backed)

| # | Root Cause | Evidence | Severity |
|---|-----------|----------|----------|
| 1 | **Temporal Blindness** — Models cannot perceive wall-clock time | Penn paper: 4% → 32% deal closure with time reminders (8x). UMD TicToc: best model only 65% aligned with human time perception even WITH timestamps | Architectural — cannot be fixed without model changes |
| 2 | **Trained Passivity** — RLHF rewards caution over action | DEV.to: "don't ask" prompts don't work, model finds other ways to ask. Claude Code #34238: agent suggests stopping 4+ times per session | Behavioral — can be overridden with system prompt |
| 3 | **No Persistent Execution State** — Each turn re-derives intent from scratch | Gemini CLI #22261: corrections work within session, reset across sessions. 336 sessions, same 3 failure patterns | Framework gap — solvable with extension state |

---

## Risk Matrix

### Category A: The "Stop and Ask" Behaviors (What We're Fixing)

| # | Behavior | Trigger | Extension Fix | Pi Hook | Confidence |
|---|----------|---------|---------------|---------|------------|
| A1 | Model completes phase 1, says "Should I continue to phase 2?" | Trained checkpoint-seeking after completing a logical unit of work | `agent_end`: detect incomplete plan, auto-send "Continue to phase N" via `pi.sendUserMessage()` | `agent_end` + `sendUserMessage` | **HIGH** — plan-mode extension already does this pattern successfully |
| A2 | Model says "I'll wait for your confirmation before proceeding" | RLHF caution — model perceives risk in autonomous action | `before_agent_start`: inject "You are in autonomous execution mode. You have full authority to proceed. The user will interrupt if needed." | `before_agent_start` → systemPrompt | **HIGH** — DEV.to article proved empowerment > prohibition |
| A3 | Model says "Let me know if you'd like me to continue" at end of response | Conversational politeness pattern from RLHF | `agent_end`: parse final assistant message for passive phrases, auto-continue if plan has remaining phases | `agent_end` + message parsing | **MEDIUM** — depends on reliable detection of the pattern vs genuine completion |
| A4 | Model says "Here's what I would do..." instead of doing it | Describing work instead of performing it — especially in early phases | `before_agent_start`: inject "Execute the plan. Do not describe what you would do. Do the work." | `before_agent_start` → systemPrompt | **MEDIUM** — behavioral, may recur under context pressure |
| A5 | Model completes all phases but asks "Is this what you wanted?" for validation | Seeking approval for completed work | `agent_end`: detect plan fully complete, show notification instead of auto-prompting | `agent_end` + plan state tracking | **HIGH** — extension knows plan is done, can notify user instead of prompting LLM |
| A6 | Model loses track of what phase it's on after compaction | Context summary doesn't preserve plan state | `session_before_compact`: inject plan state into compaction; `before_agent_start`: always re-inject current plan state | `session_before_compact` + `before_agent_start` | **HIGH** — plan state is persisted in extension, not dependent on LLM memory |
| A7 | Model stops after hitting an error and waits for instruction | Genuine ambiguity — error could mean "stop" or "try different approach" | `agent_end`: detect error in last turn, inject "You encountered an error. Diagnose and fix it. If blocked, document the blocker and continue with the next phase." | `agent_end` + `turn_end` error detection | **MEDIUM** — some errors genuinely need human input |

### Category B: Risks of Auto-Continuation (What Could Go Wrong)

| # | Risk | Scenario | Mitigation | Pi Hook | Residual Risk |
|---|------|----------|------------|---------|---------------|
| B1 | **Infinite loop** — Extension keeps sending "continue" forever | Model finishes plan but extension doesn't detect completion, or model keeps generating empty/minimal responses | **Max continuation count** per plan (e.g., 10). **Diminishing response detection** — if the model's response is <50 tokens or identical to previous, stop. **Cooldown timer** — require minimum time between auto-continuations | `agent_end` counter + response length check | **LOW** after mitigation — hard cap prevents infinite loop |
| B2 | **Runaway cost** — Auto-continuation burns through API budget | 10 auto-continuations × large context window = significant cost | **Per-plan cost cap** — track cumulative cost via `agent_end` event data. **Turn limit** — configurable max turns per execution plan. **Context usage monitoring** via `ctx.getContextUsage()` | `agent_end` cost tracking + `getContextUsage()` | **MEDIUM** — cost tracking is available but not precise in real-time. User must set budget |
| B3 | **Wrong direction** — Model goes off-plan and auto-continuation amplifies the error | Model misinterprets phase 2, makes bad changes, extension auto-continues to phase 3 building on bad foundation | **Phase validation** — after each auto-continuation, inject "Verify that phase N was completed correctly before proceeding." **Plan re-injection** — always re-inject the full plan with phase status so model can self-correct. **Git checkpoint** — auto-commit before each phase so user can revert | `turn_end` + `before_agent_start` + `pi.exec("git")` | **MEDIUM-HIGH** — this is the hardest risk. Model may not catch its own errors. Git checkpoints are the real safety net |
| B4 | **Context exhaustion** — Long multi-phase execution fills context window, triggers compaction mid-plan | 4-phase plan + 15 turns of tool calls per phase = context overflow | **Proactive compaction** — monitor context usage in `turn_end`, trigger `ctx.compact()` before hitting limit, with custom compaction that preserves plan state. **Plan state outside context** — plan lives in extension state (appendEntry), not dependent on LLM memory | `turn_end` + `getContextUsage()` + `compact()` + `appendEntry` | **LOW** — pi's compaction system handles this, and extension state survives compaction |
| B5 | **User wants to stop but can't** — Extension auto-continues before user can type | User sees model going wrong direction but auto-continuation fires instantly | **Delay before auto-continuation** — configurable pause (e.g., 3-5 seconds) with visible countdown in UI widget. **Interrupt detection** — check `ctx.hasPendingMessages()` before auto-continuing. **Keyboard shortcut** to toggle execution mode on/off (Ctrl+Shift+E) | `agent_end` + setTimeout + `hasPendingMessages()` + `registerShortcut` | **LOW** after mitigation — user always has Ctrl+C, and delay gives window to intervene |
| B6 | **Stale plan** — Plan was approved hours ago, codebase has changed since | User went to sleep, auto-execution continued, other processes changed files | **Staleness check** — before auto-continuing, check if plan was approved >N hours ago, or if there are uncommitted changes from outside the agent | `agent_end` + `pi.exec("git status")` + plan timestamp | **LOW** — this is an edge case. Plan timestamp check is simple |
| B7 | **Multiple sessions conflict** — Two pi-relay sessions auto-executing in same project | User has two sessions open, both in execution mode on same codebase | **Lock file** per project — write a `.pi/execution-mode.lock` when entering execution mode. Check on `session_start` | `session_start` + filesystem lock | **LOW** — uncommon scenario but easy to mitigate |
| B8 | **Compaction loses plan context** — Auto-compaction summarizes away the plan approval and phase details | Standard compaction doesn't know plan state is critical | **Custom compaction handler** — `session_before_compact` injects plan state into summary. Or: plan state is in `appendEntry` (persisted separately from LLM context) and always re-injected via `before_agent_start` | `session_before_compact` + `appendEntry` + `before_agent_start` | **LOW** — extension state via appendEntry is independent of compaction |

### Category C: Temporal Awareness Risks

| # | Risk | Scenario | Mitigation | Pi Hook | Residual Risk |
|---|------|----------|------------|---------|---------------|
| C1 | **Model ignores injected time** | System prompt says "It is 2 AM, deadline is 9:30 AM" but model doesn't factor it into behavior | **Urgency language over numbers** — Penn paper showed "(Deadline approaching — act with urgency)" outperforms "137 seconds left". Use escalating urgency language | `before_agent_start` → systemPrompt | **MEDIUM** — even with urgency cues, best alignment is ~65% (UMD paper). Can't force the model to care |
| C2 | **Wrong timezone** | Extension injects time in UTC but user's deadline is in EST | **User-configurable timezone** in extension settings. Default to system timezone | Extension config | **LOW** — simple config |
| C3 | **Deadline passed** | It's 10 AM, market opened at 9:30, plan was supposed to be done by then | **Post-deadline detection** — notify user the deadline has passed, switch from urgency to damage-control mode | `before_agent_start` + time comparison | **LOW** — easy to detect and handle |
| C4 | **Time injection bloats system prompt** | Adding time + plan state + execution mode adds 500+ tokens to every turn | **Concise injection format** — keep under 200 tokens. Use structured, minimal format | `before_agent_start` | **LOW** — 200 tokens is negligible in a 200K context window |

### Category D: State Management Risks

| # | Risk | Scenario | Mitigation | Pi Hook | Residual Risk |
|---|------|----------|------------|---------|---------------|
| D1 | **Plan parsing fails** — Extension can't extract structured plan from freeform LLM output | Model writes plan in unexpected format, can't detect phases | **Tool-based plan registration** — provide a `register_plan` tool the model calls with structured phases, rather than parsing freeform text. Fallback: regex/heuristic parsing of numbered lists | `registerTool` | **MEDIUM** — tool approach is reliable, but model must choose to use it. Could make it mandatory via system prompt instruction |
| D2 | **State corruption** — Extension state gets out of sync with actual plan progress | Model completes phase 2 but extension thinks it's still on phase 1 | **Model-driven state updates** — provide `mark_phase_complete` tool. Extension also scans `turn_end` messages for [DONE:N] markers (like plan-mode extension). Dual-signal: tool OR marker | `registerTool` + `turn_end` message scanning | **MEDIUM** — dual-signal reduces single point of failure |
| D3 | **Session resume loses state** — User closes browser, reopens, extension state is lost | Pi-relay creates new pi session on reconnect | **Persist via `appendEntry`** — all plan state saved to session file. `session_start` handler scans entries to reconstruct state | `appendEntry` + `session_start` | **HIGH** confidence in fix — this is exactly how plan-mode extension works |
| D4 | **Branch/fork loses state** — User uses `/tree` or `/fork`, extension state references wrong branch | Session navigation changes the entry history | **session_fork/session_tree** handlers — re-scan branch entries to reconstruct state for the new branch | `session_fork` + `session_tree` | **HIGH** confidence — pi's session system supports this |
| D5 | **Multiple plans active** — User approves plan A, then asks about something else, then wants to resume plan A | Extension confused about which plan is active | **Explicit plan lifecycle** — `/plan start`, `/plan pause`, `/plan resume` commands. Only one active plan at a time. Paused plans stored but don't trigger auto-continuation | `registerCommand` | **HIGH** confidence — command-based lifecycle is explicit |

### Category F: Process Death / System Restart (CRITICAL — Previously Missing)

The agent process can die mid-execution. This is fundamentally different from the model choosing to stop — there's no `agent_end` event, no graceful shutdown, no chance to persist state. Your pi-relay has restarted **32 times** under PM2.

#### How the process can die

| # | Cause | Frequency | Warning | Data Lost |
|---|-------|-----------|---------|-----------|
| F0 | **OOM killer** — Linux kills node process when system memory is exhausted | Moderate on 12GB box with multiple services | None — SIGKILL, no signal handler runs | All in-memory state. Pi SDK session file is safe (appendFileSync writes are atomic per-entry). Relay session JSONL is safe (also appendFileSync). But `pi-bridge.sessionState` is gone — the live piSession object, the event subscription, everything |
| F1 | **PM2 restart** — PM2 restarts due to uncaught exception, memory limit, or manual restart | Common (32 restarts observed) | SIGTERM sent, `gracefulShutdown()` runs, but extension `session_shutdown` may not fire because the pi SDK session is destroyed during `relay.destroyAll()` | Same as F0 but with a brief window for graceful cleanup |
| F2 | **System reboot** — Server reboots (kernel update, power loss, cloud provider maintenance) | Infrequent | SIGTERM for graceful, nothing for power loss | Same as F0 |
| F3 | **Node.js crash** — Unhandled promise rejection, segfault in native module (node-pty) | Occasional | Pi-relay catches uncaughtException and writes crash.json, then exits | Same as F0. Crash info is persisted for post-restart notification |
| F4 | **Network timeout** — API call to LLM provider hangs, no timeout configured | Rare but possible | Process doesn't die but becomes unresponsive. PM2 may kill it if health checks fail | No data loss if process stays alive. If PM2 kills it, same as F1 |
| F5 | **Disk full** — appendFileSync fails because filesystem is full | Rare | appendFileSync throws, which may cascade to uncaughtException → F3 | Partial entry may be written. Session file may be corrupted |

#### What's lost on process death

| Component | Persisted? | Recovery After Restart |
|-----------|-----------|----------------------|
| Relay session history (chat messages) | ✅ Yes — JSONL on disk | ✅ `loadSessions()` restores on startup |
| Pi SDK session file (conversation tree) | ✅ Yes — JSONL with `appendFileSync` | ❌ **NOT automatically linked** — pi-relay creates a NEW pi session after restart because `piSessionFile` is not in relay session meta |
| Extension `appendEntry` state (plan phases, execution mode) | ✅ Yes — inside pi SDK session file | ❌ **LOST** — new pi session = new session file = no old entries |
| `pi-bridge.sessionState` (live piSession, event subscription) | ❌ No — in-memory only | ❌ Gone. Recreated on next user message |
| Extension in-memory state (plan tracking, counters, timers) | ❌ No — in-memory only | ❌ Gone unless separately persisted |
| Mid-stream LLM response (tokens received but not yet committed as entry) | ❌ No | ❌ Lost. Last committed assistant message + tool results are safe |
| Execution mode on/off flag | ❌ No (only in extension memory) | ❌ Gone — execution mode silently deactivates |

#### The critical gap: `piSessionFile` is not persisted

```
BEFORE RESTART:
  relay session (JSONL) ──links to──> pi SDK session file (JSONL)
                                      └── has appendEntry state
                                      └── has conversation tree
                                      └── extension can read getEntries()

AFTER RESTART:
  relay session (JSONL) ──piSessionFile: null──> NEW pi SDK session (JSONL)
                                                  └── empty, no history
                                                  └── no appendEntry state
                                                  └── extension thinks it's a fresh session
  
  OLD pi SDK session file still exists on disk, but nothing points to it.
```

#### Risk matrix for process death scenarios

| # | Risk | Scenario | Mitigation | Implementation | Confidence |
|---|------|----------|------------|----------------|------------|
| F6 | **Execution mode silently dies** — Process restarts, extension re-initializes with no active plan, user thinks work is continuing | User goes to sleep, pi-relay OOMs at 3 AM, PM2 restarts it. User wakes up to find work stopped at phase 2 with no indication why | **Dual persistence**: (1) Write execution state to a **sidecar file** on the filesystem (e.g., `{project}/.pi/execution-mode.json`) independent of both relay and pi session. (2) On `session_start`, extension reads sidecar file to detect interrupted execution. (3) Push notification or UI notification on reconnect: "Execution was interrupted at phase 2/4 due to process restart" | Extension + filesystem write | **HIGH** — sidecar file is trivially simple and completely independent of session linkage |
| F7 | **Plan state lost** — Extension can't find appendEntry data because pi SDK session is new | After restart, extension `session_start` scans `getEntries()` — finds nothing because it's a brand new pi session | **Same sidecar file solution** as F6: plan state (phases, completion status, deadline, original plan text) lives in `{project}/.pi/execution-mode.json`, not in appendEntry. appendEntry is a BACKUP, sidecar is primary | Extension + filesystem | **HIGH** |
| F8 | **Auto-resume after restart creates confusion** — Extension detects interrupted plan and auto-sends continuation prompt, but context is gone | Sidecar says "phase 3 pending" so extension sends "Continue to phase 3." But the pi session is brand new — no conversation history, model has no idea what phase 3 is | **Re-inject full plan context on resume**: Sidecar file stores the complete plan text + all phase descriptions. On resume, extension injects the full plan as a `before_agent_start` message: "You were executing a plan that was interrupted. Here is the plan: [...]. Phases 1-2 are complete. Resume from phase 3." | Extension + `before_agent_start` | **MEDIUM** — The model will TRY to resume but won't have tool call history. It may re-do work or miss context. Git log can help ("check git log to see what was done") |
| F9 | **Half-written file from interrupted tool call** — Process died while `write` or `edit` tool was mid-execution | Model was writing a file, process killed between read and write. File may be partially written or truncated | **Git checkpoint before each phase** mitigates this. Extension can also run `git status` / `git diff` on resume to detect dirty state | `pi.exec("git")` on resume | **MEDIUM** — git checkpoint is the safety net, but only if it was committed before the tool call started |
| F10 | **Orphaned execution lock** — Extension wrote a lock file, process died before removing it | Lock file from B7 (multi-session protection) is stale after crash | **Stale lock detection**: Lock file includes PID + timestamp. On startup, check if PID is alive. If not, or if timestamp > 30min old, consider it stale and remove | Filesystem + `process.kill(pid, 0)` check | **HIGH** |
| F11 | **pi-relay loses link to pi session on restart** — This is a pi-relay bug, not just an extension concern | Even without the execution mode extension, restarting pi-relay creates orphaned pi sessions. Users lose conversation context | **Fix pi-relay**: persist `piSessionFile` in relay session meta. On `saveSessionFile`, include `piSessionFile` in the meta object. On `loadSessions`, restore it. On `createPiSession`, if `piSessionFile` exists, use `SessionManager.open()` | **pi-bridge.js + sessions.js modification** | **HIGH** — This is a ~10 line fix to pi-relay itself and benefits all users, not just the execution mode extension |

#### Recommended architecture for crash resilience

```
PRIMARY STATE (survives everything):
  {project}/.pi/execution-mode.json
  ├── active: true/false
  ├── planId: "uuid"
  ├── planText: "Full plan text..."
  ├── phases: [{name, status, completedAt}, ...]
  ├── currentPhase: 2
  ├── deadline: "2026-04-03T13:30:00Z"
  ├── startedAt: "2026-04-02T22:00:00Z"
  ├── lastCheckpoint: "git-commit-hash"
  ├── pid: 12345
  ├── sessionId: "relay-session-id"
  └── updatedAt: "2026-04-02T23:15:00Z"

SECONDARY STATE (backup, also in pi session):
  pi SDK session file (via appendEntry)
  └── Same data, for when pi session IS linked

ON SESSION_START:
  1. Read sidecar file
  2. If active plan exists AND pid != current process:
     → Plan was interrupted by process death
     → Notify user
     → If auto-resume enabled: re-inject plan, send continuation
  3. If active plan exists AND pid == current process:
     → Normal operation, plan is running
  4. If no sidecar file:
     → Check appendEntry as fallback
     → Normal fresh session

ON PROCESS SHUTDOWN (graceful):
  1. session_shutdown fires
  2. Write sidecar with active: false + reason: "graceful"
  3. Clean up

ON PROCESS DEATH (ungraceful):
  1. Nothing runs
  2. Sidecar file still has active: true + stale pid
  3. Next startup detects this state
```

### Category E: Edge Cases Specific to Pi-Relay (Web UI)

| # | Risk | Scenario | Mitigation | Pi Hook | Residual Risk |
|---|------|----------|------------|---------|---------------|
| E1 | **Push notification spam** — Every auto-continuation triggers a "done" push notification | Pi-relay sends push on `agent_end`, auto-continue triggers another `agent_end`, etc. | **Suppress push during execution mode** — modify pi-bridge to check execution state, or extension sends a suppression signal | Would require pi-bridge modification OR extension UI widget to signal state | **MEDIUM** — may need pi-bridge change, not just extension |
| E2 | **Web UI shows "done" then immediately starts again** — Confusing UX | User sees response, "done" indicator, then immediately starts processing again | **UI widget** showing execution progress — "Phase 2/4 — auto-continuing in 3s..." via `ctx.ui.setWidget()` or `ctx.ui.setStatus()`. The pi-relay extension UI bridge supports widgets and status | `setWidget` + `setStatus` | **LOW** — relay already supports extension UI forwarding |
| E3 | **Mobile user can't interrupt** — No keyboard shortcut on phone | User on phone via pi-relay PWA, model going wrong direction, no Ctrl+C | **Emergency stop button** in web UI widget. Extension registers a command `/stop-exec` that pauses execution mode. Widget shows a clickable stop button | `registerCommand` + `setWidget` with interactive elements... BUT pi-relay's widget is text-only (not interactive buttons) | **MEDIUM** — pi-relay widgets are display-only. Would need `/stop-exec` command typed into chat, or a pi-relay UI modification to add a stop button |
| E4 | **Extension not loaded** — User starts pi session without the extension installed | Extension provides no benefit if not loaded | **Default fail-safe** — without extension, behavior is exactly as today (no regression). Extension is purely additive | N/A | **NONE** — absence of extension changes nothing |
| E5 | **Extension conflicts with other extensions** — Other extensions also hook agent_end | Multiple agent_end handlers fire, ordering issues | **Event ordering** — pi runs extension handlers in load order. Extension should check if another handler already sent a follow-up message via `ctx.hasPendingMessages()` before auto-continuing | `hasPendingMessages()` check in `agent_end` | **LOW** — simple guard |

---

## Capability Assessment: What the Extension CAN and CANNOT Fix

### ✅ CAN Fix (via pi extension hooks + filesystem)

| Capability | How |
|-----------|-----|
| Inject time awareness every turn | `before_agent_start` → modify systemPrompt with current time + deadline |
| Inject execution mode directive | `before_agent_start` → inject message with authority + plan context |
| Track plan phases across turns | Sidecar JSON file (primary) + `appendEntry` (backup) + `turn_end` for progress detection |
| Auto-continue when plan is incomplete | `agent_end` → `sendUserMessage("Continue to phase N")` |
| Survive compaction | `session_before_compact` to inject state + sidecar file is outside LLM context entirely |
| Survive session resume | `session_start` → read sidecar file + fallback to `getEntries()` |
| Survive branch/fork | `session_fork`/`session_tree` → re-read sidecar file |
| **Survive process death / restart** | **Sidecar file persists on filesystem. On `session_start`, detect stale PID = interrupted execution. Re-inject full plan context + notify user** |
| **Survive pi-relay restart (with pi-bridge fix)** | **Persist `piSessionFile` in relay session meta → pi session linkage survives restart → appendEntry state accessible** |
| Provide stop mechanism | `registerShortcut` + `registerCommand("/stop-exec")` |
| Show progress in UI | `setWidget` + `setStatus` (works in both TUI and pi-relay) |
| Prevent infinite loops | Counter + response-length check + max turns per plan |
| Git checkpoint before phases | `pi.exec("git add -A && git commit -m 'checkpoint: before phase N'")` |
| Proactive compaction | `getContextUsage()` monitoring + `ctx.compact()` trigger |
| **Detect interrupted execution on startup** | **Read sidecar file → PID check → if stale, show "Execution interrupted at phase N. Resume?" or auto-resume if configured** |

### ⚠️ PARTIALLY Fixes (limited by model behavior)

| Limitation | Why | Best Effort |
|-----------|-----|-------------|
| Model going in wrong direction | Model may not self-correct even with plan re-injection | Git checkpoints allow revert. Phase validation prompt helps but isn't guaranteed |
| Model ignoring urgency cues | Even best models only 65% aligned with human time perception (UMD paper) | Urgency language > numbers. Still better than nothing (8x improvement per Penn paper) |
| Model hallucinating plan completion | Model says "done" but didn't actually do the work (Gemini #22261: 40% of sessions) | Verification steps in plan. Extension can't independently verify code correctness — would need test execution |
| Model producing minimal/empty responses | Under context pressure, model may output near-nothing to "complete" a turn | Response length check catches this, but underlying cause (context pressure) needs compaction |

### ❌ CANNOT Fix (architectural/model limitations)

| Limitation | Why | Workaround |
|-----------|-----|------------|
| True temporal awareness | Models fundamentally can't perceive wall-clock time. Extension can inject it but can't make the model "understand" time | Best available: urgency language injection. Architectural fix requires model changes |
| RLHF-trained passivity in novel situations | When model encounters a truly new situation not covered by plan, it will default to asking | Decision framework in system prompt covers common cases. Novel situations still need human input |
| Cross-session behavioral regression | Corrections within a session don't survive to new sessions (Gemini #22261 finding) | Extension state survives via sidecar file + appendEntry. System prompt is re-injected every session. But the model itself resets to baseline |
| Model quality/capability | If the model can't actually do the work, auto-continuation just produces more bad output faster | This extension is about execution management, not improving model capability |
| **Lost context after process death** | When process dies mid-execution, the new pi session has no conversation history — model doesn't know what tools it ran, what files it changed | Sidecar file re-injects the PLAN, but not the detailed tool call history. `git log` and `git diff` are the recovery mechanism: "Check git log to see what was completed" |
| **Partial tool execution** | If process dies while a `write` or `bash` tool is executing, the operation may be half-done | Git checkpoint before each phase is the only safety net. There's no transactional rollback for filesystem operations |
| Real-time interruption from mobile | Pi-relay widgets are display-only, can't have interactive "STOP" buttons | User must type `/stop-exec` in chat or rely on pi-relay's abort button if one exists |

---

## Priority Implementation Order

Based on risk/impact analysis (cost is not a constraint per user):

| Priority | Component | Addresses | Complexity |
|----------|-----------|-----------|------------|
| **P0** | **Fix pi-relay: persist piSessionFile in relay session meta** | F11 (foundational) | **Low** — ~10 lines in sessions.js + pi-bridge.js. Benefits everything downstream |
| **P0** | **Sidecar file for crash-resilient execution state** | F6, F7, F8, F10 | **Low** — filesystem read/write of JSON. Independent of session linkage |
| **P0** | System prompt injection (time + execution mode + plan state) | A1, A2, A3, A4, C1 | Low — `before_agent_start` only |
| **P0** | Auto-continuation on `agent_end` with incomplete plan | A1, A3 | Low — `agent_end` + `sendUserMessage` |
| **P0** | Safety limits (max continuations, response length check, delay) | B1, B5 | Low — counters and timers |
| **P1** | Plan registration tool + phase tracking | D1, D2, A6 | Medium — `registerTool` + state management |
| **P1** | Crash recovery: detect interrupted execution + re-inject plan context | F8 | Medium — sidecar file + `before_agent_start` plan re-injection |
| **P1** | UI progress widget + status indicator | E2, B5 | Low — `setWidget` + `setStatus` |
| **P1** | Stop command + keyboard shortcut | B5, E3 | Low — `registerCommand` + `registerShortcut` |
| **P1** | Git checkpoint before auto-continuation | B3, F9 | Low — `pi.exec("git")` |
| **P2** | Proactive compaction monitoring | B4 | Medium — `getContextUsage()` + `compact()` |
| **P2** | Custom compaction preserving plan state | B8, A6 | Medium — `session_before_compact` |
| **P2** | Push notification suppression during execution | E1 | Requires pi-bridge modification |
| **P2** | Multi-session lock file with stale detection | B7, F10 | Low — filesystem + PID check |
| **P3** | Deadline escalation (approaching → passed) | C3 | Low — time comparison |

---

## Decision: Should We Build This?

**Yes, with a phased approach. Two deliverables:**

### Deliverable 1: Pi-relay fix (~10 lines)

Persist `piSessionFile` in relay session meta. This is a foundational bug fix that benefits everyone — without it, every pi-relay restart orphans the pi SDK session and loses all extension state, conversation context, and tree history.

### Deliverable 2: Execution Mode Extension

The P0 items — sidecar file + system prompt injection + auto-continuation + safety limits — would solve the SPXer problem AND survive process death. Those are:
- ~400 lines of TypeScript (up from 200 because of crash resilience)
- Sidecar file on filesystem for crash-resilient state (independent of session linkage)
- Well-established pi extension patterns (plan-mode extension proves the approach)
- Zero risk of regression (extension is additive, Ctrl+C always works)
- Zero risk to pi-relay (extension runs inside pi SDK, relay just forwards events)

The research is clear: injecting time + urgency + execution authority into the system prompt gives 6-8x improvement (Penn paper), and empowerment-based prompting eliminates the "ask permission" pattern (DEV.to). These are not speculative — they're empirically validated.

The process death scenarios (Category F) are addressed by the sidecar file architecture — execution state lives on the filesystem, not in any session's memory. When the process restarts, the extension reads the sidecar, detects the stale PID, and either notifies the user or auto-resumes.

The remaining hard risks:
- **B3 (wrong direction amplified)** — Git checkpoints are the only real safety net
- **F8 (lost context after crash)** — Model can re-derive state from git log + plan text, but won't have detailed tool history
- **Partial tool execution (F9)** — No transactional filesystem operations exist; git is the rollback mechanism
