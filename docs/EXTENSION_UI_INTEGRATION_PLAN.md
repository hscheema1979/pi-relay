# Extension UI Integration Plan for pi-relay

## Problem Statement

pi-relay creates `AgentSession` via pi's SDK but never provides an `ExtensionUIContext`.
Extensions get a `noOpUIContext` where all UI methods are silent no-ops. This means:
- `ctx.ui.notify()` → silently dropped
- `ctx.ui.setStatus()` → silently dropped
- `ctx.ui.setWidget()` → silently dropped
- `ctx.ui.select()` → returns `undefined` (dialog cancelled)
- `ctx.ui.confirm()` → returns `false`
- `ctx.ui.input()` → returns `undefined`
- `ctx.ui.custom()` → returns `undefined`

Extensions like pi-agent-teams, pi-context, pi-boomerang, pi-processes, and pi-rewind
are functionally running but their UI feedback is invisible to the user.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Browser (pi-relay web UI)                              │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Chat Panel   │  │ Status Bar   │  │ Extension     │  │
│  │ (existing)   │  │ (new)        │  │ Panels (new)  │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                │                   │          │
│         └────────────────┼───────────────────┘          │
│                          │ WebSocket                    │
├──────────────────────────┼──────────────────────────────┤
│  pi-relay server         │                              │
│  ┌───────────────────────┼─────────────────────────┐    │
│  │ pi-bridge.js          │                         │    │
│  │  ┌────────────────────┼───────────────────┐     │    │
│  │  │ Custom UIContext    │                   │     │    │
│  │  │ (relayUIContext)    │                   │     │    │
│  │  │  notify() ─────────┼→ WS {type:"ext_notify"} │   │
│  │  │  setStatus() ──────┼→ WS {type:"ext_status"}│    │
│  │  │  setWidget() ──────┼→ WS {type:"ext_widget"}│    │
│  │  │  select() ─────────┼→ WS {type:"ext_select"}│    │
│  │  │  confirm() ────────┼→ WS {type:"ext_confirm"}│   │
│  │  └────────────────────┼───────────────────┘     │    │
│  │                       │                         │    │
│  │  AgentSession ←── bindExtensions({ uiContext }) │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

## Implementation Phases

---

### Phase 1: Wire Up the UIContext (Server-Side)

**Goal**: Extensions can talk to the browser. Biggest bang for the buck.

**File: `lib/pi-bridge.js`**

Create a `relayUIContext` object that implements `ExtensionUIContext` and passes
messages through the existing WebSocket `send()` function. Pass it via
`session.bindExtensions({ uiContext: relayUIContext })` after creating each
`AgentSession`.

```js
function createRelayUIContext(send, pendingDialogs) {
  return {
    // --- Fire-and-forget (just forward to browser) ---
    notify: function (message, type) {
      send({ type: "ext_notify", message: message, notifyType: type || "info" });
    },
    setStatus: function (key, text) {
      send({ type: "ext_status", key: key, text: text });
    },
    setWidget: function (key, content, options) {
      // Only string arrays are supported (component factories are TUI-only)
      if (Array.isArray(content)) {
        send({
          type: "ext_widget",
          key: key,
          lines: content,
          placement: (options && options.placement) || "aboveEditor"
        });
      } else if (content === undefined) {
        send({ type: "ext_widget", key: key, lines: null });
      }
    },
    setTitle: function (title) {
      send({ type: "ext_title", title: title });
    },
    setEditorText: function (text) {
      send({ type: "ext_editor_text", text: text });
    },

    // --- Dialog methods (need round-trip to browser) ---
    select: function (title, options, opts) {
      return new Promise(function (resolve) {
        var id = crypto.randomUUID();
        var timer = null;
        pendingDialogs.set(id, { resolve: resolve, timer: timer });
        if (opts && opts.timeout) {
          timer = setTimeout(function () {
            pendingDialogs.delete(id);
            resolve(undefined);
          }, opts.timeout);
          pendingDialogs.get(id).timer = timer;
        }
        send({ type: "ext_select", id: id, title: title, options: options });
      });
    },
    confirm: function (title, message, opts) {
      return new Promise(function (resolve) {
        var id = crypto.randomUUID();
        var timer = null;
        pendingDialogs.set(id, { resolve: resolve, timer: timer });
        if (opts && opts.timeout) {
          timer = setTimeout(function () {
            pendingDialogs.delete(id);
            resolve(false);
          }, opts.timeout);
          pendingDialogs.get(id).timer = timer;
        }
        send({ type: "ext_confirm", id: id, title: title, message: message });
      });
    },
    input: function (title, placeholder, opts) {
      return new Promise(function (resolve) {
        var id = crypto.randomUUID();
        var timer = null;
        pendingDialogs.set(id, { resolve: resolve, timer: timer });
        if (opts && opts.timeout) {
          timer = setTimeout(function () {
            pendingDialogs.delete(id);
            resolve(undefined);
          }, opts.timeout);
          pendingDialogs.get(id).timer = timer;
        }
        send({ type: "ext_input", id: id, title: title, placeholder: placeholder || "" });
      });
    },
    editor: function (title, prefill) {
      return new Promise(function (resolve) {
        var id = crypto.randomUUID();
        pendingDialogs.set(id, { resolve: resolve, timer: null });
        send({ type: "ext_editor", id: id, title: title, prefill: prefill || "" });
      });
    },

    // --- No-ops (TUI-only, can't translate to web) ---
    onTerminalInput: function () { return function () {}; },
    setWorkingMessage: function () {},
    setFooter: function () {},
    setHeader: function () {},
    custom: async function () { return undefined; },
    pasteToEditor: function () {},
    getEditorText: function () { return ""; },
    setEditorComponent: function () {},
    get theme() { return undefined; },
    getAllThemes: function () { return []; },
    getTheme: function () { return undefined; },
    setTheme: function () { return { success: false, error: "Not in TUI mode" }; },
    getToolsExpanded: function () { return false; },
    setToolsExpanded: function () {},
  };
}
```

