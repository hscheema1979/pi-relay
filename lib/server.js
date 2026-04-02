var http = require("http");
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var { WebSocketServer } = require("ws");
var { pinPageHtml, setupPageHtml, dashboardPageHtml, machinePageHtml } = require("./pages");
var { createProjectContext } = require("./project");
var { createRemoteProjectContext } = require("./remote-project");
var tailscale = require("./tailscale");
var tts = require("./tts");

var { CONFIG_DIR } = require("./config");

var publicDir = path.join(__dirname, "public");
var bundledThemesDir = path.join(__dirname, "themes");
var userThemesDir = path.join(CONFIG_DIR, "themes");

var MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function generateAuthToken(pin) {
  return crypto.createHash("sha256").update("claude-relay:" + pin).digest("hex");
}

function parseCookies(req) {
  var cookies = {};
  var header = req.headers.cookie || "";
  header.split(";").forEach(function (part) {
    var pair = part.trim().split("=");
    if (pair.length === 2) cookies[pair[0]] = pair[1];
  });
  return cookies;
}

function isAuthed(req, authToken) {
  if (!authToken) return true;
  var cookies = parseCookies(req);
  return cookies["relay_auth"] === authToken;
}

// --- PIN rate limiting ---
var pinAttempts = {}; // ip → { count, lastAttempt }
var PIN_MAX_ATTEMPTS = 5;
var PIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function checkPinRateLimit(ip) {
  var entry = pinAttempts[ip];
  if (!entry) return null;
  if (entry.count >= PIN_MAX_ATTEMPTS) {
    var elapsed = Date.now() - entry.lastAttempt;
    if (elapsed < PIN_LOCKOUT_MS) {
      return Math.ceil((PIN_LOCKOUT_MS - elapsed) / 1000);
    }
    delete pinAttempts[ip];
  }
  return null;
}

function recordPinFailure(ip) {
  if (!pinAttempts[ip]) pinAttempts[ip] = { count: 0, lastAttempt: 0 };
  pinAttempts[ip].count++;
  pinAttempts[ip].lastAttempt = Date.now();
}

function clearPinFailures(ip) {
  delete pinAttempts[ip];
}

