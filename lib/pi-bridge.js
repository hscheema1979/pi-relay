/**
 * pi-bridge.js — Bridge between pi's SDK (AgentSession) and the relay WebSocket protocol.
 *
 * Each relay session gets its own pi AgentSession instance.
 * Events from each AgentSession are routed to the correct relay session.
 */

var crypto = require("crypto");
var fs = require("fs");
var path = require("path");

function createPiBridge(opts) {
  var cwd = opts.cwd;
  var slug = opts.slug || "";
  var sm = opts.sessionManager;  // relay session manager (sessions.js)
  var send = opts.send;          // broadcast to all WS clients
  var pushModule = opts.pushModule;
  var autonomous = opts.autonomous || null; // autonomous session manager
  var debug = opts.debug || false;

  // Pi SDK module (loaded lazily)
  var piSdk = null;

  // Per-relay-session state: localId → { piSession, unsubscribe, pendingDialogs }
  var sessionState = {};

  // --- Extension UI Context ---
  // Creates an ExtensionUIContext that forwards calls over WebSocket to the browser.
  // Fire-and-forget methods (notify, setStatus, setWidget, setTitle) send immediately.
  // Dialog methods (select, confirm, input, editor) return Promises resolved when
  // the browser responds via ext_dialog_response.

  function createRelayUIContext(sessionSend, pendingDialogs) {
    return {
      // --- Fire-and-forget methods ---
      notify: function (message, type) {
        sessionSend({ type: "ext_notify", message: message, notifyType: type || "info" });
      },
      setStatus: function (key, text) {
        sessionSend({ type: "ext_status", key: key, text: text || null });
      },
      setWidget: function (key, content, options) {
        if (Array.isArray(content)) {
          sessionSend({
            type: "ext_widget",
            key: key,
            lines: content,
            placement: (options && options.placement) || "aboveEditor",
          });
        } else if (content === undefined || content === null) {
          sessionSend({ type: "ext_widget", key: key, lines: null });
        }
        // Component factories (function) are TUI-only, silently ignored
      },
      setTitle: function (title) {
        sessionSend({ type: "ext_title", title: title });
      },
      setEditorText: function (text) {
        sessionSend({ type: "ext_editor_text", text: text });
      },

      // --- Dialog methods (round-trip to browser) ---
      select: function (title, options, opts) {
        return new Promise(function (resolve) {
          var id = crypto.randomUUID();
          var timer = null;
          pendingDialogs.set(id, { resolve: resolve, timer: timer });
          if (opts && opts.timeout) {
            timer = setTimeout(function () {
              pendingDialogs.delete(id);
              resolve(undefined);
            }, opts.timeout);
            pendingDialogs.get(id).timer = timer;
          }
          sessionSend({ type: "ext_select", id: id, title: title, options: options });
        });
      },
      confirm: function (title, message, opts) {
        return new Promise(function (resolve) {
          var id = crypto.randomUUID();
          var timer = null;
          pendingDialogs.set(id, { resolve: resolve, timer: timer });
          if (opts && opts.timeout) {
            timer = setTimeout(function () {
              pendingDialogs.delete(id);
              resolve(false);
            }, opts.timeout);
            pendingDialogs.get(id).timer = timer;
          }
          sessionSend({ type: "ext_confirm", id: id, title: title, message: message });
        });
      },
      input: function (title, placeholder, opts) {
        return new Promise(function (resolve) {
          var id = crypto.randomUUID();
          var timer = null;
          pendingDialogs.set(id, { resolve: resolve, timer: timer });
          if (opts && opts.timeout) {
            timer = setTimeout(function () {
              pendingDialogs.delete(id);
              resolve(undefined);
            }, opts.timeout);
            pendingDialogs.get(id).timer = timer;
          }
          sessionSend({ type: "ext_input", id: id, title: title, placeholder: placeholder || "" });
        });
      },
      editor: function (title, prefill) {
        return new Promise(function (resolve) {
          var id = crypto.randomUUID();
          pendingDialogs.set(id, { resolve: resolve, timer: null });
          sessionSend({ type: "ext_editor", id: id, title: title, prefill: prefill || "" });
        });
      },

      // --- No-ops (TUI-only, cannot translate to web) ---
      onTerminalInput: function () { return function () {}; },
      setWorkingMessage: function () {},
      setFooter: function () {},
      setHeader: function () {},
      custom: async function () { return undefined; },
      pasteToEditor: function () {},
      getEditorText: function () { return ""; },
      setEditorComponent: function () {},
      get theme() { return undefined; },
      getAllThemes: function () { return []; },
      getTheme: function () { return undefined; },
      setTheme: function () { return { success: false, error: "Not in TUI mode" }; },
      getToolsExpanded: function () { return false; },
      setToolsExpanded: function () {},
    };
  }

  // Shared state
  var currentModel = null;
  var pendingModel = null;
  var availableModels = [];

  function log() {
    if (debug) console.log.apply(console, ["[pi-bridge]"].concat(Array.from(arguments)));
  }

  // --- Autonomous session detection ---

  /**
   * Check if a session is in autonomous/execution mode.
   * Uses the persisted executionMode flag on the session object,
   * or falls back to reading the sidecar file on disk.
   */
  function isAutonomousSession(session) {
    if (session.executionMode) return true;
    // Fallback: check sidecar file on disk
    var sidecar = readExecutionModeSidecar();
    return sidecar !== null && (sidecar.status === "active" || sidecar.status === "running");
  }

  /**
   * Read the execution-mode sidecar file for this project.
   * Returns parsed JSON or null if not found/invalid.
   */
  function readExecutionModeSidecar() {
    try {
      var sidecarPath = path.join(cwd, ".pi", "execution-mode.json");
      var raw = fs.readFileSync(sidecarPath, "utf8");
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  async function getSDK() {
    if (!piSdk) {
      piSdk = await import("@mariozechner/pi-coding-agent");
    }
    return piSdk;
  }

  function sendAndRecord(session, obj) {
    sm.sendAndRecord(session, obj);
  }

  // --- Get/create per-session state ---

  function getState(session) {
    var id = session.localId;
    if (!sessionState[id]) {
      sessionState[id] = { piSession: null, unsubscribe: null, pendingDialogs: new Map() };
    }
    return sessionState[id];
  }

  function cleanupState(session) {
    var id = session.localId;
    var state = sessionState[id];
    if (!state) return;
    if (state.unsubscribe) {
      state.unsubscribe();
      state.unsubscribe = null;
    }
    // Cancel any pending extension UI dialogs
    if (state.pendingDialogs) {
      state.pendingDialogs.forEach(function (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        // Resolve with default (undefined for select/input, false for confirm)
        pending.resolve(undefined);
      });
      state.pendingDialogs.clear();
    }
    if (state.piSession) {
      try { state.piSession.dispose(); } catch (e) {}
      state.piSession = null;
    }
    delete sessionState[id];
  }

  // --- Event translation: pi events → relay WS messages ---

  function handlePiEvent(session, event) {
    try {
      _handlePiEvent(session, event);
    } catch (e) {
      console.error("[pi-bridge] Error handling event:", e.message, event.type);
    }
  }

  function _handlePiEvent(session, event) {
    switch (event.type) {
      case "agent_start":
        session.isProcessing = true;
        session.streamedText = false;
        session.responsePreview = "";
        break;

      case "agent_end":
        session.isProcessing = false;
        sendAndRecord(session, {
          type: "result",
          cost: null,
          duration: null,
          usage: null,
          modelUsage: null,
          sessionId: session.piSessionId || null,
        });
        sendAndRecord(session, { type: "done", code: 0 });

        // Suppress push notifications for autonomous sessions.
        // They send a single push on plan completion/failure, not per turn.
        if (pushModule && !isAutonomousSession(session)) {
          var preview = (session.responsePreview || "").replace(/\s+/g, " ").trim();
          if (preview.length > 140) preview = preview.substring(0, 140) + "...";
          pushModule.sendPush({
            type: "done",
            slug: slug,
            title: session.title || "Pi Agent",
            body: preview || "Response ready",
            tag: "pi-done",
          });
        }

        // Check if execution mode just completed (sidecar status changed to completed/failed)
        if (autonomous && session.executionMode) {
          var sidecar = readExecutionModeSidecar();
          if (sidecar && (sidecar.status === "completed" || sidecar.status === "failed")) {
            // Execution mode is done — update autonomous manager and send push
            session.executionMode = false;
            sm.saveSessionFile(session);
            autonomous.completeSession(session.localId, {
              status: sidecar.status,
              resolved: sidecar.status === "completed",
            });
            // Send single push notification for plan completion
            if (pushModule) {
              var planName = (sidecar.plan && sidecar.plan.text) || session.title || "Execution plan";
              if (planName.length > 80) planName = planName.substring(0, 80) + "...";
              var pushIcon = sidecar.status === "completed" ? "✅" : "❌";
              pushModule.sendPush({
                type: "done",
                slug: slug,
                title: pushIcon + " Execution " + sidecar.status,
                body: planName,
                tag: "pi-exec-" + sidecar.status,
              });
            }
          }
        }

        session.responsePreview = "";
        session.streamedText = false;
        sm.broadcastSessionList();
        break;

      case "message_update":
        if (event.assistantMessageEvent) {
          var ame = event.assistantMessageEvent;
          switch (ame.type) {
            case "text_delta":
              session.streamedText = true;
              if (session.responsePreview.length < 200) {
                session.responsePreview += ame.delta;
              }
              sendAndRecord(session, { type: "delta", text: ame.delta });
              break;
            case "thinking_start":
              sendAndRecord(session, { type: "thinking_start" });
              break;
            case "thinking_delta":
              sendAndRecord(session, { type: "thinking_delta", text: ame.delta });
              break;
            case "thinking_end":
              sendAndRecord(session, { type: "thinking_stop" });
              break;
          }
        }
        break;

      case "tool_execution_start":
        sendAndRecord(session, { type: "tool_start", id: event.toolCallId, name: event.toolName });
        sendAndRecord(session, {
          type: "tool_executing",
          id: event.toolCallId,
          name: event.toolName,
          input: event.args || {},
        });
        break;

      case "tool_execution_update":
        if (event.partialResult && typeof event.partialResult === "object") {
          var updateText = "";
          if (event.partialResult.content) {
            var contents = Array.isArray(event.partialResult.content) ? event.partialResult.content : [];
            for (var i = 0; i < contents.length; i++) {
              if (contents[i].type === "text") updateText += contents[i].text;
            }
          } else if (event.partialResult.stdout) {
            updateText = event.partialResult.stdout;
          } else if (typeof event.partialResult === "string") {
            updateText = event.partialResult;
          }
          if (updateText) {
            sendAndRecord(session, { type: "stderr", text: updateText });
          }
        }
        break;

      case "tool_execution_end":
        var resultText = "";
        if (event.result && event.result.content) {
          var rContents = Array.isArray(event.result.content) ? event.result.content : [];
          for (var j = 0; j < rContents.length; j++) {
            if (rContents[j].type === "text") resultText += rContents[j].text;
          }
        } else if (typeof event.result === "string") {
          resultText = event.result;
        }
        sendAndRecord(session, {
          type: "tool_result",
          id: event.toolCallId,
          content: resultText,
          is_error: event.isError || false,
        });
        break;

      case "auto_compaction_start":
        sendAndRecord(session, { type: "compacting", active: true });
        break;
      case "auto_compaction_end":
        sendAndRecord(session, { type: "compacting", active: false });
        break;
      case "auto_retry_start":
        sendAndRecord(session, { type: "info", text: "Retrying..." });
        break;
      default:
        log("Unhandled event type:", event.type);
        break;
    }
  }

  // --- Session lifecycle ---

  async function createPiSession(session) {
    var sdk = await getSDK();
    var state = getState(session);

    // Clean up any existing session for this relay session
    if (state.unsubscribe) { state.unsubscribe(); state.unsubscribe = null; }
    if (state.piSession) { try { state.piSession.dispose(); } catch (e) {} state.piSession = null; }

    var authStorage = sdk.AuthStorage.create();
    var modelRegistry = new sdk.ModelRegistry(authStorage);

    var sessionMgr;
    if (session.piSessionFile) {
      sessionMgr = sdk.SessionManager.open(session.piSessionFile);
    } else {
      sessionMgr = sdk.SessionManager.create(cwd);
    }

    var createOpts = {
      cwd: cwd,
      sessionManager: sessionMgr,
      authStorage: authStorage,
      modelRegistry: modelRegistry,
    };

    if (pendingModel) {
      createOpts.model = pendingModel;
      pendingModel = null;
    }

    var result = await sdk.createAgentSession(createOpts);
    state.piSession = result.session;

    // Track session file and persist immediately so it survives process restart
    if (state.piSession.sessionFile) {
      session.piSessionFile = state.piSession.sessionFile;
      session.piSessionId = state.piSession.sessionId;
      sm.saveSessionFile(session);
    }

    // Check if execution mode is active (from sidecar file) and register with autonomous manager
    if (autonomous) {
      var sidecar = readExecutionModeSidecar();
      if (sidecar && (sidecar.status === "active" || sidecar.status === "running")) {
        session.executionMode = true;
        sm.saveSessionFile(session);
        autonomous.registerSession(session.localId, {
          type: "execution-mode",
          status: "active",
          piSessionFile: session.piSessionFile,
          plan: sidecar.plan || null,
          safetyCounters: sidecar.safetyCounters || null,
          lastCheckpoint: sidecar.lastCheckpoint || null,
        });
        log("Registered autonomous execution-mode session", session.localId);
      }
    }

    // Update model info (shared across sessions in this project)
    currentModel = state.piSession.model ? state.piSession.model.id : "unknown";
    try {
      var avail = await modelRegistry.getAvailable();
      availableModels = avail.map(function (m) {
        return { value: m.id, displayName: m.name || m.id, provider: m.provider || "unknown" };
      });
    } catch (e) {
      availableModels = [];
    }

    sm.currentModel = currentModel;
    sm.availableModels = availableModels;
    send({ type: "model_info", model: currentModel, models: availableModels });

    // Subscribe to events — routed to this specific relay session
    state.unsubscribe = state.piSession.subscribe(function (event) {
      handlePiEvent(session, event);
    });

    // Bind extension UI context so extensions can talk to the browser.
    // This replaces the default noOpUIContext with our relay implementation
    // that forwards notify/setStatus/setWidget/select/confirm/input over WebSocket.
    // Also emits session_start to all extensions.
    // Use send() (broadcast only, not persisted) for ephemeral UI like toasts and status.
    try {
      var uiCtx = createRelayUIContext(
        function (obj) { send(obj); },
        state.pendingDialogs
      );
      await state.piSession.bindExtensions({
        uiContext: uiCtx,
        onError: function (err) {
          log("Extension error:", err.event, err.error);
          sendAndRecord(session, {
            type: "ext_notify",
            message: "Extension error (" + err.event + "): " + err.error,
            notifyType: "error",
          });
        },
      });
      log("Extension UI context bound for session", session.localId);
    } catch (e) {
      log("Failed to bind extension UI context:", e.message);
    }

    // Broadcast updated slash commands from extension runner
    try {
      var runner = state.piSession.extensionRunner;
      if (runner) {
        var extCommands = runner.getRegisteredCommands();
        if (extCommands && extCommands.length > 0) {
          var commands = [];
          // Re-load prompts and skills
          var rl = state.piSession.resourceLoader;
          if (rl) {
            var prompts = rl.getPrompts();
            if (prompts && prompts.prompts) {
              for (var pi = 0; pi < prompts.prompts.length; pi++) {
                commands.push({
                  name: prompts.prompts[pi].name,
                  desc: prompts.prompts[pi].description || prompts.prompts[pi].name,
                  source: "prompt",
                });
              }
            }
            var skills = rl.getSkills();
            if (skills && skills.skills) {
              for (var si = 0; si < skills.skills.length; si++) {
                commands.push({
                  name: "skill:" + skills.skills[si].name,
                  desc: skills.skills[si].description || skills.skills[si].name,
                  source: "skill",
                });
              }
            }
          }
          for (var ci = 0; ci < extCommands.length; ci++) {
            commands.push({
              name: extCommands[ci].invocationName || extCommands[ci].name,
              desc: extCommands[ci].description || extCommands[ci].name,
              source: "extension",
            });
          }
          sm.slashCommands = commands;
          send({ type: "slash_commands", commands: commands });
        }
      }
    } catch (e) {
      log("Failed to extract extension commands:", e.message);
    }

    return state.piSession;
  }

  // --- Query handling ---

  async function startQuery(session, text, images) {
    try {
      var state = getState(session);
      if (!state.piSession) {
        await createPiSession(session);
        state = getState(session);
      }

      session.isProcessing = true;
      session.streamedText = false;
      session.responsePreview = "";
      sm.broadcastSessionList();

      var promptOpts = {};
      if (images && images.length > 0) {
        promptOpts.images = images.map(function (img) {
          return {
            type: "image",
            data: img.data,
            mimeType: img.mediaType,
          };
        });
      }

      if (state.piSession.isStreaming) {
        await state.piSession.steer(text, promptOpts.images);
      } else {
        await state.piSession.prompt(text, promptOpts);
      }

      // If prompt returned without triggering agent events (e.g. extension command
      // handled directly), ensure the UI gets a done signal so it exits processing state.
      if (session.isProcessing && !session.streamedText) {
        session.isProcessing = false;
        sendAndRecord(session, { type: "done", code: 0 });
        sm.broadcastSessionList();
      }
    } catch (err) {
      session.isProcessing = false;
      if (err.name === "AbortError" || (err.message && err.message.indexOf("abort") !== -1)) {
        sendAndRecord(session, { type: "info", text: "Interrupted · What should pi do instead?" });
        sendAndRecord(session, { type: "done", code: 0 });
      } else {
        console.error("[pi-bridge] Query error:", err.message || err);
        sendAndRecord(session, { type: "error", text: "Pi agent error: " + (err.message || err) });
        sendAndRecord(session, { type: "done", code: 1 });
      }
      sm.broadcastSessionList();
    }
  }

  async function abortQuery(session) {
    var state = getState(session);
    if (state.piSession) {
      try {
        await state.piSession.abort();
      } catch (e) {
        log("Abort error:", e.message);
      }
    }
  }

  // --- Model management ---

  async function findModel(modelId) {
    var sdk = await getSDK();
    var authStorage = sdk.AuthStorage.create();
    var modelRegistry = new sdk.ModelRegistry(authStorage);

    var parts = modelId.split("/");
    if (parts.length === 2) {
      var model = modelRegistry.find(parts[0], parts[1]);
      if (model) return model;
    }

    try {
      var avail = await modelRegistry.getAvailable();
      for (var i = 0; i < avail.length; i++) {
        if (avail[i].id === modelId) {
          return avail[i];
        }
      }
    } catch (e) {}

    return null;
  }

  async function setModel(session, modelId) {
    try {
      var model = await findModel(modelId);
      if (!model) {
        send({ type: "error", text: "Model not found: " + modelId });
        return;
      }

      pendingModel = model;
      currentModel = modelId;
      sm.currentModel = currentModel;
      send({ type: "model_info", model: currentModel, models: availableModels });

      // If this relay session has an active piSession, switch it live
      var state = getState(session);
      if (state.piSession) {
        await state.piSession.setModel(model);
      }
    } catch (e) {
      send({ type: "error", text: "Failed to switch model: " + (e.message || e) });
    }
  }

  // --- Warmup ---

  async function warmup() {
    try {
      var sdk = await getSDK();
      var authStorage = sdk.AuthStorage.create();
      var modelRegistry = new sdk.ModelRegistry(authStorage);

      try {
        var avail = await modelRegistry.getAvailable();
        availableModels = avail.map(function (m) {
          return { value: m.id, displayName: m.name || m.id, provider: m.provider || "unknown" };
        });
      } catch (e) {
        availableModels = [];
      }

      try {
        var settingsManager = sdk.SettingsManager.create(cwd);
        if (avail && avail.length > 0) {
          currentModel = avail[0].id || avail[0].name || "unknown";
        }
      } catch (e) {}

      sm.currentModel = currentModel || "";
      sm.availableModels = availableModels;
      send({ type: "model_info", model: currentModel || "", models: availableModels });

      var commands = [];
      try {
        var loader = new sdk.DefaultResourceLoader({ cwd: cwd });
        await loader.reload();

        // Load prompt templates
        var prompts = loader.getPrompts();
        if (prompts && prompts.prompts) {
          commands = prompts.prompts.map(function (p) {
            return { name: p.name, desc: p.description || p.name, source: "prompt" };
          });
        }

        // Load skills as /skill:name commands
        var skills = loader.getSkills();
        if (skills && skills.skills) {
          for (var si = 0; si < skills.skills.length; si++) {
            var skill = skills.skills[si];
            commands.push({
              name: "skill:" + skill.name,
              desc: skill.description || skill.name,
              source: "skill",
            });
          }
        }

        // Load extension-registered commands
        var extResult = loader.getExtensions();
        if (extResult && extResult.extensions) {
          for (var ei = 0; ei < extResult.extensions.length; ei++) {
            var ext = extResult.extensions[ei];
            if (ext.commands && ext.commands.size > 0) {
              ext.commands.forEach(function (cmd, cmdName) {
                commands.push({
                  name: cmdName,
                  desc: cmd.description || cmdName,
                  source: "extension",
                });
              });
            }
          }
        }
      } catch (e) {
        log("Failed to load resources:", e.message);
      }
      sm.slashCommands = commands;
      send({ type: "slash_commands", commands: commands });

    } catch (e) {
      if (e && e.name !== "AbortError") {
        console.error("[pi-bridge] Warmup error:", e.message || e);
        send({ type: "error", text: "Failed to load pi SDK: " + (e.message || e) });
      }
    }
  }

  // --- New session ---

  async function newSession(session) {
    cleanupState(session);
    session.piSessionFile = null;
    session.piSessionId = null;
  }

  // --- Resume session ---

  async function resumeSession(session, sessionPath) {
    cleanupState(session);
    session.piSessionFile = sessionPath;
    await createPiSession(session);
  }

  // --- List CLI sessions ---

  async function listSessions() {
    try {
      var sdk = await getSDK();
      var sessions = await sdk.SessionManager.list(cwd);
      return sessions.map(function (s) {
        return {
          id: s.id,
          path: s.path || s.id,
          firstMessage: s.firstMessage || "(no message)",
          messageCount: s.messageCount || 0,
          lastModified: s.lastModified || null,
          cwd: s.cwd || cwd,
        };
      });
    } catch (e) {
      console.error("[pi-bridge] listSessions error:", e.message);
      return [];
    }
  }

  // --- Extension UI dialog response handler ---

  function handleExtDialogResponse(session, msg) {
    var state = getState(session);
    if (!state.pendingDialogs) return;
    var pending = state.pendingDialogs.get(msg.id);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    state.pendingDialogs.delete(msg.id);
    if (msg.cancelled) {
      // Cancelled: resolve with undefined (select/input/editor) or false (confirm)
      pending.resolve(msg.method === "confirm" ? false : undefined);
    } else if (msg.method === "confirm") {
      pending.resolve(!!msg.confirmed);
    } else {
      pending.resolve(msg.value);
    }
  }

  // --- Cleanup ---

  function destroy() {
    var ids = Object.keys(sessionState);
    for (var i = 0; i < ids.length; i++) {
      var state = sessionState[ids[i]];
      if (state.unsubscribe) { try { state.unsubscribe(); } catch (e) {} }
      if (state.piSession) { try { state.piSession.dispose(); } catch (e) {} }
    }
    sessionState = {};
  }

  return {
    startQuery: startQuery,
    abortQuery: abortQuery,
    setModel: setModel,
    warmup: warmup,
    newSession: newSession,
    resumeSession: resumeSession,
    listSessions: listSessions,
    handleExtDialogResponse: handleExtDialogResponse,
    destroy: destroy,
  };
}

module.exports = { createPiBridge: createPiBridge };
