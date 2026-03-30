/**
 * sidebar-resize.js — Draggable dividers between sidebar sections.
 *
 * The sidebar layout (flex column):
 *   #sidebar-header          (fixed)
 *   #sidebar-nav             (projects — resizable, flex-grow)
 *   .sidebar-divider[projects-tools]
 *   #sidebar-tools           (tools — fixed height, shrinkable)
 *   .sidebar-divider[tools-sessions]
 *   #sidebar-sessions-header (fixed)
 *   .sidebar-panel           (sessions — flex:1, takes remaining)
 *   #sidebar-footer          (fixed)
 *
 * Dragging a divider adjusts the height of the section above it.
 * Heights are persisted in localStorage.
 */

var STORAGE_KEY = "pi-relay-sidebar-sizes";

export function initSidebarResize() {
  var sidebar = document.getElementById("sidebar");
  if (!sidebar) return;

  var dividers = sidebar.querySelectorAll(".sidebar-divider");
  if (dividers.length === 0) return;

  // Section mapping: divider data-divider → section above
  var sectionMap = {
    "projects-tools": document.getElementById("sidebar-nav"),
    "tools-sessions": document.getElementById("sidebar-tools"),
  };

  // Load saved sizes
  var saved = {};
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch (e) {}

  // Apply saved sizes
  for (var key in saved) {
    var section = sectionMap[key];
    if (section && saved[key] > 0) {
      section.style.height = saved[key] + "px";
      section.style.flexGrow = "0";
      section.style.flexShrink = "0";
    }
  }

  // Bind drag events to each divider
  for (var i = 0; i < dividers.length; i++) {
    bindDivider(dividers[i], sectionMap, saved);
  }
}

function bindDivider(divider, sectionMap, saved) {
  var key = divider.getAttribute("data-divider");
  var section = sectionMap[key];
  if (!section) return;

  var startY = 0;
  var startHeight = 0;
  var dragging = false;

  function onPointerDown(e) {
    // Only primary button
    if (e.button && e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    startY = e.clientY || (e.touches ? e.touches[0].clientY : 0);
    startHeight = section.getBoundingClientRect().height;
    divider.classList.add("dragging");
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    document.addEventListener("mousemove", onPointerMove);
    document.addEventListener("mouseup", onPointerUp);
    document.addEventListener("touchmove", onPointerMove, { passive: false });
    document.addEventListener("touchend", onPointerUp);
  }

  function onPointerMove(e) {
    if (!dragging) return;
    if (e.cancelable) e.preventDefault();
    var clientY = e.clientY || (e.touches ? e.touches[0].clientY : 0);
    var delta = clientY - startY;
    var newHeight = Math.max(32, startHeight + delta);
    // Cap at 70% of sidebar height
    var sidebarHeight = document.getElementById("sidebar").clientHeight;
    newHeight = Math.min(newHeight, sidebarHeight * 0.7);
    section.style.height = newHeight + "px";
    section.style.flexGrow = "0";
    section.style.flexShrink = "0";
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.body.style.webkitUserSelect = "";
    document.removeEventListener("mousemove", onPointerMove);
    document.removeEventListener("mouseup", onPointerUp);
    document.removeEventListener("touchmove", onPointerMove);
    document.removeEventListener("touchend", onPointerUp);

    // Save
    var height = section.getBoundingClientRect().height;
    saved[key] = Math.round(height);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch (e) {}
  }

  divider.addEventListener("mousedown", onPointerDown);
  divider.addEventListener("touchstart", onPointerDown, { passive: false });

  // Double-click to reset
  divider.addEventListener("dblclick", function () {
    section.style.height = "";
    section.style.flexGrow = "";
    section.style.flexShrink = "";
    delete saved[key];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch (e) {}
  });
}
