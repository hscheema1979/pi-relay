/**
 * pi-bridge.js — Bridge between pi's SDK (AgentSession) and the relay WebSocket protocol.
 *
 * Replaces sdk-bridge.js (Claude Agent SDK) with pi's @mariozechner/pi-coding-agent SDK.
 * Translates pi AgentSession events into the message format the relay UI expects.
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
  var piSession = null;        // AgentSession instance
  var unsubscribe = null;      // event subscription cleanup
  var currentModel = null;
  var pendingModel = null;     // Model to use when creating next session
  var availableModels = [];

  function log() {
    if (debug) console.log.apply(console, ["[pi-bridge]"].concat(Array.from(arguments)));
  }

  // --- Lazy SDK loader ---
  async function getSDK() {
    if (!piSdk) {
      piSdk = await import("@mariozechner/pi-coding-agent");
    }
    return piSdk;
  }

  function sendAndRecord(session, obj) {
    sm.sendAndRecord(session, obj);
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
        // Streaming tool output (e.g., bash stdout)
        if (event.partialResult && typeof event.partialResult === "object") {
          var updateText = "";
          if (event.partialResult.content) {
            // Extract text from content array
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

    var authStorage = sdk.AuthStorage.create();
    var modelRegistry = new sdk.ModelRegistry(authStorage);

    var sessionMgr;
    if (session.piSessionFile) {
      // Resume existing session
      sessionMgr = sdk.SessionManager.open(session.piSessionFile);
    } else {
      // New session
      sessionMgr = sdk.SessionManager.create(cwd);
    }

    var createOpts = {
      cwd: cwd,
      sessionManager: sessionMgr,
      authStorage: authStorage,
      modelRegistry: modelRegistry,
    };

    // Use pending model if one was selected before session creation
    if (pendingModel) {
      createOpts.model = pendingModel;
      pendingModel = null;
    }

    var result = await sdk.createAgentSession(createOpts);
    piSession = result.session;

    // Track session file
    if (piSession.sessionFile) {
      session.piSessionFile = piSession.sessionFile;
      session.piSessionId = piSession.sessionId;
    }

    // Get model info
    currentModel = piSession.model ? piSession.model.id : "unknown";
    try {
      var avail = await modelRegistry.getAvailable();
      availableModels = avail.map(function (m) { return m.id || m.name || String(m); });
    } catch (e) {
      availableModels = [];
    }

    sm.currentModel = currentModel;
    sm.availableModels = availableModels;
    send({ type: "model_info", model: currentModel, models: availableModels });

    // Subscribe to events
    if (unsubscribe) unsubscribe();
    unsubscribe = piSession.subscribe(function (event) {
      handlePiEvent(session, event);
    });

    return piSession;
  }

  // --- Query handling ---

  async function startQuery(session, text, images) {
    try {
      if (!piSession) {
        await createPiSession(session);
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

      // If already streaming, use steer
      if (piSession.isStreaming) {
        await piSession.steer(text);
      } else {
        await piSession.prompt(text, promptOpts);
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
    if (piSession) {
      try {
        await piSession.abort();
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

    // Try provider/id combo first (e.g. "litellm/gemini-2.5-flash")
    var parts = modelId.split("/");
    if (parts.length === 2) {
      var model = modelRegistry.find(parts[0], parts[1]);
      if (model) return model;
    }

    // Search across all available models by id
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

      // Store for next session creation
      pendingModel = model;
      currentModel = modelId;
      sm.currentModel = currentModel;
      send({ type: "model_info", model: currentModel, models: availableModels });

      // If session exists, switch it live
      if (piSession) {
        await piSession.setModel(model);
      }
    } catch (e) {
      send({ type: "error", text: "Failed to switch model: " + (e.message || e) });
    }
  }

  // --- Warmup: load SDK and get model/command info ---

  async function warmup() {
    try {
      var sdk = await getSDK();
      var authStorage = sdk.AuthStorage.create();
      var modelRegistry = new sdk.ModelRegistry(authStorage);

      // Get available models
      try {
        var avail = await modelRegistry.getAvailable();
        availableModels = avail.map(function (m) { return m.id || m.name || String(m); });
      } catch (e) {
        availableModels = [];
      }

      // Get default model from settings
      try {
        var settingsManager = sdk.SettingsManager.create(cwd);
        // Try to determine default model
        if (avail && avail.length > 0) {
          currentModel = avail[0].id || avail[0].name || "unknown";
        }
      } catch (e) {}

      // Cache in session manager so new client connections get the info
      sm.currentModel = currentModel || "";
      sm.availableModels = availableModels;
      send({ type: "model_info", model: currentModel || "", models: availableModels });

      // Send slash commands (pi prompt templates act as slash commands)
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
    // Clean up old session
    if (piSession) {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      try { piSession.dispose(); } catch (e) {}
      piSession = null;
    }
    session.piSessionFile = null;
    session.piSessionId = null;
  }

  // --- Resume session ---

  async function resumeSession(session, sessionPath) {
    await newSession(session);
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
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (piSession) {
      try { piSession.dispose(); } catch (e) {}
      piSession = null;
    }
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
    getPiSession: function () { return piSession; },
  };
}

module.exports = { createPiBridge: createPiBridge };
