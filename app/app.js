"use strict";

import { PaceTracker } from "./pace.mjs";
import { assessDelivery, createCoachState } from "./coach.mjs";
import { PauseDetector } from "./pauses.mjs";
import { MicrophoneMonitor } from "./audio-input.mjs";
import { analyseFillers } from "./fillers.mjs";
import { CameraMonitor } from "./camera-input.mjs";
import { VISION_SETTINGS } from "./vision.mjs";
import { SessionMeasurements } from "./session-measurements.mjs";
import { createReview } from "./review.mjs";
import { AstraReview } from "./astra-review.mjs";
import { formatDuration } from "./format-duration.mjs";
import { SpokenCues } from "./spoken-cues.mjs";

const spokenCuesControl = document.getElementById("spoken-cues");
spokenCuesControl.value = "off";
const spokenCues = new SpokenCues({
  onStatus: (message) => { document.getElementById("voice-status").textContent = message; },
  onDelay: ({delayMs, outputLatencyMs}) => {
    document.getElementById("voice-delay").textContent =
      `Last LOOK UP: ${(delayMs / 1000).toFixed(2)} s to playback start; ` +
      `device latency estimate ${(outputLatencyMs / 1000).toFixed(2)} s.`;
  },
});
let cueEventId = 0;

function voiceAction(action) {
  try { action(); } catch {
    document.getElementById("voice-status").textContent = "Spoken cues unavailable. Text coaching continues.";
  }
}

spokenCuesControl.addEventListener("change", () => {
  voiceAction(() => spokenCues.setEnabled(spokenCuesControl.value === "on"));
});

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const listenButton = document.getElementById("listen-button");
const clearButton = document.getElementById("clear-button");
const statusLabel = document.getElementById("status-label");
const statusMessage = document.getElementById("status-message");
const transcript = document.getElementById("transcript");

let activeRecognition = null;
let transcriptText = "";
let fillerAnalysis = analyseFillers("");
const pace = new PaceTracker();
const measurements = new SessionMeasurements();
const astra = new AstraReview(document);
const paceValue = document.getElementById("pace-value");
const sessionSummary = document.getElementById("session-summary");
let paceTimer = null;
let sessionActive = false;
let sessionPhrases = [];
let restartTimer = null;
let startTimer = null;
let restartAttempts = 0;
let recognitionListening = false;
const RESTART_DELAYS = [500, 1000, 2000];
const STABLE_SECONDS = 10;
const coachCue = document.getElementById("coach-cue");
let coachState = createCoachState();
let cueTimer = null;
// Set true for local camera diagnostics and preview during development.
const SHOW_VISION_DIAGNOSTICS = false;
const visionCounts = {face_visible_and_facing: 0, face_visible_not_facing: 0,
  no_face: 0, unavailable: 0, stale: 0};
let currentVisionState = "unavailable";
let lastDiagnosticAt = null;
let notVisibleCues = 0;
document.getElementById("vision-diagnostics").hidden = !SHOW_VISION_DIAGNOSTICS;

function showVisionDiagnostics() {
  document.getElementById("vision-current").textContent = "Current vision state: " + currentVisionState;
  for (const [state, count] of Object.entries(visionCounts)) {
    document.getElementById("vision-" + state).textContent = String(count);
  }
}
showVisionDiagnostics();

let cameraObservation = {state: "unavailable", observedAt: null};
const cameraStatus = document.getElementById("camera-status");
const cameraPreview = document.getElementById("camera-preview");
const camera = new CameraMonitor(document.getElementById("camera-video"), (observation) => {
  if (!sessionActive) return;
  cameraObservation = observation;
  const fresh = Number.isFinite(observation.observedAt) && observation.observedAt <= nowSeconds() &&
    nowSeconds() - observation.observedAt <= VISION_SETTINGS.maxObservationAge;
  currentVisionState = observation.state in visionCounts ? observation.state : "unavailable";
  if (!fresh && currentVisionState !== "unavailable") currentVisionState = "stale";
  if (observation.observedAt !== lastDiagnosticAt) {
    visionCounts[currentVisionState]++;
    lastDiagnosticAt = observation.observedAt;
  }
  showVisionDiagnostics();
  if (paceTimer !== null) measurements.camera(observation, nowSeconds());
  const label = currentVisionState === "unavailable" ? "Camera unavailable" : currentVisionState === "stale" ? "Waiting for camera frames" : "Camera ready";
  if (cameraStatus.textContent !== label) cameraStatus.textContent = label;
  updatePace();
});
const pauses = new PauseDetector();
const audioStatus = document.getElementById("audio-status");
let pauseMonitoring = false;
const microphone = new MicrophoneMonitor((level) => {
  if (!sessionActive) return;
  const observation = pauses.observe(level, nowSeconds());
  pauseMonitoring = observation.state !== "unavailable";
  if (paceTimer !== null) measurements.audio(observation, nowSeconds());
  const message = pauseMonitoring ? "Pause monitoring active" : "Pause monitoring unavailable. Coaching is standing by.";
  if (audioStatus.textContent !== message) audioStatus.textContent = message;
  if (!pauseMonitoring) updatePace();
}, (reason) => {
  if (!sessionActive) return;
  pauseMonitoring = false;
  pauses.invalidate();
  measurements.audioIncomplete = true;
  audioStatus.textContent = reason === "permission-denied"
    ? "Allow microphone access in Chrome and Windows, then stop and start again. Coaching is standing by."
    : "Microphone audio analysis stopped or is unavailable. Check your microphone, then stop and start again. Coaching is standing by.";
  updatePace();
});

