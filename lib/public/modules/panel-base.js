/**
 * panel-base.js — Reusable panel factory for fleet orchestration panels.
 *
 * Extracts the common pattern from autonomous.js:
 *   init() → sidebar button + badge → panel toggle → WS event → debounced polling → render
 *
 * Usage:
 *   const panel = createPanel({
 *     id: 'loops',
 *     fetchUrl: 'api/orchestrator/loops',
 *     renderFn: (data, bodyEl) => { bodyEl.innerHTML = '...'; },
 *     badgeFn: (data) => ({ count: 3, state: 'active' }),
 *   });
 *   panel.init({ basePath: '/' });
 *   panel.handleUpdate(msg);  // called from WS handler
 */

import { refreshIcons } from './icons.js';

/**
 * @param {object} cfg
 * @param {string} cfg.id         - Panel identifier (e.g. 'loops', 'schedules')
 * @param {string} cfg.fetchUrl   - Relative API URL (appended to basePath)
 * @param {function} cfg.renderFn - (data, bodyEl, opts) => void — renders panel body
 * @param {function} [cfg.badgeFn] - (data) => { count, state } | null — updates badge
 * @param {number} [cfg.fgInterval] - Foreground poll interval (ms), default 5000
 * @param {number} [cfg.bgInterval] - Background poll interval (ms), default 30000
 * @param {number} [cfg.debounceMs] - Debounce for WS-triggered fetches (ms), default 500
 */
export function createPanel(cfg) {
  var id = cfg.id;
  var fetchUrl = cfg.fetchUrl;
  var renderFn = cfg.renderFn;
  var badgeFn = cfg.badgeFn || null;
  var FG_INTERVAL = cfg.fgInterval || 5000;
  var BG_INTERVAL = cfg.bgInterval || 30000;
  var DEBOUNCE_MS = cfg.debounceMs || 500;

  var panelEl = null;
  var bodyEl = null;
  var refreshBtn = null;
  var closeBtn = null;
  var sidebarBtn = null;
  var badgeEl = null;
  var basePath = "/";
  var optsRef = null;

  // Polling
  var activeTimer = null;
  var bgTimer = null;
  var debounceTimer = null;
  var fetchInFlight = false;
  var fetchPendingAfter = false;

  // Last fetched data (accessible for external use)
  var lastData = null;

  function init(opts) {
    basePath = opts.basePath || "/";
    optsRef = opts;

    panelEl = document.getElementById(id + "-panel");
    bodyEl = document.getElementById(id + "-panel-body");
    refreshBtn = document.getElementById(id + "-panel-refresh");
    closeBtn = document.getElementById(id + "-panel-close");
    sidebarBtn = document.getElementById(id + "-sidebar-btn");

    if (sidebarBtn) {
      badgeEl = document.createElement("span");
      badgeEl.className = "fleet-badge " + id + "-badge";
      sidebarBtn.appendChild(badgeEl);

      sidebarBtn.addEventListener("click", function () {
        toggle();
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        close();
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener("click", function () {
        doFetch();
      });
    }

    // Start background polling for badge
    startBgPolling();
  }

  function toggle() {
    if (!panelEl) return;
    // Close other fleet panels first
    closeOtherFleetPanels(id);
    var opening = panelEl.classList.contains("hidden");
    panelEl.classList.toggle("hidden");
    if (opening) {
      doFetch();
      startFgPolling();
      stopBgPolling();
    } else {
      stopFgPolling();
      startBgPolling();
    }
    refreshIcons();
  }

  function close() {
    if (panelEl) panelEl.classList.add("hidden");
    stopFgPolling();
    startBgPolling();
  }

  function handleUpdate() {
    debouncedFetch();
  }

  // --- Polling ---

  function startFgPolling() {
    stopFgPolling();
    activeTimer = setInterval(doFetch, FG_INTERVAL);
  }

  function stopFgPolling() {
    if (activeTimer) { clearInterval(activeTimer); activeTimer = null; }
  }

  function startBgPolling() {
    stopBgPolling();
    debouncedFetch();
    bgTimer = setInterval(doFetch, BG_INTERVAL);
  }

  function stopBgPolling() {
    if (bgTimer) { clearInterval(bgTimer); bgTimer = null; }
  }

  function debouncedFetch() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      doFetch();
    }, DEBOUNCE_MS);
  }

  function doFetch() {
    if (fetchInFlight) { fetchPendingAfter = true; return; }
    fetchInFlight = true;
    fetchPendingAfter = false;

    fetch(basePath + fetchUrl)
      .then(function (r) { return r.json(); })
      .then(function (resp) {
        var data = resp.data;
        lastData = data;
        updateBadge(data);
        if (panelEl && !panelEl.classList.contains("hidden") && bodyEl) {
          renderFn(data, bodyEl, optsRef);
          refreshIcons();
        }
      })
      .catch(function () {
        if (panelEl && !panelEl.classList.contains("hidden") && bodyEl) {
          bodyEl.innerHTML = '<div class="fleet-empty">Failed to load data</div>';
        }
      })
      .then(function () {
        fetchInFlight = false;
        if (fetchPendingAfter) { fetchPendingAfter = false; doFetch(); }
      });
  }

  function updateBadge(data) {
    if (!badgeEl || !badgeFn) return;
    var info = badgeFn(data);
    if (!info || !info.count) {
      badgeEl.style.display = "none";
      badgeEl.textContent = "";
      if (sidebarBtn) {
        sidebarBtn.classList.remove("has-active", "has-warning", "has-error");
      }
      return;
    }
    badgeEl.style.display = "";
    badgeEl.textContent = info.count > 99 ? "99+" : String(info.count);
    if (sidebarBtn) {
      sidebarBtn.classList.remove("has-active", "has-warning", "has-error");
      if (info.state === "active") sidebarBtn.classList.add("has-active");
      else if (info.state === "warning") sidebarBtn.classList.add("has-warning");
      else if (info.state === "error") sidebarBtn.classList.add("has-error");
    }
  }

  function isOpen() {
    return panelEl && !panelEl.classList.contains("hidden");
  }

  function sendWs(msg) {
    if (optsRef && optsRef.ws) {
      var socket = typeof optsRef.ws === "function" ? optsRef.ws : optsRef.ws;
      if (typeof socket === "object" && socket.readyState === 1) {
        socket.send(JSON.stringify(msg));
      }
    }
  }

  function destroy() {
    stopFgPolling();
    stopBgPolling();
    if (debounceTimer) clearTimeout(debounceTimer);
  }

  return {
    init: init,
    toggle: toggle,
    close: close,
    handleUpdate: handleUpdate,
    isOpen: isOpen,
    destroy: destroy,
    sendWs: sendWs,
    get lastData() { return lastData; },
    get panelEl() { return panelEl; },
    get bodyEl() { return bodyEl; },
  };
}

