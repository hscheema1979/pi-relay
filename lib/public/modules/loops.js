/**
 * loops.js — Loops panel for fleet orchestration.
 * Shows active, paused, and completed loops with streaming output.
 */

import { createPanel, registerFleetPanel, esc, timeAgo, formatDuration, statusDot } from './panel-base.js';
import { refreshIcons } from './icons.js';

var wsRef = null;
var basePathRef = "/";

// Track streaming deltas per loop
var loopDeltas = {};

var panel = createPanel({
  id: "loops",
  fetchUrl: "api/orchestrator/loops",
  renderFn: renderLoops,
  badgeFn: function (data) {
    if (!data || !Array.isArray(data)) return null;
    var active = 0;
    for (var i = 0; i < data.length; i++) {
      if (data[i].state === "running") active++;
    }
    return active > 0 ? { count: active, state: "active" } : null;
  },
  fgInterval: 3000,
});

export function initLoops(opts) {
  basePathRef = opts.basePath || "/";
  wsRef = opts;
  panel.init(opts);
  registerFleetPanel("loops", panel);
}

export function toggleLoopsPanel() {
  panel.toggle();
}

export function handleLoopMessage(msg) {
  if (msg.type === "loop_delta") {
    if (!loopDeltas[msg.loopId]) loopDeltas[msg.loopId] = "";
    loopDeltas[msg.loopId] += msg.text;
    // Trim to last 2000 chars
    if (loopDeltas[msg.loopId].length > 2000) {
      loopDeltas[msg.loopId] = loopDeltas[msg.loopId].slice(-2000);
    }
    // If panel is open, update the streaming area
    if (panel.isOpen()) {
      var el = document.getElementById("loop-stream-" + msg.loopId);
      if (el) el.textContent = loopDeltas[msg.loopId];
    }
    return;
  }
  // For status/iteration updates, trigger a re-fetch
  panel.handleUpdate();
}

function sendWs(msg) {
  if (wsRef && wsRef.ws) {
    var socket = typeof wsRef.ws === "object" ? wsRef.ws : null;
    if (wsRef.ws && typeof wsRef.ws === "object" && wsRef.ws.readyState === 1) {
      wsRef.ws.send(JSON.stringify(msg));
    }
  }
}

function renderLoops(data, bodyEl) {
  if (!data || !Array.isArray(data) || data.length === 0) {
    bodyEl.innerHTML =
      '<div class="fleet-empty">No loops' +
      '<div class="fleet-empty-hint">Start a loop to run commands at regular intervals.</div>' +
      '</div>' +
      renderCreateForm();
    bindActions(bodyEl);
    return;
  }

  // Separate by state
  var running = [], paused = [], completed = [], stopped = [];
  for (var i = 0; i < data.length; i++) {
    var l = data[i];
    if (l.state === "running") running.push(l);
    else if (l.state === "paused") paused.push(l);
    else if (l.state === "completed") completed.push(l);
    else stopped.push(l);
  }

  var html = renderCreateForm();

  if (running.length > 0) {
    html += '<div class="fleet-section-header">' + statusDot("running") + ' Running (' + running.length + ')</div>';
    for (var r = 0; r < running.length; r++) html += renderLoopCard(running[r]);
  }

  if (paused.length > 0) {
    html += '<div class="fleet-section-header">' + statusDot("paused") + ' Paused (' + paused.length + ')</div>';
    for (var p = 0; p < paused.length; p++) html += renderLoopCard(paused[p]);
  }

  if (completed.length > 0) {
    html += '<div class="fleet-section-header">' + statusDot("completed") + ' Completed (' + completed.length + ')</div>';
    for (var c = 0; c < completed.length; c++) html += renderLoopCard(completed[c]);
  }

  if (stopped.length > 0) {
    html += '<div class="fleet-section-header">' + statusDot("failed") + ' Stopped (' + stopped.length + ')</div>';
    for (var s = 0; s < stopped.length; s++) html += renderLoopCard(stopped[s]);
  }

  bodyEl.innerHTML = html;
  bindActions(bodyEl);
}

