/**
 * autonomous.js — Browser-side Autonomous Work panel.
 * Fetches autonomous session data from /api/autonomous-sessions and renders
 * active, interrupted, and recent sessions in a unified panel.
 */

import { showToast } from './utils.js';
import { refreshIcons } from './icons.js';

var panelEl = null;
var bodyEl = null;
var refreshBtn = null;
var closeBtn = null;
var sidebarBtn = null;
var badgeEl = null;
var basePath = "/";
var optsRef = null;

// Polling timers
var activeTimer = null;    // fast poll when panel open
var bgTimer = null;        // slow poll when panel closed
var BG_INTERVAL = 30000;   // 30s background poll
var FG_INTERVAL = 5000;    // 5s foreground poll

// Last known state for badge updates
var lastData = null;

export function initAutonomous(opts) {
  basePath = opts.basePath || "/";
  optsRef = opts;

  panelEl = document.getElementById("autonomous-panel");
  bodyEl = document.getElementById("autonomous-panel-body");
  refreshBtn = document.getElementById("autonomous-panel-refresh");
  closeBtn = document.getElementById("autonomous-panel-close");
  sidebarBtn = document.getElementById("autonomous-sidebar-btn");

  if (sidebarBtn) {
    // Create badge element
    badgeEl = document.createElement("span");
    badgeEl.className = "autonomous-badge";
    sidebarBtn.appendChild(badgeEl);

    sidebarBtn.addEventListener("click", function () {
      toggleAutonomousPanel();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener("click", function () {
      closeAutonomousPanel();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", function () {
      loadAutonomousSessions();
    });
  }

  // Start background polling for badge updates
  startBgPolling();
}

export function toggleAutonomousPanel() {
  if (!panelEl) return;
  var opening = panelEl.classList.contains("hidden");
  panelEl.classList.toggle("hidden");
  if (opening) {
    loadAutonomousSessions();
    startFgPolling();
    stopBgPolling();
  } else {
    stopFgPolling();
    startBgPolling();
  }
  refreshIcons();
}

export function closeAutonomousPanel() {
  if (panelEl) panelEl.classList.add("hidden");
  stopFgPolling();
  startBgPolling();
}

/**
 * Called externally when an autonomous_update WebSocket message arrives.
 * Triggers an immediate refresh.
 */
export function handleAutonomousUpdate() {
  loadAutonomousSessions();
}

// --- Polling ---

function startFgPolling() {
  stopFgPolling();
  activeTimer = setInterval(loadAutonomousSessions, FG_INTERVAL);
}

function stopFgPolling() {
  if (activeTimer) {
    clearInterval(activeTimer);
    activeTimer = null;
  }
}

function startBgPolling() {
  stopBgPolling();
  // Initial badge fetch
  loadAutonomousSessions();
  bgTimer = setInterval(loadAutonomousSessions, BG_INTERVAL);
}

function stopBgPolling() {
  if (bgTimer) {
    clearInterval(bgTimer);
    bgTimer = null;
  }
}

// --- Data fetching ---

function loadAutonomousSessions() {
  fetch(basePath + "api/autonomous-sessions")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      lastData = data;
      updateBadge(data);
      if (panelEl && !panelEl.classList.contains("hidden")) {
        renderPanel(data);
      }
    })
    .catch(function () {
      if (panelEl && !panelEl.classList.contains("hidden") && bodyEl) {
        bodyEl.innerHTML = '<div class="autonomous-empty">Failed to load autonomous sessions</div>';
      }
    });
}

// --- Badge ---

