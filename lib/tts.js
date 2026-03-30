/**
 * tts.js — Server-side Text-to-Speech (multi-engine)
 *
 * Engines:
 *   - gemini:  Gemini TTS via LiteLLM proxy (paid)
 *   - kokoro:  Kokoro TTS via Chutes AI (free)
 *   - edge:    Microsoft Edge TTS (free, natural voices)
 *
 * All engines return: { audio: Buffer, mimeType: string, durationMs: number }
 */

var http = require("http");
var https = require("https");

// ============================================================
// Gemini TTS
// ============================================================

var GEMINI_VOICES = [
  "Achernar", "Achird", "Algenib", "Algieba", "Alnilam",
  "Aoede", "Autonoe", "Callirrhoe", "Charon", "Despina",
  "Enceladus", "Erinome", "Fenrir", "Gacrux", "Iapetus",
  "Kore", "Laomedeia", "Leda", "Orus", "Puck",
  "Pulcherrima", "Rasalgethi", "Sadachbia", "Sadaltager",
  "Schedar", "Sulafat", "Umbriel", "Vindemiatrix", "Zephyr",
  "Zubenelgenubi"
];

var GEMINI_DEFAULT_VOICE = "Kore";
var GEMINI_DEFAULT_MODEL = "gemini-2.5-flash-preview-tts";

// ============================================================
// Kokoro TTS (Chutes AI)
// ============================================================

var KOKORO_VOICES = [
  // American Female
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica",
  "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  // American Male
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
  "am_michael", "am_onyx", "am_puck",
  // British Female
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
  // British Male
  "bm_daniel", "bm_fable", "bm_george", "bm_lewis"
];

var KOKORO_DEFAULT_VOICE = "af_bella";
var KOKORO_API_URL = "https://chutes-kokoro.chutes.ai/speak";

// ============================================================
// Edge TTS (Microsoft, free)
// ============================================================

var EDGE_VOICES = [
  // US English
  "en-US-AriaNeural", "en-US-JennyNeural", "en-US-GuyNeural",
  "en-US-ChristopherNeural", "en-US-EricNeural", "en-US-MichelleNeural",
  "en-US-RogerNeural", "en-US-SteffanNeural", "en-US-AnaNeural",
  "en-US-AndrewNeural", "en-US-AvaNeural", "en-US-BrianNeural",
  "en-US-EmmaNeural",
  // UK English
  "en-GB-SoniaNeural", "en-GB-RyanNeural", "en-GB-LibbyNeural",
  "en-GB-MaisieNeural", "en-GB-ThomasNeural",
  // Australian
  "en-AU-NatashaNeural", "en-AU-WilliamNeural",
  // Indian
  "en-IN-NeerjaNeural", "en-IN-PrabhatNeural"
];

var EDGE_DEFAULT_VOICE = "en-US-AriaNeural";

// ============================================================
// Utility: PCM → WAV
// ============================================================

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

// ============================================================
// Gemini TTS speak
// ============================================================

function speakGemini(opts) {
  var text = opts.text;
  var voice = opts.voice || GEMINI_DEFAULT_VOICE;
  var model = opts.model || GEMINI_DEFAULT_MODEL;
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
            reject(new Error("Gemini TTS error: " + (data.error.message || JSON.stringify(data.error))));
            return;
          }
          var msg = data.choices && data.choices[0] && data.choices[0].message;
          if (!msg || !msg.audio || !msg.audio.data) {
            reject(new Error("No audio in Gemini response"));
            return;
          }
          var pcmBuffer = Buffer.from(msg.audio.data, "base64");
          var sampleRate = 24000;
          var wavBuffer = pcmToWav(pcmBuffer, sampleRate);
          resolve({
            audio: wavBuffer,
            mimeType: "audio/wav",
            sampleRate: sampleRate,
            durationMs: Math.round(pcmBuffer.length / (sampleRate * 2) * 1000),
          });
        } catch (e) {
          reject(new Error("Failed to parse Gemini TTS response: " + e.message));
        }
      });
    });

    req.on("error", function (e) { reject(new Error("Gemini TTS request failed: " + e.message)); });
    req.on("timeout", function () { req.destroy(); reject(new Error("Gemini TTS request timed out")); });
    req.write(body);
    req.end();
  });
}

// ============================================================
// Kokoro TTS speak (Chutes AI)
// ============================================================