Then in `createPiSession()`, after creating the session:

```js
var pendingDialogs = new Map();
var uiCtx = createRelayUIContext(send, pendingDialogs);

// Store on session state for dialog response routing
state.pendingDialogs = pendingDialogs;

// Bind the UI context so extensions get real UI
await state.piSession.bindExtensions({ uiContext: uiCtx });
```

And add a WS message handler for dialog responses:

```js
if (msg.type === "ext_dialog_response") {
  var pending = state.pendingDialogs.get(msg.id);
  if (pending) {
    clearTimeout(pending.timer);
    state.pendingDialogs.delete(msg.id);
    pending.resolve(msg.value);
  }
  return;
}
```

**Effort**: ~100 lines server-side. No browser changes yet needed for fire-and-forget
messages — they'll just be new WS message types the browser ignores until Phase 2.

---

### Phase 2: Browser — Notifications & Status Bar

**Goal**: See `notify()` toasts and `setStatus()` entries in the web UI.

**2a. Notification Toasts**

Handle `ext_notify` messages in `app.js`. Render as toast notifications
(similar to the existing `info` message type but styled by `notifyType`).

```js
// In WS message handler:
case "ext_notify":
  showNotification(msg.message, msg.notifyType); // info/warning/error styling
  break;
```

Simple CSS toast that auto-dismisses after 5s. Warning/error stay longer.

**2b. Extension Status Bar**

Handle `ext_status` messages. Maintain a `Map<key, text>` of status entries.
Render as a thin bar above or below the chat input, showing all active statuses.

```js
case "ext_status":
  if (msg.text) extensionStatuses.set(msg.key, msg.text);
  else extensionStatuses.delete(msg.key);
  renderStatusBar();
  break;
```

**Impact**: pi-agent-teams worker status, pi-context token usage, pi-processes
running process count, pi-boomerang chain progress — all become visible.

**Effort**: ~80 lines JS + ~40 lines CSS.

---

### Phase 3: Browser — Widget Panel

**Goal**: See `setWidget()` content — this is where pi-agent-teams shows its worker
task list, pi-context shows its token dashboard, etc.

Handle `ext_widget` messages. Render as collapsible panels above the chat.
Each widget key gets its own panel.

```js
case "ext_widget":
  if (msg.lines) {
    extensionWidgets.set(msg.key, { lines: msg.lines, placement: msg.placement });
  } else {
    extensionWidgets.delete(msg.key);
  }
  renderWidgets();
  break;
```

Render as monospace text blocks (widgets are string arrays, often using
Unicode box drawing for layout). Support ANSI-to-HTML for color.

**Effort**: ~120 lines JS + ~60 lines CSS.

---

### Phase 4: Browser — Dialog Modals

**Goal**: Extensions can ask the user questions. Permission gates, confirmation
dialogs, input prompts.

For each dialog type, show a modal overlay:

| Message | Modal UI |
|---------|----------|
| `ext_select` | Radio buttons + OK/Cancel |
| `ext_confirm` | Message + Yes/No buttons |
| `ext_input` | Text input + OK/Cancel |
| `ext_editor` | Textarea + OK/Cancel |

On user action, send back:
```js
ws.send(JSON.stringify({
  type: "ext_dialog_response",
  id: msg.id,
  value: selectedValue  // or { confirmed: true/false } for confirm
}));
```

