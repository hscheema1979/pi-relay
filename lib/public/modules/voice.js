/**
 * voice.js — Voice conversation mode for Pi Relay
 *
 * Voice input:  Browser SpeechRecognition (hands-free mic)
 * Voice output: Multiple TTS engines:
 *   - native:  Android/browser built-in (free, instant)
 *   - kokoro:  Kokoro via Chutes AI (free, high quality)
 *   - edge:    Microsoft Edge TTS (free, natural voices)
 *   - gemini:  Gemini TTS via server (paid, highest quality)
 */

import { refreshIcons } from './icons.js';

var ctx;

// --- State ---
var voiceEnabled = false;
var listening = false;
var speaking = false;
var autoListen = true;
var recognition = null;
var playbackSpeed = 1.0;
var playbackPitch = 1.0;

// TTS engine
var ttsEngine = "native";
var engineData = {};  // Populated from server: { kokoro: { voices, default }, edge: {...}, gemini: {...} }

// Engine-specific voice selections
var selectedVoices = {
  native: "",
  kokoro: "af_bella",
  edge: "en-US-AriaNeural",
  gemini: "Kore",
};

// Native TTS state
var nativeVoices = [];

// Audio playback queue (used for server engines: kokoro, edge, gemini)
var audioQueue = [];
var currentAudio = null;

// Native TTS queue
var nativeSpeechQueue = [];
var nativeSpeaking = false;

// Streaming buffer
var pendingText = "";
var ttsInFlight = 0;
var responseDone = false;

// Sentence splitter
var SENTENCE_END = /(?<=[.!?…])\s+/;

// Media session
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
    if (typeof prefs.autoListen === "boolean") autoListen = prefs.autoListen;
    if (typeof prefs.speed === "number") playbackSpeed = prefs.speed;
    if (typeof prefs.pitch === "number") playbackPitch = prefs.pitch;
    if (prefs.ttsEngine) ttsEngine = prefs.ttsEngine;
    if (prefs.selectedVoices) {
      for (var k in prefs.selectedVoices) {
        selectedVoices[k] = prefs.selectedVoices[k];
      }
    }
    // Legacy migration
    if (prefs.voice && !prefs.selectedVoices) selectedVoices.gemini = prefs.voice;
    if (prefs.geminiVoice) selectedVoices.gemini = prefs.geminiVoice;
    if (prefs.nativeVoice) selectedVoices.native = prefs.nativeVoice;
  } catch (e) {}

  // Fetch server engine voices
  fetch((window._piRelayBase || "") + "/api/tts/voices")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.engines) {
        engineData = data.engines;
        // Update defaults if user hasn't picked yet
        for (var eng in engineData) {
          if (!selectedVoices[eng] && engineData[eng].default) {
            selectedVoices[eng] = engineData[eng].default;
          }
        }
        populateEngineVoices();
      }
    })
    .catch(function () {});

  // Load native voices
  loadNativeVoices();
  if (window.speechSynthesis && window.speechSynthesis.onvoiceschanged !== undefined) {
    window.speechSynthesis.onvoiceschanged = function () {
      loadNativeVoices();
      populateEngineVoices();
    };
  }

  createUI();
}

// --- Native Voice Loading ---

function loadNativeVoices() {
  if (!window.speechSynthesis) return;
  var voices = window.speechSynthesis.getVoices();
  if (!voices || voices.length === 0) return;

  nativeVoices = voices.slice();

  // Sort: English first, local first, then by name
  nativeVoices.sort(function (a, b) {
    var aEn = a.lang && a.lang.startsWith("en") ? 0 : 1;
    var bEn = b.lang && b.lang.startsWith("en") ? 0 : 1;
    if (aEn !== bEn) return aEn - bEn;
    if (a.localService && !b.localService) return -1;
    if (!a.localService && b.localService) return 1;
    return a.name.localeCompare(b.name);
  });

  // Auto-select if none set
  if (!selectedVoices.native && nativeVoices.length > 0) {
    var enVoices = nativeVoices.filter(function (v) { return v.lang && v.lang.startsWith("en"); });
    var pool = enVoices.length > 0 ? enVoices : nativeVoices;
    var samsung = pool.find(function (v) { return v.name.toLowerCase().indexOf("samsung") !== -1; });
    var google = pool.find(function (v) { return v.name.toLowerCase().indexOf("google") !== -1; });
    selectedVoices.native = samsung ? samsung.name : google ? google.name : pool[0].name;
  }

  console.log("[voice] Found " + nativeVoices.length + " native voices");
}

