/**
 * process-monitor-bridge.js — Bridges fleet-manager process monitor incidents
 * to orchestrator hook events.
 *
 * Watches ~/.pi-relay/fleet-manager/state/incidents.jsonl (tail -f style)
 * and fires orchestrator hooks for each new incident.
 *
 * Incident → Hook Event mapping:
 *   stopped/crash_loop → ProcessCrash
 *   attempt (tier 1/2) → FixAttempted
 *   resolved          → FixResolved
 *   health_check_fail → HealthCheckFailed
 */

var fs = require("fs");
var path = require("path");

var INCIDENTS_PATH = path.join(
  __dirname, "..", "..", "fleet-manager", "state", "incidents.jsonl"
);

/**
 * Create a process monitor bridge.
 * @param {object} opts
 * @param {object} opts.hooks      - HooksManager from orchestrator
 * @param {function} opts.send     - Broadcast WS message
 * @param {function} [opts.onIncident] - Optional callback for each incident
 */
function createProcessMonitorBridge(opts) {
  var hooks = opts.hooks;
  var send = opts.send;
  var onIncident = opts.onIncident || null;

  var watcher = null;
  var fileOffset = 0;
  var started = false;
  var buffer = "";

  function start() {
    if (started) return;
    started = true;

    // Seek to end of file on startup (only process new incidents)
    try {
      var stat = fs.statSync(INCIDENTS_PATH);
      fileOffset = stat.size;
    } catch (e) {
      fileOffset = 0;
    }

    // Watch for changes
    try {
      watcher = fs.watch(path.dirname(INCIDENTS_PATH), function (eventType, filename) {
        if (filename === path.basename(INCIDENTS_PATH)) {
          readNewLines();
        }
      });
    } catch (e) {
      // Fall back to polling if watch fails
      setInterval(readNewLines, 5000);
    }
  }

  function readNewLines() {
    var fd;
    try {
      fd = fs.openSync(INCIDENTS_PATH, "r");
    } catch (e) {
      return;
    }

    try {
      var stat = fs.fstatSync(fd);
      if (stat.size <= fileOffset) {
        // File was truncated or unchanged
        if (stat.size < fileOffset) fileOffset = 0;
        fs.closeSync(fd);
        return;
      }

      var readSize = stat.size - fileOffset;
      var buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, fileOffset);
      fileOffset = stat.size;
      fs.closeSync(fd);

      buffer += buf.toString("utf8");
      var lines = buffer.split("\n");
      buffer = lines.pop(); // Keep incomplete last line in buffer

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        try {
          var incident = JSON.parse(line);
          processIncident(incident);
        } catch (e) {
          // Skip malformed lines
        }
      }
    } catch (e) {
      try { fs.closeSync(fd); } catch (e2) {}
    }
  }

  function processIncident(incident) {
    var problem = incident.problem || {};
    var service = problem.service || "unknown";
    var machine = problem.machine || "unknown";
    var status = incident.status || "unknown";
    var attempts = incident.attempts || [];

    // Determine hook event type
    var hookEvent = null;
    var payload = {
      incidentId: incident.id,
      service: service,
      machine: machine,
      serviceType: problem.serviceType || "unknown",
    };

    if (status === "resolved") {
      hookEvent = "FixResolved";
      var lastAttempt = attempts[attempts.length - 1];
      payload.tier = lastAttempt ? lastAttempt.tier : 0;
      payload.duration = incident.resolvedAt && incident.startedAt
        ? new Date(incident.resolvedAt).getTime() - new Date(incident.startedAt).getTime()
        : 0;
      payload.pattern = lastAttempt ? lastAttempt.pattern : "";
    } else if (attempts.length > 0) {
      hookEvent = "FixAttempted";
      var latest = attempts[attempts.length - 1];
      payload.tier = latest.tier;
      payload.pattern = latest.pattern;
      payload.commands = latest.commands;
      payload.verified = latest.verified;
    } else if (problem.type === "health_check_fail" || problem.type === "healthcheck_fail") {
      hookEvent = "HealthCheckFailed";
      payload.errorLog = (problem.errorLog || "").slice(0, 500);
    } else {
      // stopped, crash_loop, errored → ProcessCrash
      hookEvent = "ProcessCrash";
      payload.type = problem.type;
      payload.errorLog = (problem.errorLog || "").slice(0, 500);
    }

    // Fire hook
    if (hooks && hookEvent) {
      hooks.fire(hookEvent, service).catch(function (e) {
        // Hook execution errors are non-fatal
      });
    }

    // Broadcast to WS clients
    if (send) {
      send({
        type: "process_incident",
        event: hookEvent,
        incident: {
          id: incident.id,
          service: service,
          machine: machine,
          status: status,
          problemType: problem.type,
          attempts: attempts.length,
          startedAt: incident.startedAt,
          resolvedAt: incident.resolvedAt,
        },
      });
    }

    if (onIncident) {
      onIncident(hookEvent, payload, incident);
    }
  }

  /**
   * Read recent incidents for display (not tail — reads last N).
   * @param {number} limit - Number of recent incidents to return
   */
  function getRecentIncidents(limit) {
    limit = limit || 20;
    try {
      var content = fs.readFileSync(INCIDENTS_PATH, "utf8");
      var lines = content.trim().split("\n");
      var start = Math.max(0, lines.length - limit);
      var incidents = [];
      for (var i = start; i < lines.length; i++) {
        try {
          incidents.push(JSON.parse(lines[i]));
        } catch (e) {}
      }
      return incidents;
    } catch (e) {
      return [];
    }
  }

  function stop() {
    started = false;
    if (watcher) {
      watcher.close();
      watcher = null;
    }
  }

  return {
    start: start,
    stop: stop,
    getRecentIncidents: getRecentIncidents,
  };
}

module.exports = { createProcessMonitorBridge };
