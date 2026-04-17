/**
 * machines-panel.js — Machine registry panel for cross-VPS fleet management.
 * Shows all registered machines, their status, capabilities, and projects.
 */

import { createPanel, registerFleetPanel, esc, statusDot } from './panel-base.js';
import { refreshIcons } from './icons.js';

var wsRef = null;

var panel = createPanel({
  id: "machines",
  fetchUrl: "api/orchestrator/machines",
  renderFn: renderMachines,
  badgeFn: function (data) {
    if (!data || !Array.isArray(data)) return null;
    var available = 0;
    for (var i = 0; i < data.length; i++) {
      if (data[i].available) available++;
    }
    return available > 0 ? { count: available, state: "active" } : null;
  },
  fgInterval: 15000,
  bgInterval: 60000,
});

export function initMachines(opts) {
  wsRef = opts;
  panel.init(opts);
  registerFleetPanel("machines", panel);
}

export function toggleMachinesPanel() {
  panel.toggle();
}

export function handleMachineMessage(msg) {
  panel.handleUpdate();
}

function sendWs(msg) {
  if (wsRef && wsRef.ws && typeof wsRef.ws === "object" && wsRef.ws.readyState === 1) {
    wsRef.ws.send(JSON.stringify(msg));
  }
}

function renderMachines(data, bodyEl) {
  if (!data || !Array.isArray(data) || data.length === 0) {
    bodyEl.innerHTML =
      '<div class="fleet-empty">No machines registered' +
      '<div class="fleet-empty-hint">Machines are auto-discovered from the fleet configuration.</div>' +
      '</div>';
    return;
  }

  var available = [], unavailable = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i].available !== false) available.push(data[i]);
    else unavailable.push(data[i]);
  }

  var html = '';

  // Overview bar
  html += '<div class="fleet-summary-bar">';
  html += '<span class="fleet-summary-item">' + statusDot("running") + ' Available: ' + available.length + '</span>';
  html += '<span class="fleet-summary-item">' + statusDot("failed") + ' Unavailable: ' + unavailable.length + '</span>';
  html += '<span class="fleet-summary-item">Total: ' + data.length + '</span>';
  html += '</div>';

  if (available.length > 0) {
    html += '<div class="fleet-section-header">' + statusDot("running") + ' Available (' + available.length + ')</div>';
    for (var a = 0; a < available.length; a++) html += renderMachineCard(available[a]);
  }

  if (unavailable.length > 0) {
    html += '<div class="fleet-section-header">' + statusDot("failed") + ' Unavailable (' + unavailable.length + ')</div>';
    for (var u = 0; u < unavailable.length; u++) html += renderMachineCard(unavailable[u]);
  }

  bodyEl.innerHTML = html;
  bindActions(bodyEl);
}

function renderMachineCard(machine) {
  var id = machine.id;
  var hostname = machine.hostname || id;
  var ip = machine.ip || "";
  var port = machine.port || "";
  var role = machine.role || "";
  var specs = machine.specs || "";
  var sshUser = machine.sshUser || "";
  var caps = machine.capabilities || [];
  var projects = machine.projects || [];
  var available = machine.available !== false;

  var html = '<div class="fleet-card machine-card" data-machine-id="' + esc(id) + '">';

  html += '<div class="fleet-card-header">';
  html += statusDot(available ? "running" : "failed");
  html += '<span class="fleet-card-title machine-hostname">' + esc(hostname.toUpperCase()) + '</span>';
  html += '<span class="fleet-card-meta">' + esc(role) + '</span>';
  html += '</div>';

  html += '<div class="machine-details">';
  html += '<div class="machine-detail-row">';
  html += '<span class="machine-label">IP</span><span class="machine-value">' + esc(ip) + ':' + esc(String(port)) + '</span>';
  html += '</div>';
  if (specs) {
    html += '<div class="machine-detail-row">';
    html += '<span class="machine-label">Specs</span><span class="machine-value">' + esc(specs) + '</span>';
    html += '</div>';
  }
  if (sshUser) {
    html += '<div class="machine-detail-row">';
    html += '<span class="machine-label">SSH</span><span class="machine-value">' + esc(sshUser) + '@' + esc(ip) + '</span>';
    html += '</div>';
  }
  html += '</div>';

  // Capabilities
  if (caps.length > 0) {
    html += '<div class="machine-caps">';
    for (var i = 0; i < caps.length; i++) {
      html += '<span class="machine-cap-tag">' + esc(caps[i]) + '</span>';
    }
    html += '</div>';
  }

  // Projects
  if (projects.length > 0) {
    html += '<div class="machine-projects">';
    html += '<span class="machine-label">Projects:</span> ';
    for (var j = 0; j < projects.length; j++) {
      html += '<span class="machine-project-tag">' + esc(projects[j]) + '</span>';
    }
    html += '</div>';
  }

  // Actions
  html += '<div class="fleet-card-actions">';
  html += '<button class="fleet-btn fleet-btn-sm" data-action="toggle-available" data-id="' + esc(id) + '" data-available="' + (available ? "false" : "true") + '">';
  html += available ? 'Disable' : 'Enable';
  html += '</button>';
  html += '<button class="fleet-btn fleet-btn-sm" data-action="ping-machine" data-id="' + esc(id) + '">Ping</button>';
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

    if (action === "toggle-available") {
      var newAvail = btn.getAttribute("data-available") === "true";
      sendWs({
        type: "machine_register",
        id: id,
        available: newAvail,
      });
    } else if (action === "ping-machine") {
      btn.textContent = "...";
      btn.disabled = true;
      // Simple connectivity check — fetch orchestrator status from the remote machine
      // For now just trigger a list refresh
      sendWs({ type: "machine_list" });
      setTimeout(function () {
        btn.textContent = "Ping";
        btn.disabled = false;
      }, 2000);
    }
  });
  refreshIcons();
}
