/**
 * fleet-bridge.js — Bridges fleet-manager orchestrator to pi-relay's WebSocket protocol.
 *
 * This thin layer:
 * 1. Creates an Orchestrator instance per project
 * 2. Adapts pi-bridge's agent query into the AgentQuery interface fleet-manager expects
 * 3. Forwards fleet-manager events → WebSocket messages to the browser
 * 4. Routes incoming WS messages (loop_*, schedule_*, fleet_*, etc.) → orchestrator calls
 * 5. Machine registry for cross-machine dispatch via remote AgentQuery adapters
 * 6. HTTP API getters for frontend panels
 *
 * Pi-relay stays focused on transport/UI; fleet-manager owns orchestration logic.
 */

var path = require("path");
var fs = require("fs");
var os = require("os");
var { createRemoteAgentQuery, closeAllConnections } = require("./remote-agent-query");
var { createProcessMonitorBridge } = require("./process-monitor-bridge");
var { createLiteLLMQuery } = require("./litellm-query");

// Fleet-manager is built from TypeScript to dist/ via `tsc`.
var orchestratorModule = null;

var ORCHESTRATOR_PATH = path.join(
  __dirname, "..", "..", "fleet-manager", "dist", "orchestrator", "index.js"
);

async function loadOrchestrator() {
  if (orchestratorModule) return orchestratorModule;
  orchestratorModule = await import(ORCHESTRATOR_PATH);
  return orchestratorModule;
}

// ─── Default Machine Definitions ────────────────────────────────────────────

var DEFAULT_MACHINES = [
  { id: "vps1", hostname: "vps1", ip: "100.101.179.63", port: 3002, sshUser: "root", role: "Control plane", capabilities: ["portainer", "netdata", "docker"], projects: ["home"], specs: "2 vCPU, 8 GB" },
  { id: "vps2", hostname: "vps2", ip: "100.103.208.24", port: 3002, sshUser: "root", role: "Web app", capabilities: ["web", "nginx", "systemd"], projects: ["home", "myhealthteam"], specs: "4 vCPU, 16 GB" },
  { id: "vps3", hostname: "vps3", ip: "100.72.152.122", port: 3002, sshUser: "ubuntu", role: "Compute/AI", capabilities: ["compute", "ai", "spxer"], projects: ["home", "council-of-agents", "coa-chat", "openclaw", "spxer"], specs: "8 vCPU, 22 GB" },
  { id: "vps4", hostname: "vps4", ip: "100.97.253.91", port: 3002, sshUser: "ubuntu", role: "Development", capabilities: ["dev", "postgres", "redis"], projects: ["home", "spxer"], specs: "2 vCPU, 4 GB" },
  { id: "vps5", hostname: "vps5", ip: "100.99.47.10", port: 3015, sshUser: "ubuntu", role: "AI dev (hub)", capabilities: ["ai", "litellm", "hub"], projects: ["ubuntu", "fleet-manager", "pi-relay"], specs: "6 vCPU, 12 GB" },
];

/**
 * Create a fleet bridge for a project context.
 *
 * @param {object} opts
 * @param {string} opts.cwd        - Project working directory
 * @param {string} opts.slug       - Project slug
 * @param {function} opts.send     - Broadcast to all WS clients: send({ type, ... })
 * @param {function} opts.sendTo   - Send to one client: sendTo(ws, { type, ... })
 * @param {object} opts.bridge     - Pi-bridge instance (for creating agent queries)
 * @param {object} opts.sm         - Session manager
 */
