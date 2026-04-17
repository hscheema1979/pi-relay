/**
 * worktrees-panel.js — Worktree management panel.
 * Create, list, merge, and remove git worktrees for parallel development.
 */

import { createPanel, registerFleetPanel, esc, timeAgo, statusDot, formatDuration } from './panel-base.js';
import { refreshIcons } from './icons.js';

var wsRef = null;

var panel = createPanel({
  id: "worktrees",
  fetchUrl: "api/orchestrator/worktrees",
  renderFn: renderWorktrees,
  badgeFn: function (data) {
    if (!data || !Array.isArray(data)) return null;
    var active = 0;
    for (var i = 0; i < data.length; i++) {
      if (data[i].state === "active" || data[i].state === "created") active++;
    }
    return active > 0 ? { count: active, state: "active" } : null;
  },
  fgInterval: 10000,
  bgInterval: 60000,
});

export function initWorktrees(opts) {
  wsRef = opts;
  panel.init(opts);
  registerFleetPanel("worktrees", panel);
}

export function toggleWorktreesPanel() {
  panel.toggle();
}

export function handleWorktreeMessage(msg) {
  panel.handleUpdate();
}

function sendWs(msg) {
  if (wsRef && wsRef.ws && typeof wsRef.ws === "object" && wsRef.ws.readyState === 1) {
    wsRef.ws.send(JSON.stringify(msg));
  }
}

function renderWorktrees(data, bodyEl) {
  if (!data || !Array.isArray(data) || data.length === 0) {
    bodyEl.innerHTML =
      '<div class="fleet-empty">No worktrees' +
      '<div class="fleet-empty-hint">Create a worktree for isolated parallel development.</div>' +
      '</div>' +
      renderCreateForm();
    bindActions(bodyEl);
    return;
  }

  var active = [], merged = [], other = [];
  for (var i = 0; i < data.length; i++) {
    var s = data[i].state;
    if (s === "active" || s === "created") active.push(data[i]);
    else if (s === "merged") merged.push(data[i]);
    else other.push(data[i]);
  }

  var html = renderCreateForm();

  if (active.length > 0) {
    html += '<div class="fleet-section-header">' + statusDot("running") + ' Active (' + active.length + ')</div>';
    for (var a = 0; a < active.length; a++) html += renderWorktreeCard(active[a]);
  }

  if (merged.length > 0) {
    html += '<div class="fleet-section-header">' + statusDot("completed") + ' Merged (' + merged.length + ')</div>';
    for (var m = 0; m < merged.length; m++) html += renderWorktreeCard(merged[m]);
  }

  if (other.length > 0) {
    html += '<div class="fleet-section-header">' + statusDot("paused") + ' Other (' + other.length + ')</div>';
    for (var o = 0; o < other.length; o++) html += renderWorktreeCard(other[o]);
  }

  bodyEl.innerHTML = html;
  bindActions(bodyEl);
}

function renderCreateForm() {
  return '<div class="fleet-create-form">' +
    '<div class="fleet-create-row fleet-create-options">' +
    '<input type="text" id="wt-branch-input" class="fleet-input fleet-input-sm" placeholder="Branch name" />' +
    '<input type="text" id="wt-base-input" class="fleet-input fleet-input-sm" placeholder="Base branch (optional)" />' +
    '</div>' +
    '<div class="fleet-create-row">' +
    '<input type="text" id="wt-desc-input" class="fleet-input" placeholder="Description (optional)..." />' +
    '<button class="fleet-btn fleet-btn-primary" data-action="create-worktree"><i data-lucide="git-branch-plus"></i> Create</button>' +
    '</div>' +
    '</div>';
}

function renderWorktreeCard(wt) {
  var id = wt.id;
  var config = wt.config || {};
  var branch = wt.branch || config.branch || "";
  var baseBranch = config.baseBranch || "";
  var desc = config.description || "";
  var state = wt.state || "active";
  var wtPath = wt.path || "";
  var createdAt = wt.createdAt;
  var changedFiles = wt.changedFiles;

  var stateMap = {
    active: "running",
    created: "running",
    merged: "completed",
    removed: "paused",
    error: "error",
  };

  var html = '<div class="fleet-card" data-wt-id="' + esc(id) + '">';
  html += '<div class="fleet-card-header">';
  html += statusDot(stateMap[state] || "paused");
  html += '<code class="fleet-cron-badge">' + esc(branch) + '</code>';
  if (desc) {
    html += '<span class="fleet-card-title">' + esc(desc) + '</span>';
  }
  html += '</div>';

  html += '<div class="fleet-card-stats">';
  if (baseBranch) html += '<span>base: ' + esc(baseBranch) + '</span>';
  if (createdAt) html += '<span>' + esc(timeAgo(createdAt)) + '</span>';
  if (changedFiles != null) html += '<span>' + changedFiles + ' files changed</span>';
  html += '<span class="fleet-state-label">' + esc(state) + '</span>';
  html += '</div>';

  if (wtPath) {
    html += '<div class="hook-command"><code>' + esc(wtPath) + '</code></div>';
  }

  // Actions — only for active worktrees
  if (state === "active" || state === "created") {
    html += '<div class="fleet-card-actions">';
    html += '<button class="fleet-btn fleet-btn-sm fleet-btn-primary" data-action="merge-worktree" data-id="' + esc(id) + '"><i data-lucide="git-merge"></i> Merge</button>';
    html += '<button class="fleet-btn fleet-btn-danger fleet-btn-sm" data-action="remove-worktree" data-id="' + esc(id) + '"><i data-lucide="trash-2"></i> Remove</button>';
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function bindActions(container) {
  container.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-action]");
    if (!btn) return;
    var action = btn.getAttribute("data-action");
    var id = btn.getAttribute("data-id");

    if (action === "create-worktree") {
      var branchInput = document.getElementById("wt-branch-input");
      var baseInput = document.getElementById("wt-base-input");
      var descInput = document.getElementById("wt-desc-input");
      if (!branchInput || !branchInput.value.trim()) return;

      sendWs({
        type: "worktree_create",
        branch: branchInput.value.trim(),
        baseBranch: baseInput ? baseInput.value.trim() || undefined : undefined,
        description: descInput ? descInput.value.trim() || undefined : undefined,
      });
      branchInput.value = "";
      if (descInput) descInput.value = "";
    } else if (action === "merge-worktree") {
      sendWs({ type: "worktree_merge", worktreeId: id });
    } else if (action === "remove-worktree") {
      sendWs({ type: "worktree_remove", worktreeId: id });
    }
  });
  refreshIcons();
}
