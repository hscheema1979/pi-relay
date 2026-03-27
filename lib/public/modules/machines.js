/**
 * machines.js — Tailscale machine discovery and remote project management
 */

import { escapeHtml } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';

var ctx;
var machinesData = null;
var scanning = false;
var addedRemoteSlugs = new Set();

function init(context) {
  ctx = context;
  // Initial scan
  scanMachines();
}

function scanMachines() {
  if (scanning) return;
  scanning = true;

  var refreshBtn = document.getElementById("machines-refresh");
  if (refreshBtn) refreshBtn.classList.add("scanning");

  fetch("/api/machines")
    .then(function (res) { return res.json(); })
    .then(function (data) {
      machinesData = data;
      renderMachines();
    })
    .catch(function (err) {
      machinesData = { error: err.message, machines: [] };
      renderMachines();
    })
    .finally(function () {
      scanning = false;
      if (refreshBtn) refreshBtn.classList.remove("scanning");
    });
}

function renderMachines() {
  var listEl = document.getElementById("machines-list");
  if (!listEl) return;

  if (!machinesData) {
    listEl.innerHTML = '<div class="machines-empty">Loading...</div>';
    return;
  }

  if (machinesData.error && !machinesData.machines) {
    // Tailscale not available - hide section
    var section = document.getElementById("machines-section");
    if (section) section.style.display = "none";
    return;
  }

  var machines = machinesData.machines || [];
  // Filter to only machines that have a relay
  var relayMachines = machines.filter(function (m) { return m.hasRelay; });

  if (relayMachines.length === 0) {
    listEl.innerHTML = '<div class="machines-empty">No other pi-relay instances found</div>';
    return;
  }

  var html = "";
  for (var i = 0; i < relayMachines.length; i++) {
    var m = relayMachines[i];
    html += renderMachine(m);
  }
  listEl.innerHTML = html;
  refreshIcons();
}

function renderMachine(m) {
  var statusClass = m.online ? "online" : "offline";
  var ip = m.ip || "";
  var projects = (m.relay && m.relay.projects) || [];
  
  var projectsHtml = "";
  for (var j = 0; j < projects.length; j++) {
    var p = projects[j];
    var slug = p.slug;
    var remoteSlug = p.project || slug;
    var alreadyAdded = addedRemoteSlugs.has(m.hostname + "-" + slug) || addedRemoteSlugs.has(slug);
    
    projectsHtml += '<div class="machine-project-item' + (alreadyAdded ? " already-added" : "") + '" ' +
      'data-host="' + escapeHtml(m.ip || m.fqdn) + '" ' +
      'data-slug="' + escapeHtml(slug) + '" ' +
      'data-remote-slug="' + escapeHtml(remoteSlug) + '" ' +
      'data-machine="' + escapeHtml(m.hostname) + '">' +
      '<span class="machine-project-slug">' + escapeHtml(slug) + '</span>' +
      '<span class="machine-project-add">' + (alreadyAdded ? "added" : "add") + '</span>' +
      '</div>';
  }

  return '<div class="machine-item">' +
    '<div class="machine-header">' +
    '<span class="machine-status ' + statusClass + '"></span>' +
    '<span class="machine-name">' + escapeHtml(m.hostname) + '</span>' +
    '<span class="machine-ip">' + escapeHtml(ip) + '</span>' +
    '</div>' +
    (projects.length > 0 ? '<div class="machine-projects">' + projectsHtml + '</div>' : '') +
    '</div>';
}

function addRemoteProject(host, slug, remoteSlug, machineName) {
  var fullSlug = machineName + "-" + slug;
  
  fetch("/api/remote-projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      remoteHost: host,
      remoteSlug: remoteSlug,
      slug: fullSlug,
      machineName: machineName,
    })
  })
  .then(function (res) { return res.json(); })
  .then(function (data) {
    if (data.ok) {
      addedRemoteSlugs.add(fullSlug);
      renderMachines();
      // Show toast
      if (ctx.showToast) {
        ctx.showToast("Added remote project: " + fullSlug, "success");
      }
      // Navigate to the new project
      setTimeout(function () {
        window.location.href = "/p/" + fullSlug + "/";
      }, 500);
    } else {
      if (ctx.showToast) {
        ctx.showToast(data.error || "Failed to add remote project", "error");
      }
    }
  })
  .catch(function (err) {
    if (ctx.showToast) {
      ctx.showToast("Error: " + err.message, "error");
    }
  });
}

function handleRemoteProjectsUpdate(remoteProjects) {
  // Update our set of added slugs
  addedRemoteSlugs.clear();
  for (var i = 0; i < remoteProjects.length; i++) {
    addedRemoteSlugs.add(remoteProjects[i].slug);
  }
  renderMachines();
}

function bindEvents() {
  // Refresh button
  var refreshBtn = document.getElementById("machines-refresh");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", function () {
      // Force refresh
      fetch("/api/machines/refresh", { method: "POST" })
        .then(function () { 
          setTimeout(scanMachines, 500); 
        });
    });
  }

  // Project click handlers (delegated)
  var listEl = document.getElementById("machines-list");
  if (listEl) {
    listEl.addEventListener("click", function (e) {
      var item = e.target.closest(".machine-project-item");
      if (!item || item.classList.contains("already-added")) return;
      
      var host = item.getAttribute("data-host");
      var slug = item.getAttribute("data-slug");
      var remoteSlug = item.getAttribute("data-remote-slug");
      var machine = item.getAttribute("data-machine");
      
      addRemoteProject(host, slug, remoteSlug, machine);
    });
  }
}

export { init, scanMachines, renderMachines, handleRemoteProjectsUpdate, bindEvents };
