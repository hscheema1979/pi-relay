/**
 * hooks-panel.js — Hooks panel for pre/post tool-use event handlers.
 * Register hooks that fire commands on specific events with glob matching.
 */

import { createPanel, registerFleetPanel, esc, timeAgo, statusDot } from './panel-base.js';
import { refreshIcons } from './icons.js';

var wsRef = null;

var EVENTS = [
  { value: "PreToolUse", label: "Pre Tool Use" },
  { value: "PostToolUse", label: "Post Tool Use" },
  { value: "Stop", label: "Stop" },
  { value: "ProcessCrash", label: "Process Crash" },
  { value: "ProcessRestart", label: "Process Restart" },
  { value: "HealthCheckFailed", label: "Health Check Failed" },
  { value: "FixAttempted", label: "Fix Attempted" },
  { value: "FixResolved", label: "Fix Resolved" },
];

var PRESETS = [
  { label: "Auto-format on save", event: "PostToolUse", match: "Write,Edit", command: "prettier --write $FILE", desc: "Run prettier after file edits" },
  { label: "Lint after edit", event: "PostToolUse", match: "Edit,Write", command: "eslint --fix $FILE", desc: "ESLint fix after edits" },
  { label: "Notify on crash", event: "ProcessCrash", match: "*", command: "echo 'CRASH: $SERVICE on $MACHINE' | notify", desc: "Send notification on process crash" },
];

var panel = createPanel({
  id: "hooks",
  fetchUrl: "api/orchestrator/hooks",
  renderFn: renderHooks,
  badgeFn: function (data) {
    if (!data || !Array.isArray(data)) return null;
    var enabled = 0;
    for (var i = 0; i < data.length; i++) {
      if (data[i].enabled !== false) enabled++;
    }
    return enabled > 0 ? { count: enabled, state: "active" } : null;
  },
  fgInterval: 10000,
  bgInterval: 60000,
});

export function initHooks(opts) {
  wsRef = opts;
  panel.init(opts);
  registerFleetPanel("hooks", panel);
}

export function toggleHooksPanel() {
  panel.toggle();
}

export function handleHookMessage(msg) {
  panel.handleUpdate();
}

function sendWs(msg) {
  if (wsRef && wsRef.ws && typeof wsRef.ws === "object" && wsRef.ws.readyState === 1) {
    wsRef.ws.send(JSON.stringify(msg));
  }
}

function renderHooks(data, bodyEl) {
  if (!data || !Array.isArray(data) || data.length === 0) {
    bodyEl.innerHTML =
      '<div class="fleet-empty">No hooks registered' +
      '<div class="fleet-empty-hint">Hooks run commands when specific events occur.</div>' +
      '</div>' +
      renderCreateForm() +
      renderPresets();
    bindActions(bodyEl);
    return;
  }

  var enabled = [], disabled = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i].enabled !== false) enabled.push(data[i]);
    else disabled.push(data[i]);
  }

  var html = renderCreateForm();
  html += renderPresets();

  if (enabled.length > 0) {
    html += '<div class="fleet-section-header">' + statusDot("running") + ' Active (' + enabled.length + ')</div>';
    for (var e = 0; e < enabled.length; e++) html += renderHookCard(enabled[e]);
  }

  if (disabled.length > 0) {
    html += '<div class="fleet-section-header">' + statusDot("paused") + ' Disabled (' + disabled.length + ')</div>';
    for (var d = 0; d < disabled.length; d++) html += renderHookCard(disabled[d]);
  }

  bodyEl.innerHTML = html;
  bindActions(bodyEl);
}

function renderCreateForm() {
  var eventOpts = '';
  for (var i = 0; i < EVENTS.length; i++) {
    eventOpts += '<option value="' + EVENTS[i].value + '">' + EVENTS[i].label + '</option>';
  }

  return '<div class="fleet-create-form">' +
    '<div class="fleet-create-row fleet-create-options">' +
    '<select id="hook-event-select" class="fleet-select">' + eventOpts + '</select>' +
    '<input type="text" id="hook-match-input" class="fleet-input fleet-input-sm" placeholder="Match (glob)" value="*" />' +
    '</div>' +
    '<div class="fleet-create-row">' +
    '<input type="text" id="hook-cmd-input" class="fleet-input" placeholder="Command to run..." />' +
    '<button class="fleet-btn fleet-btn-primary" data-action="create-hook"><i data-lucide="plus"></i> Add</button>' +
    '</div>' +
    '</div>';
}

