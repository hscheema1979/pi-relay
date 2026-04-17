/**
 * autoresearch-panel.js — Autoresearch panel for goal-directed autonomous iteration.
 * Shows research sessions with mode, iterations, metric tracking, and streaming output.
 */

import { createPanel, registerFleetPanel, esc, timeAgo, formatDuration, statusDot } from './panel-base.js';
import { refreshIcons } from './icons.js';

var wsRef = null;
var arDeltas = {};

var MODES = [
  { value: "research", label: "Research", icon: "🔍" },
  { value: "security", label: "Security", icon: "🔒" },
  { value: "debug", label: "Debug", icon: "🐛" },
  { value: "fix", label: "Fix", icon: "🔧" },
  { value: "ship", label: "Ship", icon: "🚀" },
  { value: "scenario", label: "Scenario", icon: "🎯" },
  { value: "predict", label: "Predict", icon: "🔮" },
  { value: "learn", label: "Learn", icon: "📚" },
];

var panel = createPanel({
  id: "autoresearch",
  fetchUrl: "api/orchestrator/autoresearch",
  renderFn: renderAutoresearch,
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

export function initAutoresearch(opts) {
  wsRef = opts;
  panel.init(opts);
  registerFleetPanel("autoresearch", panel);
}

export function toggleAutoresearchPanel() {
  panel.toggle();
}

export function handleAutoresearchMessage(msg) {
  if (msg.type === "autoresearch_delta") {
    if (!arDeltas[msg.id]) arDeltas[msg.id] = "";
    arDeltas[msg.id] += msg.text;
    if (arDeltas[msg.id].length > 2000) arDeltas[msg.id] = arDeltas[msg.id].slice(-2000);
    if (panel.isOpen()) {
      var el = document.getElementById("ar-stream-" + msg.id);
      if (el) el.textContent = arDeltas[msg.id];
    }
    return;
  }
  panel.handleUpdate();
}

function sendWs(msg) {
  if (wsRef && wsRef.ws && typeof wsRef.ws === "object" && wsRef.ws.readyState === 1) {
    wsRef.ws.send(JSON.stringify(msg));
  }
}

function renderAutoresearch(data, bodyEl) {
  if (!data || !Array.isArray(data) || data.length === 0) {
    bodyEl.innerHTML =
      '<div class="fleet-empty">No autoresearch sessions' +
      '<div class="fleet-empty-hint">Start an autonomous research session to iteratively explore a goal.</div>' +
      '</div>' +
      renderCreateForm();
    bindActions(bodyEl);
    return;
  }

  var running = [], paused = [], completed = [], other = [];
  for (var i = 0; i < data.length; i++) {
    var s = data[i].state;
    if (s === "running") running.push(data[i]);
    else if (s === "paused") paused.push(data[i]);
    else if (s === "completed") completed.push(data[i]);
    else other.push(data[i]);
  }

  var html = renderCreateForm();

  if (running.length > 0) {
    html += '<div class="fleet-section-header">' + statusDot("running") + ' Running (' + running.length + ')</div>';
    for (var r = 0; r < running.length; r++) html += renderSessionCard(running[r]);
  }
  if (paused.length > 0) {
    html += '<div class="fleet-section-header">' + statusDot("paused") + ' Paused (' + paused.length + ')</div>';
    for (var p = 0; p < paused.length; p++) html += renderSessionCard(paused[p]);
  }
  if (completed.length > 0) {
    html += '<div class="fleet-section-header">' + statusDot("completed") + ' Completed (' + completed.length + ')</div>';
    for (var c = 0; c < completed.length; c++) html += renderSessionCard(completed[c]);
  }
  if (other.length > 0) {
    html += '<div class="fleet-section-header">' + statusDot("failed") + ' Other (' + other.length + ')</div>';
    for (var o = 0; o < other.length; o++) html += renderSessionCard(other[o]);
  }

  bodyEl.innerHTML = html;
  bindActions(bodyEl);
}

function renderCreateForm() {
  var modeOpts = '';
  for (var i = 0; i < MODES.length; i++) {
    modeOpts += '<option value="' + MODES[i].value + '">' + MODES[i].icon + ' ' + MODES[i].label + '</option>';
  }

  return '<div class="fleet-create-form">' +
    '<div class="fleet-create-row">' +
    '<input type="text" id="ar-goal-input" class="fleet-input" placeholder="Research goal..." />' +
    '</div>' +
    '<div class="fleet-create-row fleet-create-options">' +
    '<select id="ar-mode-select" class="fleet-select">' + modeOpts + '</select>' +
    '<input type="number" id="ar-max-iter" class="fleet-input fleet-input-sm" placeholder="Max iter" min="1" value="5" />' +
    '<select id="ar-target-machine" class="fleet-select">' +
    '<option value="">Local</option>' +
    '<option value="vps1">VPS1</option>' +
    '<option value="vps2">VPS2</option>' +
    '<option value="vps3">VPS3</option>' +
    '<option value="vps4">VPS4</option>' +
    '</select>' +
    '<button class="fleet-btn fleet-btn-primary" data-action="start-ar"><i data-lucide="play"></i> Start</button>' +
    '</div>' +
    '<div class="fleet-create-row">' +
    '<input type="text" id="ar-metric-input" class="fleet-input" placeholder="Metric to track (optional, e.g. test pass rate)" />' +
    '</div>' +
    '<div class="fleet-create-row">' +
    '<input type="text" id="ar-guard-input" class="fleet-input" placeholder="Guard command (optional, e.g. npm test)" />' +
    '</div>' +
    '</div>';
}

function renderSessionCard(session) {
  var id = session.id;
  var config = session.config || {};
  var state = session.state;
  var mode = config.mode || "research";
  var goal = config.goal || "";
  var iteration = session.iteration || 0;
  var maxIter = config.maxIterations || "∞";
  var bestMetric = session.bestMetric;
  var target = config.targetMachine || "local";
  var created = session.createdAt ? timeAgo(session.createdAt) : "";

  var modeInfo = MODES.find(function (m) { return m.value === mode; }) || MODES[0];

  var html = '<div class="fleet-card" data-ar-id="' + esc(id) + '">';
  html += '<div class="fleet-card-header">';
  html += statusDot(state);
  html += '<span class="ar-mode-badge">' + modeInfo.icon + ' ' + modeInfo.label + '</span>';
  html += '<span class="fleet-card-title">' + esc(goal.slice(0, 60)) + '</span>';
  html += '</div>';

  html += '<div class="fleet-card-stats">';
  html += '<span>Iter: ' + iteration + '/' + maxIter + '</span>';
  html += '<span>' + esc(target) + '</span>';
  if (bestMetric != null) html += '<span>Best: ' + esc(String(bestMetric)) + '</span>';
  if (config.metric) html += '<span>Metric: ' + esc(config.metric) + '</span>';
  html += '<span>' + esc(created) + '</span>';
  html += '</div>';

  // Streaming
  if (state === "running" && arDeltas[id]) {
    html += '<pre class="fleet-stream" id="ar-stream-' + esc(id) + '">' + esc(arDeltas[id].slice(-500)) + '</pre>';
  }

  // Actions
  html += '<div class="fleet-card-actions">';
  if (state === "running") {
    html += '<button class="fleet-btn" data-action="pause-ar" data-id="' + esc(id) + '"><i data-lucide="pause"></i></button>';
    html += '<button class="fleet-btn fleet-btn-danger" data-action="stop-ar" data-id="' + esc(id) + '"><i data-lucide="square"></i></button>';
  } else if (state === "paused") {
    html += '<button class="fleet-btn fleet-btn-primary" data-action="resume-ar" data-id="' + esc(id) + '"><i data-lucide="play"></i></button>';
    html += '<button class="fleet-btn fleet-btn-danger" data-action="stop-ar" data-id="' + esc(id) + '"><i data-lucide="square"></i></button>';
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

    if (action === "start-ar") {
      var goal = document.getElementById("ar-goal-input");
      var mode = document.getElementById("ar-mode-select");
      var maxIter = document.getElementById("ar-max-iter");
      var target = document.getElementById("ar-target-machine");
      var metric = document.getElementById("ar-metric-input");
      var guard = document.getElementById("ar-guard-input");
      if (!goal || !goal.value.trim()) return;

      sendWs({
        type: "autoresearch_start",
        goal: goal.value.trim(),
        mode: mode.value,
        maxIterations: parseInt(maxIter.value) || 5,
        metric: metric && metric.value.trim() ? metric.value.trim() : undefined,
        guardCommand: guard && guard.value.trim() ? guard.value.trim() : undefined,
        targetMachine: target.value || undefined,
      });
      goal.value = "";
      if (metric) metric.value = "";
      if (guard) guard.value = "";
    } else if (action === "pause-ar") {
      sendWs({ type: "autoresearch_pause", id: id });
    } else if (action === "resume-ar") {
      sendWs({ type: "autoresearch_resume", id: id });
    } else if (action === "stop-ar") {
      sendWs({ type: "autoresearch_stop", id: id });
    }
  });
  refreshIcons();
}
