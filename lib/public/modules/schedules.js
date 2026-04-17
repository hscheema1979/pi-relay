/**
 * schedules.js — Schedules panel for fleet orchestration.
 * Shows cron-based scheduled tasks with next-run countdown.
 */

import { createPanel, registerFleetPanel, esc, timeAgo, formatDuration, statusDot } from './panel-base.js';
import { refreshIcons } from './icons.js';

var wsRef = null;
var countdownTimer = null;

var panel = createPanel({
  id: "schedules",
  fetchUrl: "api/orchestrator/schedules",
  renderFn: renderSchedules,
  badgeFn: function (data) {
    if (!data || !Array.isArray(data)) return null;
    var active = 0;
    for (var i = 0; i < data.length; i++) {
      if (!data[i].paused) active++;
    }
    return active > 0 ? { count: active, state: "active" } : null;
  },
  fgInterval: 10000,
  bgInterval: 60000,
});

export function initSchedules(opts) {
  wsRef = opts;
  panel.init(opts);
  registerFleetPanel("schedules", panel);
}

export function toggleSchedulesPanel() {
  panel.toggle();
}

export function handleScheduleMessage(msg) {
  panel.handleUpdate();
}

function sendWs(msg) {
  if (wsRef && wsRef.ws && typeof wsRef.ws === "object" && wsRef.ws.readyState === 1) {
    wsRef.ws.send(JSON.stringify(msg));
  }
}

// Cron presets
var CRON_PRESETS = [
  { label: "Every 5 min", cron: "*/5 * * * *" },
  { label: "Every 15 min", cron: "*/15 * * * *" },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily 9AM", cron: "0 9 * * *" },
  { label: "Weekly Mon", cron: "0 9 * * 1" },
];

function renderSchedules(data, bodyEl) {
  if (!data || !Array.isArray(data) || data.length === 0) {
    bodyEl.innerHTML =
      '<div class="fleet-empty">No schedules' +
      '<div class="fleet-empty-hint">Create a schedule to run commands on a cron timer.</div>' +
      '</div>' +
      renderCreateForm();
    bindActions(bodyEl);
    startCountdown();
    return;
  }

  // Separate active vs paused
  var active = [], paused = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i].paused) paused.push(data[i]); else active.push(data[i]);
  }

  var html = renderCreateForm();

  if (active.length > 0) {
    html += '<div class="fleet-section-header">' + statusDot("running") + ' Active (' + active.length + ')</div>';
    for (var a = 0; a < active.length; a++) html += renderScheduleCard(active[a]);
  }

  if (paused.length > 0) {
    html += '<div class="fleet-section-header">' + statusDot("paused") + ' Paused (' + paused.length + ')</div>';
    for (var p = 0; p < paused.length; p++) html += renderScheduleCard(paused[p]);
  }

  bodyEl.innerHTML = html;
  bindActions(bodyEl);
  startCountdown();
}

function renderCreateForm() {
  var presetsHtml = '';
  for (var i = 0; i < CRON_PRESETS.length; i++) {
    presetsHtml += '<option value="' + CRON_PRESETS[i].cron + '">' + CRON_PRESETS[i].label + '</option>';
  }

  return '<div class="fleet-create-form">' +
    '<div class="fleet-create-row">' +
    '<input type="text" id="sched-cmd-input" class="fleet-input" placeholder="Command to schedule..." />' +
    '</div>' +
    '<div class="fleet-create-row fleet-create-options">' +
    '<select id="sched-cron-preset" class="fleet-select">' +
    presetsHtml +
    '<option value="custom">Custom...</option>' +
    '</select>' +
    '<input type="text" id="sched-cron-custom" class="fleet-input fleet-input-sm hidden" placeholder="*/5 * * * *" />' +
    '<select id="sched-target-machine" class="fleet-select">' +
    '<option value="">Local</option>' +
    '<option value="vps1">VPS1</option>' +
    '<option value="vps2">VPS2</option>' +
    '<option value="vps3">VPS3</option>' +
    '<option value="vps4">VPS4</option>' +
    '</select>' +
    '<button class="fleet-btn fleet-btn-primary" data-action="create-schedule"><i data-lucide="plus"></i> Create</button>' +
    '</div>' +
    '</div>';
}

