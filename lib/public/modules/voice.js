/**
 * voice.js — Voice conversation mode for Pi Relay
 *
 * Voice input:  Browser SpeechRecognition (hands-free mic)
 * Voice output: Server-side Gemini TTS → WAV audio playback via Audio API
 *
 * Designed for reliability while driving — no browser-side synthesis,
 * audio plays via standard Audio element (survives background/screen-off).
 */

import { refreshIcons } from './icons.js';

var ctx;

// --- State ---
var voiceEnabled = false;
var listening = false;
var speaking = false;
var autoListen = true;
var recognition = null;
var selectedVoice = "Kore";
var availableVoices = [];

// Audio playback queue
var audioQueue = [];       // Array of WAV blob URLs waiting to play
var currentAudio = null;   // Currently playing Audio element
var pendingText = "";      // Buffer for streaming delta text
var ttsInFlight = 0;       // Number of TTS requests in flight
var responseDone = false;  // Whether the current response is complete

// Sentence splitter
var SENTENCE_END = /(?<=[.!?…])\s+/;

// Media session (Android notification controls)
var mediaSessionActive = false;

// --- Init ---

function init(context) {
  ctx = context;

  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.maxAlternatives = 1;

    recognition.onresult = onRecognitionResult;
    recognition.onend = onRecognitionEnd;
    recognition.onerror = onRecognitionError;
    recognition.onstart = function () {
      listening = true;
      updateUI();
    };
  }

  // Load preferences
  try {
    var prefs = JSON.parse(localStorage.getItem("pi-voice-prefs") || "{}");
    if (prefs.voice) selectedVoice = prefs.voice;
    if (typeof prefs.autoListen === "boolean") autoListen = prefs.autoListen;
  } catch (e) {}

  // Fetch available voices
  fetch((window._piRelayBase || "") + "/api/tts/voices")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.voices) availableVoices = data.voices;
    })
    .catch(function () {});

  createUI();
}

// --- UI ---

function createUI() {
  // Voice button in input bar
  var inputBar = document.getElementById("input-bar");
  if (!inputBar) return;

  var btn = document.createElement("button");
  btn.id = "voice-btn";
  btn.type = "button";
  btn.title = "Voice mode";
  btn.className = "voice-btn";
  btn.innerHTML = '<i data-lucide="mic-off"></i>';
  btn.addEventListener("click", toggleVoice);

  var sendBtn = document.getElementById("send-btn");
  if (sendBtn && sendBtn.parentNode) {
    sendBtn.parentNode.insertBefore(btn, sendBtn);
  }

  // Voice settings panel (hidden by default)
  var panel = document.createElement("div");
  panel.id = "voice-panel";
  panel.className = "voice-panel hidden";
  panel.innerHTML =
    '<div class="voice-panel-header">' +
      '<span>Voice Settings</span>' +
      '<button id="voice-panel-close" type="button"><i data-lucide="x"></i></button>' +
    '</div>' +
    '<div class="voice-panel-body">' +
      '<label class="voice-setting">' +
        '<span>Voice</span>' +
        '<select id="voice-select"></select>' +
      '</label>' +
      '<label class="voice-setting">' +
        '<span>Auto-listen after response</span>' +
        '<input type="checkbox" id="voice-auto-listen"' + (autoListen ? ' checked' : '') + '>' +
      '</label>' +
      '<button id="voice-test-btn" class="voice-test-btn">Test voice</button>' +
    '</div>';
  document.body.appendChild(panel);

  // Settings gear on long-press / right-click
  btn.addEventListener("contextmenu", function (e) {
    e.preventDefault();
    togglePanel();
  });

  // Bind panel events
  document.getElementById("voice-panel-close").addEventListener("click", function () {
    panel.classList.add("hidden");
  });

  document.getElementById("voice-select").addEventListener("change", function () {
    selectedVoice = this.value;
    savePrefs();
  });

  document.getElementById("voice-auto-listen").addEventListener("change", function () {
    autoListen = this.checked;
    savePrefs();
  });

  document.getElementById("voice-test-btn").addEventListener("click", function () {
    speakText("Hello! This is how I sound. Ready when you are.");
  });

  populateVoiceSelect();
  refreshIcons();
}

function populateVoiceSelect() {
  var select = document.getElementById("voice-select");
  if (!select) return;
  select.innerHTML = "";
  var voices = availableVoices.length > 0 ? availableVoices : ["Kore", "Puck", "Charon", "Zephyr", "Leda", "Aoede"];
  for (var i = 0; i < voices.length; i++) {
    var opt = document.createElement("option");
    opt.value = voices[i];
    opt.textContent = voices[i];
    if (voices[i] === selectedVoice) opt.selected = true;
    select.appendChild(opt);
  }
}