// --- Cross-panel coordination ---
// Only one fleet panel should be open at a time.

var registeredPanels = {};

export function registerFleetPanel(id, panelInstance) {
  registeredPanels[id] = panelInstance;
}

function closeOtherFleetPanels(currentId) {
  for (var pid in registeredPanels) {
    if (pid !== currentId && registeredPanels[pid].isOpen()) {
      registeredPanels[pid].close();
    }
  }
}

// --- Shared utilities for fleet panel rendering ---

export function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function timeAgo(dateStr) {
  var d = new Date(dateStr);
  var now = Date.now();
  var diff = now - d.getTime();
  if (diff < 0) return "just now";
  if (diff < 60000) return Math.floor(diff / 1000) + "s ago";
  if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
  if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
  return Math.floor(diff / 86400000) + "d ago";
}

export function formatDuration(ms) {
  if (!ms) return "-";
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  if (ms < 3600000) return Math.floor(ms / 60000) + "m " + Math.floor((ms % 60000) / 1000) + "s";
  return Math.floor(ms / 3600000) + "h " + Math.floor((ms % 3600000) / 60000) + "m";
}

export function statusDot(state) {
  var color = state === "running" ? "var(--accent)" :
              state === "completed" || state === "done" ? "var(--success, #22c55e)" :
              state === "paused" ? "var(--warning, #e0a000)" :
              state === "failed" || state === "error" ? "var(--error)" :
              "var(--text-muted)";
  return '<span class="fleet-status-dot" style="background:' + color + '"></span>';
}
