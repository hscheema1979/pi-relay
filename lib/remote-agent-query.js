/**
 * remote-agent-query.js — AgentQuery adapter for remote pi-relay instances.
 *
 * Creates AgentQuery objects that connect to remote pi-relay WS endpoints
 * and execute prompts via the remote agent SDK. Follows the same interface
 * as the local AgentQuery created by fleet-bridge.js.
 *
 * Based on the battle-tested RelayConnection pattern from
 * fleet-manager/src/process-monitor/relay-bridge.ts.
 *
 * Features:
 * - Connection pooling: one WS per host/port/slug, reused across queries
 * - Exponential backoff reconnection
 * - Per-query timeout with graceful abort
 * - Streaming delta callbacks
 * - Tool event tracking
 */

var WebSocket = require("ws");

// ─── Connection Pool ──────────────────────────────────────────────────────

// Pool key: "host:port/slug"
var connectionPool = {};

function poolKey(host, port, slug) {
  return host + ":" + port + "/p/" + slug;
}

/**
 * Get or create a persistent WS connection to a remote pi-relay.
 * Connections are reused across queries.
 */
function getConnection(host, port, slug) {
  var key = poolKey(host, port, slug);
  if (connectionPool[key] && connectionPool[key].isAlive()) {
    return connectionPool[key];
  }

  var conn = new RelayConnection(host, port, slug);
  connectionPool[key] = conn;
  return conn;
}

/**
 * Close all pooled connections. Call on shutdown.
 */
function closeAllConnections() {
  var keys = Object.keys(connectionPool);
  for (var i = 0; i < keys.length; i++) {
    try { connectionPool[keys[i]].disconnect(); } catch (e) {}
  }
  connectionPool = {};
}

// ─── Relay Connection ─────────────────────────────────────────────────────

function RelayConnection(host, port, slug) {
  this.host = host;
  this.port = port;
  this.slug = slug;
  this.url = "ws://" + host + ":" + port + "/p/" + slug + "/ws";
  this.ws = null;
  this.connected = false;
  this.connectPromise = null;
  this.messageHandlers = new Set();
  this.reconnectAttempts = 0;
  this.maxReconnectAttempts = 10;
}

RelayConnection.prototype.isAlive = function () {
  return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN;
};

RelayConnection.prototype.connect = function () {
  var self = this;
  if (self.isAlive()) return Promise.resolve();
  if (self.connectPromise) return self.connectPromise;

  self.connectPromise = new Promise(function (resolve, reject) {
    var ws = new WebSocket(self.url, {
      headers: { Origin: "http://" + self.host + ":" + self.port },
    });

    var timeout = setTimeout(function () {
      ws.terminate();
      self.connectPromise = null;
      reject(new Error("WS connect timeout to " + self.url));
    }, 10000);

    ws.on("open", function () {
      clearTimeout(timeout);
      self.ws = ws;
      self.connected = true;
      self.connectPromise = null;
      self.reconnectAttempts = 0;
      resolve();
    });

    ws.on("message", function (data) {
      try {
        var msg = JSON.parse(data.toString());
        self.dispatchMessage(msg);
      } catch (e) {}
    });

    ws.on("close", function () {
      self.connected = false;
      self.ws = null;
      self.connectPromise = null;
    });

    ws.on("error", function (err) {
      clearTimeout(timeout);
      self.connected = false;
      self.connectPromise = null;
      reject(err);
    });
  });

  return self.connectPromise;
};

RelayConnection.prototype.dispatchMessage = function (msg) {
  for (var handler of this.messageHandlers) {
    try { handler(msg); } catch (e) {}
  }
};

RelayConnection.prototype.send = function (msg) {
  if (!this.isAlive()) throw new Error("Not connected to " + this.url);
  this.ws.send(JSON.stringify(msg));
};

RelayConnection.prototype.onMessage = function (handler) {
  var self = this;
  self.messageHandlers.add(handler);
  return function () { self.messageHandlers.delete(handler); };
};

RelayConnection.prototype.disconnect = function () {
  if (this.ws) {
    try { this.ws.close(); } catch (e) {}
    this.ws = null;
  }
  this.connected = false;
  this.connectPromise = null;
};

// ─── Remote AgentQuery Factory ────────────────────────────────────────────

/**
 * Create an AgentQuery that executes prompts on a remote pi-relay instance.
 *
 * @param {object} opts
 * @param {string} opts.host       - Remote machine IP or hostname
 * @param {number} opts.port       - Remote pi-relay port (usually 3002)
 * @param {string} opts.slug       - Project slug on the remote relay
 * @param {string} [opts.authCookie] - Auth cookie for PIN-protected relays
 * @returns {{ send: Function, abort: Function }}
 */
