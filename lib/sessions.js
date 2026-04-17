const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const config = require("./config");

// UUID pattern for Agent SDK session IDs
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads an Agent SDK session JSONL file and converts it to relay history format.
 * SDK sessions live at ~/.claude/projects/{encodedCwd}/{sdkSessionId}.jsonl
 * Returns an array of relay history entries, or null if the file doesn't exist/can't be parsed.
 */
function parseSdkSessionToRelayHistory(cwd, sdkSessionId) {
  if (!sdkSessionId || !UUID_RE.test(sdkSessionId)) return null;
  var encodedCwdLocal = cwd.replace(/\//g, "-");
  var sdkFile = path.join(os.homedir(), ".claude", "projects", encodedCwdLocal, sdkSessionId + ".jsonl");
  var content;
  try { content = fs.readFileSync(sdkFile, "utf8"); } catch (e) { return null; }

  var lines = content.trim().split("\n");
  var entries = [];
  var toolIdMap = {};  // sdkToolUseId → relayToolId
  var toolCounter = 0;

  for (var i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    var obj;
    try { obj = JSON.parse(lines[i]); } catch (e) { continue; }

    if (obj.type === "user" && obj.message && Array.isArray(obj.message.content)) {
      var textParts = [];
      for (var ci = 0; ci < obj.message.content.length; ci++) {
        var block = obj.message.content[ci];
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        } else if (block.type === "tool_result") {
          // Match to relay tool id via SDK tool_use_id
          var relayId = toolIdMap[block.tool_use_id];
          if (relayId) {
            var resultContent = "";
            if (typeof block.content === "string") {
              resultContent = block.content;
            } else if (Array.isArray(block.content)) {
              resultContent = block.content.map(function (c) { return c.text || ""; }).join("");
            }
            entries.push({ type: "tool_result", id: relayId, content: resultContent });
          }
        }
      }
      if (textParts.length > 0) {
        entries.push({ type: "user_message", text: textParts.join("\n") });
      }

    } else if (obj.type === "assistant" && obj.message && Array.isArray(obj.message.content)) {
      var textAccum = [];
      for (var ci = 0; ci < obj.message.content.length; ci++) {
        var block = obj.message.content[ci];
        if (block.type === "text" && block.text) {
          textAccum.push(block.text);
        } else if (block.type === "tool_use") {
          // Flush accumulated text before tool
          if (textAccum.length > 0) {
            entries.push({ type: "delta", text: textAccum.join("") });
            textAccum = [];
          }
          var relayToolId = "sdk-" + (++toolCounter);
          toolIdMap[block.id] = relayToolId;
          entries.push({ type: "tool_start", id: relayToolId, name: block.name });
          entries.push({ type: "tool_executing", id: relayToolId, name: block.name, input: block.input || {} });
        }
      }
      if (textAccum.length > 0) {
        entries.push({ type: "delta", text: textAccum.join("") });
      }
    }
    // Skip: queue-operation, attachment, last-prompt
  }

  return entries.length > 0 ? entries : null;
}