function getNativeVoiceObj() {
  if (!window.speechSynthesis) return null;
  var voices = window.speechSynthesis.getVoices();
  for (var i = 0; i < voices.length; i++) {
    if (voices[i].name === selectedVoices.native) return voices[i];
  }
  return voices[0] || null;
}

// --- UI ---

function createUI() {
  var inputBar = document.getElementById("input-bottom-right");
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

  // Settings panel
  var panel = document.createElement("div");
  panel.id = "voice-panel";
  panel.className = "voice-panel hidden";
  panel.innerHTML =
    '<div class="voice-panel-header">' +
      '<span>Voice Settings</span>' +
      '<button id="voice-panel-close" type="button"><i data-lucide="x"></i></button>' +
    '</div>' +
    '<div class="voice-panel-body">' +
      // Engine selector
      '<label class="voice-setting">' +
        '<span>TTS Engine</span>' +
        '<select id="voice-engine-select">' +
          '<option value="native"' + sel("native") + '>📱 Native (Free)</option>' +
          '<option value="kokoro"' + sel("kokoro") + '>🎵 Kokoro (Free)</option>' +
          '<option value="edge"' + sel("edge") + '>🔊 Edge (Free)</option>' +
          '<option value="gemini"' + sel("gemini") + '>✨ Gemini (Paid)</option>' +
        '</select>' +
      '</label>' +
      // Voice selector (changes per engine)
      '<label class="voice-setting">' +
        '<span>Voice</span>' +
        '<select id="voice-select"></select>' +
      '</label>' +
      // Pitch (native only)
      '<div id="pitch-setting"' + (ttsEngine !== "native" ? ' class="hidden"' : '') + '>' +
        '<label class="voice-setting">' +
          '<span>Pitch</span>' +
          '<div class="voice-speed-wrap">' +
            '<input type="range" id="voice-pitch" min="0.5" max="1.5" step="0.1" value="' + playbackPitch + '">' +
            '<span id="voice-pitch-label">' + playbackPitch.toFixed(1) + '</span>' +
          '</div>' +
        '</label>' +
      '</div>' +
      // Speed
      '<label class="voice-setting">' +
        '<span>Speed</span>' +
        '<div class="voice-speed-wrap">' +
          '<input type="range" id="voice-speed" min="0.5" max="2.0" step="0.1" value="' + playbackSpeed + '">' +
          '<span id="voice-speed-label">' + playbackSpeed.toFixed(1) + 'x</span>' +
        '</div>' +
      '</label>' +
      // Auto-listen
      '<label class="voice-setting">' +
        '<span>Auto-listen after response</span>' +
        '<input type="checkbox" id="voice-auto-listen"' + (autoListen ? ' checked' : '') + '>' +
      '</label>' +
      // Hint for native
      '<div id="voice-hint" class="voice-hint"' + (ttsEngine !== "native" ? ' style="display:none"' : '') + '>' +
        '💡 More voices: Phone Settings → Text-to-Speech' +
      '</div>' +
      // Test
      '<button id="voice-test-btn" class="voice-test-btn">Test voice</button>' +
    '</div>';
  document.body.appendChild(panel);

  // Long-press / right-click for settings
  btn.addEventListener("contextmenu", function (e) {
    e.preventDefault();
    togglePanel();
  });

  // Events
  document.getElementById("voice-panel-close").addEventListener("click", function () {
    panel.classList.add("hidden");
  });

  document.getElementById("voice-engine-select").addEventListener("change", function () {
    ttsEngine = this.value;
    populateEngineVoices();
    document.getElementById("pitch-setting").classList.toggle("hidden", ttsEngine !== "native");
    document.getElementById("voice-hint").style.display = ttsEngine === "native" ? "" : "none";
    savePrefs();
  });

  document.getElementById("voice-select").addEventListener("change", function () {
    selectedVoices[ttsEngine] = this.value;
    savePrefs();
  });

  document.getElementById("voice-pitch").addEventListener("input", function () {
    playbackPitch = parseFloat(this.value);
    document.getElementById("voice-pitch-label").textContent = playbackPitch.toFixed(1);
    savePrefs();
  });

  document.getElementById("voice-speed").addEventListener("input", function () {
    playbackSpeed = parseFloat(this.value);
    document.getElementById("voice-speed-label").textContent = playbackSpeed.toFixed(1) + "x";
    if (currentAudio) currentAudio.playbackRate = playbackSpeed;
    savePrefs();
  });

  document.getElementById("voice-auto-listen").addEventListener("change", function () {
    autoListen = this.checked;
    savePrefs();
  });

  document.getElementById("voice-test-btn").addEventListener("click", function () {
    speakText("Hello! This is how I sound. Ready when you are.");
  });

  populateEngineVoices();
  refreshIcons();
}