**Impact**: pi-governance approval gates, pi-guardrails confirmation, pi-rewind
checkpoint selection — all become interactive.

**Effort**: ~200 lines JS + ~80 lines CSS.

---

### Phase 5: Extension Slash Commands

**Goal**: `/team status`, `/boomerang`, `/acm`, `/ps` — relay already discovers
extension commands and sends them as `slash_commands`. But when user types them,
they go through `prompt()` which treats them as user messages, not extension commands.

The fix: in `pi-bridge.js`, before calling `startQuery()`, check if the text starts
with `/` and matches a registered extension command. If so, route it through the
extension runner's command handler instead of `session.prompt()`.

```js
// In startQuery():
if (text.startsWith("/")) {
  var cmdName = text.split(" ")[0].substring(1);
  var runner = state.piSession.extensionRunner;
  if (runner) {
    var cmd = runner.findCommand(cmdName);
    if (cmd) {
      await runner.executeCommand(cmd, text.substring(cmdName.length + 2).trim());
      return;
    }
  }
}
// Otherwise, fall through to session.prompt()
```

Note: This needs care — extension commands receive `ExtensionCommandContext` which
has `waitForIdle()`, `newSession()`, `fork()`, `navigateTree()`. Some of these
need additional plumbing. Start by supporting simple commands that just do
`ctx.ui.notify()` and tool calls.

**Effort**: ~60 lines, but requires understanding the ExtensionRunner internals.

---

### Phase 6: Teams/Worker Visibility Panel (Optional)

**Goal**: Dedicated panel for multi-agent orchestration.

pi-agent-teams uses file-based task stores and mailboxes. Independent of the
extension UI, add an API endpoint that reads these files directly:

**Server**: `GET /api/teams-status` → reads task store + mailbox files
**Browser**: Polling panel showing workers, tasks, messages

This is independent of Phase 1-5 and can be built in parallel.
The file locations follow a convention:
- Tasks: `~/.pi/agent/teams/<task-list-id>/tasks/*.json`
- Mailbox: `~/.pi/agent/teams/<task-list-id>/mailbox/*.json`

**Effort**: ~200 lines server + ~300 lines browser.

---

## Priority Order

| Phase | Impact | Effort | Dependencies |
|-------|--------|--------|--------------|
| 1 | ★★★★★ | Small (~100 LOC) | None |
| 2 | ★★★★ | Small (~120 LOC) | Phase 1 |
| 3 | ★★★★ | Medium (~180 LOC) | Phase 1 |
| 4 | ★★★ | Medium (~280 LOC) | Phase 1 |
| 5 | ★★★ | Medium (~60 LOC) | Phase 1, understanding ExtensionRunner |
| 6 | ★★ | Large (~500 LOC) | Independent |

**Recommended**: Do Phases 1→2→3 first. This unlocks 80% of the value with
~400 lines of code. Notifications, status bars, and widgets make almost every
installed extension visible and useful.

## Packages Unlocked Per Phase

| Phase | Package | What Becomes Visible |
|-------|---------|---------------------|
| 1+2 | pi-agent-teams | Worker status notifications, task completion alerts |
| 1+2 | pi-boomerang | Chain progress, context collapse summaries |
| 1+2 | pi-context | Context management notifications |
| 1+2 | pi-web-access | Search progress notifications |
| 1+2 | pi-processes | Process started/stopped notifications |
| 1+3 | pi-agent-teams | Worker task list widget, live status dashboard |
| 1+3 | pi-context | Token usage widget |
| 1+4 | pi-governance | Approval dialogs for dangerous commands |
| 1+4 | pi-guardrails | Confirmation for destructive operations |
| 1+4 | pi-rewind | Checkpoint selection for rewind |
| 5 | All | Slash commands work: /team, /boomerang, /acm, /ps |

## Key Technical Notes

1. **`bindExtensions()` is the entry point** — `AgentSession` has a `bindExtensions()`
   method that accepts `{ uiContext }`. This is how interactive and RPC modes inject
   their UI implementations. pi-relay just needs to call it.

2. **`hasUI` becomes `true`** — once you provide a uiContext that isn't `noOpUIContext`,
   `runner.hasUI()` returns true, which changes extension behavior (some extensions
   gate features behind `ctx.hasUI`).

3. **Dialog methods are async** — `select()`, `confirm()`, `input()` return Promises
   that block the extension until the user responds. The WebSocket round-trip handles
   this naturally with pending promise maps.

4. **Widget content is strings only** — in non-TUI mode, `setWidget()` only receives
   string arrays, not component factories. This is fine for web rendering.

5. **The subagent tool spawns `pi --mode json`** — completely independent of UI.
   Works already. The teams tool spawns `pi --mode rpc` — also independent.
   Both just need visibility, not functionality fixes.