function renderPresets() {
  var html = '<div class="fleet-section-header">Quick Presets</div>';
  html += '<div class="hook-presets">';
  for (var i = 0; i < PRESETS.length; i++) {
    var p = PRESETS[i];
    html += '<button class="fleet-btn fleet-btn-sm hook-preset-btn" data-action="apply-preset" data-idx="' + i + '">';
    html += esc(p.label);
    html += '</button>';
  }
  html += '</div>';
  return html;
}

function renderHookCard(hook) {
  var id = hook.id;
  var config = hook.config || hook;
  var event = config.event || "";
  var match = config.match || "*";
  var command = config.command || "";
  var enabled = hook.enabled !== false;
  var desc = config.description || "";
  var runCount = hook.runCount || 0;
  var lastResult = hook.lastResult;

  var html = '<div class="fleet-card hook-card" data-hook-id="' + esc(id) + '">';
  html += '<div class="fleet-card-header">';
  html += statusDot(enabled ? "running" : "paused");
  html += '<span class="hook-event-badge">' + esc(event) + '</span>';
  html += '<span class="fleet-card-title">' + esc(desc || command.slice(0, 40)) + '</span>';
  html += '</div>';

  html += '<div class="fleet-card-stats">';
  html += '<span>match: <code>' + esc(match) + '</code></span>';
  html += '<span>runs: ' + runCount + '</span>';
  if (lastResult) {
    var lastOk = lastResult.exitCode === 0;
    html += '<span>last: ' + (lastOk ? '✓' : '✗ exit ' + lastResult.exitCode) + '</span>';
  }
  html += '</div>';

  html += '<div class="hook-command"><code>' + esc(command) + '</code></div>';

  // Last result output
  if (lastResult && lastResult.output) {
    html += '<pre class="fleet-stream">' + esc(lastResult.output.slice(0, 300)) + '</pre>';
  }

  // Actions
  html += '<div class="fleet-card-actions">';
  html += '<button class="fleet-btn fleet-btn-sm" data-action="toggle-hook" data-id="' + esc(id) + '" data-enabled="' + (enabled ? "false" : "true") + '">';
  html += enabled ? 'Disable' : 'Enable';
  html += '</button>';
  html += '<button class="fleet-btn fleet-btn-danger fleet-btn-sm" data-action="delete-hook" data-id="' + esc(id) + '"><i data-lucide="trash-2"></i></button>';
  html += '</div>';

  html += '</div>';
  return html;
}

function bindActions(container) {
  container.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-action]");
    if (!btn) return;
    var action = btn.getAttribute("data-action");
    var id = btn.getAttribute("data-id");

    if (action === "create-hook") {
      var event = document.getElementById("hook-event-select");
      var match = document.getElementById("hook-match-input");
      var cmd = document.getElementById("hook-cmd-input");
      if (!cmd || !cmd.value.trim()) return;

      sendWs({
        type: "hook_register",
        event: event.value,
        match: match.value.trim() || "*",
        command: cmd.value.trim(),
        description: cmd.value.trim().slice(0, 50),
      });
      cmd.value = "";
    } else if (action === "toggle-hook") {
      var enabled = btn.getAttribute("data-enabled") === "true";
      sendWs({ type: "hook_toggle", hookId: id, enabled: enabled });
    } else if (action === "delete-hook") {
      sendWs({ type: "hook_unregister", hookId: id });
    } else if (action === "apply-preset") {
      var idx = parseInt(btn.getAttribute("data-idx"));
      var preset = PRESETS[idx];
      if (!preset) return;
      sendWs({
        type: "hook_register",
        event: preset.event,
        match: preset.match,
        command: preset.command,
        description: preset.desc,
      });
    }
  });
  refreshIcons();
}