function hideCue() {
  voiceAction(() => spokenCues.cancelCue());
  clearTimeout(cueTimer);
  cueTimer = null;
  if (coachCue.textContent !== "Coach standing by") coachCue.textContent = "Coach standing by";
  coachCue.dataset.active = "false";
}

function resetCoach() {
  coachState = createCoachState();
  hideCue();
}

function updateCoach(estimate, now) {
  const audio = pauses.observation(now);
  const result = assessDelivery({
    active: sessionActive,
    pace: {state: estimate.state, wpm: estimate.wpm, observedAt: pace.lastWordAt},
    audio,
    vision: paceTimer !== null && now - pace.startedAt >= pace.windowSeconds
      ? cameraObservation : {state: "unavailable", observedAt: null},
  }, coachState, now);
  coachState = result.nextState;
  if (!sessionActive || audio.state === "unavailable" || estimate.state === "measuring" ||
      (coachCue.textContent === "SLOW DOWN" && estimate.state !== "ready") ||
      (coachCue.textContent === "LOOK UP" && (!["face_visible_not_facing", "no_face"].includes(cameraObservation.state) ||
        cameraObservation.active === false ||
        now - cameraObservation.observedAt > VISION_SETTINGS.maxObservationAge))) {
    hideCue();
  } else if (["SLOW_DOWN", "PAUSE", "LOOK_UP"].includes(result.decision)) {
    hideCue();
    measurements.cue(result.decision);
    if (result.decision === "LOOK_UP" && cameraObservation.state === "no_face") notVisibleCues++;
    coachCue.textContent = {PAUSE: "PAUSE", LOOK_UP: "LOOK UP", SLOW_DOWN: "SLOW DOWN"}[result.decision];
    coachCue.dataset.active = "true";
    const timer = setTimeout(() => {
      if (cueTimer === timer) hideCue();
    }, 3000);
    cueTimer = timer;
    voiceAction(() => spokenCues.cue({
      id: ++cueEventId, type: result.decision, at: now * 1000, expiresAt: now * 1000 + 3000,
    }));
  }
}

function nowSeconds() {
  return performance.now() / 1000;
}

function updatePace() {
  const now = nowSeconds();
  if (sessionActive && !["unavailable", "stale"].includes(currentVisionState) &&
      now - cameraObservation.observedAt > VISION_SETTINGS.maxObservationAge) {
    currentVisionState = "stale";
    visionCounts.stale++;
    showVisionDiagnostics();
    cameraStatus.textContent = "Waiting for camera frames";
  }
  if (!recognitionListening) {
    paceValue.textContent = "Waiting for speech...";
    updateCoach({state: "waiting", wpm: null}, now);
    return;
  }
  const estimate = pace.estimate(now);
  paceValue.textContent = estimate.state === "ready"
    ? `${Math.round(estimate.wpm)} WPM`
    : estimate.state === "measuring" ? "Measuring..." : "Waiting for speech...";
  updateCoach(estimate, now);
}

