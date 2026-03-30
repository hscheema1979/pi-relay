/**
 * extension-ui.js — Browser-side handling for pi extension UI messages.
 *
 * Handles:
 *   - ext_notify   → toast notifications
 *   - ext_status   → status bar entries
 *   - ext_widget   → collapsible widget panels above input
 *   - ext_select   → selection dialog modal
 *   - ext_confirm  → confirmation dialog modal
 *   - ext_input    → text input dialog modal
 *   - ext_editor   → textarea editor dialog modal
 *   - ext_title    → document title
 *   - ext_editor_text → (future) prefill input
 */

import { showToast } from './utils.js';

var ws = null;
var statusEntries = new Map();  // key → text
var widgetEntries = new Map();  // key → { lines, placement }
var statusBarEl = null;
var widgetContainerEl = null;
var activeModal = null;

export function initExtensionUI(websocket) {
  ws = websocket;

  // Create status bar element (above input area)
  statusBarEl = document.createElement("div");
  statusBarEl.id = "ext-status-bar";
  statusBarEl.className = "ext-status-bar hidden";
  var inputArea = document.getElementById("input-area");
  if (inputArea) {
    inputArea.parentNode.insertBefore(statusBarEl, inputArea);
  }

  // Create widget container (above input area, below status bar)
  widgetContainerEl = document.createElement("div");
  widgetContainerEl.id = "ext-widgets";
  widgetContainerEl.className = "ext-widgets hidden";
  if (inputArea) {
    inputArea.parentNode.insertBefore(widgetContainerEl, inputArea);
  }
}

export function handleExtensionMessage(msg) {
  switch (msg.type) {
    case "ext_notify":
      handleNotify(msg);
      break;
    case "ext_status":
      handleStatus(msg);
      break;
    case "ext_widget":
      handleWidget(msg);
      break;
    case "ext_select":
      handleSelect(msg);
      break;
    case "ext_confirm":
      handleConfirm(msg);
      break;
    case "ext_input":
      handleInput(msg);
      break;
    case "ext_editor":
      handleEditor(msg);
      break;
    case "ext_title":
      if (msg.title) document.title = msg.title;
      break;
    case "ext_editor_text":
      var inputEl = document.getElementById("input");
      if (inputEl && msg.text) {
        inputEl.value = msg.text;
        inputEl.dispatchEvent(new Event("input"));
      }
      break;
    default:
      return false;
  }
  return true;
}

// Reset state on session switch
export function resetExtensionUI() {
  statusEntries.clear();
  widgetEntries.clear();
  renderStatusBar();
  renderWidgets();
  dismissModal();
}

// --- Notifications ---

function handleNotify(msg) {
  var level = msg.notifyType || "info";
  // Map to toast levels: info→default, warning→warn, error→error
  var toastLevel = level === "warning" ? "warn" : level === "error" ? "error" : "success";
  showToast(msg.message, toastLevel);
}

// --- Status Bar ---

function handleStatus(msg) {
  if (msg.text) {
    statusEntries.set(msg.key, msg.text);
  } else {
    statusEntries.delete(msg.key);
  }
  renderStatusBar();
}

function renderStatusBar() {
  if (!statusBarEl) return;
  if (statusEntries.size === 0) {
    statusBarEl.classList.add("hidden");
    statusBarEl.innerHTML = "";
    return;
  }
  statusBarEl.classList.remove("hidden");
  var html = "";
  statusEntries.forEach(function (text, key) {
    html += '<span class="ext-status-entry" data-key="' + escHtml(key) + '">' + escHtml(text) + '</span>';
  });
  statusBarEl.innerHTML = html;
}

// --- Widgets ---

function handleWidget(msg) {
  if (msg.lines && msg.lines.length > 0) {
    widgetEntries.set(msg.key, { lines: msg.lines, placement: msg.placement || "aboveEditor" });
  } else {
    widgetEntries.delete(msg.key);
  }
  renderWidgets();
}

function renderWidgets() {
  if (!widgetContainerEl) return;
  if (widgetEntries.size === 0) {
    widgetContainerEl.classList.add("hidden");
    widgetContainerEl.innerHTML = "";
    return;
  }
  widgetContainerEl.classList.remove("hidden");
  var html = "";
  widgetEntries.forEach(function (entry, key) {
    var collapsed = widgetContainerEl.querySelector('[data-widget-key="' + key + '"].collapsed');
    var isCollapsed = collapsed !== null;
    html += '<div class="ext-widget' + (isCollapsed ? ' collapsed' : '') + '" data-widget-key="' + escHtml(key) + '">';
    html += '<div class="ext-widget-header" onclick="this.parentNode.classList.toggle(\'collapsed\')">';
    html += '<span class="ext-widget-toggle">▾</span> ';
    html += '<span class="ext-widget-label">' + escHtml(key) + '</span>';
    html += '</div>';
    html += '<pre class="ext-widget-body">';
    for (var i = 0; i < entry.lines.length; i++) {
      html += escHtml(entry.lines[i]) + "\n";
    }
    html += '</pre></div>';
  });
  widgetContainerEl.innerHTML = html;
}