function serveStatic(urlPath, res) {
  if (urlPath === "/") urlPath = "/index.html";

  var filePath = path.join(publicDir, urlPath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }

  try {
    var content = fs.readFileSync(filePath);
    var ext = path.extname(filePath);
    var mime = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime + "; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(content);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Extract slug from URL path: /p/{slug}/... → slug
 * Returns null if path doesn't match /p/{slug}
 */
function extractSlug(urlPath) {
  var match = urlPath.match(/^\/p\/([a-z0-9_-]+)(\/|$)/);
  return match ? match[1] : null;
}

/**
 * Strip the /p/{slug} prefix from URL path
 */
function stripPrefix(urlPath, slug) {
  var prefix = "/p/" + slug;
  var rest = urlPath.substring(prefix.length);
  return rest || "/";
}

/**
 * Create a multi-project server.
 * opts: { tlsOptions, caPath, pinHash, port, debug, dangerouslySkipPermissions }
 */
function createServer(opts) {
  var tlsOptions = opts.tlsOptions || null;
  var caPath = opts.caPath || null;
  var pinHash = opts.pinHash || null;
  var portNum = opts.port || 2633;
  var debug = opts.debug || false;
  var dangerouslySkipPermissions = opts.dangerouslySkipPermissions || false;
  var lanHost = opts.lanHost || null;
  var onAddProject = opts.onAddProject || null;
  var onRemoveProject = opts.onRemoveProject || null;

  var authToken = pinHash || null;
  var realVersion = require("../package.json").version;
  var currentVersion = debug ? "0.0.9" : realVersion;

  var caContent = caPath ? (function () { try { return fs.readFileSync(caPath); } catch (e) { return null; } })() : null;
  var pinPage = pinPageHtml();

  // --- Project registry ---
  var projects = new Map(); // slug → projectContext
  var remoteProjects = new Map(); // slug → remoteProjectContext
  var cachedDiscovery = null; // Cached tailscale discovery result
  var discoveryPromise = null; // In-flight discovery request

  // --- TTS health-check cache ---
  var ttsHealthCache = {};     // { engine: { ok, error, ts } }
  var TTS_HEALTH_TTL = 60000; // 60s cache

  // --- Push module (global) ---
  var pushModule = null;
  try {
    var { initPush } = require("./push");
    pushModule = initPush();
  } catch (e) {}

  // --- HTTP handler ---
  var appHandler = function (req, res) {
    var fullUrl = req.url.split("?")[0];

    // Global auth endpoint
    if (req.method === "POST" && req.url === "/auth") {
      var ip = req.socket.remoteAddress || "";
      var remaining = checkPinRateLimit(ip);
      if (remaining !== null) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, locked: true, retryAfter: remaining }));
        return;
      }
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", function () {
        try {
          var data = JSON.parse(body);
          if (authToken && generateAuthToken(data.pin) === authToken) {
            clearPinFailures(ip);
            res.writeHead(200, {
              "Set-Cookie": "relay_auth=" + authToken + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000" + (tlsOptions ? "; Secure" : ""),
              "Content-Type": "application/json",
            });
            res.end('{"ok":true}');
          } else {
            recordPinFailure(ip);
            var attemptsLeft = PIN_MAX_ATTEMPTS - (pinAttempts[ip] ? pinAttempts[ip].count : 0);
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, attemptsLeft: Math.max(attemptsLeft, 0) }));
          }
        } catch (e) {
          res.writeHead(400);
          res.end("Bad request");
        }
      });
      return;
    }

    // CA certificate download
    if (req.url === "/ca/download" && req.method === "GET" && caContent) {
      res.writeHead(200, {
        "Content-Type": "application/x-pem-file",
        "Content-Disposition": 'attachment; filename="claude-relay-ca.pem"',
      });
      res.end(caContent);
      return;
    }

    // CORS preflight for cross-origin requests (HTTP onboarding → HTTPS)
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    // Setup page
    if (fullUrl === "/setup" && req.method === "GET") {
      var host = req.headers.host || "localhost";
      var hostname = host.split(":")[0];
      var protocol = tlsOptions ? "https" : "http";
      var setupUrl = protocol + "://" + hostname + ":" + portNum;
      var lanMode = /[?&]mode=lan/.test(req.url);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(setupPageHtml(setupUrl, setupUrl, !!caContent, lanMode));
      return;
    }

    // Global push endpoints (used by setup page)
    if (req.method === "GET" && fullUrl === "/api/vapid-public-key" && pushModule) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ publicKey: pushModule.publicKey }));
      return;
    }

    if (req.method === "POST" && fullUrl === "/api/push-subscribe" && pushModule) {
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", function () {
        try {
          var parsed = JSON.parse(body);
          var sub = parsed.subscription || parsed;
          pushModule.addSubscription(sub, parsed.replaceEndpoint);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400);
          res.end("Bad request");
        }
      });
      return;
    }

    // --- TTS: list voices (all engines) ---
    if (req.method === "GET" && fullUrl === "/api/tts/voices") {
      if (!isAuthed(req, authToken)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        engines: {
          kokoro: { voices: tts.KOKORO_VOICES, default: tts.KOKORO_DEFAULT_VOICE, label: "Kokoro (Free)", free: true },
          edge:   { voices: tts.EDGE_VOICES,   default: tts.EDGE_DEFAULT_VOICE,   label: "Edge (Free)",   free: true },
          gemini: { voices: tts.GEMINI_VOICES,  default: tts.GEMINI_DEFAULT_VOICE, label: "Gemini (Paid)", free: false },
        },
        // Legacy compat
        voices: tts.VOICES,
        default: tts.DEFAULT_VOICE,
      }));
      return;
    }

    // --- TTS: health-check engines ---
    if (req.method === "GET" && fullUrl === "/api/tts/health") {
      if (!isAuthed(req, authToken)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return;
      }
      var hQuery = require("url").parse(req.url, true).query || {};
      var enginesToCheck = hQuery.engine ? [hQuery.engine] : ["kokoro", "edge", "gemini"];
      var now = Date.now();
      var needsCheck = [];
      var result = {};

      // Return cached results where fresh, queue stale ones
      for (var hi = 0; hi < enginesToCheck.length; hi++) {
        var hEng = enginesToCheck[hi];
        var cached = ttsHealthCache[hEng];
        if (cached && (now - cached.ts) < TTS_HEALTH_TTL) {
          result[hEng] = { ok: cached.ok, error: cached.error || undefined };
        } else {
          needsCheck.push(hEng);
        }
      }

      if (needsCheck.length === 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ engines: result }));
        return;
      }

      // Check each engine with a short test phrase
      var pending = needsCheck.length;
      for (var hj = 0; hj < needsCheck.length; hj++) {
        (function (eng) {
          var hOpts = { engine: eng, text: "ok" };
          if (eng === "gemini") {
            hOpts.voice = tts.GEMINI_DEFAULT_VOICE;
            hOpts.model = tts.GEMINI_DEFAULT_MODEL;
            if (opts.litellmHost) hOpts.litellmHost = opts.litellmHost;
            if (opts.litellmPort) hOpts.litellmPort = opts.litellmPort;
            if (opts.litellmKey) hOpts.litellmKey = opts.litellmKey;
          } else if (eng === "kokoro") {
            hOpts.voice = tts.KOKORO_DEFAULT_VOICE;
            if (opts.chutesApiKey) hOpts.chutesApiKey = opts.chutesApiKey;
          } else if (eng === "edge") {
            hOpts.voice = tts.EDGE_DEFAULT_VOICE;
          }

          tts.speak(hOpts).then(function () {
            ttsHealthCache[eng] = { ok: true, error: null, ts: Date.now() };
            result[eng] = { ok: true };
          }).catch(function (err) {
            ttsHealthCache[eng] = { ok: false, error: err.message, ts: Date.now() };
            result[eng] = { ok: false, error: err.message };
          }).then(function () {
            pending--;
            if (pending === 0) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ engines: result }));
            }
          });
        })(needsCheck[hj]);
      }
      return;
    }

    // --- TTS: synthesize speech (multi-engine, with fallback) ---
    if (req.method === "POST" && fullUrl === "/api/tts/speak") {
      if (!isAuthed(req, authToken)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return;
      }
      var ttsBody = "";
      req.on("data", function (chunk) { ttsBody += chunk; });
      req.on("end", function () {
        try {
          var ttsData = JSON.parse(ttsBody);
          if (!ttsData.text || !ttsData.text.trim()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"missing text"}');
            return;
          }
          var primaryEngine = ttsData.engine || "kokoro";
          // Fallback order: requested engine → edge → kokoro → gemini
          // (skip native — that's client-side only)
          var fallbackOrder = [primaryEngine];
          var allServerEngines = ["edge", "kokoro", "gemini"];
          for (var fi = 0; fi < allServerEngines.length; fi++) {
            if (allServerEngines[fi] !== primaryEngine) {
              fallbackOrder.push(allServerEngines[fi]);
            }
          }

          function buildTtsOpts(engine, data) {
            var o = {
              engine: engine,
              text: data.text,
              voice: data.voice,
              speed: data.speed || 1.0,
            };
            if (engine === "gemini") {
              o.voice = data.voice || tts.GEMINI_DEFAULT_VOICE;
              o.model = data.model || tts.GEMINI_DEFAULT_MODEL;
              if (opts.litellmHost) o.litellmHost = opts.litellmHost;
              if (opts.litellmPort) o.litellmPort = opts.litellmPort;
              if (opts.litellmKey) o.litellmKey = opts.litellmKey;
            } else if (engine === "kokoro") {
              o.voice = data.voice || tts.KOKORO_DEFAULT_VOICE;
              if (opts.chutesApiKey) o.chutesApiKey = opts.chutesApiKey;
            } else if (engine === "edge") {
              o.voice = data.voice || tts.EDGE_DEFAULT_VOICE;
            }
            // When falling back, use the engine's default voice (not the primary's voice)
            if (engine !== primaryEngine) {
              if (engine === "gemini") o.voice = tts.GEMINI_DEFAULT_VOICE;
              else if (engine === "kokoro") o.voice = tts.KOKORO_DEFAULT_VOICE;
              else if (engine === "edge") o.voice = tts.EDGE_DEFAULT_VOICE;
            }
            return o;
          }

          function tryEngine(index) {
            if (index >= fallbackOrder.length) {
              // All engines failed
              console.error("[tts] All engines failed for text: " + ttsData.text.slice(0, 60));
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "All TTS engines failed" }));
              return;
            }
            var engine = fallbackOrder[index];
            var ttsOpts = buildTtsOpts(engine, ttsData);

            tts.speak(ttsOpts).then(function (result) {
              if (engine !== primaryEngine) {
                console.log("[tts] Fallback: " + primaryEngine + " → " + engine + " succeeded");
                // Mark the failed primary as unhealthy in cache
                ttsHealthCache[primaryEngine] = { ok: false, error: "fallback triggered", ts: Date.now() };
              }
              // Mark the successful engine as healthy
              ttsHealthCache[engine] = { ok: true, error: null, ts: Date.now() };
              res.writeHead(200, {
                "Content-Type": result.mimeType,
                "Content-Length": result.audio.length,
                "X-TTS-Duration-Ms": result.durationMs || 0,
                "X-TTS-Engine-Used": engine,
                "X-TTS-Engine-Requested": primaryEngine,
                "Cache-Control": "no-cache",
              });
              res.end(result.audio);
            }).catch(function (err) {
              console.error("[tts] Error (" + engine + "):", err.message);
              // Mark this engine as unhealthy
              ttsHealthCache[engine] = { ok: false, error: err.message, ts: Date.now() };
              // Try next fallback
              tryEngine(index + 1);
            });
          }

          tryEngine(0);
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"invalid JSON"}');
        }
      });
      return;
    }

    // Theme list: bundled (lib/themes/) + user (~/.claude-relay/themes/)
    if (req.method === "GET" && fullUrl === "/api/themes") {
      var bundled = {};
      var custom = {};
      // Read bundled themes
      try {
        var bFiles = fs.readdirSync(bundledThemesDir);
        for (var i = 0; i < bFiles.length; i++) {
          if (!bFiles[i].endsWith(".json")) continue;
          try {
            var raw = fs.readFileSync(path.join(bundledThemesDir, bFiles[i]), "utf8");
            var id = bFiles[i].replace(/\.json$/, "");
            bundled[id] = JSON.parse(raw);
          } catch (e) {}
        }
      } catch (e) {}
      // Read user themes (override bundled if same id)
      try {
        var uFiles = fs.readdirSync(userThemesDir);
        for (var j = 0; j < uFiles.length; j++) {
          if (!uFiles[j].endsWith(".json")) continue;
          try {
            var uRaw = fs.readFileSync(path.join(userThemesDir, uFiles[j]), "utf8");
            var uid = uFiles[j].replace(/\.json$/, "");
            custom[uid] = JSON.parse(uRaw);
          } catch (e) {}
        }
      } catch (e) {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ bundled: bundled, custom: custom }));
      return;
    }

    // --- Tailscale machine discovery ---
    if (req.method === "GET" && fullUrl === "/api/machines") {
      if (!isAuthed(req, authToken)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return;
      }
      // Use cached discovery or start new one
      if (discoveryPromise) {
        discoveryPromise.then(function (result) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        }).catch(function (err) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message, machines: [] }));
        });
      } else {
        tailscale.discover({ port: portNum }).then(function (result) {
          cachedDiscovery = result;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        }).catch(function (err) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message, machines: [] }));
        });
      }
      return;
    }

    // Refresh machine discovery (force new scan)
    if (req.method === "POST" && fullUrl === "/api/machines/refresh") {
      if (!isAuthed(req, authToken)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return;
      }
      cachedDiscovery = null;
      discoveryPromise = tailscale.discover({ port: portNum });
      discoveryPromise.then(function (result) {
        cachedDiscovery = result;
        discoveryPromise = null;
      }).catch(function () {
        discoveryPromise = null;
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true,"message":"Discovery started"}');
      return;
    }

    // --- Remote projects CRUD ---
    if (req.method === "GET" && fullUrl === "/api/remote-projects") {
      if (!isAuthed(req, authToken)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return;
      }
      var list = [];
      remoteProjects.forEach(function (ctx, slug) {
        list.push(ctx.getStatus());
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }

    // Add remote project
    if (req.method === "POST" && fullUrl === "/api/remote-projects") {
      if (!isAuthed(req, authToken)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return;
      }
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", function () {
        try {
          var data = JSON.parse(body);
          if (!data.remoteHost) { res.writeHead(400); res.end('{"error":"missing remoteHost"}'); return; }
          if (!data.remoteSlug) { res.writeHead(400); res.end('{"error":"missing remoteSlug"}'); return; }
          var slug = data.slug || data.remoteSlug;
          // Check for collision with local project
          if (projects.has(slug)) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end('{"error":"slug conflicts with local project"}');
            return;
          }
          if (remoteProjects.has(slug)) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end('{"error":"remote project already exists","slug":"' + slug + '"}');
            return;
          }
          // Build auth cookie for the remote relay
          // If remoteAuthToken is provided (the hash of the remote relay's PIN),
          // use that. Otherwise, try forwarding the browser's cookie (which may
          // contain the correct auth if both relays share the same PIN).
          var authCookie = null;
          if (data.remoteAuthToken) {
            authCookie = "relay_auth=" + data.remoteAuthToken;
          } else if (req.headers.cookie) {
            authCookie = req.headers.cookie;
          }
          var ctx = createRemoteProjectContext({
            remoteHost: data.remoteHost,
            remotePort: data.remotePort || portNum,
            remoteSlug: data.remoteSlug,
            remoteTLS: data.remoteTLS || false,
            slug: slug,
            title: data.title || null,
            machineName: data.machineName || data.remoteHost,
            authCookie: authCookie,
          });
          remoteProjects.set(slug, ctx);
          ctx.warmup();
          console.log("[server] Added remote project:", slug, "→", data.remoteHost + ":" + (data.remotePort || portNum) + "/" + data.remoteSlug);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, slug: slug }));
          // Broadcast update
          broadcastAll({ type: "remote_projects_updated", remoteProjects: getRemoteProjects() });
          broadcastAll({ type: "projects_updated", projects: getAllProjects(), projectCount: projects.size + remoteProjects.size });
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"' + (e.message || "bad request") + '"}');
        }
      });
      return;
    }

    // Remove remote project
    if (req.method === "DELETE" && fullUrl.match(/^\/api\/remote-projects\/[a-z0-9_-]+$/)) {
      if (!isAuthed(req, authToken)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return;
      }
      var rSlug = fullUrl.replace("/api/remote-projects/", "");
      if (!remoteProjects.has(rSlug)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end('{"error":"not found"}');
        return;
      }
      removeRemoteProject(rSlug);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }

    // Root path — dashboard or redirect
    if (fullUrl === "/" && req.method === "GET") {
      if (!isAuthed(req, authToken)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(pinPage);
        return;
      }
      var hasGoneParam = req.url.indexOf("gone=") !== -1;
      var totalProjects = projects.size + remoteProjects.size;
      if (totalProjects === 1 && !hasGoneParam) {
        var firstSlug = projects.size > 0 ? projects.keys().next().value : remoteProjects.keys().next().value;
        res.writeHead(302, { "Location": "/p/" + firstSlug + "/" });
        res.end();
        return;
      }
      var statusList = [];
      projects.forEach(function (ctx) { statusList.push(ctx.getStatus()); });
      remoteProjects.forEach(function (ctx) { statusList.push(ctx.getStatus()); });
      // Include discovered machines in dashboard
      var machinesList = cachedDiscovery ? (cachedDiscovery.machines || []) : [];
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(dashboardPageHtml(statusList, currentVersion, machinesList));
      // Trigger a background discovery if we don't have cached data
      if (!cachedDiscovery && !discoveryPromise) {
        discoveryPromise = tailscale.discover({ port: portNum });
        discoveryPromise.then(function (result) {
          cachedDiscovery = result;
          discoveryPromise = null;
        }).catch(function () { discoveryPromise = null; });
      }
      return;
    }

    // Global info endpoint
    // Returns minimal info (version, auth required) without auth,
    // and full project list with auth — so machine discovery works for PIN-protected relays
    if (req.method === "GET" && req.url === "/info") {
      if (!isAuthed(req, authToken)) {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ version: currentVersion, authRequired: true }));
        return;
      }
      var projectList = [];
      projects.forEach(function (ctx, slug) {
        projectList.push({ slug: slug, project: ctx.project, remote: false });
      });
      remoteProjects.forEach(function (ctx, slug) {
        projectList.push({ slug: slug, project: ctx.project, remote: true, machine: ctx.getStatus().machine });
      });
      res.end(JSON.stringify({ projects: projectList, version: currentVersion }));
      return;
    }

    // Machine page: /m/{hostname}/
    var machineMatch = fullUrl.match(/^\/m\/([a-zA-Z0-9_.-]+)(\/?)$/);
    if (machineMatch && req.method === "GET") {
      if (!isAuthed(req, authToken)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(pinPage);
        return;
      }
      var machineHostname = machineMatch[1];
      // Find machine in cached discovery
      var machineData = null;
      if (cachedDiscovery && cachedDiscovery.machines) {
        for (var mi = 0; mi < cachedDiscovery.machines.length; mi++) {
          if (cachedDiscovery.machines[mi].hostname === machineHostname) {
            machineData = cachedDiscovery.machines[mi];
            break;
          }
        }
      }
      if (machineData && machineData.hasRelay && machineData.online) {
        // Probe for fresh project list
        tailscale.probeRelay(machineData.ip || machineData.fqdn, machineData.relayPort || portNum, 5000).then(function (info) {
          var machineInfo = {
            ip: machineData.ip || machineData.fqdn,
            port: machineData.relayPort || portNum,
            online: true,
            projects: info ? (info.projects || []) : []
          };
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(machinePageHtml(machineHostname, machineInfo, currentVersion));
        }).catch(function () {
          var machineInfo = { ip: machineData.ip || machineData.fqdn, port: machineData.relayPort || portNum, online: false, projects: [] };
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(machinePageHtml(machineHostname, machineInfo, currentVersion));
        });
      } else if (machineData) {
        // Machine exists but offline
        var machineInfo = { ip: machineData.ip || machineData.fqdn, port: machineData.relayPort || portNum, online: false, projects: [] };
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(machinePageHtml(machineHostname, machineInfo, currentVersion));
      } else {
        // Unknown machine - try to trigger discovery and show offline
        var machineInfo = { ip: '', port: portNum, online: false, projects: [] };
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(machinePageHtml(machineHostname, machineInfo, currentVersion));
      }
      return;
    }

    // Static files at root (favicon, manifest, icons, sw.js, etc.)
    if (fullUrl.lastIndexOf("/") === 0 && !fullUrl.includes("..")) {
      if (serveStatic(fullUrl, res)) return;
    }

    // Project-scoped routes: /p/{slug}/...
    var slug = extractSlug(req.url.split("?")[0]);
    if (!slug) {
      // Not a project route and not handled above
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    // Check both local and remote projects
    var ctx = projects.get(slug);
    var isRemote = false;
    if (!ctx) {
      ctx = remoteProjects.get(slug);
      isRemote = true;
    }
    if (!ctx) {
      res.writeHead(302, { "Location": "/?gone=" + encodeURIComponent(slug) });
      res.end();
      return;
    }

    // Redirect /p/{slug} → /p/{slug}/ (trailing slash required for relative paths)
    if (fullUrl === "/p/" + slug) {
      res.writeHead(301, { "Location": "/p/" + slug + "/" });
      res.end();
      return;
    }

    // Auth check for project routes
    if (!isAuthed(req, authToken)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pinPage);
      return;
    }

    // Strip prefix for project-scoped handling
    var projectUrl = stripPrefix(req.url.split("?")[0], slug);
    // Re-attach query string for API routes
    var qsIdx = req.url.indexOf("?");
    var projectUrlWithQS = qsIdx >= 0 ? projectUrl + req.url.substring(qsIdx) : projectUrl;

    // Try project HTTP handler first (APIs)
    var origUrl = req.url;
    req.url = projectUrlWithQS;
    var handled = ctx.handleHTTP(req, res, projectUrlWithQS);
    req.url = origUrl;
    if (handled) return;

    // Static files (same assets for all projects)
    if (req.method === "GET") {
      if (serveStatic(projectUrl, res)) return;
    }

    res.writeHead(404);
    res.end("Not found");
  };

  // --- Server setup ---
  var server;
  if (tlsOptions) {
    server = require("https").createServer(tlsOptions, appHandler);
  } else {
    server = http.createServer(appHandler);
  }

  // --- HTTP onboarding server (only when TLS is active) ---
  var onboardingServer = null;
  if (tlsOptions) {
    onboardingServer = http.createServer(function (req, res) {
      var url = req.url.split("?")[0];

      // CA certificate download
      if (url === "/ca/download" && req.method === "GET" && caContent) {
        res.writeHead(200, {
          "Content-Type": "application/x-pem-file",
          "Content-Disposition": 'attachment; filename="claude-relay-ca.pem"',
        });
        res.end(caContent);
        return;
      }

      // Setup page
      if (url === "/setup" && req.method === "GET") {
        var host = req.headers.host || "localhost";
        var hostname = host.split(":")[0];
        var httpsSetupUrl = "https://" + hostname + ":" + portNum;
        var httpSetupUrl = "http://" + hostname + ":" + (portNum + 1);
        var lanMode = /[?&]mode=lan/.test(req.url);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(setupPageHtml(httpsSetupUrl, httpSetupUrl, !!caContent, lanMode));
        return;
      }

      // /info — CORS-enabled, used by setup page to verify HTTPS
      if (url === "/info" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ version: currentVersion }));
        return;
      }

      // Static files at root (favicon, manifest, icons, etc.)
      if (url.lastIndexOf("/") === 0 && !url.includes("..")) {
        if (serveStatic(url, res)) return;
      }

      // Everything else → redirect to HTTPS setup
      var hostname = (req.headers.host || "localhost").split(":")[0];
      res.writeHead(302, { "Location": "https://" + hostname + ":" + portNum + "/setup" });
      res.end();
    });
  }

  // --- WebSocket ---
  var wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", function (req, socket, head) {
    // Origin validation (CSRF prevention)
    var origin = req.headers.origin;
    if (origin) {
      try {
        var originUrl = new URL(origin);
        var originPort = String(originUrl.port || (originUrl.protocol === "https:" ? "443" : "80"));
        // Extract port from Host header for reverse proxy support.
        // Use URL parser to correctly handle IPv6 addresses (e.g. [::1])
        // and infer default port from origin protocol (not backend tlsOptions)
        // so TLS-terminating proxies on :443 with HTTP backends work.
        var hostPort;
        try {
          var hostUrl = new URL(originUrl.protocol + "//" + (req.headers.host || ""));
          hostPort = String(hostUrl.port || (originUrl.protocol === "https:" ? "443" : "80"));
        } catch (e2) {
          hostPort = String(portNum);
        }
        if (originPort !== String(portNum) && originPort !== hostPort) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
      } catch (e) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    if (!isAuthed(req, authToken)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // Extract slug from WS URL: /p/{slug}/ws
    var wsSlug = extractSlug(req.url);
    if (!wsSlug) {
      socket.destroy();
      return;
    }

    // Check both local and remote projects
    var ctx = projects.get(wsSlug) || remoteProjects.get(wsSlug);
    if (!ctx) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, function (ws) {
      ctx.handleConnection(ws);
    });
  });

  // --- Project management ---
  function addProject(cwd, slug, title) {
    if (projects.has(slug)) return false;
    var ctx = createProjectContext({
      cwd: cwd,
      slug: slug,
      title: title || null,
      pushModule: pushModule,
      debug: debug,
      dangerouslySkipPermissions: dangerouslySkipPermissions,
      currentVersion: currentVersion,
      lanHost: lanHost,
      getProjectCount: function () { return projects.size + remoteProjects.size; },
      getProjectList: function () {
        var list = [];
        projects.forEach(function (ctx) { list.push(ctx.getStatus()); });
        remoteProjects.forEach(function (ctx) { list.push(ctx.getStatus()); });
        return list;
      },
      onAddProject: onAddProject,
      onRemoveProject: onRemoveProject,
    });
    projects.set(slug, ctx);
    ctx.warmup();
    return true;
  }

  function removeProject(slug) {
    var ctx = projects.get(slug);
    if (!ctx) return false;
    ctx.destroy();
    projects.delete(slug);
    return true;
  }

  function getProjects() {
    var list = [];
    projects.forEach(function (ctx) {
      list.push(ctx.getStatus());
    });
    return list;
  }

  // --- Remote project management ---
  function addRemoteProject(opts) {
    var slug = opts.slug || opts.remoteSlug;
    if (projects.has(slug) || remoteProjects.has(slug)) return { ok: false, error: "slug already exists" };
    var ctx = createRemoteProjectContext({
      remoteHost: opts.remoteHost,
      remotePort: opts.remotePort || portNum,
      remoteSlug: opts.remoteSlug,
      remoteTLS: opts.remoteTLS || false,
      slug: slug,
      title: opts.title || null,
      machineName: opts.machineName || opts.remoteHost,
      authCookie: null, // Daemon doesn't need cookie, uses internal auth
    });
    remoteProjects.set(slug, ctx);
    ctx.warmup();
    console.log("[server] Added remote project:", slug, "→", opts.remoteHost + ":" + (opts.remotePort || portNum) + "/" + opts.remoteSlug);
    return { ok: true, slug: slug };
  }

  function removeRemoteProject(slug) {
    var ctx = remoteProjects.get(slug);
    if (!ctx) return false;
    ctx.destroy();
    remoteProjects.delete(slug);
    console.log("[server] Removed remote project:", slug);
    return true;
  }

  function getRemoteProjects() {
    var list = [];
    remoteProjects.forEach(function (ctx) {
      list.push(ctx.getStatus());
    });
    return list;
  }

  function getAllProjects() {
    var list = [];
    projects.forEach(function (ctx) { list.push(ctx.getStatus()); });
    remoteProjects.forEach(function (ctx) { list.push(ctx.getStatus()); });
    return list;
  }

  function setProjectTitle(slug, title) {
    var ctx = projects.get(slug) || remoteProjects.get(slug);
    if (!ctx) return false;
    ctx.setTitle(title);
    return true;
  }

  function setAuthToken(hash) {
    authToken = hash;
  }

  function broadcastAll(msg) {
    projects.forEach(function (ctx) {
      ctx.send(msg);
    });
    remoteProjects.forEach(function (ctx) {
      ctx.send(msg);
    });
  }

  function destroyAll() {
    projects.forEach(function (ctx, slug) {
      console.log("[server] Destroying project:", slug);
      ctx.destroy();
    });
    projects.clear();
    remoteProjects.forEach(function (ctx, slug) {
      console.log("[server] Destroying remote project:", slug);
      ctx.destroy();
    });
    remoteProjects.clear();
  }

  return {
    server: server,
    onboardingServer: onboardingServer,
    isTLS: !!tlsOptions,
    addProject: addProject,
    removeProject: removeProject,
    getProjects: getProjects,
    addRemoteProject: addRemoteProject,
    removeRemoteProject: removeRemoteProject,
    getRemoteProjects: getRemoteProjects,
    getAllProjects: getAllProjects,
    setProjectTitle: setProjectTitle,
    setAuthToken: setAuthToken,
    broadcastAll: broadcastAll,
    destroyAll: destroyAll,
  };
}

module.exports = { createServer: createServer, generateAuthToken: generateAuthToken };