function updateBadge(data) {
  if (!sidebarBtn) return;
  sidebarBtn.classList.remove("has-active", "has-interrupted", "has-failed");

  var hasActive = data.active && data.active.length > 0;
  var hasInterrupted = data.interrupted && data.interrupted.length > 0;
  var hasFailed = false;

  if (data.recent) {
    for (var i = 0; i < data.recent.length; i++) {
      if (data.recent[i].status === "failed" || data.recent[i].status === "escalated") {
        // Only show failed badge for recent failures (< 5 min)
        var age = Date.now() - new Date(data.recent[i].completedAt).getTime();
        if (age < 300000) {
          hasFailed = true;
          break;
        }
      }
    }
  }

  // Priority: interrupted > failed > active
  if (hasInterrupted) {
    sidebarBtn.classList.add("has-interrupted");
  } else if (hasFailed) {
    sidebarBtn.classList.add("has-failed");
  } else if (hasActive) {
    sidebarBtn.classList.add("has-active");
  }
}

// --- Rendering ---

function renderPanel(data) {
  if (!bodyEl) return;

  var active = data.active || [];
  var interrupted = data.interrupted || [];
  var recent = data.recent || [];

  if (active.length === 0 && interrupted.length === 0 && recent.length === 0) {
    bodyEl.innerHTML = '<div class="autonomous-empty">No autonomous work<div class="autonomous-empty-hint">Execution mode plans and agent-fix sessions will appear here.</div></div>';
    return;
  }

  var html = "";

  // ACTIVE section
  if (active.length > 0) {
    html += '<div class="autonomous-section-header"><span class="autonomous-section-icon">▶</span> Active</div>';
    for (var i = 0; i < active.length; i++) {
      html += renderActiveCard(active[i]);
    }
  }

  // INTERRUPTED section
  if (interrupted.length > 0) {
    html += '<div class="autonomous-section-header"><span class="autonomous-section-icon">⚠</span> Interrupted</div>';
    for (var j = 0; j < interrupted.length; j++) {
      html += renderInterruptedCard(interrupted[j]);
    }
  }

  // RECENT section
  if (recent.length > 0) {
    html += '<div class="autonomous-section-header"><span class="autonomous-section-icon">✓</span> Recent</div>';
    for (var k = 0; k < recent.length; k++) {
      html += renderRecentItem(recent[k]);
    }
  }

  bodyEl.innerHTML = html;
  bindCardActions();
  refreshIcons();
}

function renderActiveCard(session) {
  var icon = session.type === "agent-fix" ? "🔧" : "📋";
  var title = getSessionTitle(session);
  var meta = getSessionMeta(session);

  var html = '<div class="autonomous-card" data-session-id="' + esc(session.sessionId || "") + '">';
  html += '<div class="autonomous-card-header">';
  html += '<span class="autonomous-card-icon">' + icon + '</span>';
  html += '<span class="autonomous-card-title">' + esc(title) + '</span>';
  html += '<span class="autonomous-status autonomous-status-active">active</span>';
  html += '</div>';
  html += '<div class="autonomous-card-meta">' + meta + '</div>';

  // Phase progress for execution-mode
  if (session.type === "execution-mode" && session.plan) {
    html += renderPhaseProgress(session.plan);
  }

  // Safety counters
  if (session.safetyCounters) {
    html += '<div class="autonomous-safety">';
    html += '<span>Continuations: ' + (session.safetyCounters.continuations || 0) + '/' + (session.safetyCounters.maxContinuations || 10) + '</span>';
    html += '</div>';
  }

  // Action buttons
  html += '<div class="autonomous-card-actions">';
  if (session.sessionId) {
    html += '<button class="autonomous-btn autonomous-btn-primary" data-action="watch" data-session-id="' + esc(session.sessionId) + '">Watch</button>';
  }
  if (session.type === "execution-mode") {
    html += '<button class="autonomous-btn" data-action="pause" data-session-id="' + esc(session.sessionId || "") + '">Pause</button>';
  }
  html += '<button class="autonomous-btn autonomous-btn-danger" data-action="stop" data-session-id="' + esc(session.sessionId || "") + '">Stop</button>';
  html += '</div>';

  html += '</div>';
  return html;
}

