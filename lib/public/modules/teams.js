/**
 * teams.js — Browser-side Teams panel.
 * Fetches team status from /api/teams and renders worker/task views.
 */

import { showToast } from './utils.js';
import { refreshIcons } from './icons.js';

var panelEl = null;
var bodyEl = null;
var refreshBtn = null;
var closeBtn = null;
var sidebarBtn = null;
var refreshTimer = null;
var basePath = "/";

export function initTeams(opts) {
  basePath = opts.basePath || "/";
  panelEl = document.getElementById("teams-panel");
  bodyEl = document.getElementById("teams-panel-body");
  refreshBtn = document.getElementById("teams-panel-refresh");
  closeBtn = document.getElementById("teams-panel-close");
  sidebarBtn = document.getElementById("teams-sidebar-btn");

  if (closeBtn) {
    closeBtn.addEventListener("click", function () {
      closeTeamsPanel();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", function () {
      loadTeams();
    });
  }

  if (sidebarBtn) {
    sidebarBtn.addEventListener("click", function () {
      toggleTeamsPanel();
    });
  }
}

export function toggleTeamsPanel() {
  if (!panelEl) return;
  var opening = panelEl.classList.contains("hidden");
  panelEl.classList.toggle("hidden");
  if (opening) {
    loadTeams();
    // Auto-refresh every 10s while open
    refreshTimer = setInterval(loadTeams, 10000);
  } else {
    stopRefresh();
  }
  refreshIcons();
}

export function closeTeamsPanel() {
  if (panelEl) panelEl.classList.add("hidden");
  stopRefresh();
}

function stopRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function loadTeams() {
  fetch(basePath + "api/teams")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      renderTeams(data.teams || []);
    })
    .catch(function (err) {
      if (bodyEl) bodyEl.innerHTML = '<div class="teams-error">Failed to load teams</div>';
    });
}

function renderTeams(teams) {
  if (!bodyEl) return;

  if (teams.length === 0) {
    bodyEl.innerHTML = '<div class="teams-empty">No teams found.<br><span class="teams-hint">Use the <code>teams</code> tool or <code>/team delegate</code> to create one.</span></div>';
    return;
  }

  var html = "";
  for (var i = 0; i < teams.length; i++) {
    var team = teams[i];
    var workerCount = 0;
    var onlineCount = 0;
    for (var mi = 0; mi < team.members.length; mi++) {
      if (team.members[mi].role === "worker") {
        workerCount++;
        if (team.members[mi].status === "online" && !team.members[mi].shutdownRequested) onlineCount++;
      }
    }

    var completedTasks = 0;
    var totalTasks = team.tasks.length;
    for (var ti = 0; ti < totalTasks; ti++) {
      if (team.tasks[ti].status === "completed") completedTasks++;
    }

    var teamAge = timeAgo(team.createdAt);
    var teamClass = onlineCount > 0 ? "team-active" : "team-idle";

    html += '<div class="teams-team ' + teamClass + '" data-team-id="' + esc(team.id) + '">';
    html += '<div class="teams-team-header">';
    html += '<span class="teams-team-indicator ' + (onlineCount > 0 ? 'online' : 'offline') + '"></span>';
    html += '<span class="teams-team-title">' + esc(team.lead) + '</span>';
    html += '<span class="teams-team-meta">';
    html += onlineCount + '/' + workerCount + ' workers';
    if (totalTasks > 0) html += ' · ' + completedTasks + '/' + totalTasks + ' tasks';
    html += ' · ' + teamAge;
    html += '</span>';
    html += '</div>';

    // Members
    html += '<div class="teams-members">';
    for (var mj = 0; mj < team.members.length; mj++) {
      var m = team.members[mj];
      if (m.role === "lead") continue;
      var statusCls = m.status === "online" && !m.shutdownRequested ? "online" : "offline";
      html += '<div class="teams-member">';
      html += '<span class="teams-member-dot ' + statusCls + '"></span>';
      html += '<span class="teams-member-name">' + esc(m.name) + '</span>';
      if (m.model) {
        var shortModel = m.model.split("/").pop();
        html += '<span class="teams-member-model">' + esc(shortModel) + '</span>';
      }
      html += '</div>';
    }
    html += '</div>';

    // Tasks
    if (team.tasks.length > 0) {
      html += '<div class="teams-tasks">';
      for (var tk = 0; tk < team.tasks.length; tk++) {
        var task = team.tasks[tk];
        var statusIcon = task.status === "completed" ? "✓" : task.status === "in_progress" ? "▶" : "○";
        var statusCls2 = "task-" + (task.status || "pending").replace(/_/g, "-");
        html += '<div class="teams-task ' + statusCls2 + '">';
        html += '<span class="teams-task-icon">' + statusIcon + '</span>';
        html += '<span class="teams-task-text">' + esc(task.subject || "(no description)") + '</span>';
        if (task.owner) {
          html += '<span class="teams-task-owner">' + esc(task.owner) + '</span>';
        }
        html += '</div>';
      }
      html += '</div>';
    }

    html += '</div>';
  }

  bodyEl.innerHTML = html;
}

function timeAgo(dateStr) {
  if (!dateStr) return "";
  var now = Date.now();
  var then = new Date(dateStr).getTime();
  var diff = Math.max(0, now - then);
  var mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  var hours = Math.floor(mins / 60);
  if (hours < 24) return hours + "h ago";
  var days = Math.floor(hours / 24);
  return days + "d ago";
}

function esc(s) {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
