/**
 * remote-project.js — Proxy project context for remote pi-relay instances.
 *
 * Behaves like a local projectContext (same interface) but proxies
 * all WebSocket messages to/from a remote relay backend.
 *
 * The browser doesn't know the difference — it's still /p/{slug}/ws.
 */

var WebSocket = require("ws");
var http = require("http");
var https = require("https");

/**
 * Create a remote project context that proxies to a remote relay.
 *
 * opts: {
 *   remoteHost:   "100.101.179.63" or "vps1.tailf4e4dd.ts.net",
 *   remotePort:   3002,
 *   remoteSlug:   "app"  (the slug on the remote relay),
 *   remoteTLS:    false,
 *   slug:         "vps1-app"  (local slug for this proxy),
 *   title:        "VPS1 — App",
 *   machineName:  "vps1",
 *   authCookie:   "relay_auth=..." (optional, for remote PIN auth),
 * }
 */
function createRemoteProjectContext(opts) {
  var remoteHost = opts.remoteHost;
  var remotePort = opts.remotePort || 3002;
  var remoteSlug = opts.remoteSlug;
  var remoteTLS = opts.remoteTLS || false;
  var slug = opts.slug;
  var title = opts.title || null;
  var machineName = opts.machineName || remoteHost;
  var authCookie = opts.authCookie || null;

  var wsProto = remoteTLS ? "wss" : "ws";
  var httpProto = remoteTLS ? "https" : "http";
  var remoteWsUrl = wsProto + "://" + remoteHost + ":" + remotePort + "/p/" + remoteSlug + "/ws";
  var remoteBaseUrl = httpProto + "://" + remoteHost + ":" + remotePort + "/p/" + remoteSlug;

  // Connected browser clients
  var clients = new Set();

  // Connection to the remote relay
  var upstream = null;
  var upstreamConnected = false;
  var reconnectTimer = null;
  var reconnectAttempts = 0;
  var MAX_RECONNECT_ATTEMPTS = 50;
  var destroyed = false;

  // Queued messages from browser clients while upstream is connecting
  var pendingMessages = [];

  // Cache of initial state messages from the remote relay.
  // When a new browser client connects after the upstream is already established,
  // we replay these cached messages so the client gets the full initial state.
  var cachedInitMessages = [];
  // Types that define the init sequence structure (cached by type, deduplicated)
  var cacheableTypes = { info: 1, session_list: 1, session_switched: 1, history_meta: 1, history_done: 1,
    model_info: 1, slash_commands: 1, term_list: 1, client_count: 1 };
  // History entries (between history_meta and history_done) — stored in order
  var cachedHistoryEntries = [];
  var inHistoryPhase = false;
  var initPhaseComplete = false;

  function log() {
    console.log.apply(console, ["[remote:" + slug + "]"].concat(Array.from(arguments)));
  }

  // --- Send to all browser clients ---
  function send(obj) {
    var data = JSON.stringify(obj);
    for (var ws of clients) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  function sendTo(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // --- Upstream (remote relay) connection ---

  // Track whether we've received the info message from the remote relay
  var receivedInfo = false;
  var lastError = null;

  function connectUpstream() {
    if (destroyed) return;
    if (upstream && (upstream.readyState === WebSocket.CONNECTING || upstream.readyState === WebSocket.OPEN)) return;

    var headers = {};
    if (authCookie) {
      headers["Cookie"] = authCookie;
    }

    log("Connecting to", remoteWsUrl);
    upstream = new WebSocket(remoteWsUrl, { headers: headers });

    upstream.on("open", function () {
      upstreamConnected = true;
      reconnectAttempts = 0;
      lastError = null;
      receivedInfo = false;
      initPhaseComplete = false;
      inHistoryPhase = false;
      cachedInitMessages = [];
      cachedHistoryEntries = [];
      log("Connected to remote relay");

      // Flush pending messages
      for (var i = 0; i < pendingMessages.length; i++) {
        upstream.send(pendingMessages[i]);
      }
      pendingMessages = [];

      // Notify browser clients of connection status
      send({ type: "remote_status", connected: true, machine: machineName });
    });

    upstream.on("message", function (data) {
      // Forward everything from remote relay to all browser clients
      var raw = data.toString();

      // Track if we received the info message and cache initial state
      try {
        var parsed = JSON.parse(raw);
        if (parsed.type === "info") receivedInfo = true;

        // Cache initial state messages for replay to late-joining clients.
        // Stop caching after history_done (the init sequence is complete).
        if (!initPhaseComplete) {
          if (parsed.type === "history_meta") {
            inHistoryPhase = true;
            cachedHistoryEntries = [];
          }

          if (cacheableTypes[parsed.type]) {
            // For structured types, replace any previous cached version
            var replaced = false;
            for (var ci = 0; ci < cachedInitMessages.length; ci++) {
              if (cachedInitMessages[ci].type === parsed.type) {
                cachedInitMessages[ci] = parsed;
                replaced = true;
                break;
              }
            }
            if (!replaced) cachedInitMessages.push(parsed);
          } else if (inHistoryPhase && parsed.type !== "history_done") {
            // Cache history entries (delta, user_message, tool_start, etc.)
            cachedHistoryEntries.push(parsed);
          }

          if (parsed.type === "history_done") {
            inHistoryPhase = false;
            initPhaseComplete = true;
          }
        } else {
          // After init phase, still update cached info/session_list/model_info
          // so late-joining clients get current state
          if (parsed.type === "info" || parsed.type === "session_list" || parsed.type === "model_info" || parsed.type === "slash_commands") {
            for (var ci2 = 0; ci2 < cachedInitMessages.length; ci2++) {
              if (cachedInitMessages[ci2].type === parsed.type) {
                cachedInitMessages[ci2] = parsed;
                break;
              }
            }
          }
        }
      } catch (e) {}

      for (var ws of clients) {
        if (ws.readyState === 1) ws.send(raw);
      }
    });

    upstream.on("close", function (code, reason) {
      upstreamConnected = false;
      var reasonStr = reason ? reason.toString() : "";
      log("Disconnected from remote relay:", code, reasonStr);

      // Detect auth failures
      if (code === 1006 || code === 401) {
        lastError = "Authentication failed — remote relay may require a PIN";
      } else if (code === 403) {
        lastError = "Connection rejected by remote relay (403 Forbidden)";
      } else if (reasonStr) {
        lastError = reasonStr;
      }

      send({ type: "remote_status", connected: false, machine: machineName, error: lastError || null });

      // If we never received info, send a synthetic one so the UI isn't blank
      if (!receivedInfo) {
        sendFallbackInfo();
      }

      scheduleReconnect();
    });

    upstream.on("unexpected-response", function (req, res) {
      // Fired when the server responds with a non-101 status code
      var statusCode = res.statusCode;
      log("Upstream rejected connection with HTTP", statusCode);
      if (statusCode === 401) {
        lastError = "Authentication failed — the remote relay requires a PIN. Make sure auth credentials are configured.";
      } else if (statusCode === 403) {
        lastError = "Connection rejected by remote relay (403 Forbidden)";
      } else {
        lastError = "Remote relay returned HTTP " + statusCode;
      }
      upstreamConnected = false;
      send({ type: "remote_status", connected: false, machine: machineName, error: lastError });
      if (!receivedInfo) sendFallbackInfo();
      // Destroy the connection and schedule reconnect
      try { upstream.close(); } catch (e) {}
      upstream = null;
      scheduleReconnect();
    });

    upstream.on("error", function (err) {
      upstreamConnected = false;
      lastError = err.message;
      log("Connection error:", err.message);
      // close handler will fire and trigger reconnect
    });
  }

  /**
   * Send a synthetic info message so the browser UI doesn't stay blank
   * when the upstream connection fails.
   */
  function sendFallbackInfo() {
    send({
      type: "info",
      cwd: remoteHost + ":" + remotePort + "/" + remoteSlug,
      slug: slug,
      project: title || remoteSlug,
      projectCount: 1,
      projects: [],
      remote: true,
      remoteError: lastError || "Cannot connect to remote relay",
    });
  }

  function scheduleReconnect() {
    if (destroyed) return;
    if (reconnectTimer) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log("Max reconnect attempts reached, giving up");
      send({ type: "remote_status", connected: false, machine: machineName, error: "Connection lost" });
      return;
    }
    reconnectAttempts++;
    var delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts - 1), 30000);
    log("Reconnecting in", Math.round(delay / 1000) + "s (attempt", reconnectAttempts + ")");
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connectUpstream();
    }, delay);
  }

  function disconnectUpstream() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (upstream) {
      try { upstream.close(); } catch (e) {}
      upstream = null;
    }
    upstreamConnected = false;
  }

  // --- Browser client connection ---

  function handleConnection(ws) {
    clients.add(ws);

    // Send initial info about this being a remote project
    sendTo(ws, {
      type: "remote_info",
      remote: true,
      machine: machineName,
      remoteHost: remoteHost,
      remotePort: remotePort,
      remoteSlug: remoteSlug,
      connected: upstreamConnected,
    });

    if (upstreamConnected && cachedInitMessages.length > 0) {
      // Upstream is already connected and we have cached initial state.
      // Replay it to this new browser client so it gets info/session_list/history.
      for (var ci = 0; ci < cachedInitMessages.length; ci++) {
        sendTo(ws, cachedInitMessages[ci]);
        // Insert cached history entries after history_meta
        if (cachedInitMessages[ci].type === "history_meta" && cachedHistoryEntries.length > 0) {
          for (var hi = 0; hi < cachedHistoryEntries.length; hi++) {
            sendTo(ws, cachedHistoryEntries[hi]);
          }
        }
      }
    } else if (!upstreamConnected) {
      // Upstream not connected — try to connect, and show fallback info after a delay
      if (!upstream || upstream.readyState === WebSocket.CLOSED) {
        connectUpstream();
      }
      // Delay slightly to let upstream connection attempt proceed first
      setTimeout(function () {
        if (!upstreamConnected && !receivedInfo && ws.readyState === 1) {
          sendTo(ws, {
            type: "info",
            cwd: remoteHost + ":" + remotePort + "/" + remoteSlug,
            slug: slug,
            project: title || remoteSlug,
            projectCount: 1,
            projects: [],
            remote: true,
            remoteError: lastError || "Connecting to remote relay...",
          });
        }
      }, 2000);
    } else {
      // Upstream connected but no cached messages yet (race condition).
      // Reconnect upstream to get a fresh init sequence for this client.
      log("Upstream connected but no cached state — reconnecting for fresh init");
      disconnectUpstream();
      connectUpstream();
    }

    ws.on("message", function (raw) {
      // Forward everything from browser to remote relay
      var data = raw.toString();
      if (upstreamConnected && upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(data);
      } else {
        pendingMessages.push(data);
      }
    });

    ws.on("close", function () {
      clients.delete(ws);
      // Don't disconnect upstream when last client leaves — keep connection warm
    });
  }

  // --- HTTP proxy for project-scoped API calls ---

  function handleHTTP(req, res, urlPath) {
    // Proxy API requests to the remote relay
    if (!urlPath.startsWith("/api/") && urlPath !== "/info") return false;

    var targetUrl = remoteBaseUrl + urlPath;
    var mod = remoteTLS ? https : http;

    var proxyHeaders = Object.assign({}, req.headers);
    delete proxyHeaders.host;
    if (authCookie) {
      proxyHeaders.cookie = authCookie;
    }

    var proxyReq = mod.request(targetUrl, {
      method: req.method,
      headers: proxyHeaders,
      timeout: 10000,
    }, function (proxyRes) {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", function (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Remote relay unreachable: " + err.message }));
    });

    proxyReq.on("timeout", function () {
      proxyReq.destroy();
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Remote relay timeout" }));
    });

    // Pipe request body (for POST requests)
    req.pipe(proxyReq);
    return true;
  }

  // --- Status ---

  function getStatus() {
    return {
      slug: slug,
      path: remoteHost + ":" + remotePort + "/" + remoteSlug,
      project: remoteSlug,
      title: title,
      clients: clients.size,
      sessions: 0,  // Remote relay manages sessions; we don't know the count
      isProcessing: false,
      remote: true,
      machine: machineName,
      remoteHost: remoteHost,
      remotePort: remotePort,
      remoteSlug: remoteSlug,
      connected: upstreamConnected,
    };
  }

  function setTitle(newTitle) {
    title = newTitle || null;
  }

  // --- Lifecycle ---

  function warmup() {
    connectUpstream();
  }

  function destroy() {
    destroyed = true;
    disconnectUpstream();
    for (var ws of clients) {
      try { ws.close(); } catch (e) {}
    }
    clients.clear();
  }

  return {
    cwd: remoteHost + ":" + remotePort + "/" + remoteSlug,
    slug: slug,
    project: remoteSlug,
    clients: clients,
    remote: true,
    send: send,
    sendTo: sendTo,
    handleConnection: handleConnection,
    handleHTTP: handleHTTP,
    getStatus: getStatus,
    setTitle: setTitle,
    warmup: warmup,
    destroy: destroy,
  };
}

module.exports = { createRemoteProjectContext: createRemoteProjectContext };