function sel(engine) {
  return ttsEngine === engine ? " selected" : "";
}

function populateEngineVoices() {
  var select = document.getElementById("voice-select");
  if (!select) return;
  select.innerHTML = "";

  if (ttsEngine === "native") {
    // Native browser/Android voices
    for (var i = 0; i < nativeVoices.length; i++) {
      var v = nativeVoices[i];
      var opt = document.createElement("option");
      opt.value = v.name;
      var label = v.name;
      if (v.lang) label += " (" + v.lang + ")";
      if (v.localService) label += " ★";
      opt.textContent = label;
      if (v.name === selectedVoices.native) opt.selected = true;
      select.appendChild(opt);
    }
    if (nativeVoices.length === 0) {
      var none = document.createElement("option");
      none.textContent = "No voices available";
      none.disabled = true;
      select.appendChild(none);
    }
  } else {
    // Server engines: kokoro, edge, gemini
    var data = engineData[ttsEngine];
    var voices = data ? data.voices : [];
    var current = selectedVoices[ttsEngine] || (data ? data.default : "");

    for (var j = 0; j < voices.length; j++) {
      var opt2 = document.createElement("option");
      opt2.value = voices[j];
      // Make voice names more readable
      var name = voices[j];
      if (ttsEngine === "kokoro") {
        name = formatKokoroName(voices[j]);
      } else if (ttsEngine === "edge") {
        name = formatEdgeName(voices[j]);
      }
      opt2.textContent = name;
      if (voices[j] === current) opt2.selected = true;
      select.appendChild(opt2);
    }
    if (voices.length === 0) {
      var loading = document.createElement("option");
      loading.textContent = "Loading voices...";
      loading.disabled = true;
      select.appendChild(loading);
    }
  }
}

function formatKokoroName(id) {
  // af_bella → 🇺🇸 Bella (Female)
  var parts = id.split("_");
  if (parts.length !== 2) return id;
  var prefix = parts[0];
  var name = parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
  var flags = { af: "🇺🇸♀ ", am: "🇺🇸♂ ", bf: "🇬🇧♀ ", bm: "🇬🇧♂ " };
  return (flags[prefix] || "") + name;
}

function formatEdgeName(id) {
  // en-US-AriaNeural → 🇺🇸 Aria
  var match = id.match(/^en-(\w+)-(\w+)Neural$/);
  if (!match) return id;
  var region = match[1];
  var name = match[2];
  var flags = { US: "🇺🇸 ", GB: "🇬🇧 ", AU: "🇦🇺 ", IN: "🇮🇳 " };
  return (flags[region] || region + " ") + name;
}