function finishPace(interrupted = false) {
  if (paceTimer === null) return;
  clearInterval(paceTimer);
  paceTimer = null;
  paceValue.textContent = "Waiting for speech...";
  const result = pace.summary(nowSeconds());
  document.getElementById("session-duration").textContent = formatDuration(result.duration);
  document.getElementById("average-pace").textContent = result.averageWpm === null
    ? "Not enough data" : `${Math.round(result.averageWpm)} WPM`;
  document.getElementById("total-words").textContent = String(result.words);
  document.getElementById("summary-note").textContent = interrupted
    ? "Recognition was interrupted. These estimates cover only the listening interval and may be incomplete."
    : "Based on the displayed transcript, including any unfinished text, and the full listening time including pauses. Short samples are less reliable.";
  showFillerSummary();
  const snapshot = {...result, ...measurements.summary(nowSeconds()), fillers: fillerAnalysis};
  const profile = createReview(snapshot);
  showReview(profile);
  const visibilityNote = document.getElementById("camera-not-visible-note");
  visibilityNote.hidden = notVisibleCues === 0;
  visibilityNote.textContent = notVisibleCues > 0
    ? "SpeakCue detected periods when the presenter was not visible to the camera." : "";
  sessionSummary.hidden = false;
  document.getElementById("summary-heading").focus();
  return {snapshot, profile, transcript: transcriptText};
}

/** Render the structured review using text nodes only. */
function showReview(review) {
  const setText = (id, text) => { document.getElementById(id).textContent = text; };
  const list = (id, values) => {
    document.getElementById(id).replaceChildren(...values.map((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    }));
  };
  setText("pace-interpretation", review.pace.label + (review.pace.coverageNote ? " — " + review.pace.coverageNote : ""));
  const coverage = review.recognitionCoverage;
  const coverageLabel = coverage.reliability[0].toUpperCase() + coverage.reliability.slice(1);
  setText("recognition-coverage", "Recognition coverage: " +
    (coverage.percent === null ? "Unavailable" : (Math.floor(coverage.percent * 10) / 10).toFixed(1) + "%") +
    " — " + coverageLabel + ". Speech recognition availability as a percentage of session time.");
  if (coverage.reliability === "insufficient") {
    setText("filler-rate", "Filler rate: not shown because recognition coverage is insufficient.");
  } else if (review.fillers.coverageNote) {
    document.getElementById("filler-rate").textContent += " — " + review.fillers.coverageNote;
  }
  setText("pause-count", review.pauses.count === null ? "Unavailable" : String(review.pauses.count));
  setText("pause-longest", review.pauses.longestSeconds === null ? "Unavailable" : review.pauses.longestSeconds.toFixed(1) + " seconds");
  setText("pause-feedback", review.pauses.feedback);
  document.getElementById("pause-feedback").hidden = review.improvements.some(item => item.heading === "Pauses");
  setText("camera-facing", review.camera.percent === null ? "Unavailable or insufficient observations" :
    review.camera.percent.toFixed(0) + "% when your face was detected" + (review.camera.reliable ? "" : " (incomplete coverage)"));
  setText("cue-total", "Total live cues: " + review.cues.total);
  list("cue-breakdown", ["PAUSE", "LOOK_UP", "SLOW_DOWN"].map(key => key.replaceAll("_", " ") + ": " + review.cues[key]));
  list("review-strengths", review.strengths);
  setText("strengths-note", review.strengths.length ? "" : "There wasn’t enough reliable data to identify a clear strength in this session.");
  document.getElementById("review-improvements").replaceChildren(...review.improvements.map(({heading, message}) => {
    const item = document.createElement("li");
    const title = document.createElement("h4");
    title.textContent = heading;
    const text = document.createElement("p");
    text.textContent = message;
    item.append(title, text);
    return item;
  }));
  document.getElementById("review-improvements").hidden = review.improvements.length === 0;
  setText("review-improvement", review.improvementMessage);
  document.getElementById("review-improvement").hidden = review.improvements.length > 0;
  list("review-quality", review.dataQuality);
  document.getElementById("quality-section").hidden = false;
}

/** Render only the ended session's filler feedback, never a live counter. */
function showFillerSummary() {
  document.getElementById("filler-total").textContent = `Total: ${fillerAnalysis.totalFillers}`;
  const breakdown = document.getElementById("filler-breakdown");
  const entries = Object.entries(fillerAnalysis.counts).filter(([, count]) => count > 0);
  breakdown.replaceChildren(...entries.map(([name, count]) => {
    const item = document.createElement("li");
    item.textContent = `${name}: ${count}`;
    return item;
  }));
  breakdown.hidden = entries.length === 0;
  document.getElementById("filler-message").textContent = fillerAnalysis.totalFillers === 0
    ? "No common filler words detected." : "These speech patterns may be useful to review in context.";
  document.getElementById("filler-message").hidden = fillerAnalysis.totalFillers > 0;
  document.getElementById("filler-rate").textContent = fillerAnalysis.ratePer100Words === null
    ? "Filler rate: not shown for fewer than 20 recognised words."
    : `Filler rate: ${fillerAnalysis.ratePer100Words.toFixed(1)} per 100 words`;
}

