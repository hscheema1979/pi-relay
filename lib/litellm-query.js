/**
 * litellm-query.js — Direct LiteLLM query adapter for cheap model routing.
 *
 * For tasks that don't need tool use (health checks, simple monitoring),
 * this bypasses the full pi-bridge agent session and makes direct
 * OpenAI-compatible HTTP calls to LiteLLM.
 *
 * Implements the AgentQuery interface: { send(prompt, opts), abort() }
 */

var http = require("http");

var LITELLM_HOST = process.env.LITELLM_HOST || "100.99.47.10";
var LITELLM_PORT = parseInt(process.env.LITELLM_PORT || "4010");
var LITELLM_KEY = process.env.LITELLM_KEY || "";

/**
 * Create an AgentQuery that talks directly to LiteLLM.
 * @param {object} [opts]
 * @param {string} [opts.model] - Default model (overridable per-send)
 * @param {string} [opts.systemPrompt] - System prompt
 */
function createLiteLLMQuery(opts) {
  opts = opts || {};
  var defaultModel = opts.model || "deepseek-chat";
  var systemPrompt = opts.systemPrompt || "You are a helpful assistant.";
  var aborted = false;
  var activeReq = null;

  return {
    send: function (prompt, queryOpts) {
      queryOpts = queryOpts || {};
      var model = queryOpts.model || defaultModel;
      var timeoutMs = queryOpts.timeoutMs || 120000;
      var onDelta = queryOpts.onDelta || null;

      return new Promise(function (resolve) {
        if (aborted) {
          return resolve({
            text: "",
            completed: false,
            durationMs: 0,
            toolCalls: [],
            error: "Aborted",
          });
        }

        var startTime = Date.now();
        var text = "";

        var body = JSON.stringify({
          model: model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          stream: true,
          max_tokens: 4096,
        });

        var headers = {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        };
        if (LITELLM_KEY) {
          headers["Authorization"] = "Bearer " + LITELLM_KEY;
        }

        var reqOpts = {
          hostname: LITELLM_HOST,
          port: LITELLM_PORT,
          path: "/v1/chat/completions",
          method: "POST",
          headers: headers,
          timeout: timeoutMs,
        };

        var req = http.request(reqOpts, function (res) {
          var buffer = "";

          res.on("data", function (chunk) {
            if (aborted) return;
            buffer += chunk.toString();

            // Parse SSE stream
            var lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (var i = 0; i < lines.length; i++) {
              var line = lines[i].trim();
              if (!line.startsWith("data: ")) continue;
              var data = line.slice(6);
              if (data === "[DONE]") continue;

              try {
                var parsed = JSON.parse(data);
                var delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
                if (delta && delta.content) {
                  text += delta.content;
                  if (onDelta) onDelta(delta.content);
                }
              } catch (e) {
                // Skip malformed chunks
              }
            }
          });

          res.on("end", function () {
            activeReq = null;
            resolve({
              text: text,
              completed: !aborted && res.statusCode === 200,
              durationMs: Date.now() - startTime,
              toolCalls: [],
              error: res.statusCode !== 200 ? "HTTP " + res.statusCode : undefined,
            });
          });

          res.on("error", function (err) {
            activeReq = null;
            resolve({
              text: text,
              completed: false,
              durationMs: Date.now() - startTime,
              toolCalls: [],
              error: err.message,
            });
          });
        });

        req.on("error", function (err) {
          activeReq = null;
          resolve({
            text: "",
            completed: false,
            durationMs: Date.now() - startTime,
            toolCalls: [],
            error: err.message,
          });
        });

        req.on("timeout", function () {
          req.destroy();
          activeReq = null;
          resolve({
            text: text,
            completed: false,
            durationMs: Date.now() - startTime,
            toolCalls: [],
            error: "Timed out after " + timeoutMs + "ms",
          });
        });

        activeReq = req;
        req.write(body);
        req.end();
      });
    },

    abort: function () {
      aborted = true;
      if (activeReq) {
        activeReq.destroy();
        activeReq = null;
      }
    },
  };
}

module.exports = { createLiteLLMQuery };