function renderCreateForm() {
  return '<div class="fleet-create-form">' +
    '<div class="fleet-create-row">' +
    '<input type="text" id="loop-cmd-input" class="fleet-input" placeholder="Command to loop..." />' +
    '</div>' +
    '<div class="fleet-create-row fleet-create-options">' +
    '<select id="loop-interval-select" class="fleet-select">' +
    '<option value="60000">1 min</option>' +
    '<option value="300000" selected>5 min</option>' +
    '<option value="600000">10 min</option>' +
    '<option value="1800000">30 min</option>' +
    '<option value="3600000">1 hour</option>' +
    '</select>' +
    '<input type="number" id="loop-max-iter" class="fleet-input fleet-input-sm" placeholder="Max iter" min="1" value="10" />' +
    '<select id="loop-target-machine" class="fleet-select">' +
    '<option value="">Local</option>' +
    '<option value="vps1">VPS1</option>' +
    '<option value="vps2">VPS2</option>' +
    '<option value="vps3">VPS3</option>' +
    '<option value="vps4">VPS4</option>' +
    '</select>' +
    '<button class="fleet-btn fleet-btn-primary" data-action="start-loop"><i data-lucide="play"></i> Start</button>' +
    '</div>' +
    '</div>';
}

function renderLoopCard(loop) {
  var id = loop.id;
  var cmd = loop.config ? loop.config.command : "";
  var state = loop.state;
  var iter = loop.iteration || 0;
  var maxIter = loop.config ? loop.config.maxIterations : "∞";
  var target = loop.config && loop.config.targetMachine ? loop.config.targetMachine : "local";
  var created = loop.createdAt ? timeAgo(loop.createdAt) : "";

  var html = '<div class="fleet-card" data-loop-id="' + esc(id) + '">';
  html += '<div class="fleet-card-header">';
  html += statusDot(state);
  html += '<span class="fleet-card-title">' + esc(cmd ? cmd.slice(0, 60) : id) + '</span>';
  html += '<span class="fleet-card-meta">' + esc(target) + '</span>';
  html += '</div>';

  html += '<div class="fleet-card-stats">';
  html += '<span>Iter: ' + iter + '/' + (maxIter || '∞') + '</span>';
  html += '<span>' + esc(created) + '</span>';
  html += '</div>';

  // Streaming output for running loops
  if (state === "running" && loopDeltas[id]) {
    html += '<pre class="fleet-stream" id="loop-stream-' + esc(id) + '">' + esc(loopDeltas[id].slice(-500)) + '</pre>';
  }

  // Actions
  html += '<div class="fleet-card-actions">';
  if (state === "running") {
    html += '<button class="fleet-btn" data-action="pause-loop" data-id="' + esc(id) + '"><i data-lucide="pause"></i></button>';
    html += '<button class="fleet-btn fleet-btn-danger" data-action="stop-loop" data-id="' + esc(id) + '"><i data-lucide="square"></i></button>';
  } else if (state === "paused") {
    html += '<button class="fleet-btn fleet-btn-primary" data-action="resume-loop" data-id="' + esc(id) + '"><i data-lucide="play"></i></button>';
    html += '<button class="fleet-btn fleet-btn-danger" data-action="stop-loop" data-id="' + esc(id) + '"><i data-lucide="square"></i></button>';
  }
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

    if (action === "start-loop") {
      var cmd = document.getElementById("loop-cmd-input");
      var interval = document.getElementById("loop-interval-select");
      var maxIter = document.getElementById("loop-max-iter");
      var target = document.getElementById("loop-target-machine");
      if (!cmd || !cmd.value.trim()) return;

      sendWs({
        type: "loop_start",
        command: cmd.value.trim(),
        intervalMs: parseInt(interval.value),
        maxIterations: parseInt(maxIter.value) || undefined,
        targetMachine: target.value || undefined,
      });
      cmd.value = "";
    } else if (action === "pause-loop") {
      sendWs({ type: "loop_pause", loopId: id });
    } else if (action === "resume-loop") {
      sendWs({ type: "loop_resume", loopId: id });
    } else if (action === "stop-loop") {
      sendWs({ type: "loop_stop", loopId: id });
    }
  });
  refreshIcons();
}