/** Update controls and announce status without repeatedly announcing live text. */
function setStatus(label, message) {
  statusLabel.textContent = label;
  statusMessage.textContent = message;
  listenButton.disabled = !Recognition;
  listenButton.textContent = sessionActive ? "STOP LISTENING" : "START LISTENING";
  clearButton.disabled = sessionActive || !transcriptText;
  document.getElementById("setup-guidance").hidden = sessionActive || !sessionSummary.hidden;
  document.getElementById("coach-panel").hidden = !sessionActive && !sessionSummary.hidden;
  document.getElementById("transcript-section").hidden = sessionActive || !transcriptText;
}

/** @param {string} text - Current complete recognition text. */
function showTranscript(text) {
  if (text !== transcriptText) fillerAnalysis = analyseFillers(text);
  transcriptText = text;
  transcript.textContent = text || "Your speech will appear here.";
  transcript.dataset.empty = String(!text);
  clearButton.disabled = sessionActive || !text;
}

/** Ignore all subsequent callbacks before releasing microphone capture. */
function releaseRecognition() {
  clearTimeout(startTimer);
  startTimer = null;
  recognitionListening = false;
  measurements.recognition(false, nowSeconds());
  const recognition = activeRecognition;
  activeRecognition = null;
  if (recognition) {
    try {
      // Abort preserves the displayed text and discards pending recognition results.
      recognition.abort();
    } catch {
      // An already ended recognition session has nothing left to cancel.
    }
  }
}

/** End the presentation and invalidate pending recovery before releasing capture. */
function endSession(interrupted = false) {
  sessionActive = false;
  voiceAction(() => spokenCues.stopSession());
  measurements.recognitionInterrupted ||= interrupted;
  measurements.stopRecognitionCoverage(nowSeconds());
  const finished = finishPace(interrupted);
  document.getElementById("live-pace").hidden = true;
  camera.stop();
  currentVisionState = "unavailable";
  showVisionDiagnostics();
  cameraObservation = {state: "unavailable", observedAt: null};
  cameraStatus.textContent = "Camera unavailable";
  cameraPreview.hidden = true;
  microphone.stop();
  pauses.reset();
  pauseMonitoring = false;
  audioStatus.textContent = "Pause monitoring stopped";
  resetCoach();
  clearTimeout(restartTimer);
  restartTimer = null;
  releaseRecognition();
  return finished;
}

/** Allow three delayed recovery attempts; only one attempt can be pending. */
function scheduleRestart() {
  if (!sessionActive || activeRecognition || restartTimer !== null) return;
  if (restartAttempts >= RESTART_DELAYS.length) {
    showRecognitionError("restart-failed");
    return;
  }
  const delay = RESTART_DELAYS[restartAttempts++];
  updatePace();
  setStatus("Reconnecting", "Speech recognition ended. Reconnecting automatically; your transcript is preserved. You can still select Stop listening.");
  const timer = setTimeout(() => {
    if (!sessionActive || restartTimer !== timer) return;
    restartTimer = null;
    startRecognition(true);
  }, delay);
  restartTimer = timer;
}

/** @param {string} code - Browser recognition error identifier. */
function showRecognitionError(code) {
  endSession(true);
  if (code === "not-allowed" || code === "service-not-allowed") {
    setStatus("Microphone permission denied", "Allow microphone access in Chrome’s site settings and Windows microphone privacy settings, then try again. Your browser or organisation may also restrict speech recognition.");
    return;
  }

  const messages = {
    "restart-failed": "Speech recognition could not stay connected after three restart attempts. Your transcript is preserved. Check your connection and microphone, then select Start listening for a new session.",
    "restart-timeout": "Speech recognition did not reconnect in time. Your transcript is preserved. Check your connection and microphone, then try starting again.",
    "audio-capture": "Chrome could not access a microphone. Check that your laptop’s built-in microphone is enabled and selected in Chrome settings, then try again.",
    "network": "Speech recognition could not connect. Check your internet connection, then try again.",
    "no-speech": "No speech was detected. Check your microphone, speak closer to the laptop, and try again.",
    "language-not-supported": "English speech recognition is unavailable in this browser. Try an updated desktop Chrome installation.",
  };
  setStatus("Recognition error", messages[code] || "Speech recognition stopped because of a problem. Try starting again. If it continues, check Chrome’s microphone settings and reload this page.");
}

