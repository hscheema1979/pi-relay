/**
 * tts.js — Server-side Text-to-Speech via LiteLLM → Gemini TTS
 *
 * Calls the local LiteLLM proxy using the OpenAI chat completions format
 * with modalities: ["audio"] and audio.format: "pcm16".
 * Returns WAV audio buffer.
 */

var http = require("http");

// Gemini TTS voices
var VOICES = [
  "Achernar", "Achird", "Algenib", "Algieba", "Alnilam",
  "Aoede", "Autonoe", "Callirrhoe", "Charon", "Despina",
  "Enceladus", "Erinome", "Fenrir", "Gacrux", "Iapetus",
  "Kore", "Laomedeia", "Leda", "Orus", "Puck",
  "Pulcherrima", "Rasalgethi", "Sadachbia", "Sadaltager",
  "Schedar", "Sulafat", "Umbriel", "Vindemiatrix", "Zephyr",
  "Zubenelgenubi"
];

var DEFAULT_VOICE = "Kore";
var DEFAULT_MODEL = "gemini-2.5-flash-preview-tts";

/**
 * Convert raw PCM (16-bit, mono, 24kHz) to WAV buffer.
 */
function pcmToWav(pcmBuffer, sampleRate) {
  sampleRate = sampleRate || 24000;
  var numChannels = 1;
  var bitsPerSample = 16;
  var byteRate = sampleRate * numChannels * bitsPerSample / 8;
  var blockAlign = numChannels * bitsPerSample / 8;
  var dataSize = pcmBuffer.length;

  var header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Generate speech audio via LiteLLM proxy.
 *
 * opts: {
 *   text:         string (required)
 *   voice:        string (default: "Kore")
 *   model:        string (default: "gemini-2.5-flash-preview-tts")
 *   litellmHost:  string (default: "127.0.0.1")
 *   litellmPort:  number (default: 4010)
 *   litellmKey:   string (default: "sk-litellm-master-simplepilot")
 * }
 *
 * Returns: Promise<{ audio: Buffer, mimeType: string, durationMs: number }>
 */
function speak(opts) {
  var text = opts.text;
  var voice = opts.voice || DEFAULT_VOICE;
  var model = opts.model || DEFAULT_MODEL;
  var host = opts.litellmHost || "127.0.0.1";
  var port = opts.litellmPort || 4010;
  var key = opts.litellmKey || "sk-litellm-master-simplepilot";

  if (!text) return Promise.reject(new Error("Missing text"));

  var body = JSON.stringify({
    model: model,
    messages: [{ role: "user", content: "Say the following text exactly as written, with natural speech: " + text }],
    modalities: ["audio"],
    audio: { format: "pcm16", voice: voice },
  });

  return new Promise(function (resolve, reject) {
    var req = http.request({
      hostname: host,
      port: port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 30000,
    }, function (res) {
      var chunks = [];
      res.on("data", function (chunk) { chunks.push(chunk); });
      res.on("end", function () {
        var raw = Buffer.concat(chunks).toString("utf8");
        try {
          var data = JSON.parse(raw);

          if (data.error) {
            reject(new Error("LiteLLM TTS error: " + (data.error.message || JSON.stringify(data.error))));
            return;
          }

          var msg = data.choices && data.choices[0] && data.choices[0].message;
          if (!msg || !msg.audio || !msg.audio.data) {
            reject(new Error("No audio in response"));
            return;
          }

          // Decode base64 PCM
          var pcmBuffer = Buffer.from(msg.audio.data, "base64");
          var sampleRate = 24000; // Gemini TTS default

          // Convert to WAV
          var wavBuffer = pcmToWav(pcmBuffer, sampleRate);

          resolve({
            audio: wavBuffer,
            mimeType: "audio/wav",
            sampleRate: sampleRate,
            durationMs: Math.round(pcmBuffer.length / (sampleRate * 2) * 1000),
            transcript: msg.audio.transcript || null,
          });
        } catch (e) {
          reject(new Error("Failed to parse TTS response: " + e.message));
        }
      });
    });

    req.on("error", function (e) {
      reject(new Error("TTS request failed: " + e.message));
    });

    req.on("timeout", function () {
      req.destroy();
      reject(new Error("TTS request timed out"));
    });

    req.write(body);
    req.end();
  });
}

module.exports = {
  speak: speak,
  VOICES: VOICES,
  DEFAULT_VOICE: DEFAULT_VOICE,
  DEFAULT_MODEL: DEFAULT_MODEL,
};
