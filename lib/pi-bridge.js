/**
 * pi-bridge.js — Bridge between Claude Agent SDK and the relay WebSocket protocol.
 *
 * Each relay session gets its own Agent SDK query.
 * Messages from each query are translated to the relay WS protocol.
 *
 * Migrated from @mariozechner/pi-coding-agent to @anthropic-ai/claude-agent-sdk.
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
  var autonomous = opts.autonomous || null;
  var debug = opts.debug || false;

  // Agent SDK module (loaded lazily since it's ESM-compatible but we're CJS)
  var agentSdk = null;

  // Per-relay-session state: localId → { query, sessionId, pendingDialogs, queryRunning, streamState }
  var sessionState = {};

  // Shared state
  var currentModel = null;
  var pendingModel = null;
  var availableModels = [];

  function log() {
    if (debug) console.log.apply(console, ["[pi-bridge]"].concat(Array.from(arguments)));
  }

  // --- Autonomous session detection ---

  function isAutonomousSession(session) {
    if (session.executionMode) return true;
    var sidecar = readExecutionModeSidecar();
    return sidecar !== null && (sidecar.status === "active" || sidecar.status === "running");
  }

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
    if (!agentSdk) {
      agentSdk = require("@anthropic-ai/claude-agent-sdk");
    }
    return agentSdk;
  }

  function sendAndRecord(session, obj) {
    sm.sendAndRecord(session, obj);
  }

  // --- Per-session state management ---

  function getState(session) {
    var id = session.localId;
    if (!sessionState[id]) {
      sessionState[id] = {
        query: null,           // Active Query instance (for close/interrupt)
        sessionId: null,       // Agent SDK session ID for resume
        pendingDialogs: new Map(),
        queryRunning: false,
        // Track streaming state per content block index
        streamState: {
          blockTypes: {},      // index → block type (text, thinking, tool_use)
          blockIds: {},        // index → tool_use id
          blockNames: {},      // index → tool name
          thinkingActive: false,
        },
      };
    }
    return sessionState[id];
  }

  function resetStreamState(state) {
    state.streamState = {
      blockTypes: {},
      blockIds: {},
      blockNames: {},
      thinkingActive: false,
    };
  }

  function cleanupState(session) {
    var id = session.localId;
    var state = sessionState[id];
    if (!state) return;
    if (state.query) {
      try { state.query.close(); } catch (e) {}
      state.query = null;
    }
    if (state.pendingDialogs) {
      state.pendingDialogs.forEach(function (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(undefined);
      });
      state.pendingDialogs.clear();
    }
    state.queryRunning = false;
    delete sessionState[id];
  }

  // --- Translate Agent SDK messages to relay WS protocol ---

  function handleAgentMessage(session, msg) {
    try {
      _handleAgentMessage(session, msg);
    } catch (e) {
      console.error("[pi-bridge] Error handling message:", e.message, msg.type);
    }
  }

  function _handleAgentMessage(session, msg) {
    var state = getState(session);

    switch (msg.type) {
      case "system":
        if (msg.subtype === "init" && msg.session_id) {
          state.sessionId = msg.session_id;
          session.piSessionId = msg.session_id;
          sm.saveSessionFile(session);

          // Update model from init message if available
          if (msg.model) {
            currentModel = msg.model;
            sm.currentModel = currentModel;
            send({ type: "model_info", model: currentModel, models: availableModels });
          }
        }
        break;

      case "stream_event":
        // Incremental streaming events — translate to relay protocol
        handleStreamEvent(session, msg, state);
        break;

      case "assistant":
        // Complete assistant messages — these arrive after streaming is done.
        // If we're using includePartialMessages, the stream_event messages
        // already sent the content incrementally. We only need to handle
        // tool_use blocks that weren't streamed (they arrive complete).
        if (msg.message && msg.message.content) {
          var content = msg.message.content;
          for (var i = 0; i < content.length; i++) {
            var block = content[i];
            if (block.type === "tool_use") {
              // Send tool_start + tool_executing for tool use blocks
              // (stream events only give us partial JSON, the complete block is here)
              sendAndRecord(session, {
                type: "tool_start",
                id: block.id,
                name: block.name,
              });
              sendAndRecord(session, {
                type: "tool_executing",
                id: block.id,
                name: block.name,
                input: block.input || {},
              });
            }
          }
        }
        // Reset stream state for next assistant turn
        resetStreamState(state);
        break;

      case "user":
        // Tool results coming back from the Agent SDK
        if (msg.message && msg.message.content) {
          var userContent = Array.isArray(msg.message.content) ? msg.message.content : [];
          for (var j = 0; j < userContent.length; j++) {
            var toolResult = userContent[j];
            if (toolResult.type === "tool_result") {
              var resultText = "";
              if (typeof toolResult.content === "string") {
                resultText = toolResult.content;
              } else if (Array.isArray(toolResult.content)) {
                for (var k = 0; k < toolResult.content.length; k++) {
                  if (toolResult.content[k].type === "text") {
                    resultText += toolResult.content[k].text;
                  }
                }
              }
              sendAndRecord(session, {
                type: "tool_result",
                id: toolResult.tool_use_id,
                content: resultText,
                is_error: toolResult.is_error || false,
              });
            }
          }
        }
        break;

      case "result":
        // Query finished
        session.isProcessing = false;

        // Close any open thinking block
        if (state.streamState.thinkingActive) {
          sendAndRecord(session, { type: "thinking_stop" });
          state.streamState.thinkingActive = false;
        }

        sendAndRecord(session, {
          type: "result",
          cost: msg.total_cost_usd || null,
          duration: msg.duration_ms || null,
          usage: msg.usage || null,
          modelUsage: msg.modelUsage || null,
          sessionId: msg.session_id || session.piSessionId || null,
        });
        sendAndRecord(session, { type: "done", code: msg.is_error ? 1 : 0 });

        // Push notification (suppress for autonomous sessions)
        if (pushModule && !isAutonomousSession(session)) {
          var preview = (session.responsePreview || "").replace(/\s+/g, " ").trim();
          if (preview.length > 140) preview = preview.substring(0, 140) + "...";
          pushModule.sendPush({
            type: "done",
            slug: slug,
            title: session.title || "Claude Agent",
            body: preview || "Response ready",
            tag: "pi-done",
          });
        }

        // Check execution mode sidecar
        handleAutonomousCheck(session);

        session.responsePreview = "";
        session.streamedText = false;
        resetStreamState(state);
        sm.broadcastSessionList();
        break;

      default:
        // Ignore rate_limit_event, status, and other internal messages
        log("Unhandled message type:", msg.type, msg.subtype || "");
        break;
    }
  }

  // --- Handle streaming events for incremental text/thinking delivery ---

  function handleStreamEvent(session, msg, state) {
    var event = msg.event;
    if (!event) return;

    switch (event.type) {
      case "content_block_start":
        var block = event.content_block;
        var idx = event.index;
        state.streamState.blockTypes[idx] = block.type;

        if (block.type === "thinking") {
          state.streamState.thinkingActive = true;
          sendAndRecord(session, { type: "thinking_start" });
        } else if (block.type === "text") {
          session.streamedText = true;
        } else if (block.type === "tool_use") {
          state.streamState.blockIds[idx] = block.id;
          state.streamState.blockNames[idx] = block.name;
          // Don't send tool_start here — wait for the complete assistant message
          // which has the full input. The stream only gives partial JSON.
        }
        break;

      case "content_block_delta":
        var deltaIdx = event.index;
        var delta = event.delta;
        var blockType = state.streamState.blockTypes[deltaIdx];

        if (delta.type === "thinking_delta" && blockType === "thinking") {
          sendAndRecord(session, { type: "thinking_delta", text: delta.thinking });
        } else if (delta.type === "text_delta" && blockType === "text") {
          if (session.responsePreview.length < 200) {
            session.responsePreview += delta.text;
          }
          sendAndRecord(session, { type: "delta", text: delta.text });
        }
        // input_json_delta for tool_use — ignored, we use the complete block
        break;

      case "content_block_stop":
        var stopIdx = event.index;
        var stopType = state.streamState.blockTypes[stopIdx];

        if (stopType === "thinking" && state.streamState.thinkingActive) {
          sendAndRecord(session, { type: "thinking_stop" });
          state.streamState.thinkingActive = false;
        }
        break;

      case "message_start":
      case "message_delta":
      case "message_stop":
        // These are message-level events, not content-level.
        // We handle completion via the 'result' message type.
        break;

      default:
        log("Unhandled stream event:", event.type);
        break;
    }
  }

  // --- Autonomous state tracking ---

  function handleAutonomousCheck(session) {
    if (!autonomous) return;
    var sidecar = readExecutionModeSidecar();
    if (!sidecar) return;

    // Detect mid-session plan activation
    if (!session.executionMode && (sidecar.status === "active" || sidecar.status === "running")) {
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
      log("Registered autonomous execution-mode session (mid-session)", session.localId);
      send({ type: "autonomous_update" });
    }

    // Update plan progress while active
    if (session.executionMode && (sidecar.status === "active" || sidecar.status === "running")) {
      autonomous.updateSession(session.localId, {
        plan: sidecar.plan || null,
        safetyCounters: sidecar.safetyCounters || null,
        lastCheckpoint: sidecar.lastCheckpoint || null,
      });
      send({ type: "autonomous_update" });
    }

    // Detect completion
    if (session.executionMode && (sidecar.status === "completed" || sidecar.status === "failed")) {
      session.executionMode = false;
      sm.saveSessionFile(session);
      autonomous.completeSession(session.localId, {
        status: sidecar.status,
        resolved: sidecar.status === "completed",
      });
      send({ type: "autonomous_update" });
      if (pushModule) {
        var planName = (sidecar.plan && sidecar.plan.text) || session.title || "Execution plan";
        if (planName.length > 80) planName = planName.substring(0, 80) + "...";
        var pushIcon = sidecar.status === "completed" ? "\u2705" : "\u274C";
        pushModule.sendPush({
          type: "done",
          slug: slug,
          title: pushIcon + " Execution " + sidecar.status,
          body: planName,
          tag: "pi-exec-" + sidecar.status,
        });
      }
    }

    // Detect pause
    if (session.executionMode && sidecar.status === "paused") {
      autonomous.updateSession(session.localId, {
        status: "paused",
        plan: sidecar.plan || null,
        safetyCounters: sidecar.safetyCounters || null,
      });
      send({ type: "autonomous_update" });
    }

    // Detect idle (plan was stopped/dismissed)
    if (session.executionMode && sidecar.status === "idle") {
      session.executionMode = false;
      sm.saveSessionFile(session);
      autonomous.removeSession(session.localId);
      send({ type: "autonomous_update" });
    }
  }

  // --- Query handling ---

  async function startQuery(session, text, images) {
    try {
      var sdk = await getSDK();
      var state = getState(session);

      session.isProcessing = true;
      session.streamedText = false;
      session.responsePreview = "";
      resetStreamState(state);
      sm.broadcastSessionList();

      // Build query options
      var queryOpts = {
        cwd: cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
      };

      // Set model if pending
      if (pendingModel) {
        queryOpts.model = pendingModel;
        pendingModel = null;
      } else if (currentModel) {
        queryOpts.model = currentModel;
      }

      // Resume existing session if we have one
      if (state.sessionId) {
        queryOpts.resume = state.sessionId;
      }

      // Build prompt
      var prompt = text;

      // Run the query — returns an async generator of SDKMessage
      var queryIter = sdk.query({
        prompt: prompt,
        options: queryOpts,
      });

      // Store query reference for abort/close
      state.query = queryIter;
      state.queryRunning = true;

      for await (var msg of queryIter) {
        handleAgentMessage(session, msg);
      }

      // If query completed without sending a result event, ensure UI exits processing state
      if (session.isProcessing) {
        session.isProcessing = false;
        sendAndRecord(session, { type: "done", code: 0 });
        sm.broadcastSessionList();
      }

      state.queryRunning = false;
      state.query = null;
    } catch (err) {
      session.isProcessing = false;
      var state = getState(session);
      state.queryRunning = false;
      state.query = null;

      if (err.name === "AbortError" || (err.message && err.message.indexOf("abort") !== -1)) {
        sendAndRecord(session, { type: "info", text: "Interrupted \u00B7 What should Claude do instead?" });
        sendAndRecord(session, { type: "done", code: 0 });
      } else {
        console.error("[pi-bridge] Query error:", err.message || err);
        sendAndRecord(session, { type: "error", text: "Agent error: " + (err.message || err) });
        sendAndRecord(session, { type: "done", code: 1 });
      }
      sm.broadcastSessionList();
    }
  }

  async function abortQuery(session) {
    var state = getState(session);
    if (state.query) {
      try {
        state.query.close();
      } catch (e) {
        log("Abort error:", e.message);
      }
    }
  }

  // --- Model management ---

  async function setModel(session, modelId) {
    try {
      pendingModel = modelId;
      currentModel = modelId;
      sm.currentModel = currentModel;
      send({ type: "model_info", model: currentModel, models: availableModels });
    } catch (e) {
      send({ type: "error", text: "Failed to switch model: " + (e.message || e) });
    }
  }

  // --- Warmup ---

  async function warmup() {
    try {
      var sdk = await getSDK();

      // Hardcoded model list — Agent SDK doesn't expose a model registry.
      availableModels = [
        { value: "claude-opus-4-6", displayName: "Claude Opus 4.6", provider: "anthropic" },
        { value: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", provider: "anthropic" },
        { value: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", provider: "anthropic" },
        { value: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", provider: "anthropic" },
        { value: "claude-opus-4-5", displayName: "Claude Opus 4.5", provider: "anthropic" },
      ];
      currentModel = "claude-sonnet-4-6";

      sm.currentModel = currentModel;
      sm.availableModels = availableModels;
      send({ type: "model_info", model: currentModel, models: availableModels });

      // Scan for slash commands
      var commands = [];
      try {
        var claudeMdPath = path.join(cwd, "CLAUDE.md");
        if (fs.existsSync(claudeMdPath)) {
          commands.push({ name: "help", desc: "Show available commands", source: "system" });
        }
      } catch (e) {}
      sm.slashCommands = commands;
      send({ type: "slash_commands", commands: commands });

    } catch (e) {
      if (e && e.name !== "AbortError") {
        console.error("[pi-bridge] Warmup error:", e.message || e);
        send({ type: "error", text: "Failed to load Agent SDK: " + (e.message || e) });
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
    // For Agent SDK, we resume by session ID, not file path.
    session.piSessionFile = sessionPath;
    // If sessionPath looks like a UUID, use it as the session ID
    if (sessionPath && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionPath)) {
      var state = getState(session);
      state.sessionId = sessionPath;
      session.piSessionId = sessionPath;
    }
  }

  // --- List CLI sessions ---

  async function listSessions() {
    try {
      var sdk = await getSDK();
      var sessions = await sdk.listSessions({ dir: cwd, limit: 50 });
      return sessions.map(function (s) {
        return {
          id: s.sessionId,
          path: s.sessionId,
          firstMessage: s.firstPrompt || s.summary || "(no message)",
          messageCount: 0,
          lastModified: s.lastModified || null,
          cwd: cwd,
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
      if (state.query) { try { state.query.close(); } catch (e) {} }
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
