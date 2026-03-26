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
  var debug = opts.debug || false;

  // Pi SDK module (loaded lazily)
  var piSdk = null;

  // Per-relay-session state: localId → { piSession, unsubscribe }
  var sessionState = {};

  // Shared state
  var currentModel = null;
  var pendingModel = null;
  var availableModels = [];

  function log() {
    if (debug) console.log.apply(console, ["[pi-bridge]"].concat(Array.from(arguments)));
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
      sessionState[id] = { piSession: null, unsubscribe: null };
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

        if (pushModule) {
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

    // Track session file
    if (state.piSession.sessionFile) {
      session.piSessionFile = state.piSession.sessionFile;
      session.piSessionId = state.piSession.sessionId;
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
            source: {
              type: "base64",
              mediaType: img.mediaType,
              data: img.data,
            },
          };
        });
      }

      if (state.piSession.isStreaming) {
        await state.piSession.steer(text);
      } else {
        await state.piSession.prompt(text, promptOpts);
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
        var prompts = loader.getPrompts();
        if (prompts && prompts.prompts) {
          commands = prompts.prompts.map(function (p) {
            return { name: p.name, desc: p.description || p.name };
          });
        }
      } catch (e) {
        log("Failed to load prompts:", e.message);
      }
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
    destroy: destroy,
  };
}

module.exports = { createPiBridge: createPiBridge };