function togglePanel() {
  var panel = document.getElementById("voice-panel");
  if (panel) {
    populateVoiceSelect();
    panel.classList.toggle("hidden");
  }
}

function updateUI() {
  var btn = document.getElementById("voice-btn");
  if (!btn) return;

  btn.classList.toggle("active", voiceEnabled);
  btn.classList.toggle("listening", listening);
  btn.classList.toggle("speaking", speaking);

  if (listening) {
    btn.innerHTML = '<i data-lucide="mic"></i>';
    btn.title = "Listening… (click to stop)";
    btn.style.color = "";
  } else if (speaking) {
    btn.innerHTML = '<i data-lucide="volume-2"></i>';
    btn.title = "Speaking… (click to stop)";
  } else if (voiceEnabled) {
    btn.innerHTML = '<i data-lucide="mic"></i>';
    btn.title = "Voice mode on (click to disable, long-press for settings)";
  } else {
    btn.innerHTML = '<i data-lucide="mic-off"></i>';
    btn.title = "Voice mode (click to enable, long-press for settings)";
  }
  refreshIcons();
}

function savePrefs() {
  try {
    localStorage.setItem("pi-voice-prefs", JSON.stringify({
      voice: selectedVoice,
      autoListen: autoListen,
    }));
  } catch (e) {}
}

// --- Toggle ---

function toggleVoice() {
  if (voiceEnabled) {
    disableVoice();
  } else {
    enableVoice();
  }
}

function enableVoice() {
  voiceEnabled = true;
  updateUI();
  startListening();
  setupMediaSession();
  if (ctx.showToast) ctx.showToast("🎤 Voice mode on — speak your message", "info");
}

function disableVoice() {
  voiceEnabled = false;
  stopListening();
  stopSpeaking();
  updateUI();
  teardownMediaSession();
}

// --- Speech Recognition (Input) ---

var interimTranscript = "";
var finalTranscript = "";

function startListening() {
  if (!recognition || listening) return;
  stopSpeaking();
  interimTranscript = "";
  finalTranscript = "";
  try { recognition.start(); } catch (e) {}
}

function stopListening() {
  if (!recognition) return;
  try { recognition.stop(); } catch (e) {}
  listening = false;
  updateUI();
}

function onRecognitionResult(event) {
  interimTranscript = "";
  finalTranscript = "";
  for (var i = event.resultIndex; i < event.results.length; i++) {
    if (event.results[i].isFinal) {
      finalTranscript += event.results[i][0].transcript;
    } else {
      interimTranscript += event.results[i][0].transcript;
    }
  }
  // Show in input field
  if (ctx.inputEl) {
    ctx.inputEl.value = finalTranscript || interimTranscript;
    if (ctx.autoResize) ctx.autoResize();
  }
}

function onRecognitionEnd() {
  listening = false;
  updateUI();
  var text = (finalTranscript || "").trim();
  if (text && voiceEnabled) {
    if (ctx.inputEl) {
      ctx.inputEl.value = text;
      if (ctx.autoResize) ctx.autoResize();
    }
    if (ctx.sendMessage) ctx.sendMessage();
  } else if (voiceEnabled && !text) {
    // No speech — retry
    setTimeout(function () {
      if (voiceEnabled && !speaking) startListening();
    }, 300);
  }
}

function onRecognitionError(event) {
  listening = false;
  updateUI();
  if (event.error === "not-allowed" || event.error === "service-not-allowed") {
    disableVoice();
    if (ctx.showToast) ctx.showToast("Microphone access denied", "error");
  } else if (event.error === "no-speech" && voiceEnabled) {
    setTimeout(function () {
      if (voiceEnabled && !speaking) startListening();
    }, 500);
  } else if (event.error !== "aborted" && voiceEnabled) {
    setTimeout(function () {
      if (voiceEnabled && !speaking) startListening();
    }, 1000);
  }
}

// --- TTS (Output) ---

/**
 * Called on each "delta" from app.js
 */
function feedDelta(text) {
  if (!voiceEnabled) return;
  pendingText += text;
  flushSentences();
}

/**
 * Called on "done" from app.js — flush remaining text
 */
function feedDone() {
  if (!voiceEnabled) return;
  responseDone = true;
  var remaining = pendingText.trim();
  pendingText = "";
  if (remaining) {
    var clean = cleanForSpeech(remaining);
    if (clean) requestTTS(clean);
  }
  // If nothing in queue and nothing in flight, resume listening
  checkFinished();
}

function flushSentences() {
  var parts = pendingText.split(SENTENCE_END);
  if (parts.length <= 1) return; // No complete sentence yet

  // Speak all complete sentences, keep the trailing fragment
  for (var i = 0; i < parts.length - 1; i++) {
    var sentence = parts[i].trim();
    var clean = cleanForSpeech(sentence);
    if (clean) requestTTS(clean);
  }
  pendingText = parts[parts.length - 1];
}