function speakKokoro(opts) {
  var text = opts.text;
  var voice = opts.voice || KOKORO_DEFAULT_VOICE;
  var speed = opts.speed || 1.0;
  var apiKey = opts.chutesApiKey || process.env.CHUTES_API_KEY || "";

  if (!text) return Promise.reject(new Error("Missing text"));
  if (!apiKey) return Promise.reject(new Error("Missing CHUTES_API_KEY for Kokoro TTS"));

  var body = JSON.stringify({
    text: text,
    voice: voice,
    speed: speed,
  });

  return new Promise(function (resolve, reject) {
    var url = new URL(KOKORO_API_URL);
    var req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 30000,
    }, function (res) {
      var chunks = [];
      res.on("data", function (chunk) { chunks.push(chunk); });
      res.on("end", function () {
        var buf = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          reject(new Error("Kokoro TTS error " + res.statusCode + ": " + buf.toString("utf8").slice(0, 200)));
          return;
        }
        // Kokoro returns WAV directly
        var sampleRate = 24000;
        var durationMs = Math.round((buf.length - 44) / (sampleRate * 2) * 1000);
        resolve({
          audio: buf,
          mimeType: "audio/wav",
          sampleRate: sampleRate,
          durationMs: durationMs > 0 ? durationMs : 0,
        });
      });
    });

    req.on("error", function (e) { reject(new Error("Kokoro TTS request failed: " + e.message)); });
    req.on("timeout", function () { req.destroy(); reject(new Error("Kokoro TTS request timed out")); });
    req.write(body);
    req.end();
  });
}

// ============================================================
// Edge TTS speak (Microsoft, free — via edge-tts Python CLI)
// ============================================================

var childProcess = require("child_process");
var fs = require("fs");
var os = require("os");
var path = require("path");

function speakEdge(opts) {
  var text = opts.text;
  var voice = opts.voice || EDGE_DEFAULT_VOICE;

  if (!text) return Promise.reject(new Error("Missing text"));

  // Write to temp file, call edge-tts CLI
  var tmpFile = path.join(os.tmpdir(), "edge-tts-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".mp3");

  return new Promise(function (resolve, reject) {
    // Escape text for shell safety — pass via stdin instead
    var proc = childProcess.spawn("edge-tts", [
      "--text", text,
      "--voice", voice,
      "--write-media", tmpFile,
    ], {
      timeout: 30000,
    });

    var stderr = "";
    proc.stderr.on("data", function (chunk) { stderr += chunk; });

    proc.on("close", function (code) {
      if (code !== 0) {
        try { fs.unlinkSync(tmpFile); } catch (e) {}
        reject(new Error("Edge TTS failed (exit " + code + "): " + stderr.slice(0, 200)));
        return;
      }
      try {
        var audioBuf = fs.readFileSync(tmpFile);
        fs.unlinkSync(tmpFile);
        resolve({
          audio: audioBuf,
          mimeType: "audio/mpeg",
          durationMs: Math.round(audioBuf.length / (48000 / 8) * 1000),
        });
      } catch (e) {
        reject(new Error("Edge TTS: failed to read output: " + e.message));
      }
    });

    proc.on("error", function (e) {
      try { fs.unlinkSync(tmpFile); } catch (ex) {}
      reject(new Error("Edge TTS spawn error: " + e.message + ". Install: pip3 install edge-tts"));
    });
  });
}

// ============================================================
// Unified speak function
// ============================================================

function speak(opts) {
  var engine = opts.engine || "kokoro";

  switch (engine) {
    case "gemini":
      return speakGemini(opts);
    case "kokoro":
      return speakKokoro(opts);
    case "edge":
      return speakEdge(opts);
    default:
      return Promise.reject(new Error("Unknown TTS engine: " + engine));
  }
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  speak: speak,
  speakGemini: speakGemini,
  speakKokoro: speakKokoro,
  speakEdge: speakEdge,

  GEMINI_VOICES: GEMINI_VOICES,
  GEMINI_DEFAULT_VOICE: GEMINI_DEFAULT_VOICE,
  GEMINI_DEFAULT_MODEL: GEMINI_DEFAULT_MODEL,

  KOKORO_VOICES: KOKORO_VOICES,
  KOKORO_DEFAULT_VOICE: KOKORO_DEFAULT_VOICE,

  EDGE_VOICES: EDGE_VOICES,
  EDGE_DEFAULT_VOICE: EDGE_DEFAULT_VOICE,

  // Legacy compat
  VOICES: GEMINI_VOICES,
  DEFAULT_VOICE: GEMINI_DEFAULT_VOICE,
  DEFAULT_MODEL: GEMINI_DEFAULT_MODEL,
};
