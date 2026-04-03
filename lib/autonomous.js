/**
 * autonomous.js — Tracks autonomous agent sessions (execution-mode, agent-fix)
 * with crash-resilient state persistence.
 *
 * State is kept in memory for fast access and written atomically to disk
 * (tmp file + rename) on every mutation so it survives SIGKILL.
 * On startup, stale PIDs indicate interrupted work.
 */

var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var { CONFIG_DIR } = require("./config");

var STATE_DIR = path.join(CONFIG_DIR, "autonomous-state");

/**
 * Encode a cwd path into a safe, collision-free filename.
 * Uses URL-encoding so the mapping is injective (no two paths map to the same name).
 * Falls back to checking for legacy dash-encoded files for backward compatibility.
 */
function encodePathForFilename(cwd) {
  return encodeURIComponent(cwd);
}

function legacyEncodePathForFilename(cwd) {
  return cwd.replace(/\//g, "-");
}

function createAutonomousManager(opts) {
  var cwd = opts.cwd;
  var slug = opts.slug || "";
  var encodedCwd = encodePathForFilename(cwd);
  var stateFile = path.join(STATE_DIR, encodedCwd + ".json");

  // Backward compat: migrate legacy dash-encoded file if new file doesn't exist
  var legacyFile = path.join(STATE_DIR, legacyEncodePathForFilename(cwd) + ".json");

  // Ensure directory exists
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch (e) {}

  // Migrate legacy file if needed
  if (legacyFile !== stateFile) {
    try {
      if (!fs.existsSync(stateFile) && fs.existsSync(legacyFile)) {
        fs.renameSync(legacyFile, stateFile);
      }
    } catch (e) {}
  }

  // --- Atomic file operations ---

  function atomicWriteJSON(filePath, data) {
    var tmp = filePath + ".tmp." + process.pid;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, filePath);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch (_) {}
      throw e;
    }
  }

  function safeReadJSON(filePath, defaultValue) {
    try {
      var raw = fs.readFileSync(filePath, "utf8");
      return JSON.parse(raw);
    } catch (e) {
      return defaultValue;
    }
  }

  // --- In-memory state with disk persistence ---
  // Load state from disk once on init, keep in memory for reads.
  // Every mutation writes through to disk atomically.

  var _state = safeReadJSON(stateFile, {
    version: 1,
    updatedAt: null,
    sessions: {},
  });

  function getState() {
    return _state;
  }

  function persistState() {
    _state.updatedAt = new Date().toISOString();
    atomicWriteJSON(stateFile, _state);
  }

  // --- Public API ---

  function registerSession(sessionId, entry) {
    var state = getState();
    state.sessions[sessionId] = Object.assign({}, entry, {
      pid: process.pid,
      startedAt: entry.startedAt || new Date().toISOString(),
      status: entry.status || "active",
    });
    persistState();
  }

  function updateSession(sessionId, updates) {
    var state = getState();
    if (!state.sessions[sessionId]) return false;
    Object.assign(state.sessions[sessionId], updates);
    state.sessions[sessionId].pid = process.pid;
    persistState();
    return true;
  }

  function completeSession(sessionId, outcome) {
    var state = getState();
    var session = state.sessions[sessionId];
    if (!session) return false;
    session.status = outcome.status || "completed";
    session.completedAt = new Date().toISOString();
    session.duration = Date.now() - new Date(session.startedAt).getTime();
    if (outcome.resolved !== undefined) session.resolved = outcome.resolved;
    if (outcome.diagnosis) session.diagnosis = outcome.diagnosis;
    if (outcome.error) session.error = outcome.error;
    persistState();
    return true;
  }

  function removeSession(sessionId) {
    var state = getState();
    delete state.sessions[sessionId];
    persistState();
  }

  // --- Queries (read from memory — no disk I/O) ---

  function getActive() {
    var state = getState();
    var results = [];
    var ids = Object.keys(state.sessions);
    for (var i = 0; i < ids.length; i++) {
      var s = state.sessions[ids[i]];
      if (s.status === "active" || s.status === "running") {
        results.push(Object.assign({ sessionId: ids[i] }, s));
      }
    }
    return results;
  }

  function getInterrupted() {
    var state = getState();
    var results = [];
    var ids = Object.keys(state.sessions);
    for (var i = 0; i < ids.length; i++) {
      var s = state.sessions[ids[i]];
      if (s.status === "interrupted") {
        results.push(Object.assign({ sessionId: ids[i] }, s));
      }
    }
    return results;
  }

  function getRecent(limit) {
    limit = limit || 20;
    var state = getState();
    var results = [];
    var ids = Object.keys(state.sessions);
    for (var i = 0; i < ids.length; i++) {
      var s = state.sessions[ids[i]];
      if (
        s.status === "completed" ||
        s.status === "failed" ||
        s.status === "resolved" ||
        s.status === "escalated"
      ) {
        results.push(Object.assign({ sessionId: ids[i] }, s));
      }
    }
    // Sort by completedAt descending
    results.sort(function (a, b) {
      return (b.completedAt || "").localeCompare(a.completedAt || "");
    });
    return results.slice(0, limit);
  }

  function getAll() {
    return {
      active: getActive(),
      interrupted: getInterrupted(),
      recent: getRecent(),
    };
  }

  // --- Recovery ---

  function detectInterrupted() {
    var state = getState();
    var interrupted = [];
    var ids = Object.keys(state.sessions);
    var changed = false;

    for (var i = 0; i < ids.length; i++) {
      var s = state.sessions[ids[i]];
      if (s.status !== "active" && s.status !== "running") continue;

      // Check if the PID that owned this session is still alive
      var pidAlive = false;
      if (s.pid) {
        try {
          process.kill(s.pid, 0); // signal 0 = check existence
          pidAlive = true;
        } catch (e) {
          pidAlive = false;
        }
      }

      if (!pidAlive) {
        // Process died — mark as interrupted
        s.status = "interrupted";
        s.interruptedAt = new Date().toISOString();
        s.interruptReason = "process_death";
        interrupted.push(Object.assign({ sessionId: ids[i] }, s));
        changed = true;
      }
    }

    if (changed) persistState();
    return interrupted;
  }

  function markInterrupted(sessionId, reason) {
    var state = getState();
    if (!state.sessions[sessionId]) return false;
    state.sessions[sessionId].status = "interrupted";
    state.sessions[sessionId].interruptedAt = new Date().toISOString();
    state.sessions[sessionId].interruptReason = reason || "unknown";
    persistState();
    return true;
  }

  function markAllGracefulShutdown() {
    var state = getState();
    var ids = Object.keys(state.sessions);
    var changed = false;
    for (var i = 0; i < ids.length; i++) {
      var s = state.sessions[ids[i]];
      if (s.status === "active" || s.status === "running") {
        s.status = "interrupted";
        s.interruptedAt = new Date().toISOString();
        s.interruptReason = "graceful_shutdown";
        changed = true;
      }
    }
    if (changed) persistState();
  }

  // --- Cleanup old completed entries ---

  function cleanup(maxAgeMs) {
    maxAgeMs = maxAgeMs || 24 * 60 * 60 * 1000; // 24 hours default
    var state = getState();
    var cutoff = Date.now() - maxAgeMs;
    var ids = Object.keys(state.sessions);
    var changed = false;
    for (var i = 0; i < ids.length; i++) {
      var s = state.sessions[ids[i]];
      if (
        (s.status === "completed" ||
          s.status === "failed" ||
          s.status === "resolved" ||
          s.status === "escalated") &&
        s.completedAt
      ) {
        if (new Date(s.completedAt).getTime() < cutoff) {
          delete state.sessions[ids[i]];
          changed = true;
        }
      }
    }
    if (changed) persistState();
  }

  return {
    registerSession: registerSession,
    updateSession: updateSession,
    completeSession: completeSession,
    removeSession: removeSession,
    getActive: getActive,
    getInterrupted: getInterrupted,
    getRecent: getRecent,
    getAll: getAll,
    detectInterrupted: detectInterrupted,
    markInterrupted: markInterrupted,
    markAllGracefulShutdown: markAllGracefulShutdown,
    cleanup: cleanup,
    stateFile: stateFile,
  };
}

module.exports = { createAutonomousManager: createAutonomousManager };