function cleanForSpeech(text) {
  // Strip markdown
  text = text.replace(/```[\s\S]*?```/g, " code block. ");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/_([^_]+)_/g, "$1");
  text = text.replace(/#{1,6}\s*/g, "");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "image: $1");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  text = text.replace(/>\s*/g, "");
  text = text.replace(/\n{2,}/g, ". ");
  text = text.replace(/\n/g, " ");
  text = text.replace(/\s{2,}/g, " ");
  text = text.trim();
  if (!text || text.replace(/[^a-zA-Z0-9]/g, "").length < 3) return "";
  return text;
}

function requestTTS(text) {
  ttsInFlight++;
  var basePath = window._piRelayBase || "";
  // Detect if we're in a project context
  var slugMatch = location.pathname.match(/^(.*?\/p\/[a-z0-9_-]+)\//);
  var apiBase = slugMatch ? "" : "";

  fetch(basePath + "/api/tts/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text, voice: selectedVoice }),
  })
  .then(function (res) {
    if (!res.ok) throw new Error("TTS failed: " + res.status);
    return res.blob();
  })
  .then(function (blob) {
    var url = URL.createObjectURL(blob);
    audioQueue.push(url);
    playNext();
  })
  .catch(function (err) {
    console.error("[voice] TTS error:", err.message);
  })
  .finally(function () {
    ttsInFlight--;
    checkFinished();
  });
}

function playNext() {
  if (currentAudio || audioQueue.length === 0) return;

  speaking = true;
  updateUI();

  var url = audioQueue.shift();
  var audio = new Audio(url);
  currentAudio = audio;

  audio.onended = function () {
    URL.revokeObjectURL(url);
    currentAudio = null;
    speaking = false;
    updateUI();

    if (audioQueue.length > 0) {
      playNext();
    } else {
      checkFinished();
    }
  };

  audio.onerror = function () {
    URL.revokeObjectURL(url);
    currentAudio = null;
    speaking = false;
    updateUI();
    if (audioQueue.length > 0) {
      playNext();
    } else {
      checkFinished();
    }
  };

  audio.play().catch(function (err) {
    console.error("[voice] Audio play error:", err.message);
    currentAudio = null;
    speaking = false;
    updateUI();
    checkFinished();
  });
}

function checkFinished() {
  // All TTS done, all audio played, response complete → resume listening
  if (responseDone && ttsInFlight === 0 && audioQueue.length === 0 && !currentAudio) {
    responseDone = false;
    if (voiceEnabled && autoListen) {
      setTimeout(function () {
        if (voiceEnabled && !speaking) startListening();
      }, 400);
    }
  }
}

function stopSpeaking() {
  audioQueue.forEach(function (url) { URL.revokeObjectURL(url); });
  audioQueue = [];
  pendingText = "";
  ttsInFlight = 0;
  responseDone = false;
  if (currentAudio) {
    try { currentAudio.pause(); } catch (e) {}
    currentAudio = null;
  }
  speaking = false;
  updateUI();
}

/**
 * Speak a single string immediately (e.g. test button)
 */
function speakText(text) {
  stopSpeaking();
  requestTTS(text);
}

// --- Media Session (Android lock screen / notification controls) ---

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  mediaSessionActive = true;

  navigator.mediaSession.metadata = new MediaMetadata({
    title: "Pi Relay Voice",
    artist: "Pi Relay",
    album: "Voice Conversation",
  });

  navigator.mediaSession.setActionHandler("pause", function () {
    stopSpeaking();
    stopListening();
  });

  navigator.mediaSession.setActionHandler("play", function () {
    if (voiceEnabled) startListening();
  });

  navigator.mediaSession.setActionHandler("stop", function () {
    disableVoice();
  });
}

function teardownMediaSession() {
  if (!("mediaSession" in navigator) || !mediaSessionActive) return;
  mediaSessionActive = false;
  try {
    navigator.mediaSession.setActionHandler("pause", null);
    navigator.mediaSession.setActionHandler("play", null);
    navigator.mediaSession.setActionHandler("stop", null);
  } catch (e) {}
}

// --- Reset on session switch ---

function reset() {
  stopSpeaking();
  pendingText = "";
  responseDone = false;
  ttsInFlight = 0;
}

// --- Exports ---

function isVoiceEnabled() { return voiceEnabled; }

export {
  init,
  toggleVoice,
  enableVoice,
  disableVoice,
  feedDelta,
  feedDone,
  stopSpeaking,
  isVoiceEnabled,
  reset,
};