function renderScheduleCard(sched) {
  var id = sched.id;
  var config = sched.config || {};
  var cmd = config.command || "";
  var cron = config.cron || "";
  var desc = config.description || "";
  var paused = sched.paused;
  var target = config.targetMachine || "local";
  var nextRun = sched.nextRun;
  var lastRunAt = sched.lastRunAt;
  var runs = sched.runs || [];
  var lastRun = runs.length > 0 ? runs[runs.length - 1] : null;

  var html = '<div class="fleet-card" data-schedule-id="' + esc(id) + '">';
  html += '<div class="fleet-card-header">';
  html += statusDot(paused ? "paused" : "running");
  html += '<span class="fleet-card-title">' + esc(desc || cmd.slice(0, 50)) + '</span>';
  html += '<code class="fleet-cron-badge">' + esc(cron) + '</code>';
  html += '</div>';

  html += '<div class="fleet-card-stats">';
  html += '<span>' + esc(target) + '</span>';
  if (nextRun && !paused) {
    html += '<span class="fleet-countdown" data-next="' + new Date(nextRun).getTime() + '">next: calculating...</span>';
  }
  if (lastRun) {
    var lastIcon = lastRun.error ? '✗' : '✓';
    html += '<span>last: ' + lastIcon + ' ' + esc(timeAgo(lastRun.startedAt || lastRunAt)) + '</span>';
  }
  html += '<span>runs: ' + runs.length + '</span>';
  html += '</div>';

  // Recent run history (last 3)
  if (runs.length > 0) {
    html += '<div class="fleet-run-history">';
    var start = Math.max(0, runs.length - 3);
    for (var i = start; i < runs.length; i++) {
      var run = runs[i];
      var ok = !run.error;
      html += '<div class="fleet-run-item ' + (ok ? 'fleet-run-ok' : 'fleet-run-fail') + '">';
      html += '<span>' + (ok ? '✓' : '✗') + ' ' + esc(timeAgo(run.startedAt)) + '</span>';
      if (run.durationMs) html += '<span>' + formatDuration(run.durationMs) + '</span>';
      html += '</div>';
    }
    html += '</div>';
  }

  // Actions
  html += '<div class="fleet-card-actions">';
  if (!paused) {
    html += '<button class="fleet-btn" data-action="run-now" data-id="' + esc(id) + '" title="Run now"><i data-lucide="play"></i></button>';
    html += '<button class="fleet-btn" data-action="pause-schedule" data-id="' + esc(id) + '" title="Pause"><i data-lucide="pause"></i></button>';
  } else {
    html += '<button class="fleet-btn fleet-btn-primary" data-action="resume-schedule" data-id="' + esc(id) + '" title="Resume"><i data-lucide="play"></i></button>';
  }
  html += '<button class="fleet-btn fleet-btn-danger" data-action="delete-schedule" data-id="' + esc(id) + '" title="Delete"><i data-lucide="trash-2"></i></button>';
  html += '</div>';

  html += '</div>';
  return html;
}

function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(updateCountdowns, 1000);
}

function updateCountdowns() {
  var els = document.querySelectorAll(".fleet-countdown");
  var now = Date.now();
  for (var i = 0; i < els.length; i++) {
    var next = parseInt(els[i].getAttribute("data-next"));
    if (!next) continue;
    var diff = next - now;
    if (diff <= 0) {
      els[i].textContent = "next: now";
    } else {
      els[i].textContent = "next: " + formatDuration(diff);
    }
  }
}

function bindActions(container) {
  // Handle cron preset → custom toggle
  var preset = container.querySelector("#sched-cron-preset");
  var custom = container.querySelector("#sched-cron-custom");
  if (preset && custom) {
    preset.addEventListener("change", function () {
      if (preset.value === "custom") {
        custom.classList.remove("hidden");
        custom.focus();
      } else {
        custom.classList.add("hidden");
      }
    });
  }

  container.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-action]");
    if (!btn) return;
    var action = btn.getAttribute("data-action");
    var id = btn.getAttribute("data-id");

    if (action === "create-schedule") {
      var cmd = document.getElementById("sched-cmd-input");
      var presetEl = document.getElementById("sched-cron-preset");
      var customEl = document.getElementById("sched-cron-custom");
      var target = document.getElementById("sched-target-machine");
      if (!cmd || !cmd.value.trim()) return;

      var cronValue = presetEl.value === "custom" ? customEl.value.trim() : presetEl.value;
      if (!cronValue) return;

      sendWs({
        type: "schedule_create",
        command: cmd.value.trim(),
        cron: cronValue,
        description: cmd.value.trim().slice(0, 60),
        targetMachine: target.value || undefined,
      });
      cmd.value = "";
    } else if (action === "pause-schedule") {
      sendWs({ type: "schedule_pause", scheduleId: id });
    } else if (action === "resume-schedule") {
      sendWs({ type: "schedule_resume", scheduleId: id });
    } else if (action === "run-now") {
      sendWs({ type: "schedule_run_now", scheduleId: id });
    } else if (action === "delete-schedule") {
      sendWs({ type: "schedule_delete", scheduleId: id });
    }
  });
  refreshIcons();
}