function togglePanel() {
  var panel = document.getElementById("voice-panel");
  if (panel) {
    populateEngineVoices();
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
      ttsEngine: ttsEngine,
      selectedVoices: selectedVoices,
      autoListen: autoListen,
      speed: playbackSpeed,
      pitch: playbackPitch,
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
  setupMediaSession();
  showVoiceOverlay();
}

function disableVoice() {
  voiceEnabled = false;
  stopListening();
  stopSpeaking();
  hideVoiceOverlay();
  updateUI();
  teardownMediaSession();
}

// --- Voice Playback Overlay ---
// States: idle → listening → thinking → speaking → idle
// Push-to-talk: tap mic to start listening, tap again to send

var overlayState = "idle";
var spokenChunks = [];  // Tracks what TTS has spoken for display

function showVoiceOverlay() {
  if (document.getElementById("voice-overlay")) return;

  var el = document.createElement("div");
  el.id = "voice-overlay";
  el.className = "vo-overlay";
  el.innerHTML =
    '<div class="vo-top"></div>' +
    '<div class="vo-center">' +
      // Orb
      '<div class="vo-orb-wrap">' +
        '<div class="vo-orb" id="vo-orb">' +
          // Listening: mic icon
          '<div class="vo-mic vo-hidden" id="vo-mic">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
              '<rect x="9" y="2" width="6" height="11" rx="3"></rect>' +
              '<path d="M5 10a7 7 0 0 0 14 0"></path>' +
              '<line x1="12" y1="19" x2="12" y2="22"></line>' +
            '</svg>' +
          '</div>' +
          // Speaking: waveform bars
          '<div class="vo-bars vo-hidden" id="vo-bars">' +
            '<div class="vo-bar"></div><div class="vo-bar"></div><div class="vo-bar"></div>' +
            '<div class="vo-bar"></div><div class="vo-bar"></div><div class="vo-bar"></div>' +
            '<div class="vo-bar"></div>' +
          '</div>' +
          // Thinking: dots
          '<div class="vo-dots vo-hidden" id="vo-dots">' +
            '<div class="vo-dot"></div><div class="vo-dot"></div><div class="vo-dot"></div>' +
          '</div>' +
          // Done: check
          '<div class="vo-check vo-hidden" id="vo-check">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
              '<polyline points="20 6 9 17 4 12"></polyline>' +
            '</svg>' +
          '</div>' +
        '</div>' +
      '</div>' +
      // Status
      '<div class="vo-status" id="vo-status">Tap to talk</div>' +
      // Response / transcript text
      '<div class="vo-response">' +
        '<div class="vo-response-text" id="vo-response-text"></div>' +
      '</div>' +
    '</div>' +
    // Bottom
    '<div class="vo-bottom">' +
      // Idle: big talk button
      '<div class="vo-idle-controls" id="vo-idle-controls">' +
        '<button class="vo-btn" id="vo-settings-btn" title="Voice settings">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<circle cx="12" cy="12" r="3"></circle>' +
            '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>' +
          '</svg>' +
        '</button>' +
        '<button class="vo-talk-btn" id="vo-talk-btn" title="Tap to talk">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="9" y="2" width="6" height="11" rx="3"></rect>' +
            '<path d="M5 10a7 7 0 0 0 14 0"></path>' +
            '<line x1="12" y1="19" x2="12" y2="22"></line>' +
          '</svg>' +
        '</button>' +
        '<button class="vo-btn vo-exit" id="vo-exit-btn" title="Exit voice mode">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
            '<line x1="18" y1="6" x2="6" y2="18"></line>' +
            '<line x1="6" y1="6" x2="18" y2="18"></line>' +
          '</svg>' +
        '</button>' +
      '</div>' +
      // Listening: send button
      '<div class="vo-listen-controls vo-hidden" id="vo-listen-controls">' +
        '<button class="vo-btn" id="vo-cancel-btn" title="Cancel">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
            '<line x1="18" y1="6" x2="6" y2="18"></line>' +
            '<line x1="6" y1="6" x2="18" y2="18"></line>' +
          '</svg>' +
        '</button>' +
        '<button class="vo-talk-btn vo-talk-send" id="vo-send-btn" title="Tap to send">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
            '<line x1="12" y1="19" x2="12" y2="5"></line>' +
            '<polyline points="5 12 12 5 19 12"></polyline>' +
          '</svg>' +
        '</button>' +
        '<div style="width:44px"></div>' +
      '</div>' +
      // Speaking/thinking: skip & stop
      '<div class="vo-play-controls vo-hidden" id="vo-play-controls">' +
        '<button class="vo-btn" id="vo-skip-btn" title="Skip">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<polygon points="5 4 15 12 5 20 5 4"></polygon>' +
            '<line x1="19" y1="5" x2="19" y2="19"></line>' +
          '</svg>' +
        '</button>' +
        '<button class="vo-btn vo-stop" id="vo-stop-btn" title="Stop">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="6" y="6" width="12" height="12" rx="1"></rect>' +
          '</svg>' +
        '</button>' +
        '<button class="vo-btn" id="vo-settings-btn2" title="Voice settings">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<circle cx="12" cy="12" r="3"></circle>' +
            '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>' +
          '</svg>' +
        '</button>' +
      '</div>' +
      // Engine label
      '<div class="vo-engine">' +
        '<div class="vo-engine-dot"></div>' +
        '<span id="vo-engine-label"></span>' +
      '</div>' +
    '</div>';

  document.body.appendChild(el);

  // Wire buttons
  document.getElementById("vo-talk-btn").addEventListener("click", function () {
    overlayStartListening();
  });
  document.getElementById("vo-send-btn").addEventListener("click", function () {
    overlayStopAndSend();
  });
  document.getElementById("vo-cancel-btn").addEventListener("click", function () {
    overlayCancelListening();
  });
  document.getElementById("vo-stop-btn").addEventListener("click", function () {
    stopSpeaking();
    setOverlayState("idle");
  });
  document.getElementById("vo-skip-btn").addEventListener("click", function () {
    stopSpeaking();
    setOverlayState("idle");
  });
  document.getElementById("vo-exit-btn").addEventListener("click", function () {
    disableVoice();
  });
  document.getElementById("vo-settings-btn").addEventListener("click", function () {
    togglePanel();
  });
  document.getElementById("vo-settings-btn2").addEventListener("click", function () {
    togglePanel();
  });

  // Update engine label
  updateOverlayEngineLabel();

  // Start in idle
  setOverlayState("idle");
}

function hideVoiceOverlay() {
  var el = document.getElementById("voice-overlay");
  if (el) {
    el.classList.add("vo-dismissing");
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
  }
  overlayState = "idle";
}

function updateOverlayEngineLabel() {
  var engineLabel = document.getElementById("vo-engine-label");
  if (engineLabel) {
    var labels = { native: "Native", kokoro: "Kokoro", edge: "Edge", gemini: "Gemini" };
    var voice = selectedVoices[ttsEngine] || "";
    engineLabel.textContent = (labels[ttsEngine] || ttsEngine) + " · " + voice + " · " + playbackSpeed.toFixed(1) + "×";
  }
}

function setOverlayState(state) {
  overlayState = state;

  var orb = document.getElementById("vo-orb");
  var mic = document.getElementById("vo-mic");
  var bars = document.getElementById("vo-bars");
  var dots = document.getElementById("vo-dots");
  var chk = document.getElementById("vo-check");
  var st = document.getElementById("vo-status");
  var txt = document.getElementById("vo-response-text");
  var idleCtrl = document.getElementById("vo-idle-controls");
  var listenCtrl = document.getElementById("vo-listen-controls");
  var playCtrl = document.getElementById("vo-play-controls");
  if (!orb) return;

  // Reset orb contents
  mic.classList.add("vo-hidden");
  bars.classList.add("vo-hidden");
  dots.classList.add("vo-hidden");
  chk.classList.add("vo-hidden");
  orb.className = "vo-orb";

  // Reset control panels
  idleCtrl.classList.add("vo-hidden");
  listenCtrl.classList.add("vo-hidden");
  playCtrl.classList.add("vo-hidden");

  switch (state) {
    case "idle":
      mic.classList.remove("vo-hidden");
      st.textContent = "Tap to talk";
      txt.innerHTML = "";
      idleCtrl.classList.remove("vo-hidden");
      spokenChunks = [];
      break;

    case "listening":
      orb.classList.add("listening");
      mic.classList.remove("vo-hidden");
      st.textContent = "Listening — tap to send";
      txt.innerHTML = '<span class="vo-interim"></span>';
      listenCtrl.classList.remove("vo-hidden");
      break;

    case "thinking":
      orb.classList.add("thinking");
      dots.classList.remove("vo-hidden");
      st.textContent = "Thinking…";
      txt.innerHTML = "";
      playCtrl.classList.remove("vo-hidden");
      spokenChunks = [];
      break;

    case "speaking":
      orb.classList.add("speaking");
      bars.classList.remove("vo-hidden");
      st.textContent = "Speaking…";
      playCtrl.classList.remove("vo-hidden");
      break;

    case "done":
      orb.classList.add("done");
      chk.classList.remove("vo-hidden");
      st.textContent = "Done";
      idleCtrl.classList.remove("vo-hidden");
      // Auto-return to idle after a beat
      setTimeout(function () {
        if (overlayState === "done") setOverlayState("idle");
      }, 2500);
      break;
  }
}

// Update the transcript area while listening
function updateOverlayTranscript(interim, final) {
  var txt = document.getElementById("vo-response-text");
  if (!txt || overlayState !== "listening") return;
  var html = "";
  if (final) html += '<span class="vo-spoken">' + escapeHtml(final) + '</span> ';
  if (interim) html += '<span class="vo-interim">' + escapeHtml(interim) + '</span>';
  if (!final && !interim) html = '<span class="vo-interim">…</span>';
  txt.innerHTML = html;
}

// Update the response text while TTS is speaking
function updateOverlayResponse(newChunk) {
  spokenChunks.push(newChunk);
  var txt = document.getElementById("vo-response-text");
  if (!txt) return;
  txt.textContent = spokenChunks.join(" ");
}

function escapeHtml(s) {
  var d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// --- Push-to-talk overlay actions ---

function overlayStartListening() {
  stopSpeaking();
  interimTranscript = "";
  finalTranscript = "";
  setOverlayState("listening");
  if (recognition) {
    try { recognition.start(); } catch (e) {}
  }
}

function overlayStopAndSend() {
  // Move to thinking FIRST so onRecognitionEnd won't double-send
  var text = (finalTranscript || interimTranscript || "").trim();
  setOverlayState("thinking");
  listening = false;
  // Now stop recognition (onRecognitionEnd will see state != "listening" and skip)
  if (recognition) {
    try { recognition.stop(); } catch (e) {}
  }
  if (text) {
    if (ctx.inputEl) {
      ctx.inputEl.value = text;
      if (ctx.autoResize) ctx.autoResize();
    }
    if (ctx.sendMessage) ctx.sendMessage();
  } else {
    // Nothing heard — back to idle
    setOverlayState("idle");
  }
}

function overlayCancelListening() {
  if (recognition) {
    try { recognition.abort(); } catch (e) {}
  }
  listening = false;
  interimTranscript = "";
  finalTranscript = "";
  setOverlayState("idle");
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
  // Show live transcript in overlay
  updateOverlayTranscript(interimTranscript, finalTranscript);
  // Also update the hidden input field
  if (ctx.inputEl) {
    ctx.inputEl.value = finalTranscript || interimTranscript;
    if (ctx.autoResize) ctx.autoResize();
  }
}

function onRecognitionEnd() {
  listening = false;
  updateUI();

  // If overlay is in listening state, the user tapped send or
  // speech recognition auto-stopped on silence — send the message
  if (overlayState === "listening") {
    var text = (finalTranscript || interimTranscript || "").trim();
    if (text) {
      setOverlayState("thinking");
      if (ctx.inputEl) {
        ctx.inputEl.value = text;
        if (ctx.autoResize) ctx.autoResize();
      }
      if (ctx.sendMessage) ctx.sendMessage();
    } else {
      // No speech detected — go back to idle
      setOverlayState("idle");
    }
  }
}

function onRecognitionError(event) {
  listening = false;
  updateUI();
  if (event.error === "not-allowed" || event.error === "service-not-allowed") {
    disableVoice();
    if (ctx.showToast) ctx.showToast("Microphone access denied", "error");
  } else if (event.error === "no-speech" && voiceEnabled) {
    // No speech heard — back to idle, don't auto-restart
    setOverlayState("idle");
  } else if (event.error === "aborted") {
    // User cancelled — already handled by overlayCancelListening
  } else if (voiceEnabled) {
    // Other error — back to idle
    setOverlayState("idle");
  }
}

// --- TTS Output ---

function feedDelta(text) {
  if (!voiceEnabled) return;
  // First delta — transition overlay from thinking to speaking
  if (overlayState === "thinking") {
    setOverlayState("speaking");
  }
  pendingText += text;
  flushSentences();
}

/**
 * feedFlush — Immediately flush any pending text to TTS.
 * Called when tool use starts so the intro text is spoken right away
 * instead of waiting for the entire response to complete.
 */
function feedFlush() {
  if (!voiceEnabled) return;
  var remaining = pendingText.trim();
  pendingText = "";
  if (remaining) {
    var clean = cleanForSpeech(remaining);
    if (clean) dispatchTTS(clean);
  }
}

function feedDone() {
  if (!voiceEnabled) return;
  responseDone = true;
  var remaining = pendingText.trim();
  pendingText = "";
  if (remaining) {
    var clean = cleanForSpeech(remaining);
    if (clean) dispatchTTS(clean);
  }
  checkFinished();
}

function flushSentences() {
  var parts = pendingText.split(SENTENCE_END);
  if (parts.length <= 1) return;
  for (var i = 0; i < parts.length - 1; i++) {
    var sentence = parts[i].trim();
    var clean = cleanForSpeech(sentence);
    if (clean) dispatchTTS(clean);
  }
  pendingText = parts[parts.length - 1];
}

function dispatchTTS(text) {
  // Update overlay with the spoken text
  updateOverlayResponse(text);
  if (ttsEngine === "native") {
    requestNativeTTS(text);
  } else {
    requestServerTTS(text);
  }
}

/**
 * cleanForSpeech — Convert markdown/structured text into natural spoken text.
 *
 * - Tables → summarized as "Here's a table with N rows" + key info
 * - Long bullet lists → summarized count + first few items
 * - Code blocks → "code block"
 * - Markdown formatting → stripped to plain text
 * - Emoji status indicators → spoken equivalents
 */
function cleanForSpeech(text) {
  // --- Handle tables ---
  // Detect markdown tables (lines with | separators)
  var tablePattern = /(?:^|\n)(\|.+\|(?:\n\|[-:| ]+\|)?(?:\n\|.+\|)+)/g;
  text = text.replace(tablePattern, function (match) {
    return summarizeTable(match);
  });

  // --- Handle long bullet/numbered lists ---
  // Detect consecutive list items (3+ items)
  var listPattern = /(?:^|\n)((?:\s*[-*+]\s+.+\n?){4,})/g;
  text = text.replace(listPattern, function (match) {
    return summarizeList(match, "bullet");
  });
  var numListPattern = /(?:^|\n)((?:\s*\d+\.\s+.+\n?){4,})/g;
  text = text.replace(numListPattern, function (match) {
    return summarizeList(match, "numbered");
  });

  // --- Code blocks ---
  text = text.replace(/```[\s\S]*?```/g, " code block. ");

  // --- Inline markdown ---
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*]+)\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/_([^_]+)_/g, "$1");
  text = text.replace(/#{1,6}\s*/g, "");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "image: $1");

  // --- Short lists (3 or fewer items) — just clean the bullets ---
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");

  // --- Blockquotes ---
  text = text.replace(/>\s*/g, "");

  // --- Emoji status indicators → spoken equivalents ---
  text = text.replace(/✅/g, "yes, ");
  text = text.replace(/❌/g, "no, ");
  text = text.replace(/⚠️/g, "warning, ");
  text = text.replace(/🔍/g, "");
  text = text.replace(/📝/g, "");
  text = text.replace(/🖥️/g, "");
  text = text.replace(/🎤/g, "");
  text = text.replace(/👋/g, "");
  text = text.replace(/👍/g, "");

  // --- Clean up whitespace ---
  text = text.replace(/\n{2,}/g, ". ");
  text = text.replace(/\n/g, " ");
  text = text.replace(/\s{2,}/g, " ");
  text = text.trim();
  if (!text || text.replace(/[^a-zA-Z0-9]/g, "").length < 3) return "";
  return text;
}

