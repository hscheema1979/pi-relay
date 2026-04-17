/**
 * costs-panel.js — Cost tracking and usage display panel.
 * Shows aggregated costs by model and operation, with collapsible recent entries.
 *
 * Data sources:
 *   GET api/orchestrator/costs        → CostSummary { period, totalCost, totalInputTokens, totalOutputTokens, totalOperations, byModel, byOperation }
 *   GET api/orchestrator/costs-recent → CostEntry[] { timestamp, operation, model, inputTokens, outputTokens, estimatedCost, durationMs }
 */

import { createPanel, registerFleetPanel, esc, timeAgo, formatDuration } from './panel-base.js';
import { refreshIcons } from './icons.js';

var wsRef = null;
var summaryData = null;
var recentData = null;

// Track which time-group sections are collapsed (default: expanded)
var collapsedSections = {};

var panel = createPanel({
  id: "costs",
  fetchUrl: "api/orchestrator/costs",
  renderFn: renderCosts,
  badgeFn: function (data) {
    if (!data || !data.totalOperations) return null;
    return { count: data.totalOperations, state: "active" };
  },
  fgInterval: 15000,
  bgInterval: 120000,
});

export function initCosts(opts) {
  wsRef = opts;
  panel.init(opts);
  registerFleetPanel("costs", panel);
}

export function toggleCostsPanel() {
  panel.toggle();
}

export function handleCostMessage(msg) {
  panel.handleUpdate();
}

// --- Render ---

function renderCosts(data, bodyEl) {
  summaryData = data;

  // Fetch recent entries in parallel for the timeline
  var basePath = wsRef && wsRef.basePath ? wsRef.basePath : "/";
  fetch(basePath + "api/orchestrator/costs-recent")
    .then(function (r) { return r.json(); })
    .then(function (resp) {
      recentData = (resp && resp.data) ? resp.data : (Array.isArray(resp) ? resp : []);
      doRender(bodyEl);
    })
    .catch(function () {
      recentData = [];
      doRender(bodyEl);
    });
}

function doRender(bodyEl) {
  if (!summaryData || !summaryData.totalOperations) {
    bodyEl.innerHTML =
      '<div class="fleet-empty">No cost data' +
      '<div class="fleet-empty-hint">Costs are tracked when loops, schedules, fleet missions, and autoresearch run.</div>' +
      '</div>';
    return;
  }

  var html = '';

  // --- Summary cards ---
  html += '<div class="cost-summary-grid">';
  html += renderSummaryCard('Total Cost', '$' + summaryData.totalCost.toFixed(4), 'receipt');
  html += renderSummaryCard('Operations', String(summaryData.totalOperations), 'activity');
  html += renderSummaryCard('Input Tokens', formatTokens(summaryData.totalInputTokens), 'arrow-down');
  html += renderSummaryCard('Output Tokens', formatTokens(summaryData.totalOutputTokens), 'arrow-up');
  html += '</div>';

  // --- By Model breakdown ---
  if (summaryData.byModel && Object.keys(summaryData.byModel).length > 0) {
    html += '<div class="fleet-section-header">By Model</div>';
    var models = Object.keys(summaryData.byModel);
    models.sort(function (a, b) { return summaryData.byModel[b].cost - summaryData.byModel[a].cost; });
    for (var i = 0; i < models.length; i++) {
      var m = summaryData.byModel[models[i]];
      html += '<div class="cost-breakdown-row">';
      html += '<span class="cost-breakdown-label"><code>' + esc(models[i]) + '</code></span>';
      html += '<span class="cost-breakdown-stats">';
      html += '<span>$' + m.cost.toFixed(4) + '</span>';
      html += '<span>' + m.operations + ' ops</span>';
      html += '<span>' + formatTokens(m.tokens) + ' tok</span>';
      html += '</span>';
      html += '</div>';
    }
  }

  // --- By Operation breakdown ---
  if (summaryData.byOperation && Object.keys(summaryData.byOperation).length > 0) {
    html += '<div class="fleet-section-header">By Operation</div>';
    var ops = Object.keys(summaryData.byOperation);
    ops.sort(function (a, b) { return summaryData.byOperation[b].cost - summaryData.byOperation[a].cost; });
    for (var j = 0; j < ops.length; j++) {
      var op = summaryData.byOperation[ops[j]];
      html += '<div class="cost-breakdown-row">';
      html += '<span class="cost-breakdown-label">' + esc(ops[j]) + '</span>';
      html += '<span class="cost-breakdown-stats">';
      html += '<span>$' + op.cost.toFixed(4) + '</span>';
      html += '<span>' + op.operations + ' ops</span>';
      html += '</span>';
      html += '</div>';
    }
  }

  // --- Recent entries grouped by time (collapsible) ---
  if (recentData && recentData.length > 0) {
    html += '<div class="fleet-section-header">Recent Activity</div>';
    var groups = groupByTime(recentData);
    var groupKeys = Object.keys(groups);
    for (var g = 0; g < groupKeys.length; g++) {
      var key = groupKeys[g];
      var entries = groups[key];
      var isCollapsed = !!collapsedSections[key];
      var chevron = isCollapsed ? 'chevron-right' : 'chevron-down';

      html += '<div class="cost-time-group">';
      html += '<button class="cost-time-header" data-action="toggle-section" data-section="' + esc(key) + '">';
      html += '<i data-lucide="' + chevron + '" style="width:12px;height:12px"></i> ';
      html += '<span>' + esc(key) + '</span>';
      html += '<span class="cost-time-count">' + entries.length + ' entries &middot; $' + sumCost(entries).toFixed(4) + '</span>';
      html += '</button>';
      html += '<div class="cost-time-entries' + (isCollapsed ? ' hidden' : '') + '" data-entries-for="' + esc(key) + '">';
      for (var e = entries.length - 1; e >= 0; e--) {
        html += renderRecentEntry(entries[e]);
      }
      html += '</div>';
      html += '</div>';
    }
  }

  bodyEl.innerHTML = html;
  bindActions(bodyEl);
}