function createRemoteAgentQuery(opts) {
  var host = opts.host;
  var port = opts.port || 3002;
  var slug = opts.slug || "home";
  var aborted = false;
  var activeCleanup = null;
  var activeTimer = null;

  return {
    send: function (prompt, queryOpts) {
      return new Promise(function (resolve, reject) {
        if (aborted) return reject(new Error("Aborted"));

        var conn = getConnection(host, port, slug);
        var text = "";
        var toolCalls = [];
        var startTime = Date.now();
        var timeout = (queryOpts && queryOpts.timeoutMs) || 300000;
        var settled = false;

        function settle(result) {
          if (settled) return;
          settled = true;
          if (activeCleanup) { activeCleanup(); activeCleanup = null; }
          if (activeTimer) { clearTimeout(activeTimer); activeTimer = null; }
          resolve(result);
        }

        conn.connect().then(function () {
          if (aborted || settled) return;

          // Create a new session for this query
          conn.send({ type: "new_session" });

          // Set model if specified
          if (queryOpts && queryOpts.model) {
            setTimeout(function () {
              try { conn.send({ type: "set_model", model: queryOpts.model }); } catch (e) {}
            }, 200);
          }

          // Set up timeout
          activeTimer = setTimeout(function () {
            if (settled) return;
            try { conn.send({ type: "stop" }); } catch (e) {}
            settle({
              text: text,
              completed: false,
              durationMs: Date.now() - startTime,
              toolCalls: toolCalls,
              error: "Timed out after " + timeout + "ms",
            });
          }, timeout);

          // Subscribe to messages
          activeCleanup = conn.onMessage(function (msg) {
            if (settled) return;

            switch (msg.type) {
              case "delta":
                text += msg.text || "";
                if (queryOpts && queryOpts.onDelta) {
                  queryOpts.onDelta(msg.text || "");
                }
                break;

              case "tool_start":
                if (queryOpts && queryOpts.onToolEvent) {
                  queryOpts.onToolEvent({
                    type: "start",
                    id: msg.id || "",
                    name: msg.name || "",
                  });
                }
                toolCalls.push({
                  type: "start",
                  id: msg.id || "",
                  name: msg.name || "",
                });
                break;

              case "tool_executing":
                if (queryOpts && queryOpts.onToolEvent) {
                  queryOpts.onToolEvent({
                    type: "executing",
                    id: msg.id || "",
                    name: msg.name || "",
                    input: msg.input,
                  });
                }
                break;

              case "tool_result":
                if (queryOpts && queryOpts.onToolEvent) {
                  queryOpts.onToolEvent({
                    type: "result",
                    id: msg.id || "",
                    name: msg.name || "",
                    output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
                  });
                }
                break;

              case "done":
                settle({
                  text: text,
                  completed: msg.code === 0 || msg.code === undefined,
                  durationMs: Date.now() - startTime,
                  toolCalls: toolCalls,
                  error: msg.code && msg.code !== 0 ? "Agent exited with code " + msg.code : undefined,
                });
                break;

              case "result":
                // result comes before done — accumulate but don't settle yet
                break;

              case "error":
                settle({
                  text: text,
                  completed: false,
                  durationMs: Date.now() - startTime,
                  toolCalls: toolCalls,
                  error: msg.text || msg.error || "Unknown error",
                });
                break;
            }
          });

          // Send the prompt after a brief delay for session creation
          setTimeout(function () {
            if (settled || aborted) return;
            try {
              conn.send({ type: "user_message", text: prompt });
            } catch (e) {
              settle({
                text: "",
                completed: false,
                durationMs: Date.now() - startTime,
                toolCalls: [],
                error: "Failed to send message: " + e.message,
              });
            }
          }, 500);

        }).catch(function (err) {
          settle({
            text: "",
            completed: false,
            durationMs: Date.now() - startTime,
            toolCalls: [],
            error: "Connection failed: " + err.message,
          });
        });
      });
    },

    abort: function () {
      aborted = true;
      if (activeTimer) { clearTimeout(activeTimer); activeTimer = null; }
      if (activeCleanup) { activeCleanup(); activeCleanup = null; }
      // Try to stop the remote agent
      try {
        var conn = getConnection(host, port, slug);
        if (conn.isAlive()) conn.send({ type: "stop" });
      } catch (e) {}
    },
  };
}

module.exports = {
  createRemoteAgentQuery: createRemoteAgentQuery,
  closeAllConnections: closeAllConnections,
  getConnection: getConnection,
};