/**
 * Summarize a markdown table for speech.
 * Instead of reading "pipe machine pipe IP pipe status pipe..."
 * it says something like "Here's a table with 6 rows showing machine, IP, status, and relay info."
 */
function summarizeTable(tableText) {
  var lines = tableText.trim().split("\n").filter(function (l) { return l.trim(); });
  if (lines.length === 0) return "";

  // Parse header
  var headerLine = lines[0];
  var headers = headerLine.split("|").map(function (h) { return h.trim(); }).filter(function (h) { return h && !h.match(/^[-:]+$/); });

  // Skip separator line
  var dataLines = lines.filter(function (l) { return !l.match(/^\|?\s*[-:|]+\s*\|?$/); });
  var rowCount = dataLines.length - 1; // minus header
  if (rowCount < 0) rowCount = 0;

  // Build summary
  var summary = " Here's a table with " + rowCount + " row" + (rowCount !== 1 ? "s" : "");
  if (headers.length > 0) {
    summary += " showing " + headers.slice(0, 3).join(", ");
    if (headers.length > 3) summary += " and more";
  }
  summary += ". ";

  // Extract key highlights from data rows (first 3 rows, first 2 columns)
  var highlights = [];
  for (var i = 1; i < dataLines.length && highlights.length < 3; i++) {
    var cells = dataLines[i].split("|").map(function (c) { return c.trim(); }).filter(function (c) { return c; });
    if (cells.length >= 2) {
      // Clean markdown/emoji from cell content
      var key = cells[0].replace(/\*\*/g, "").replace(/[✅❌⚠️🔍]/g, "").trim();
      var val = cells[1].replace(/\*\*/g, "").replace(/[✅❌⚠️🔍]/g, "").trim();
      if (key && val) highlights.push(key + " is " + val);
    }
  }
  if (highlights.length > 0) {
    summary += highlights.join(". ") + ". ";
  }

  return summary;
}

