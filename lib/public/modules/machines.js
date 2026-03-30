/**
 * machines.js — Tailscale machine discovery and remote project management
 */

import { escapeHtml } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';

var ctx;
var machinesData = null;
var scanning = false;
var addedRemoteSlugs = new Set();

// Remote add-project state
var remoteAddTarget = null; // { host, port, machineName, wsSlug }
var remoteAddWs = null;
var remoteAddDebounce = null;

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
  var relayPort = m.relayPort || 3002;
  
  var authRequired = m.relay && m.relay.authRequired && !m.relay.projects;

  var projectsHtml = "";
  if (authRequired) {
    projectsHtml = '<div class="machine-auth-required" style="padding:8px 12px;font-size:12px;color:var(--text-dimmer)">' +
      '<i data-lucide="lock" style="width:12px;height:12px;vertical-align:-2px;margin-right:4px"></i>' +
      'PIN-protected — enter PIN on remote relay first to discover projects' +
      '</div>';
  }
  for (var j = 0; j < projects.length; j++) {
    var p = projects[j];
    var slug = p.slug;
    var remoteSlug = p.project || slug;
    var alreadyAdded = addedRemoteSlugs.has(m.hostname + "-" + slug) || addedRemoteSlugs.has(slug);
    
    projectsHtml += '<div class="machine-project-item' + (alreadyAdded ? " already-added" : "") + '" ' +
      'data-host="' + escapeHtml(m.ip || m.fqdn) + '" ' +
      'data-port="' + relayPort + '" ' +
      'data-slug="' + escapeHtml(slug) + '" ' +
      'data-remote-slug="' + escapeHtml(remoteSlug) + '" ' +
      'data-machine="' + escapeHtml(m.hostname) + '">' +
      '<span class="machine-project-slug">' + escapeHtml(slug) + '</span>' +
      '<span class="machine-project-add">' + (alreadyAdded ? "added" : "add") + '</span>' +
      '</div>';
  }

  // "Add project" button for this machine
  var addBtnHtml = '<div class="machine-add-project" ' +
    'data-host="' + escapeHtml(m.ip || m.fqdn) + '" ' +
    'data-port="' + relayPort + '" ' +
    'data-machine="' + escapeHtml(m.hostname) + '">' +
    '<i data-lucide="plus" style="width:12px;height:12px"></i> Add project' +
    '</div>';

  return '<div class="machine-item">' +
    '<div class="machine-header">' +
    '<span class="machine-status ' + statusClass + '"></span>' +
    '<span class="machine-name">' + escapeHtml(m.hostname) + '</span>' +
    '<span class="machine-ip">' + escapeHtml(ip) + '</span>' +
    '</div>' +
    (projects.length > 0 ? '<div class="machine-projects">' + projectsHtml + '</div>' : '') +
    addBtnHtml +
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

// --- Remote "Add Project" dialog ---

function openRemoteAddProject(host, port, machineName) {
  remoteAddTarget = { host: host, port: port, machineName: machineName };
  
  var modal = document.getElementById("remote-add-project-modal");
  var input = document.getElementById("remote-add-project-input");
  var nameEl = document.getElementById("remote-add-machine-name");
  var errorEl = document.getElementById("remote-add-project-error");
  var suggestionsEl = document.getElementById("remote-add-project-suggestions");

  nameEl.textContent = machineName;
  input.value = "/";
  errorEl.classList.add("hidden");
  errorEl.textContent = "";
  suggestionsEl.classList.add("hidden");
  suggestionsEl.innerHTML = "";
  modal.classList.remove("hidden");

  // Connect a temporary WebSocket to the remote machine to browse directories
  // We'll use an existing remote project on that machine as the WS endpoint
  connectRemoteBrowseWs(host, port, machineName);

  setTimeout(function () {
    input.focus();
    input.setSelectionRange(1, 1);
  }, 100);
}

function closeRemoteAddProject() {
  var modal = document.getElementById("remote-add-project-modal");
  modal.classList.add("hidden");
  remoteAddTarget = null;
  if (remoteAddWs) {
    try { remoteAddWs.close(); } catch (e) {}
    remoteAddWs = null;
  }
}

function connectRemoteBrowseWs(host, port, machineName) {
  // Find an existing remote slug for this machine to connect through
  // We need to connect via our frontend's proxy, so we use an existing remote project slug
  var existingSlug = null;
  var allRemote = document.querySelectorAll(".machine-project-item[data-machine='" + machineName + "']");
  if (allRemote.length > 0) {
    // Use the first already-added project for this machine
    for (var i = 0; i < allRemote.length; i++) {
      var s = allRemote[i].getAttribute("data-slug");
      var fullS = machineName + "-" + s;
      if (addedRemoteSlugs.has(fullS)) {
        existingSlug = fullS;
        break;
      }
    }
    // If none added yet, add the first one temporarily
    if (!existingSlug) {
      var firstItem = allRemote[0];
      existingSlug = machineName + "-" + firstItem.getAttribute("data-slug");
    }
  }

  if (!existingSlug) {
    // No projects on this machine at all, we need at least "home"
    existingSlug = machineName + "-home";
  }

  // Connect WebSocket through our proxy
  var wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
  var wsUrl = wsProto + "//" + window.location.host + "/p/" + existingSlug + "/ws";
  
  try {
    if (remoteAddWs) { try { remoteAddWs.close(); } catch (e) {} }
    remoteAddWs = new WebSocket(wsUrl);
    
    remoteAddWs.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (msg.type === "browse_dir_result") {
          renderRemoteSuggestions(msg);
        } else if (msg.type === "add_project_result") {
          handleRemoteAddResult(msg);
        }
      } catch (e) {}
    };

    remoteAddWs.onopen = function () {
      // Trigger initial browse
      var input = document.getElementById("remote-add-project-input");
      if (input && input.value) {
        remoteAddWs.send(JSON.stringify({ type: "browse_dir", path: input.value }));
      }
    };
  } catch (e) {
    console.error("Failed to connect remote browse WS:", e);
  }
}