function renderInterruptedCard(session) {
  var icon = session.type === "agent-fix" ? "🔧" : "📋";
  var title = getSessionTitle(session);

  var html = '<div class="autonomous-card" data-session-id="' + esc(session.sessionId || "") + '">';
  html += '<div class="autonomous-card-header">';
  html += '<span class="autonomous-card-icon">' + icon + '</span>';
  html += '<span class="autonomous-card-title">' + esc(title) + '</span>';
  html += '<span class="autonomous-status autonomous-status-interrupted">interrupted</span>';
  html += '</div>';

  // Reason
  var reason = session.interruptReason || session.reason || "unknown";
  var reasonText = reason === "process_death" ? "Server crashed" :
                   reason === "graceful_shutdown" ? "Server restarted" :
                   reason;
  html += '<div class="autonomous-interrupt-reason">' + esc(reasonText) + '</div>';

  // Meta
  var interruptedAgo = session.interruptedAt ? timeAgo(session.interruptedAt) : "";
  html += '<div class="autonomous-card-meta">';
  if (interruptedAgo) html += '<span>Interrupted ' + interruptedAgo + '</span>';
  html += '</div>';

  // Phase progress for execution-mode
  if (session.type === "execution-mode" && session.plan) {
    html += renderPhaseProgress(session.plan);
  }

  // Action buttons
  html += '<div class="autonomous-card-actions">';
  if (session.type === "execution-mode") {
    html += '<button class="autonomous-btn autonomous-btn-primary" data-action="resume" data-session-id="' + esc(session.sessionId || "") + '">Resume</button>';
  }
  html += '<button class="autonomous-btn" data-action="dismiss" data-session-id="' + esc(session.sessionId || "") + '">Dismiss</button>';
  html += '</div>';

  html += '</div>';
  return html;
}

function renderRecentItem(session) {
  var isSuccess = session.status === "resolved" || session.status === "completed";
  var icon = isSuccess ? "✅" : "❌";
  var title = getSessionTitle(session);
  var detail = getRecentDetail(session);
  var completedAgo = session.completedAt ? timeAgo(session.completedAt) : "";

  var html = '<div class="autonomous-recent-item">';
  html += '<span class="autonomous-recent-icon">' + icon + '</span>';
  html += '<div class="autonomous-recent-info">';
  html += '<div class="autonomous-recent-title">' + esc(title) + '</div>';
  html += '<div class="autonomous-recent-detail">' + esc(detail) + '</div>';
  if (session.diagnosis) {
    html += '<div class="autonomous-diagnosis">' + esc(truncate(session.diagnosis, 80)) + '</div>';
  }
  html += '</div>';
  html += '<span class="autonomous-recent-time">' + completedAgo + '</span>';
  html += '</div>';
  return html;
}

function renderPhaseProgress(plan) {
  var current = plan.currentPhase || 0;
  var total = plan.totalPhases || (plan.phases ? plan.phases.length : 0);
  var phaseName = plan.phaseName || (plan.phases && plan.phases[current - 1] ? plan.phases[current - 1].name : "");
  var pct = total > 0 ? Math.round((current / total) * 100) : 0;

  var html = '<div class="autonomous-progress-wrap">';
  html += '<div class="autonomous-progress-label">';
  html += '<span>Phase ' + current + '/' + total;
  if (phaseName) html += ' · ' + esc(truncate(phaseName, 30));
  html += '</span>';
  html += '<span>' + pct + '%</span>';
  html += '</div>';
  html += '<div class="autonomous-progress-bar">';
  html += '<div class="autonomous-progress-fill" style="width:' + pct + '%"></div>';
  html += '</div>';
  html += '</div>';
  return html;
}

// --- Action button handlers ---

function bindCardActions() {
  if (!bodyEl) return;

  var buttons = bodyEl.querySelectorAll("[data-action]");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", handleCardAction);
  }
}