// --- Dialog Modals ---

function handleSelect(msg) {
  var options = msg.options || [];
  var html = '<div class="ext-modal-title">' + escHtml(msg.title || "Select") + '</div>';
  html += '<div class="ext-modal-options">';
  for (var i = 0; i < options.length; i++) {
    html += '<button class="ext-modal-option" data-value="' + escHtml(options[i]) + '">' + escHtml(options[i]) + '</button>';
  }
  html += '</div>';
  html += '<button class="ext-modal-cancel">Cancel</button>';

  showModal(html, function (el) {
    var btns = el.querySelectorAll(".ext-modal-option");
    for (var j = 0; j < btns.length; j++) {
      btns[j].addEventListener("click", function () {
        sendDialogResponse(msg.id, "select", { value: this.dataset.value });
        dismissModal();
      });
    }
    el.querySelector(".ext-modal-cancel").addEventListener("click", function () {
      sendDialogResponse(msg.id, "select", { cancelled: true });
      dismissModal();
    });
  });
}

function handleConfirm(msg) {
  var html = '<div class="ext-modal-title">' + escHtml(msg.title || "Confirm") + '</div>';
  if (msg.message) {
    html += '<div class="ext-modal-message">' + escHtml(msg.message) + '</div>';
  }
  html += '<div class="ext-modal-buttons">';
  html += '<button class="ext-modal-btn ext-modal-btn-primary">Yes</button>';
  html += '<button class="ext-modal-btn ext-modal-btn-cancel">No</button>';
  html += '</div>';

  showModal(html, function (el) {
    el.querySelector(".ext-modal-btn-primary").addEventListener("click", function () {
      sendDialogResponse(msg.id, "confirm", { confirmed: true });
      dismissModal();
    });
    el.querySelector(".ext-modal-btn-cancel").addEventListener("click", function () {
      sendDialogResponse(msg.id, "confirm", { confirmed: false });
      dismissModal();
    });
  });
}

function handleInput(msg) {
  var html = '<div class="ext-modal-title">' + escHtml(msg.title || "Input") + '</div>';
  html += '<input type="text" class="ext-modal-input" placeholder="' + escHtml(msg.placeholder || "") + '" autofocus />';
  html += '<div class="ext-modal-buttons">';
  html += '<button class="ext-modal-btn ext-modal-btn-primary">OK</button>';
  html += '<button class="ext-modal-btn ext-modal-btn-cancel">Cancel</button>';
  html += '</div>';

  showModal(html, function (el) {
    var input = el.querySelector(".ext-modal-input");
    input.focus();
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        sendDialogResponse(msg.id, "input", { value: input.value });
        dismissModal();
      } else if (e.key === "Escape") {
        sendDialogResponse(msg.id, "input", { cancelled: true });
        dismissModal();
      }
    });
    el.querySelector(".ext-modal-btn-primary").addEventListener("click", function () {
      sendDialogResponse(msg.id, "input", { value: input.value });
      dismissModal();
    });
    el.querySelector(".ext-modal-btn-cancel").addEventListener("click", function () {
      sendDialogResponse(msg.id, "input", { cancelled: true });
      dismissModal();
    });
  });
}

function handleEditor(msg) {
  var html = '<div class="ext-modal-title">' + escHtml(msg.title || "Editor") + '</div>';
  html += '<textarea class="ext-modal-textarea" autofocus>' + escHtml(msg.prefill || "") + '</textarea>';
  html += '<div class="ext-modal-buttons">';
  html += '<button class="ext-modal-btn ext-modal-btn-primary">OK</button>';
  html += '<button class="ext-modal-btn ext-modal-btn-cancel">Cancel</button>';
  html += '</div>';

  showModal(html, function (el) {
    var textarea = el.querySelector(".ext-modal-textarea");
    textarea.focus();
    el.querySelector(".ext-modal-btn-primary").addEventListener("click", function () {
      sendDialogResponse(msg.id, "editor", { value: textarea.value });
      dismissModal();
    });
    el.querySelector(".ext-modal-btn-cancel").addEventListener("click", function () {
      sendDialogResponse(msg.id, "editor", { cancelled: true });
      dismissModal();
    });
  });
}

function showModal(html, setup) {
  dismissModal();  // Remove any existing modal
  var overlay = document.createElement("div");
  overlay.className = "ext-modal-overlay";
  overlay.innerHTML = '<div class="ext-modal">' + html + '</div>';
  document.body.appendChild(overlay);
  activeModal = overlay;

  // Click outside to dismiss
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) {
      // Find the active dialog's id from the modal content and cancel it
      dismissModal();
    }
  });

  setup(overlay.querySelector(".ext-modal"));
}

function dismissModal() {
  if (activeModal) {
    activeModal.remove();
    activeModal = null;
  }
}

function sendDialogResponse(id, method, data) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(Object.assign({ type: "ext_dialog_response", id: id, method: method }, data)));
  }
}

// --- Utilities ---

function escHtml(s) {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
