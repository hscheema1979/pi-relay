/**
 * autonomous.js — Tracks autonomous agent sessions (execution-mode, agent-fix)
 * with crash-resilient state persistence.
 *
 * State is written atomically (tmp file + rename) so it survives SIGKILL.
 * On startup, stale PIDs indicate interrupted work.
 */

var fs = require("fs");
var path = require("path");
var { CONFIG_DIR } = require("./config");

var STATE_DIR = path.join(CONFIG_DIR, "autonomous-state");

function createAutonomousManager(opts) {
  var cwd = opts.cwd;
  var slug = opts.slug || "";
  var encodedCwd = cwd.replace(/\//g, "-");
  var stateFile = path.join(STATE_DIR, encodedCwd + ".json");

  // Ensure directory exists
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch (e) {}

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

  // --- State management ---

  function readState() {
    return safeReadJSON(stateFile, {
      version: 1,
      updatedAt: null,
      sessions: {},
    });
  }

  function writeState(state) {
    state.updatedAt = new Date().toISOString();
    atomicWriteJSON(stateFile, state);
  }

  // --- Public API ---

  function registerSession(sessionId, entry) {
    var state = readState();
    state.sessions[sessionId] = Object.assign({}, entry, {
      pid: process.pid,
      startedAt: entry.startedAt || new Date().toISOString(),
      status: entry.status || "active",
    });
    writeState(state);
  }

  function updateSession(sessionId, updates) {
    var state = readState();
    if (!state.sessions[sessionId]) return false;
    Object.assign(state.sessions[sessionId], updates);
    state.sessions[sessionId].pid = process.pid;
    writeState(state);
    return true;
  }

  function completeSession(sessionId, outcome) {
    var state = readState();
    var session = state.sessions[sessionId];
    if (!session) return false;
    session.status = outcome.status || "completed";
    session.completedAt = new Date().toISOString();
    session.duration = Date.now() - new Date(session.startedAt).getTime();
    if (outcome.resolved !== undefined) session.resolved = outcome.resolved;
    if (outcome.diagnosis) session.diagnosis = outcome.diagnosis;
    if (outcome.error) session.error = outcome.error;
    writeState(state);
    return true;
  }

  function removeSession(sessionId) {
    var state = readState();
    delete state.sessions[sessionId];
    writeState(state);
  }

  // --- Queries ---

  function getActive() {
    var state = readState();
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
    var state = readState();
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
    var state = readState();
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
    var state = readState();
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

    if (changed) writeState(state);
    return interrupted;
  }

  function markInterrupted(sessionId, reason) {
    var state = readState();
    if (!state.sessions[sessionId]) return false;
    state.sessions[sessionId].status = "interrupted";
    state.sessions[sessionId].interruptedAt = new Date().toISOString();
    state.sessions[sessionId].interruptReason = reason || "unknown";
    writeState(state);
    return true;
  }

  function markAllGracefulShutdown() {
    var state = readState();
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
    if (changed) writeState(state);
  }

  // --- Cleanup old completed entries ---

  function cleanup(maxAgeMs) {
    maxAgeMs = maxAgeMs || 24 * 60 * 60 * 1000; // 24 hours default
    var state = readState();
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
    if (changed) writeState(state);
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