/**
 * Summarize a long list for speech.
 * Instead of reading every bullet, says "Here are N items" + first few.
 */
function summarizeList(listText, type) {
  var lines = listText.trim().split("\n").filter(function (l) { return l.trim(); });
  var items = lines.map(function (l) {
    return l.replace(/^\s*[-*+]\s+/, "").replace(/^\s*\d+\.\s+/, "").trim();
  }).filter(function (l) { return l; });

  var count = items.length;
  if (count <= 3) {
    // Short list — just read them
    return " " + items.join(". ") + ". ";
  }

  // Long list — summarize
  var summary = " Here are " + count + " items. ";
  // Read first 2 items
  summary += items[0] + ". " + items[1] + ". ";
  if (count > 2) {
    summary += "And " + (count - 2) + " more. ";
  }
  return summary;
}

// --- Native TTS (Free — Samsung/Google/Browser) ---

function requestNativeTTS(text) {
  if (!window.speechSynthesis) {
    console.warn("[voice] speechSynthesis not available, falling back to server");
    requestServerTTS(text);
    return;
  }
  ttsInFlight++;
  nativeSpeechQueue.push(text);
  playNextNative();
}

function playNextNative() {
  if (nativeSpeaking || nativeSpeechQueue.length === 0) return;

  nativeSpeaking = true;
  speaking = true;
  updateUI();

  var text = nativeSpeechQueue.shift();
  var utterance = new SpeechSynthesisUtterance(text);

  var voiceObj = getNativeVoiceObj();
  if (voiceObj) utterance.voice = voiceObj;

  utterance.rate = playbackSpeed;
  utterance.pitch = playbackPitch;
  utterance.volume = 1.0;

  utterance.onend = function () {
    nativeSpeaking = false;
    ttsInFlight--;
    if (nativeSpeechQueue.length > 0) {
      playNextNative();
    } else {
      speaking = false;
      updateUI();
      checkFinished();
    }
  };

  utterance.onerror = function (e) {
    console.error("[voice] Native TTS error:", e.error);
    nativeSpeaking = false;
    ttsInFlight--;
    if (nativeSpeechQueue.length > 0) {
      playNextNative();
    } else {
      speaking = false;
      updateUI();
      checkFinished();
    }
  };

  // Android Chrome bug workaround
  window.speechSynthesis.cancel();
  setTimeout(function () {
    window.speechSynthesis.speak(utterance);
  }, 50);
}