function startListening() {
  if (!Recognition || sessionActive || activeRecognition) return;

  astra.reset();
  sessionActive = true;
  document.getElementById("voice-delay").textContent = "No spoken cue measured this session.";
  voiceAction(() => spokenCues.startSession());
  measurements.reset(nowSeconds());
  for (const state of Object.keys(visionCounts)) visionCounts[state] = 0;
  lastDiagnosticAt = null;
  currentVisionState = "unavailable";
  notVisibleCues = 0;
  showVisionDiagnostics();
  document.getElementById("live-pace").hidden = true;
  pauses.reset();
  pauseMonitoring = false;
  audioStatus.textContent = "Starting pause monitoring. Allow microphone access if prompted.";
  microphone.start();
  resetCoach();
  restartAttempts = 0;
  sessionPhrases = [];
  pace.reset(nowSeconds());
  sessionSummary.hidden = true;
  paceValue.textContent = "Waiting for speech...";
  cameraObservation = {state: "unavailable", observedAt: null};
  cameraStatus.textContent = "Camera unavailable";
  cameraPreview.hidden = !SHOW_VISION_DIAGNOSTICS;
  camera.start();
  startRecognition(false);
}

/** Start a browser recogniser without resetting an existing presentation. */
function startRecognition(restarting) {
  if (!sessionActive || activeRecognition) return;
  const previousPhrases = sessionPhrases.slice();
  let startedAt = null;

  try {
    const recognition = new Recognition();
    activeRecognition = recognition;
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    if (!restarting) {
      setStatus("Starting", "Allow microphone access if prompted. Select Stop listening to cancel.");
    }

    recognition.onstart = () => {
      if (activeRecognition !== recognition) return;
      clearTimeout(startTimer);
      startTimer = null;
      startedAt = nowSeconds();
      recognitionListening = true;
      if (paceTimer === null) {
        showTranscript("");
        pace.reset(nowSeconds());
        measurements.startedAt = nowSeconds();
        paceTimer = setInterval(updatePace, 1000);
      }
      measurements.recognition(true, nowSeconds());
      updatePace();
      setStatus("Listening", "Speak naturally. Select Stop listening when you finish.");
    };

    recognition.onresult = (event) => {
      if (activeRecognition !== recognition) return;
      // Results contain final phrases followed by the current interim phrases.
      // Rebuild this snapshot instead of appending revised words a second time.
      const phrases = Array.from(event.results, (result) => result[0].transcript.trim());
      // Chrome restarts result indexes at zero for each recogniser. Keep the
      // earlier snapshot as a prefix so its word positions and times survive.
      sessionPhrases = previousPhrases.concat(phrases);
      showTranscript(sessionPhrases.filter(Boolean).join(" "));
      pace.observe(sessionPhrases, nowSeconds());
      updatePace();
    };

    recognition.onerror = (event) => {
      if (activeRecognition !== recognition) return;
      showRecognitionError(event.error);
    };

    recognition.onend = () => {
      if (activeRecognition !== recognition) return;
      clearTimeout(startTimer);
      startTimer = null;
      recognitionListening = false;
      measurements.recognitionInterrupted = true;
      measurements.recognition(false, nowSeconds());
      activeRecognition = null;
      // An onstart followed immediately by onend is not a successful recovery.
      if (startedAt !== null && nowSeconds() - startedAt >= STABLE_SECONDS) {
        restartAttempts = 0;
      }
      scheduleRestart();
    };

    if (restarting) {
      startTimer = setTimeout(() => {
        if (activeRecognition === recognition) showRecognitionError("restart-timeout");
      }, 8000);
    }
    recognition.start();
  } catch (error) {
    if (restarting && error.name !== "NotAllowedError") {
      releaseRecognition();
      scheduleRestart();
    } else {
      showRecognitionError(error.name === "NotAllowedError" ? "not-allowed" : "start-failed");
    }
  }
}

listenButton.addEventListener("click", () => {
  if (sessionActive) {
    const finished = endSession();
    if (finished) astra.request(finished.transcript, finished.snapshot, finished.profile);
    setStatus("Stopped", "Your session has ended. Review your feedback below, or select Start listening for a new session.");
  } else {
    startListening();
  }
});

clearButton.addEventListener("click", () => {
  if (sessionActive) return;
  astra.reset();
  showTranscript("");
  sessionSummary.hidden = true;
  setStatus("Idle", "Transcript cleared. Select Start listening to begin.");
  listenButton.focus();
});

window.addEventListener("pagehide", () => {
  astra.reset();
  endSession(true);
});

if (Recognition) {
  setStatus("Idle", "Select Start listening to begin.");
} else {
  setStatus("Speech recognition unavailable", "This browser does not provide speech recognition. Open this localhost page in desktop Chrome.");
}
