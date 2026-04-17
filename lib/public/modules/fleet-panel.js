/**
 * fleet-panel.js — Fleet Missions panel for DAG-based multi-agent orchestration.
 * Shows mission DAGs with dependency graph, streaming output, and status tracking.
 */

import { createPanel, registerFleetPanel, esc, timeAgo, formatDuration, statusDot } from './panel-base.js';
import { refreshIcons } from './icons.js';

var wsRef = null;
var missionDeltas = {};

var panel = createPanel({
  id: "fleet",
  fetchUrl: "api/orchestrator/fleets",
  renderFn: renderFleets,
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

export function initFleet(opts) {
  wsRef = opts;
  panel.init(opts);
  registerFleetPanel("fleet", panel);
}

export function toggleFleetPanel() {
  panel.toggle();
}

export function handleFleetMessage(msg) {
  if (msg.type === "fleet_delta") {
    var key = msg.fleetId + ":" + msg.missionId;
    if (!missionDeltas[key]) missionDeltas[key] = "";
    missionDeltas[key] += msg.text;
    if (missionDeltas[key].length > 2000) missionDeltas[key] = missionDeltas[key].slice(-2000);
    if (panel.isOpen()) {
      var el = document.getElementById("fleet-stream-" + msg.missionId);
      if (el) el.textContent = missionDeltas[key];
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

function renderFleets(data, bodyEl) {
  if (!data || !Array.isArray(data) || data.length === 0) {
    bodyEl.innerHTML =
      '<div class="fleet-empty">No fleet missions' +
      '<div class="fleet-empty-hint">Create a fleet to run multiple coordinated agents with dependencies.</div>' +
      '</div>' +
      renderCreateForm();
    bindActions(bodyEl);
    return;
  }

  var html = renderCreateForm();

  for (var i = 0; i < data.length; i++) {
    html += renderFleetCard(data[i]);
  }

  bodyEl.innerHTML = html;
  bindActions(bodyEl);
}

function renderCreateForm() {
  return '<div class="fleet-create-form">' +
    '<div class="fleet-create-row">' +
    '<input type="text" id="fleet-goal-input" class="fleet-input" placeholder="Fleet goal (e.g. Refactor auth module)..." />' +
    '</div>' +
    '<div class="fleet-create-row fleet-create-options">' +
    '<input type="number" id="fleet-concurrency" class="fleet-input fleet-input-sm" placeholder="Concurrency" value="3" min="1" max="10" />' +
    '<button class="fleet-btn fleet-btn-primary" data-action="create-fleet"><i data-lucide="plus"></i> Create</button>' +
    '</div>' +
    '<div class="fleet-create-row">' +
    '<textarea id="fleet-missions-input" class="fleet-input" rows="3" placeholder="Missions (one per line, format: name | prompt | deps:dep1,dep2)"></textarea>' +
    '</div>' +
    '</div>';
}

function renderFleetCard(fleet) {
  var id = fleet.id;
  var config = fleet.config || {};
  var state = fleet.state || "pending";
  var missions = fleet.missions || config.missions || [];
  var created = fleet.createdAt ? timeAgo(fleet.createdAt) : "";

  var html = '<div class="fleet-card fleet-mission-card" data-fleet-id="' + esc(id) + '">';
  html += '<div class="fleet-card-header">';
  html += statusDot(state);
  html += '<span class="fleet-card-title">' + esc(config.goal || id) + '</span>';
  html += '<span class="fleet-card-meta">' + esc(state) + '</span>';
  html += '</div>';

  html += '<div class="fleet-card-stats">';
  html += '<span>Missions: ' + missions.length + '</span>';
  html += '<span>Concurrency: ' + (config.concurrency || 3) + '</span>';
  html += '<span>' + esc(created) + '</span>';
  html += '</div>';

  // Mission list with mini DAG visualization
  if (missions.length > 0) {
    html += '<div class="fleet-missions-list">';
    for (var i = 0; i < missions.length; i++) {
      var m = missions[i];
      var mState = m.state || m.status || "pending";
      var mName = m.name || m.id || ("Mission " + (i + 1));
      var deps = m.dependsOn || m.dependencies || [];
      var depsStr = deps.length > 0 ? " ← " + deps.join(", ") : "";

      html += '<div class="fleet-mission-item">';
      html += statusDot(mState);
      html += '<span class="fleet-mission-name">' + esc(mName) + '</span>';
      if (depsStr) html += '<span class="fleet-mission-deps">' + esc(depsStr) + '</span>';
      html += '</div>';

      // Streaming for running missions
      var key = id + ":" + (m.id || m.name);
      if (mState === "running" && missionDeltas[key]) {
        html += '<pre class="fleet-stream" id="fleet-stream-' + esc(m.id || m.name) + '">' + esc(missionDeltas[key].slice(-300)) + '</pre>';
      }
    }
    html += '</div>';
  }

  // Report if completed
  if (fleet.report) {
    html += '<div class="fleet-report">';
    html += '<div class="fleet-report-header">Report</div>';
    html += '<pre class="fleet-stream">' + esc(String(fleet.report).slice(0, 1000)) + '</pre>';
    html += '</div>';
  }

  // Actions
  html += '<div class="fleet-card-actions">';
  if (state === "running") {
    html += '<button class="fleet-btn fleet-btn-danger" data-action="cancel-fleet" data-id="' + esc(id) + '"><i data-lucide="square"></i> Cancel</button>';
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

    if (action === "create-fleet") {
      var goal = document.getElementById("fleet-goal-input");
      var concurrency = document.getElementById("fleet-concurrency");
      var missionsText = document.getElementById("fleet-missions-input");
      if (!goal || !goal.value.trim()) return;

      var missions = [];
      if (missionsText && missionsText.value.trim()) {
        var lines = missionsText.value.trim().split("\n");
        for (var i = 0; i < lines.length; i++) {
          var parts = lines[i].split("|").map(function (s) { return s.trim(); });
          var mission = { name: parts[0] || "mission-" + (i + 1), prompt: parts[1] || parts[0] };
          if (parts[2] && parts[2].startsWith("deps:")) {
            mission.dependsOn = parts[2].replace("deps:", "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
          }
          missions.push(mission);
        }
      }

      sendWs({
        type: "fleet_create",
        goal: goal.value.trim(),
        concurrency: parseInt(concurrency.value) || 3,
        missions: missions,
      });
      goal.value = "";
      if (missionsText) missionsText.value = "";
    } else if (action === "cancel-fleet") {
      sendWs({ type: "fleet_cancel", fleetId: id });
    }
  });
  refreshIcons();
}