function renderRemoteSuggestions(msg) {
  var suggestionsEl = document.getElementById("remote-add-project-suggestions");
  var entries = msg.entries || [];
  
  if (entries.length === 0) {
    suggestionsEl.classList.add("hidden");
    suggestionsEl.innerHTML = "";
    return;
  }

  var html = "";
  for (var i = 0; i < entries.length && i < 15; i++) {
    html += '<div class="add-project-suggestion" data-path="' + escapeHtml(entries[i].path) + '">' +
      escapeHtml(entries[i].path) + '</div>';
  }
  suggestionsEl.innerHTML = html;
  suggestionsEl.classList.remove("hidden");

  // Bind click handlers
  var items = suggestionsEl.querySelectorAll(".add-project-suggestion");
  for (var j = 0; j < items.length; j++) {
    items[j].addEventListener("click", function () {
      var input = document.getElementById("remote-add-project-input");
      input.value = this.getAttribute("data-path") + "/";
      // Browse into it
      if (remoteAddWs && remoteAddWs.readyState === 1) {
        remoteAddWs.send(JSON.stringify({ type: "browse_dir", path: input.value }));
      }
    });
  }
}

function handleRemoteAddResult(msg) {
  var errorEl = document.getElementById("remote-add-project-error");
  
  if (msg.ok) {
    // Project added on the remote backend. Now add it as a remote project on the frontend.
    var newSlug = msg.slug;
    var machineName = remoteAddTarget.machineName;
    var host = remoteAddTarget.host;
    var port = remoteAddTarget.port;
    
    // If it already existed on the backend, msg.existing might be true
    // Either way, add it to our frontend
    var fullSlug = machineName + "-" + newSlug;
    
    fetch("/api/remote-projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        remoteHost: host,
        remotePort: port,
        remoteSlug: newSlug,
        slug: fullSlug,
        machineName: machineName,
      })
    })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      closeRemoteAddProject();
      if (data.ok) {
        addedRemoteSlugs.add(fullSlug);
        if (ctx.showToast) {
          ctx.showToast("Added " + fullSlug, "success");
        }
        // Refresh machine list to show new project
        setTimeout(function () {
          scanMachines();
          window.location.href = "/p/" + fullSlug + "/";
        }, 300);
      } else if (data.error && data.error.includes("already exists")) {
        // Already proxied, just navigate
        if (ctx.showToast) {
          ctx.showToast("Project already connected", "info");
        }
        setTimeout(function () {
          window.location.href = "/p/" + fullSlug + "/";
        }, 300);
      } else {
        if (ctx.showToast) {
          ctx.showToast(data.error || "Failed to connect project", "error");
        }
      }
    })
    .catch(function (err) {
      closeRemoteAddProject();
      if (ctx.showToast) {
        ctx.showToast("Error: " + err.message, "error");
      }
    });
  } else {
    errorEl.textContent = msg.error || "Failed to add project";
    errorEl.classList.remove("hidden");
  }
}

function submitRemoteAddProject() {
  var input = document.getElementById("remote-add-project-input");
  var val = (input.value || "").trim();
  if (!val || val === "/") return;
  
  if (remoteAddWs && remoteAddWs.readyState === 1) {
    remoteAddWs.send(JSON.stringify({ type: "add_project", path: val }));
  }
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
      // "Add project" button per machine
      var addBtn = e.target.closest(".machine-add-project");
      if (addBtn) {
        var host = addBtn.getAttribute("data-host");
        var port = parseInt(addBtn.getAttribute("data-port")) || 3002;
        var machine = addBtn.getAttribute("data-machine");
        openRemoteAddProject(host, port, machine);
        return;
      }

      // Existing project "add" button
      var item = e.target.closest(".machine-project-item");
      if (!item || item.classList.contains("already-added")) return;
      
      var host2 = item.getAttribute("data-host");
      var slug = item.getAttribute("data-slug");
      var remoteSlug = item.getAttribute("data-remote-slug");
      var machine2 = item.getAttribute("data-machine");
      
      addRemoteProject(host2, slug, remoteSlug, machine2);
    });
  }

  // Remote add-project modal events
  var remoteModal = document.getElementById("remote-add-project-modal");
  if (remoteModal) {
    var cancelBtn = document.getElementById("remote-add-project-cancel");
    var okBtn = document.getElementById("remote-add-project-ok");
    var backdrop = remoteModal.querySelector(".confirm-backdrop");
    var input = document.getElementById("remote-add-project-input");

    cancelBtn.addEventListener("click", closeRemoteAddProject);
    backdrop.addEventListener("click", closeRemoteAddProject);
    okBtn.addEventListener("click", submitRemoteAddProject);

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        submitRemoteAddProject();
      } else if (e.key === "Escape") {
        closeRemoteAddProject();
      }
    });

    input.addEventListener("input", function () {
      if (remoteAddDebounce) clearTimeout(remoteAddDebounce);
      remoteAddDebounce = setTimeout(function () {
        if (remoteAddWs && remoteAddWs.readyState === 1) {
          remoteAddWs.send(JSON.stringify({ type: "browse_dir", path: input.value }));
        }
      }, 200);
    });
  }
}

export { init, scanMachines, renderMachines, handleRemoteProjectsUpdate, bindEvents };
