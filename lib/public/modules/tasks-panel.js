/**
 * tasks-panel.js — Tasks panel for fleet orchestration.
 * Kanban-style display: pending → in_progress → completed → blocked.
 */

import { createPanel, registerFleetPanel, esc, timeAgo, statusDot } from './panel-base.js';
import { refreshIcons } from './icons.js';

var wsRef = null;

var panel = createPanel({
  id: "tasks",
  fetchUrl: "api/orchestrator/tasks",
  renderFn: renderTasks,
  badgeFn: function (data) {
    if (!data || !Array.isArray(data)) return null;
    var inProgress = 0;
    for (var i = 0; i < data.length; i++) {
      if (data[i].status === "in_progress") inProgress++;
    }
    return inProgress > 0 ? { count: inProgress, state: "active" } : null;
  },
  fgInterval: 5000,
  bgInterval: 30000,
});

export function initTasks(opts) {
  wsRef = opts;
  panel.init(opts);
  registerFleetPanel("tasks", panel);
}

export function toggleTasksPanel() {
  panel.toggle();
}

export function handleTaskMessage(msg) {
  panel.handleUpdate();
}

function sendWs(msg) {
  if (wsRef && wsRef.ws && typeof wsRef.ws === "object" && wsRef.ws.readyState === 1) {
    wsRef.ws.send(JSON.stringify(msg));
  }
}

var PRIORITY_COLORS = {
  critical: "var(--error)",
  high: "#f97316",
  medium: "var(--warning, #e0a000)",
  low: "var(--text-muted)",
};

var STATUS_ORDER = ["in_progress", "pending", "blocked", "completed"];

function renderTasks(data, bodyEl) {
  if (!data || !Array.isArray(data) || data.length === 0) {
    bodyEl.innerHTML =
      '<div class="fleet-empty">No tasks' +
      '<div class="fleet-empty-hint">Create tasks to track work items with priorities and dependencies.</div>' +
      '</div>' +
      renderCreateForm();
    bindActions(bodyEl);
    return;
  }

  // Group by status
  var groups = {};
  for (var i = 0; i < STATUS_ORDER.length; i++) groups[STATUS_ORDER[i]] = [];
  for (var j = 0; j < data.length; j++) {
    var s = data[j].status || "pending";
    if (!groups[s]) groups[s] = [];
    groups[s].push(data[j]);
  }

  var html = renderCreateForm();

  // Summary bar
  html += '<div class="fleet-summary-bar">';
  for (var k = 0; k < STATUS_ORDER.length; k++) {
    var st = STATUS_ORDER[k];
    var count = groups[st] ? groups[st].length : 0;
    html += '<span class="fleet-summary-item">' + statusDot(st === "in_progress" ? "running" : st === "blocked" ? "paused" : st) + ' ' + st.replace("_", " ") + ': ' + count + '</span>';
  }
  html += '</div>';

  // Render each group
  var labels = { in_progress: "In Progress", pending: "Pending", blocked: "Blocked", completed: "Completed" };
  var icons = { in_progress: "running", pending: "pending", blocked: "paused", completed: "completed" };

  for (var m = 0; m < STATUS_ORDER.length; m++) {
    var status = STATUS_ORDER[m];
    var tasks = groups[status];
    if (!tasks || tasks.length === 0) continue;

    html += '<div class="fleet-section-header">' + statusDot(icons[status]) + ' ' + labels[status] + ' (' + tasks.length + ')</div>';
    for (var n = 0; n < tasks.length; n++) {
      html += renderTaskCard(tasks[n]);
    }
  }

  bodyEl.innerHTML = html;
  bindActions(bodyEl);
}