function stopNativeSpeaking() {
  nativeSpeechQueue = [];
  nativeSpeaking = false;
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}

// --- Server TTS (Kokoro, Edge, Gemini) ---

function requestServerTTS(text) {
  ttsInFlight++;
  var basePath = window._piRelayBase || "";

  fetch(basePath + "/api/tts/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      engine: ttsEngine,
      text: text,
      voice: selectedVoices[ttsEngine],
      speed: playbackSpeed,
    }),
  })
  .then(function (res) {
    if (!res.ok) throw new Error("TTS failed: " + res.status);
    return res.blob();
  })
  .then(function (blob) {
    var url = URL.createObjectURL(blob);
    audioQueue.push(url);
    playNextAudio();
  })
  .catch(function (err) {
    console.error("[voice] " + ttsEngine + " TTS error:", err.message);
  })
  .finally(function () {
    ttsInFlight--;
    checkFinished();
  });
}

function playNextAudio() {
  if (currentAudio || audioQueue.length === 0) return;

  speaking = true;
  updateUI();

  var url = audioQueue.shift();
  var audio = new Audio(url);
  audio.playbackRate = playbackSpeed;
  currentAudio = audio;

  audio.onended = function () {
    URL.revokeObjectURL(url);
    currentAudio = null;
    speaking = false;
    updateUI();
    if (audioQueue.length > 0) {
      playNextAudio();
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
      playNextAudio();
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

// --- Shared ---

function checkFinished() {
  if (responseDone && ttsInFlight === 0 && audioQueue.length === 0 && !currentAudio && nativeSpeechQueue.length === 0 && !nativeSpeaking) {
    responseDone = false;
    // Transition overlay to done → idle
    if (voiceEnabled && overlayState === "speaking") {
      setOverlayState("done");
    }
  }
}

function stopSpeaking() {
  stopNativeSpeaking();
  audioQueue.forEach(function (url) { URL.revokeObjectURL(url); });
  audioQueue = [];
  if (currentAudio) {
    try { currentAudio.pause(); } catch (e) {}
    currentAudio = null;
  }
  pendingText = "";
  ttsInFlight = 0;
  responseDone = false;
  speaking = false;
  updateUI();
}

function speakText(text) {
  stopSpeaking();
  dispatchTTS(text);
}

// --- Media Session ---

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  mediaSessionActive = true;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: "Pi Relay Voice",
    artist: "Pi Relay",
    album: "Voice Conversation",
  });
  navigator.mediaSession.setActionHandler("pause", function () { stopSpeaking(); stopListening(); });
  navigator.mediaSession.setActionHandler("play", function () { if (voiceEnabled) startListening(); });
  navigator.mediaSession.setActionHandler("stop", function () { disableVoice(); });
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

// --- Reset ---

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
  feedFlush,
  feedDone,
  stopSpeaking,
  isVoiceEnabled,
  reset,
};