function renderSummaryCard(label, value, icon) {
  return '<div class="cost-summary-card">' +
    '<div class="cost-summary-icon"><i data-lucide="' + icon + '" style="width:16px;height:16px"></i></div>' +
    '<div class="cost-summary-value">' + esc(value) + '</div>' +
    '<div class="cost-summary-label">' + esc(label) + '</div>' +
    '</div>';
}

function renderRecentEntry(entry) {
  var ts = entry.timestamp ? new Date(entry.timestamp) : null;
  var timeStr = ts ? ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  var html = '<div class="cost-entry">';
  html += '<span class="cost-entry-time">' + esc(timeStr) + '</span>';
  html += '<span class="cost-entry-op">' + esc(entry.operation || '') + '</span>';
  html += '<span class="cost-entry-model"><code>' + esc(entry.model || '') + '</code></span>';
  html += '<span class="cost-entry-cost">$' + (entry.estimatedCost || 0).toFixed(4) + '</span>';
  if (entry.durationMs) {
    html += '<span class="cost-entry-dur">' + formatDuration(entry.durationMs) + '</span>';
  }
  html += '</div>';
  return html;
}

// --- Helpers ---

function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function sumCost(entries) {
  var total = 0;
  for (var i = 0; i < entries.length; i++) {
    total += entries[i].estimatedCost || 0;
  }
  return total;
}

/** Group entries by relative time bucket: "Today", "Yesterday", "This Week", "Older" */
function groupByTime(entries) {
  var now = new Date();
  var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  var yesterdayStart = todayStart - 86400000;
  var weekStart = todayStart - 6 * 86400000;

  var groups = {};
  for (var i = 0; i < entries.length; i++) {
    var ts = new Date(entries[i].timestamp).getTime();
    var bucket;
    if (ts >= todayStart) bucket = 'Today';
    else if (ts >= yesterdayStart) bucket = 'Yesterday';
    else if (ts >= weekStart) bucket = 'This Week';
    else bucket = 'Older';

    if (!groups[bucket]) groups[bucket] = [];
    groups[bucket].push(entries[i]);
  }
  return groups;
}

function bindActions(container) {
  container.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-action]");
    if (!btn) return;
    var action = btn.getAttribute("data-action");

    if (action === "toggle-section") {
      var section = btn.getAttribute("data-section");
      collapsedSections[section] = !collapsedSections[section];
      var entriesEl = container.querySelector('[data-entries-for="' + section + '"]');
      if (entriesEl) entriesEl.classList.toggle("hidden");
      // Swap chevron icon
      var iconEl = btn.querySelector("i[data-lucide]");
      if (iconEl) {
        var newIcon = collapsedSections[section] ? "chevron-right" : "chevron-down";
        iconEl.setAttribute("data-lucide", newIcon);
      }
      refreshIcons();
    }
  });
  refreshIcons();
}