function createFleetBridge(opts) {
  var cwd = opts.cwd;
  var slug = opts.slug;
  var send = opts.send;
  var bridge = opts.bridge;
  var sm = opts.sm;

  var orchestrator = null;
  var initPromise = null;
  var ready = false;
  var pmBridge = null;

  // ─── Machine Registry ─────────────────────────────────────────────────

  var machinesFile = path.join(
    process.env.PI_RELAY_HOME || path.join(os.homedir(), ".pi-relay"),
    "fleet", "machines.json"
  );

  var machines = loadMachines();

  function loadMachines() {
    try {
      if (fs.existsSync(machinesFile)) {
        return JSON.parse(fs.readFileSync(machinesFile, "utf8"));
      }
    } catch (e) {}
    return DEFAULT_MACHINES.map(function (m) { return Object.assign({}, m, { available: true }); });
  }

  function saveMachines() {
    try {
      var dir = path.dirname(machinesFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      var tmp = machinesFile + ".tmp." + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(machines, null, 2), "utf8");
      fs.renameSync(tmp, machinesFile);
    } catch (e) {}
  }

  function getMachine(machineId) {
    for (var i = 0; i < machines.length; i++) {
      if (machines[i].id === machineId) return machines[i];
    }
    return null;
  }

  function isLocalMachine(machineId) {
    return !machineId || machineId === "vps5" || machineId === "local";
  }

  // ─── Lazy init ──────────────────────────────────────────────────────────

  function ensureReady() {
    if (ready) return Promise.resolve(orchestrator);
    if (initPromise) return initPromise;

    initPromise = loadOrchestrator().then(function (mod) {
      orchestrator = mod.createOrchestrator({
        projectCwd: cwd,
        projectSlug: slug,
      });
      wireEvents(orchestrator);

      // Startup recovery: restore persisted state
      try {
        // Scheduler: restore cron timers
        orchestrator.scheduler.loadAll(function () { return createLocalAgentQuery(); });
        // Loops: mark running as interrupted, keep paused
        orchestrator.loops.loadAll();
      } catch (e) {
        // Recovery errors are non-fatal
      }

      // Start process monitor bridge (watches incidents.jsonl → fires hooks)
      pmBridge = createProcessMonitorBridge({
        hooks: orchestrator.hooks,
        send: send,
      });
      pmBridge.start();

      // Register built-in health check schedule (every 5 min)
      try {
        var existingSchedules = orchestrator.scheduler.list();
        var hasHealthCheck = false;
        for (var s = 0; s < existingSchedules.length; s++) {
          if (existingSchedules[s].config && existingSchedules[s].config.description === "Fleet health monitoring") {
            hasHealthCheck = true;
            break;
          }
        }
        if (!hasHealthCheck) {
          orchestrator.scheduler.create({
            cron: "*/5 * * * *",
            command: "Run fleet-health check across all machines. Report any services down, high memory usage, or disk issues.",
            project: slug,
            description: "Fleet health monitoring",
          }, createLocalAgentQuery());
        }
      } catch (e) {
        // Non-fatal — health check is convenience, not required
      }

      // Hook integration: pi-bridge calls fireHook() via the deferred
      // onToolEvent callback wired in project.js. No setOnToolEvent needed.

      ready = true;
      return orchestrator;
    }).catch(function (err) {
      console.error("[fleet-bridge] Failed to load orchestrator:", err.message);
      initPromise = null;
      throw err;
    });

    return initPromise;
  }

  // ─── AgentQuery adapters ────────────────────────────────────────────────

  /** Create a local AgentQuery (runs on this machine via pi-bridge). */
  function createLocalAgentQuery() {
    var aborted = false;
    var abortFn = null;

    return {
      send: function (prompt, queryOpts) {
        return new Promise(function (resolve, reject) {
          if (aborted) return reject(new Error("Aborted"));

          var session = sm.createSession({ title: "Fleet: " + (prompt.slice(0, 40)) });

          var text = "";
          var toolCalls = [];
          var startTime = Date.now();
          var timeout = (queryOpts && queryOpts.timeoutMs) || 300000;

          var timer = setTimeout(function () {
            aborted = true;
            try { bridge.abortQuery(session); } catch (e) {}
            resolve({
              text: text,
              completed: false,
              durationMs: Date.now() - startTime,
              toolCalls: toolCalls,
              error: "Timed out after " + timeout + "ms",
            });
          }, timeout);

          var originalOnDelta = session.onDelta;
          session.onDelta = function (delta) {
            text += delta;
            if (originalOnDelta) originalOnDelta(delta);
            if (queryOpts && queryOpts.onDelta) queryOpts.onDelta(delta);
          };

          var originalOnDone = session.onDone;
          session.onDone = function (code) {
            clearTimeout(timer);
            if (originalOnDone) originalOnDone(code);
            resolve({
              text: text,
              completed: code === 0,
              durationMs: Date.now() - startTime,
              toolCalls: toolCalls,
              error: code !== 0 ? "Agent exited with code " + code : undefined,
            });
          };

          abortFn = function () {
            clearTimeout(timer);
            try { bridge.abortQuery(session); } catch (e) {}
          };

          bridge.startQuery(session, prompt);
        });
      },

      abort: function () {
        aborted = true;
        if (abortFn) abortFn();
      },
    };
  }

  /**
   * Create an AgentQuery for a target machine.
   * Returns local query for VPS5, remote query for other machines.
   */
  function createAgentQueryForTarget(targetMachine, targetProject) {
    if (isLocalMachine(targetMachine)) {
      return createLocalAgentQuery();
    }

    var machine = getMachine(targetMachine);
    if (!machine) {
      // Fallback to local if machine not found
      console.warn("[fleet-bridge] Unknown machine '" + targetMachine + "', falling back to local");
      return createLocalAgentQuery();
    }

    return createRemoteAgentQuery({
      host: machine.ip,
      port: machine.port,
      slug: targetProject || machine.projects[0] || "home",
    });
  }

  /** Shorthand: create query from a config object with optional targetMachine/targetProject. */
  function createAgentQueryFromConfig(config) {
    return createAgentQueryForTarget(
      config && config.targetMachine,
      config && config.targetProject
    );
  }

  // ─── Event wiring: orchestrator events → WS messages ────────────────────

  function wireEvents(orch) {
    // --- Loop events ---
    orch.on("loop:started", function (p) {
      send({ type: "loop_status", loopId: p.loopId, state: "running", config: p.config });
    });
    orch.on("loop:iteration:start", function (p) {
      send({ type: "loop_iteration", loopId: p.loopId, iteration: p.iteration, state: "running" });
    });
    orch.on("loop:iteration:complete", function (p) {
      send({ type: "loop_iteration", loopId: p.loopId, iteration: p.iteration, state: "completed", result: { text: p.result.text.slice(0, 2000), completed: p.result.completed } });
    });
    orch.on("loop:iteration:error", function (p) {
      send({ type: "loop_iteration", loopId: p.loopId, iteration: p.iteration, state: "error", error: p.error });
    });
    orch.on("loop:iteration:delta", function (p) {
      send({ type: "loop_delta", loopId: p.loopId, iteration: p.iteration, text: p.text });
    });
    orch.on("loop:paused", function (p) {
      send({ type: "loop_status", loopId: p.loopId, state: "paused", reason: p.reason });
    });
    orch.on("loop:resumed", function (p) {
      send({ type: "loop_status", loopId: p.loopId, state: "running" });
    });
    orch.on("loop:stopped", function (p) {
      send({ type: "loop_status", loopId: p.loopId, state: "stopped", reason: p.reason });
    });
    orch.on("loop:completed", function (p) {
      send({ type: "loop_status", loopId: p.loopId, state: "completed", totalIterations: p.totalIterations });
    });

    // --- Schedule events ---
    orch.on("schedule:created", function (p) {
      send({ type: "schedule_update", scheduleId: p.scheduleId, action: "created", config: p.config });
    });
    orch.on("schedule:deleted", function (p) {
      send({ type: "schedule_update", scheduleId: p.scheduleId, action: "deleted" });
    });
    orch.on("schedule:triggered", function (p) {
      send({ type: "schedule_triggered", scheduleId: p.scheduleId, runId: p.runId, triggered: p.triggered });
    });
    orch.on("schedule:run:complete", function (p) {
      send({ type: "schedule_run_result", scheduleId: p.scheduleId, runId: p.runId, result: { text: p.result.text.slice(0, 2000), completed: p.result.completed } });
    });
    orch.on("schedule:run:error", function (p) {
      send({ type: "schedule_run_result", scheduleId: p.scheduleId, runId: p.runId, error: p.error });
    });

    // --- Task events ---
    orch.on("task:created", function (p) {
      send({ type: "task_update", taskId: p.taskId, action: "created", config: p.config });
    });
    orch.on("task:updated", function (p) {
      send({ type: "task_update", taskId: p.taskId, action: "updated", status: p.status, prev: p.prev });
    });
    orch.on("task:completed", function (p) {
      send({ type: "task_update", taskId: p.taskId, action: "completed" });
    });
    orch.on("task:deleted", function (p) {
      send({ type: "task_update", taskId: p.taskId, action: "deleted" });
    });

    // --- Worktree events ---
    orch.on("worktree:created", function (p) {
      send({ type: "worktree_update", worktreeId: p.worktreeId, action: "created", path: p.path, branch: p.branch });
    });
    orch.on("worktree:merged", function (p) {
      send({ type: "worktree_update", worktreeId: p.worktreeId, action: "merged", targetBranch: p.targetBranch });
    });
    orch.on("worktree:removed", function (p) {
      send({ type: "worktree_update", worktreeId: p.worktreeId, action: "removed" });
    });
    orch.on("worktree:error", function (p) {
      send({ type: "worktree_update", worktreeId: p.worktreeId, action: "error", error: p.error });
    });

    // --- Fleet events ---
    orch.on("fleet:created", function (p) {
      send({ type: "fleet_update", fleetId: p.fleetId, action: "created", config: p.config });
    });
    orch.on("fleet:mission:started", function (p) {
      send({ type: "fleet_mission", fleetId: p.fleetId, missionId: p.missionId, state: "running", worktreeId: p.worktreeId });
    });
    orch.on("fleet:mission:completed", function (p) {
      send({ type: "fleet_mission", fleetId: p.fleetId, missionId: p.missionId, state: "completed", report: p.report });
    });
    orch.on("fleet:mission:failed", function (p) {
      send({ type: "fleet_mission", fleetId: p.fleetId, missionId: p.missionId, state: "failed", error: p.error });
    });
    orch.on("fleet:mission:delta", function (p) {
      send({ type: "fleet_delta", fleetId: p.fleetId, missionId: p.missionId, text: p.text });
    });
    orch.on("fleet:completed", function (p) {
      send({ type: "fleet_update", fleetId: p.fleetId, action: "completed" });
    });
    orch.on("fleet:failed", function (p) {
      send({ type: "fleet_update", fleetId: p.fleetId, action: "failed", error: p.error });
    });

    // --- Hook events ---
    orch.on("hook:triggered", function (p) {
      send({ type: "hook_event", hookId: p.hookId, action: "triggered", event: p.event, toolName: p.toolName });
    });
    orch.on("hook:result", function (p) {
      send({ type: "hook_event", hookId: p.hookId, action: "result", exitCode: p.exitCode, blocked: p.blocked, output: p.output.slice(0, 1000) });
    });

    // --- Autoresearch events ---
    orch.on("autoresearch:started", function (p) {
      send({ type: "autoresearch_status", id: p.id, state: "running", config: p.config });
    });
    orch.on("autoresearch:iteration:start", function (p) {
      send({ type: "autoresearch_iteration", id: p.id, iteration: p.iteration, state: "running" });
    });
    orch.on("autoresearch:iteration:complete", function (p) {
      send({ type: "autoresearch_iteration", id: p.id, iteration: p.iteration, state: "completed", kept: p.kept, metricValue: p.metricValue });
    });
    orch.on("autoresearch:iteration:delta", function (p) {
      send({ type: "autoresearch_delta", id: p.id, iteration: p.iteration, text: p.text });
    });
    orch.on("autoresearch:paused", function (p) {
      send({ type: "autoresearch_status", id: p.id, state: "paused", reason: p.reason });
    });
    orch.on("autoresearch:completed", function (p) {
      send({ type: "autoresearch_status", id: p.id, state: "completed", totalIterations: p.totalIterations, bestMetric: p.bestMetric });
    });
    orch.on("autoresearch:error", function (p) {
      send({ type: "autoresearch_status", id: p.id, state: "error", error: p.error });
    });
  }

  // ─── WS message router ─────────────────────────────────────────────────

  /**
   * Handle fleet-related WS messages from the browser.
   * Returns true if the message was handled, false otherwise.
   */
  function handleMessage(ws, msg) {
    var type = msg.type;
    if (!type) return false;

    if (type.startsWith("loop_") || type.startsWith("schedule_") ||
        type.startsWith("task_") || type.startsWith("worktree_") ||
        type.startsWith("fleet_") || type.startsWith("hook_") ||
        type.startsWith("autoresearch_") || type.startsWith("machine_")) {

      ensureReady().then(function (orch) {
        routeMessage(orch, ws, msg);
      }).catch(function (err) {
        send({ type: "fleet_error", error: "Orchestrator not available: " + err.message });
      });

      return true;
    }

    return false;
  }

  function routeMessage(orch, ws, msg) {
    var type = msg.type;
    var sendToClient = function (obj) {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    };

    try {
      // --- Machine Registry ---
      if (type === "machine_list") {
        sendToClient({ type: "machine_list_result", machines: machines });
        return;
      }
      if (type === "machine_register") {
        var existing = getMachine(msg.id);
        if (existing) {
          Object.assign(existing, msg);
        } else {
          machines.push(Object.assign({ available: true }, msg));
        }
        saveMachines();
        send({ type: "machine_list_result", machines: machines });
        return;
      }
      if (type === "machine_unregister") {
        machines = machines.filter(function (m) { return m.id !== msg.id; });
        saveMachines();
        send({ type: "machine_list_result", machines: machines });
        return;
      }

      // --- Loop ---
      if (type === "loop_start") {
        var loopConfig = {
          command: msg.command,
          intervalMs: msg.intervalMs,
          maxIterations: msg.maxIterations,
          safetyMode: msg.safetyMode,
          description: msg.description,
          model: msg.model,
          targetMachine: msg.targetMachine,
          targetProject: msg.targetProject,
        };
        var loopId = orch.loops.start(loopConfig, createAgentQueryFromConfig(loopConfig));
        sendToClient({ type: "loop_started", loopId: loopId });
        return;
      }
      if (type === "loop_stop") {
        orch.loops.stop(msg.loopId);
        return;
      }
      if (type === "loop_pause") {
        orch.loops.pause(msg.loopId);
        return;
      }
      if (type === "loop_resume") {
        orch.loops.resume(msg.loopId);
        return;
      }
      if (type === "loop_list") {
        var loops = orch.loops.list();
        sendToClient({ type: "loop_list_result", loops: loops });
        return;
      }

      // --- Schedule ---
      if (type === "schedule_create") {
        var schedConfig = {
          cron: msg.cron,
          command: msg.command,
          project: msg.project || slug,
          description: msg.description || "",
          model: msg.model,
          timeoutMs: msg.timeoutMs,
          targetMachine: msg.targetMachine,
          targetProject: msg.targetProject,
        };
        var schedId = orch.scheduler.create(schedConfig, createAgentQueryFromConfig(schedConfig));
        sendToClient({ type: "schedule_created", scheduleId: schedId });
        return;
      }
      if (type === "schedule_delete") {
        orch.scheduler.delete(msg.scheduleId);
        return;
      }
      if (type === "schedule_pause") {
        orch.scheduler.pause(msg.scheduleId);
        return;
      }
      if (type === "schedule_resume") {
        orch.scheduler.resume(msg.scheduleId);
        return;
      }
      if (type === "schedule_run_now") {
        orch.scheduler.runNow(msg.scheduleId).catch(function (err) {
          send({ type: "fleet_error", error: err.message });
        });
        return;
      }
      if (type === "schedule_list") {
        var scheds = orch.scheduler.list();
        sendToClient({ type: "schedule_list_result", schedules: scheds });
        return;
      }

      // --- Tasks ---
      if (type === "task_create") {
        var taskId = orch.tasks.create({
          title: msg.title,
          description: msg.description,
          priority: msg.priority,
          dependencies: msg.dependencies,
          tags: msg.tags,
        });
        sendToClient({ type: "task_created", taskId: taskId });
        return;
      }
      if (type === "task_update_status") {
        orch.tasks.updateStatus(msg.taskId, msg.status);
        return;
      }
      if (type === "task_delete") {
        orch.tasks.delete(msg.taskId);
        return;
      }
      if (type === "task_list") {
        var tasks = orch.tasks.list(msg.filters);
        sendToClient({ type: "task_list_result", tasks: tasks });
        return;
      }
      if (type === "task_summary") {
        var summary = orch.tasks.summary();
        sendToClient({ type: "task_summary_result", summary: summary });
        return;
      }

      // --- Worktrees ---
      if (type === "worktree_create") {
        orch.worktrees.create({
          branch: msg.branch,
          baseBranch: msg.baseBranch,
          description: msg.description,
        }).then(function (id) {
          sendToClient({ type: "worktree_created", worktreeId: id });
        }).catch(function (err) {
          send({ type: "fleet_error", error: err.message });
        });
        return;
      }
      if (type === "worktree_list") {
        var wts = orch.worktrees.list();
        sendToClient({ type: "worktree_list_result", worktrees: wts });
        return;
      }
      if (type === "worktree_merge") {
        orch.worktrees.merge(msg.worktreeId, msg.targetBranch).catch(function (err) {
          send({ type: "fleet_error", error: err.message });
        });
        return;
      }
      if (type === "worktree_remove") {
        orch.worktrees.remove(msg.worktreeId).catch(function () {});
        return;
      }

      // --- Fleet ---
      if (type === "fleet_create") {
        // Resolve agent-typed missions: build prompts from agent registry
        var rawMissions = msg.missions || [];
        for (var mi = 0; mi < rawMissions.length; mi++) {
          var m = rawMissions[mi];
          if (m.agentType && orch.agents && orch.agents.has(m.agentType)) {
            m.prompt = orch.agents.buildPrompt(m.agentType, m.agentParams || { goal: m.prompt });
            if (!m.model) {
              m.model = orch.agents.getModel(m.agentType);
            }
          }
        }

        var fleetConfig = {
          goal: msg.goal,
          missions: rawMissions,
          concurrency: msg.concurrency || 3,
          model: msg.model,
        };
        orch.fleet.create(fleetConfig, function (worktreePath) {
          return createLocalAgentQuery();
        }).then(function (id) {
          sendToClient({ type: "fleet_created", fleetId: id });
        }).catch(function (err) {
          send({ type: "fleet_error", error: err.message });
        });
        return;
      }
      if (type === "fleet_cancel") {
        orch.fleet.cancel(msg.fleetId).catch(function () {});
        return;
      }
      if (type === "fleet_list") {
        var fleets = orch.fleet.list();
        sendToClient({ type: "fleet_list_result", fleets: fleets });
        return;
      }
      if (type === "fleet_status") {
        var fleet = orch.fleet.get(msg.fleetId);
        sendToClient({ type: "fleet_status_result", fleet: fleet });
        return;
      }

      // --- Agent Registry ---
      if (type === "fleet_agent_list") {
        var agents = orch.agents ? orch.agents.list() : [];
        sendToClient({ type: "fleet_agent_list_result", agents: agents.map(function (a) {
          return { name: a.name, description: a.description, tools: a.tools, model: a.model };
        }) });
        return;
      }
      if (type === "fleet_agent_invoke") {
        // Run a single agent as a standalone mission
        var agentType = msg.agentType;
        var agentPrompt = orch.agents && orch.agents.has(agentType)
          ? orch.agents.buildPrompt(agentType, msg.params || { goal: msg.goal })
          : (msg.goal || msg.prompt || "");
        var agentTarget = msg.targetMachine;
        var aq = createAgentQueryForTarget(agentTarget, msg.targetProject);
        aq.send(agentPrompt, {
          model: msg.model || (orch.agents && orch.agents.getModel(agentType)),
          timeoutMs: msg.timeoutMs || 300000,
          onDelta: function (text) {
            send({ type: "fleet_agent_delta", agentType: agentType, text: text });
          },
        }).then(function (result) {
          send({ type: "fleet_agent_result", agentType: agentType, result: { text: result.text.slice(0, 5000), completed: result.completed, durationMs: result.durationMs } });
        }).catch(function (err) {
          send({ type: "fleet_agent_result", agentType: agentType, error: err.message });
        });
        sendToClient({ type: "fleet_agent_invoked", agentType: agentType });
        return;
      }

      // --- Hooks ---
      if (type === "hook_register") {
        var hookId = orch.hooks.register({
          event: msg.event,
          match: msg.match,
          command: msg.command,
          timeoutMs: msg.timeoutMs,
          enabled: msg.enabled !== false,
          description: msg.description,
        });
        sendToClient({ type: "hook_registered", hookId: hookId });
        return;
      }
      if (type === "hook_unregister") {
        orch.hooks.unregister(msg.hookId);
        return;
      }
      if (type === "hook_toggle") {
        orch.hooks.setEnabled(msg.hookId, !!msg.enabled);
        return;
      }
      if (type === "hook_list") {
        var hooks = orch.hooks.list(msg.event);
        sendToClient({ type: "hook_list_result", hooks: hooks });
        return;
      }

      // --- Autoresearch ---
      if (type === "autoresearch_start") {
        var arConfig = {
          goal: msg.goal,
          mode: msg.mode || "research",
          maxIterations: msg.maxIterations,
          metric: msg.metric,
          guardCommand: msg.guardCommand,
          model: msg.model,
          targetMachine: msg.targetMachine,
          targetProject: msg.targetProject,
        };
        var arId = orch.autoresearch.start(arConfig, createAgentQueryFromConfig(arConfig), cwd);
        sendToClient({ type: "autoresearch_started", id: arId });
        return;
      }
      if (type === "autoresearch_pause") {
        orch.autoresearch.pause(msg.id);
        return;
      }
      if (type === "autoresearch_resume") {
        orch.autoresearch.resume(msg.id);
        return;
      }
      if (type === "autoresearch_stop") {
        orch.autoresearch.stop(msg.id);
        return;
      }
      if (type === "autoresearch_list") {
        var sessions = orch.autoresearch.list();
        sendToClient({ type: "autoresearch_list_result", sessions: sessions });
        return;
      }

    } catch (err) {
      send({ type: "fleet_error", error: err.message || String(err) });
    }
  }

  // ─── HTTP API Getters (for frontend panels) ────────────────────────────

  function getOrchestratorData(module) {
    if (!ready || !orchestrator) return null;

    switch (module) {
      case "loops": return orchestrator.loops.list();
      case "schedules": return orchestrator.scheduler.list();
      case "tasks": return orchestrator.tasks.list();
      case "task-summary": return orchestrator.tasks.summary();
      case "worktrees": return orchestrator.worktrees.list();
      case "hooks": return orchestrator.hooks.list();
      case "fleets": return orchestrator.fleet.list();
      case "autoresearch": return orchestrator.autoresearch.list();
      case "machines": return machines;
      case "incidents": return pmBridge ? pmBridge.getRecentIncidents(20) : [];
      case "costs": return orchestrator.costTracker ? orchestrator.costTracker.getSummary() : null;
      case "costs-recent": return orchestrator.costTracker ? orchestrator.costTracker.getRecent(30) : [];
      case "models": return orchestrator.modelRouter ? orchestrator.modelRouter.listModels() : [];
      case "model-routing": return orchestrator.modelRouter ? orchestrator.modelRouter.getRoutingTable() : {};
      case "agents": return orchestrator.agents ? orchestrator.agents.list().map(function (a) { return { name: a.name, description: a.description, tools: a.tools, model: a.model }; }) : [];
      case "status":
        return {
          loops: orchestrator.loops.list().length,
          schedules: orchestrator.scheduler.list().length,
          tasks: orchestrator.tasks.summary(),
          fleets: orchestrator.fleet.list().length,
          autoresearch: orchestrator.autoresearch.list().length,
          machines: machines.length,
          incidents: pmBridge ? pmBridge.getRecentIncidents(5).length : 0,
        };
      default: return null;
    }
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────

  function shutdown() {
    if (pmBridge) pmBridge.stop();
    if (orchestrator) {
      // stopAll persists state for running loops/schedules
      orchestrator.shutdown();
    }
    closeAllConnections();
    ready = false;
    initPromise = null;
  }

  /**
   * Fire a hook event (PreToolUse / PostToolUse).
   * Called from pi-bridge.js when tools are executed.
   * Returns a promise that resolves to { blocked: false } by default,
   * or { blocked: true } if a PreToolUse hook exits with code 2.
   */
  function fireHook(event, toolName, payload) {
    if (!ready || !orchestrator || !orchestrator.hooks) {
      return Promise.resolve({ blocked: false });
    }
    return orchestrator.hooks.fire(event, { toolName: toolName, cwd: cwd }).catch(function (err) {
      console.error("[fleet-bridge] Hook fire error:", err.message);
      return { blocked: false };
    });
  }

  return {
    handleMessage: handleMessage,
    shutdown: shutdown,
    ensureReady: ensureReady,
    getOrchestratorData: getOrchestratorData,
    getMachines: function () { return machines; },
    fireHook: fireHook,
  };
}

module.exports = { createFleetBridge };
