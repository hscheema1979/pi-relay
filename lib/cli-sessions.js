var fs = require("fs");
var path = require("path");
var os = require("os");
var readline = require("readline");

/**
 * Compute the encoded project directory name used by pi.
 * Replaces all "/" with "-", e.g.
 * "/home/ubuntu" -> "--home-ubuntu--"
 * "/home/ubuntu/SPXer" -> "--home-ubuntu-SPXer--"
 */
function encodeCwd(cwd) {
  return "-" + cwd.replace(/\//g, "-") + "--";
}

/**
 * Parse the first ~30 lines of a pi session JSONL file to extract metadata.
 * Returns null if the file can't be parsed or has no user messages.
 */
function parseSessionFile(filePath, maxLines) {
  if (maxLines == null) maxLines = 30;
  return new Promise(function (resolve) {
    var sessionId = path.basename(filePath, ".jsonl");
    var result = {
      sessionId: sessionId,
      firstPrompt: "",
      model: null,
      gitBranch: null,
      startTime: null,
      lastActivity: null,
    };

    var lineCount = 0;
    var foundUser = false;
    var stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: "utf8" });
    } catch (e) {
      return resolve(null);
    }

    var rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", function (line) {
      lineCount++;
      if (lineCount > maxLines) {
        rl.close();
        stream.destroy();
        return;
      }

      var obj;
      try { obj = JSON.parse(line); } catch (e) { return; }

      // Session header
      if (obj.type === "session") {
        if (obj.id) result.sessionId = obj.id;
        if (obj.timestamp) result.startTime = obj.timestamp;
      }

      // Model info
      if (obj.type === "model_change" && obj.modelId && !result.model) {
        result.model = obj.modelId;
      }

      // User message — extract first prompt
      if (obj.type === "message" && obj.message && obj.message.role === "user") {
        if (!foundUser) {
          foundUser = true;
          var content = obj.message.content;
          if (typeof content === "string") {
            result.firstPrompt = content.substring(0, 100);
          } else if (Array.isArray(content)) {
            for (var i = 0; i < content.length; i++) {
              if (content[i].type === "text" && content[i].text) {
                result.firstPrompt = content[i].text.substring(0, 100);
                break;
              }
            }
          }
        }
        if (obj.timestamp) result.lastActivity = obj.timestamp;
      }
    });

    rl.on("close", function () {
      if (!foundUser) return resolve(null);

      // Use file mtime as better proxy for last activity
      try {
        var stat = fs.statSync(filePath);
        result.lastActivity = stat.mtime.toISOString();
      } catch (e) {}

      resolve(result);
    });

    rl.on("error", function () { resolve(null); });
    stream.on("error", function () { rl.close(); resolve(null); });
  });
}

/**
 * List pi CLI sessions for a given project directory.
 * Reads ~/.pi/agent/sessions/{encoded-cwd}/ and parses JSONL metadata.
 * Returns array sorted by lastActivity descending (most recent first).
 */
function listCliSessions(cwd) {
  var encoded = encodeCwd(cwd);
  var sessionDir = path.join(os.homedir(), ".pi", "agent", "sessions", encoded);

  return new Promise(function (resolve) {
    fs.readdir(sessionDir, { withFileTypes: true }, function (err, entries) {
      if (err) return resolve([]);

      var jsonlFiles = [];
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isFile() && entries[i].name.endsWith(".jsonl")) {
          jsonlFiles.push(path.join(sessionDir, entries[i].name));
        }
      }

      if (jsonlFiles.length === 0) return resolve([]);

      var pending = jsonlFiles.length;
      var results = [];

      for (var j = 0; j < jsonlFiles.length; j++) {
        parseSessionFile(jsonlFiles[j]).then(function (session) {
          if (session) results.push(session);
          pending--;
          if (pending === 0) {
            results.sort(function (a, b) {
              var ta = a.lastActivity || "";
              var tb = b.lastActivity || "";
              return ta < tb ? 1 : ta > tb ? -1 : 0;
            });
            resolve(results);
          }
        });
      }
    });
  });
}

/**
 * Get the most recent pi CLI session for a given project directory.
 */
function getMostRecentCliSession(cwd) {
  return listCliSessions(cwd).then(function (sessions) {
    return sessions.length > 0 ? sessions[0] : null;
  });
}

/**
 * Extract user message text from a content field.
 */
function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  var parts = [];
  for (var i = 0; i < content.length; i++) {
    if (content[i].type === "text" && content[i].text) {
      parts.push(content[i].text);
    }
  }
  return parts.join("");
}

/**
 * Read a full pi session JSONL file and convert it to relay-compatible
 * history entries (user_message, delta, tool_start, tool_executing, tool_result).
 * Returns a Promise that resolves to an array of history entries.
 */
function readCliSessionHistory(cwd, sessionId) {
  var encoded = encodeCwd(cwd);
  var sessionDir = path.join(os.homedir(), ".pi", "agent", "sessions", encoded);

  // Find the file — sessionId may be the UUID or the full filename stem
  return new Promise(function (resolve) {
    fs.readdir(sessionDir, function (err, files) {
      if (err) return resolve([]);

      var targetFile = null;
      for (var i = 0; i < files.length; i++) {
        if (files[i].endsWith(".jsonl")) {
          if (files[i] === sessionId + ".jsonl") {
            targetFile = path.join(sessionDir, files[i]);
            break;
          }
          // Also match by UUID embedded in filename
          if (files[i].indexOf(sessionId) !== -1) {
            targetFile = path.join(sessionDir, files[i]);
            break;
          }
        }
      }

      if (!targetFile) return resolve([]);

      var history = [];
      var stream;
      try {
        stream = fs.createReadStream(targetFile, { encoding: "utf8" });
      } catch (e) {
        return resolve([]);
      }

      var rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      var toolCounter = 0;

      rl.on("line", function (line) {
        var obj;
        try { obj = JSON.parse(line); } catch (e) { return; }

        if (obj.type !== "message" || !obj.message) return;

        // User message
        if (obj.message.role === "user") {
          var text = extractText(obj.message.content);
          if (text) {
            history.push({ type: "user_message", text: text });
          }
          return;
        }

        // Assistant message
        if (obj.message.role === "assistant" && Array.isArray(obj.message.content)) {
          for (var i = 0; i < obj.message.content.length; i++) {
            var block = obj.message.content[i];

            if (block.type === "text" && block.text) {
              history.push({ type: "delta", text: block.text });
            }

            // Pi uses "toolCall" instead of "tool_use"
            if (block.type === "toolCall" || block.type === "tool_use") {
              var toolId = "cli-tool-" + (++toolCounter);
              var toolName = block.name || "Tool";
              var toolInput = block.arguments || block.input || {};
              history.push({ type: "tool_start", id: toolId, name: toolName });
              history.push({
                type: "tool_executing",
                id: toolId,
                name: toolName,
                input: toolInput,
              });
              history.push({ type: "tool_result", id: toolId, content: "" });
            }
          }
        }

        // Tool result messages
        if (obj.message.role === "tool") {
          // Pi tool results are separate messages — skip for now,
          // we already emit empty tool_result above
        }
      });

      rl.on("close", function () { resolve(history); });
      rl.on("error", function () { resolve([]); });
      stream.on("error", function () { rl.close(); resolve([]); });
    });
  });
}

module.exports = {
  listCliSessions: listCliSessions,
  getMostRecentCliSession: getMostRecentCliSession,
  readCliSessionHistory: readCliSessionHistory,
  parseSessionFile: parseSessionFile,
  encodeCwd: encodeCwd,
  extractText: extractText,
};