function createSessionManager(opts) {
  var cwd = opts.cwd;
  var send = opts.send;          // function(obj) - broadcast to all clients
  var sendAndRecord = null;      // set after init via setSendAndRecord

  // --- Multi-session state ---
  var nextLocalId = 1;
  var sessions = new Map();     // localId -> session object
  var activeSessionId = null;   // currently active local ID
  var slashCommands = null;     // shared across sessions
  var skillNames = null;        // Claude-only skills to filter from slash menu
  var currentModel = null;      // last selected model (set by pi-bridge on warmup/switch)
  var availableModels = [];     // model list (set by pi-bridge on warmup)

  // --- Session persistence (centralized in ~/.claude-relay/sessions/{encoded-cwd}/) ---
  var encodedCwd = cwd.replace(/\//g, "-");
  var sessionsDir = path.join(config.CONFIG_DIR, "sessions", encodedCwd);
  fs.mkdirSync(sessionsDir, { recursive: true });

  // Auto-migrate from old per-project location ({cwd}/.claude-relay/sessions/)
  var oldSessionsDir = path.join(cwd, ".claude-relay", "sessions");
  try {
    var oldFiles = fs.readdirSync(oldSessionsDir);
    var migrated = 0;
    for (var mi = 0; mi < oldFiles.length; mi++) {
      if (!oldFiles[mi].endsWith(".jsonl")) continue;
      var oldFilePath = path.join(oldSessionsDir, oldFiles[mi]);
      var newFilePath = path.join(sessionsDir, oldFiles[mi]);
      if (fs.existsSync(newFilePath)) continue;
      try {
        fs.renameSync(oldFilePath, newFilePath);
        migrated++;
      } catch (renameErr) {
        try {
          fs.copyFileSync(oldFilePath, newFilePath);
          fs.unlinkSync(oldFilePath);
          migrated++;
        } catch (copyErr) {}
      }
    }
    if (migrated > 0) {
      console.log("[sessions] Migrated " + migrated + " session(s) to " + sessionsDir);
    }
    // Clean up old directory if empty
    try {
      if (fs.readdirSync(oldSessionsDir).length === 0) {
        fs.rmdirSync(oldSessionsDir);
        var parentDir = path.join(cwd, ".claude-relay");
        if (fs.readdirSync(parentDir).length === 0) fs.rmdirSync(parentDir);
      }
    } catch (e) {}
  } catch (e) {
    // Old directory doesn't exist — that's fine
  }

  function sessionFilePath(cliSessionId) {
    return path.join(sessionsDir, cliSessionId + ".jsonl");
  }

  function saveSessionFile(session) {
    if (!session.cliSessionId) return;
    session.lastActivity = Date.now();
    try {
      var metaObj = {
        type: "meta",
        localId: session.localId,
        cliSessionId: session.cliSessionId,
        title: session.title,
        createdAt: session.createdAt,
      };
      if (session.piSessionFile) metaObj.piSessionFile = session.piSessionFile;
      if (session.piSessionId) metaObj.piSessionId = session.piSessionId;
      if (session.lastRewindUuid) metaObj.lastRewindUuid = session.lastRewindUuid;
      if (session.executionMode) metaObj.executionMode = true;
      var meta = JSON.stringify(metaObj);
      var lines = [meta];
      for (var i = 0; i < session.history.length; i++) {
        lines.push(JSON.stringify(session.history[i]));
      }
      fs.writeFileSync(sessionFilePath(session.cliSessionId), lines.join("\n") + "\n");
    } catch(e) {
      console.error("[session] Failed to save session file:", e.message);
    }
  }

  function appendToSessionFile(session, obj) {
    if (!session.cliSessionId) return;
    session.lastActivity = Date.now();
    try {
      fs.appendFileSync(sessionFilePath(session.cliSessionId), JSON.stringify(obj) + "\n");
    } catch(e) {
      console.error("[session] Failed to append to session file:", e.message);
    }
  }

  function loadSessions() {
    var files;
    try { files = fs.readdirSync(sessionsDir); } catch { return; }

    var loaded = [];
    for (var i = 0; i < files.length; i++) {
      if (!files[i].endsWith(".jsonl")) continue;
      var content;
      try { content = fs.readFileSync(path.join(sessionsDir, files[i]), "utf8"); } catch { continue; }
      var lines = content.trim().split("\n");
      if (lines.length === 0) continue;

      var meta;
      try { meta = JSON.parse(lines[0]); } catch { continue; }
      if (meta.type !== "meta" || !meta.cliSessionId) continue;

      var history = [];
      for (var j = 1; j < lines.length; j++) {
        try { history.push(JSON.parse(lines[j])); } catch {}
      }

      var fileMtime = 0;
      try { fileMtime = fs.statSync(path.join(sessionsDir, files[i])).mtimeMs; } catch {}
      loaded.push({ meta: meta, history: history, mtime: fileMtime });
    }

    loaded.sort(function(a, b) { return a.meta.createdAt - b.meta.createdAt; });

    for (var i = 0; i < loaded.length; i++) {
      var m = loaded[i].meta;
      var localId = nextLocalId++;
      // Reconstruct messageUUIDs from history
      var messageUUIDs = [];
      for (var k = 0; k < loaded[i].history.length; k++) {
        if (loaded[i].history[k].type === "message_uuid") {
          messageUUIDs.push({ uuid: loaded[i].history[k].uuid, type: loaded[i].history[k].messageType, historyIndex: k });
        }
      }
      var session = {
        localId: localId,
        queryInstance: null,
        messageQueue: null,
        cliSessionId: m.cliSessionId,
        blocks: {},
        sentToolResults: {},
        pendingPermissions: {},
        pendingAskUser: {},
        isProcessing: false,
        title: m.title || "",
        createdAt: m.createdAt || Date.now(),
        lastActivity: loaded[i].mtime || m.createdAt || Date.now(),
        history: loaded[i].history,
        messageUUIDs: messageUUIDs,
        lastRewindUuid: m.lastRewindUuid || null,
        piSessionFile: m.piSessionFile || null,
        piSessionId: m.piSessionId || null,
        executionMode: m.executionMode || false,
      };
      sessions.set(localId, session);
    }
  }

  // Load persisted sessions from disk
  loadSessions();

  function getActiveSession() {
    return sessions.get(activeSessionId) || null;
  }

  function broadcastSessionList() {
    send({
      type: "session_list",
      sessions: [...sessions.values()].map(function(s) {
        return {
          id: s.localId,
          cliSessionId: s.cliSessionId || null,
          title: s.title || "New Session",
          active: s.localId === activeSessionId,
          isProcessing: s.isProcessing,
          lastActivity: s.lastActivity || s.createdAt || 0,
        };
      }),
    });
  }

  function createSession() {
    var localId = nextLocalId++;
    var session = {
      localId: localId,
      queryInstance: null,
      messageQueue: null,
      cliSessionId: crypto.randomUUID(),
      blocks: {},
      sentToolResults: {},
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
      isProcessing: false,
      title: "",
      createdAt: Date.now(),
      lastActivity: Date.now(),
      history: [],
      messageUUIDs: [],
    };
    sessions.set(localId, session);
    saveSessionFile(session);
    switchSession(localId);
    return session;
  }

  var HISTORY_PAGE_SIZE = 200;

  function findTurnBoundary(history, targetIndex) {
    for (var i = targetIndex; i >= 0; i--) {
      if (history[i] && history[i].type === "user_message") return i;
    }
    return 0;
  }

  function replayHistory(session, fromIndex) {
    // If relay has no history but this session has an SDK session ID, try to backfill
    // from ~/.claude/projects/{encodedCwd}/{sdkSessionId}.jsonl (one-time, then cached).
    if (session.history.length === 0) {
      var sdkId = session.piSessionId ||
        (UUID_RE.test(session.cliSessionId || "") ? session.cliSessionId : null);
      if (sdkId) {
        var backfilled = parseSdkSessionToRelayHistory(cwd, sdkId);
        if (backfilled) {
          session.history = backfilled;
          saveSessionFile(session);
        }
      }
    }

    var total = session.history.length;
    if (typeof fromIndex !== "number") {
      if (total <= HISTORY_PAGE_SIZE) {
        fromIndex = 0;
      } else {
        fromIndex = findTurnBoundary(session.history, Math.max(0, total - HISTORY_PAGE_SIZE));
      }
    }

    send({ type: "history_meta", total: total, from: fromIndex });

    for (var i = fromIndex; i < total; i++) {
      send(session.history[i]);
    }

    send({ type: "history_done" });
  }

  function switchSession(localId) {
    var session = sessions.get(localId);
    if (!session) return;

    activeSessionId = localId;
    send({ type: "session_switched", id: localId, cliSessionId: session.cliSessionId || null });
    broadcastSessionList();
    replayHistory(session);

    if (session.isProcessing) {
      send({ type: "status", status: "processing" });
    }

    // Re-send any pending permission requests
    var pendingIds = Object.keys(session.pendingPermissions);
    for (var i = 0; i < pendingIds.length; i++) {
      var p = session.pendingPermissions[pendingIds[i]];
      send({
        type: "permission_request_pending",
        requestId: p.requestId,
        toolName: p.toolName,
        toolInput: p.toolInput,
        toolUseId: p.toolUseId,
        decisionReason: p.decisionReason,
      });
    }
  }

  function deleteSession(localId) {
    var session = sessions.get(localId);
    if (!session) return;

    if (session.abortController) {
      try { session.abortController.abort(); } catch(e) {}
    }
    if (session.messageQueue) {
      try { session.messageQueue.end(); } catch(e) {}
    }

    if (session.cliSessionId) {
      try { fs.unlinkSync(sessionFilePath(session.cliSessionId)); } catch(e) {}
    }

    sessions.delete(localId);

    if (activeSessionId === localId) {
      var remaining = [...sessions.keys()];
      if (remaining.length > 0) {
        switchSession(remaining[remaining.length - 1]);
      } else {
        createSession();
      }
    } else {
      broadcastSessionList();
    }
  }

  function doSendAndRecord(session, obj) {
    session.history.push(obj);
    appendToSessionFile(session, obj);
    if (session.localId === activeSessionId) {
      send(obj);
    }
  }

  function resumeSession(cliSessionId, opts) {
    // If a session with this cliSessionId already exists, just switch to it
    var existing = null;
    sessions.forEach(function (s) {
      if (s.cliSessionId === cliSessionId) existing = s;
    });
    if (existing) {
      existing.lastActivity = Date.now();
      switchSession(existing.localId);
      return existing;
    }

    var cliHistory = (opts && opts.history) || [];
    var title = (opts && opts.title) || "Resumed session";
    var localId = nextLocalId++;
    var session = {
      localId: localId,
      queryInstance: null,
      messageQueue: null,
      cliSessionId: cliSessionId,
      blocks: {},
      sentToolResults: {},
      pendingPermissions: {},
      pendingAskUser: {},
      allowedTools: {},
      isProcessing: false,
      title: title,
      createdAt: Date.now(),
      history: cliHistory,
      messageUUIDs: [],
    };
    sessions.set(localId, session);
    saveSessionFile(session);
    switchSession(localId);
    return session;
  }

  // --- Spawn initial session only if no persisted sessions ---
  if (sessions.size === 0) {
    createSession();
  } else {
    // Activate the most recently used session
    var allSessions = [...sessions.values()];
    var mostRecent = allSessions[0];
    for (var i = 1; i < allSessions.length; i++) {
      if ((allSessions[i].lastActivity || 0) > (mostRecent.lastActivity || 0)) {
        mostRecent = allSessions[i];
      }
    }
    activeSessionId = mostRecent.localId;
  }

  function searchSessions(query) {
    if (!query) return [];
    var q = query.toLowerCase();
    var results = [];
    sessions.forEach(function (session) {
      var titleMatch = (session.title || "New Session").toLowerCase().indexOf(q) !== -1;
      var contentMatch = false;
      for (var i = 0; i < session.history.length; i++) {
        var entry = session.history[i];
        if ((entry.type === "delta" || entry.type === "user_message") && entry.text) {
          if (entry.text.toLowerCase().indexOf(q) !== -1) {
            contentMatch = true;
            break;
          }
        }
      }
      if (titleMatch || contentMatch) {
        results.push({
          id: session.localId,
          cliSessionId: session.cliSessionId || null,
          title: session.title || "New Session",
          active: session.localId === activeSessionId,
          isProcessing: session.isProcessing,
          lastActivity: session.lastActivity || session.createdAt || 0,
          matchType: titleMatch && contentMatch ? "both" : titleMatch ? "title" : "content",
        });
      }
    });
    return results;
  }

  return {
    get activeSessionId() { return activeSessionId; },
    get nextLocalId() { return nextLocalId; },
    get slashCommands() { return slashCommands; },
    set slashCommands(v) { slashCommands = v; },
    get skillNames() { return skillNames; },
    set skillNames(v) { skillNames = v; },
    get currentModel() { return currentModel; },
    set currentModel(v) { currentModel = v; },
    get availableModels() { return availableModels; },
    set availableModels(v) { availableModels = v; },
    sessions: sessions,
    sessionsDir: sessionsDir,
    HISTORY_PAGE_SIZE: HISTORY_PAGE_SIZE,
    getActiveSession: getActiveSession,
    createSession: createSession,
    switchSession: switchSession,
    deleteSession: deleteSession,
    resumeSession: resumeSession,
    broadcastSessionList: broadcastSessionList,
    saveSessionFile: saveSessionFile,
    appendToSessionFile: appendToSessionFile,
    sendAndRecord: doSendAndRecord,
    findTurnBoundary: findTurnBoundary,
    replayHistory: replayHistory,
    searchSessions: searchSessions,
  };
}

module.exports = { createSessionManager };