function renderCreateForm() {
  return '<div class="fleet-create-form">' +
    '<div class="fleet-create-row">' +
    '<input type="text" id="task-title-input" class="fleet-input" placeholder="Task title..." />' +
    '</div>' +
    '<div class="fleet-create-row fleet-create-options">' +
    '<select id="task-priority-select" class="fleet-select">' +
    '<option value="medium">Medium</option>' +
    '<option value="low">Low</option>' +
    '<option value="high">High</option>' +
    '<option value="critical">Critical</option>' +
    '</select>' +
    '<input type="text" id="task-tags-input" class="fleet-input fleet-input-sm" placeholder="Tags (comma)" />' +
    '<button class="fleet-btn fleet-btn-primary" data-action="create-task"><i data-lucide="plus"></i> Add</button>' +
    '</div>' +
    '</div>';
}

function renderTaskCard(task) {
  var id = task.id;
  var title = task.config ? task.config.title : task.title || id;
  var desc = task.config ? task.config.description : "";
  var priority = task.config ? task.config.priority : "medium";
  var status = task.status || "pending";
  var tags = task.config && task.config.tags ? task.config.tags : [];
  var deps = task.config && task.config.dependencies ? task.config.dependencies : [];
  var created = task.createdAt ? timeAgo(task.createdAt) : "";

  var prioColor = PRIORITY_COLORS[priority] || PRIORITY_COLORS.medium;

  var html = '<div class="fleet-card task-card" data-task-id="' + esc(id) + '">';
  html += '<div class="task-priority-bar" style="background:' + prioColor + '"></div>';
  html += '<div class="fleet-card-header">';
  html += '<span class="fleet-card-title">' + esc(title) + '</span>';
  html += '<span class="task-priority-label" style="color:' + prioColor + '">' + esc(priority) + '</span>';
  html += '</div>';

  if (desc) {
    html += '<div class="fleet-card-desc">' + esc(desc.slice(0, 120)) + '</div>';
  }

  html += '<div class="fleet-card-stats">';
  if (tags.length > 0) {
    html += '<span class="task-tags">';
    for (var i = 0; i < tags.length; i++) {
      html += '<span class="task-tag">' + esc(tags[i]) + '</span>';
    }
    html += '</span>';
  }
  if (deps.length > 0) {
    html += '<span>deps: ' + deps.length + '</span>';
  }
  html += '<span>' + esc(created) + '</span>';
  html += '</div>';

  // Status transition buttons
  html += '<div class="fleet-card-actions">';
  if (status === "pending") {
    html += '<button class="fleet-btn fleet-btn-primary fleet-btn-sm" data-action="task-status" data-id="' + esc(id) + '" data-status="in_progress">Start</button>';
  } else if (status === "in_progress") {
    html += '<button class="fleet-btn fleet-btn-sm" data-action="task-status" data-id="' + esc(id) + '" data-status="completed">Done</button>';
    html += '<button class="fleet-btn fleet-btn-sm" data-action="task-status" data-id="' + esc(id) + '" data-status="blocked">Block</button>';
  } else if (status === "blocked") {
    html += '<button class="fleet-btn fleet-btn-sm" data-action="task-status" data-id="' + esc(id) + '" data-status="in_progress">Unblock</button>';
  }
  html += '<button class="fleet-btn fleet-btn-danger fleet-btn-sm" data-action="delete-task" data-id="' + esc(id) + '"><i data-lucide="trash-2"></i></button>';
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

    if (action === "create-task") {
      var title = document.getElementById("task-title-input");
      var priority = document.getElementById("task-priority-select");
      var tagsInput = document.getElementById("task-tags-input");
      if (!title || !title.value.trim()) return;

      var tags = tagsInput && tagsInput.value.trim() ? tagsInput.value.split(",").map(function (t) { return t.trim(); }).filter(Boolean) : [];

      sendWs({
        type: "task_create",
        title: title.value.trim(),
        priority: priority.value,
        tags: tags,
      });
      title.value = "";
      if (tagsInput) tagsInput.value = "";
    } else if (action === "task-status") {
      var status = btn.getAttribute("data-status");
      sendWs({ type: "task_update_status", taskId: id, status: status });
    } else if (action === "delete-task") {
      sendWs({ type: "task_delete", taskId: id });
    }
  });
  refreshIcons();
}