function handleCardAction(e) {
  var btn = e.currentTarget;
  var action = btn.dataset.action;
  var sessionId = btn.dataset.sessionId;
  if (!action) return;

  switch (action) {
    case "watch":
      // Switch to the relay session to watch live
      switchToSession(sessionId);
      break;
    case "pause":
      sendSessionCommand(sessionId, "/exec pause");
      showToast("Pause requested");
      break;
    case "stop":
      sendSessionCommand(sessionId, "/exec stop");
      showToast("Stop requested");
      break;
    case "resume":
      sendSessionCommand(sessionId, "/exec resume");
      showToast("Resume requested");
      break;
    case "dismiss":
      dismissSession(sessionId);
      break;
  }
}

function switchToSession(sessionId) {
  if (!sessionId) return;
  var ws = optsRef ? optsRef.ws : null;
  var connected = optsRef ? optsRef.connected : false;
  if (ws && connected) {
    ws.send(JSON.stringify({ type: "switch_session", id: parseInt(sessionId, 10) || sessionId }));
    closeAutonomousPanel();
  }
}

function sendSessionCommand(sessionId, command) {
  var ws = optsRef ? optsRef.ws : null;
  var connected = optsRef ? optsRef.connected : false;
  if (ws && connected && sessionId) {
    // Send a user message to the target session with the slash command
    ws.send(JSON.stringify({
      type: "autonomous_action",
      sessionId: sessionId,
      command: command,
    }));
  }
}

function dismissSession(sessionId) {
  if (!sessionId) return;
  fetch(basePath + "api/autonomous-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "dismiss", sessionId: sessionId }),
  })
    .then(function () {
      showToast("Session dismissed");
      loadAutonomousSessions();
    })
    .catch(function () {
      showToast("Failed to dismiss", "warn");
    });
}

// --- Helpers ---

function getSessionTitle(session) {
  if (session.type === "agent-fix") {
    var svc = session.service || "unknown";
    var machine = session.machine ? " @ " + session.machine : "";
    return "Fix: " + svc + machine;
  }
  if (session.type === "execution-mode") {
    if (session.plan && session.plan.text) {
      return "Exec: " + truncate(session.plan.text, 40);
    }
    if (session.plan && session.plan.id) {
      return "Exec: " + session.plan.id;
    }
    return "Execution Mode";
  }
  return session.type || "Autonomous";
}

function getSessionMeta(session) {
  var parts = [];

  if (session.type === "agent-fix") {
    if (session.problemType) parts.push(esc(session.problemType));
    if (session.tier) parts.push("Tier " + session.tier);
  }

  if (session.startedAt) {
    parts.push(elapsed(session.startedAt));
  }

  return parts.join(' <span class="autonomous-meta-sep"></span> ');
}

function getRecentDetail(session) {
  var parts = [];

  if (session.type === "agent-fix") {
    if (session.problemType) parts.push(session.problemType);
    if (session.tier) parts.push("Tier " + session.tier);
  }

  if (session.type === "execution-mode" && session.plan) {
    var total = session.plan.totalPhases || (session.plan.phases ? session.plan.phases.length : 0);
    if (total) parts.push(total + " phases");
  }

  if (session.duration) {
    parts.push(formatDuration(session.duration));
  }

  return parts.join(" · ");
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

function elapsed(dateStr) {
  if (!dateStr) return "";
  var diff = Math.max(0, Date.now() - new Date(dateStr).getTime());
  return formatDuration(diff);
}

function formatDuration(ms) {
  var sec = Math.floor(ms / 1000);
  if (sec < 60) return sec + "s";
  var min = Math.floor(sec / 60);
  if (min < 60) return min + "m " + (sec % 60) + "s";
  var hr = Math.floor(min / 60);
  return hr + "h " + (min % 60) + "m";
}

function truncate(str, max) {
  if (!str) return "";
  if (str.length <= max) return str;
  return str.substring(0, max) + "…";
}

function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
