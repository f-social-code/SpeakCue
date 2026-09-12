import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { PaceTracker } from "../app/pace.mjs";
import { assessDelivery, createCoachState } from "../app/coach.mjs";
import { PauseDetector } from "../app/pauses.mjs";
import { analyseFillers } from "../app/fillers.mjs";
import { VISION_SETTINGS } from "../app/vision.mjs";
import { SessionMeasurements } from "../app/session-measurements.mjs";
import { createReview } from "../app/review.mjs";
import { formatDuration } from "../app/format-duration.mjs";

// Supply browser boundaries explicitly; these tests never open a microphone.
const source = readFileSync(new URL("../app/app.js", import.meta.url), "utf8")
  .replace('import { PaceTracker } from "./pace.mjs";', "")
  .replace('import { assessDelivery, createCoachState } from "./coach.mjs";', "")
  .replace('import { PauseDetector } from "./pauses.mjs";', "")
  .replace('import { MicrophoneMonitor } from "./audio-input.mjs";', "")
  .replace('import { analyseFillers } from "./fillers.mjs";', "")
  .replace('import { CameraMonitor } from "./camera-input.mjs";', "")
  .replace('import { VISION_SETTINGS } from "./vision.mjs";', "")
  .replace('import { SessionMeasurements } from "./session-measurements.mjs";', "")
  .replace('import { createReview } from "./review.mjs";', "")
  .replace('import { AstraReview } from "./astra-review.mjs";', "")
  .replace('import { formatDuration } from "./format-duration.mjs";', "")
  .replace('import { SpokenCues } from "./spoken-cues.mjs";', "");

function createApp(supported = true, diagnostics = false) {
  let time = 0;
  let nextTimer = 0;
  const timers = new Map();
  const timeouts = new Map();
  const failures = {start: false};
  const elements = new Map();
  const sessions = [];
  const astra = {requests: [], resets: 0};
  const voice = {cues: [], cancels: 0, starts: 0, stops: 0, enabled: false, fail: false};
  class SpokenCues {
    setEnabled(enabled) { voice.enabled = enabled; }
    startSession() { voice.starts++; }
    stopSession() { voice.stops++; }
    cancelCue() { voice.cancels++; }
    cue(event) {
      voice.cues.push({...event, displayed: element("coach-cue").textContent});
      if (voice.fail) throw new Error("Synthetic voice failure");
    }
  }
  class AstraReview {
    reset() { astra.resets++; }
    request(...args) { astra.requests.push(args); }
  }
  const audio = {level: 0, active: false, starts: 0, stops: 0, onLevel: null, onUnavailable: null};
  const camera = {state: "face_visible_and_facing", active: false, starts: 0, stops: 0, onObservation: null};
  class CameraMonitor {
    constructor(video, onObservation) { camera.onObservation = onObservation; }
    start() { camera.active = true; camera.starts++; }
    stop() { camera.active = false; camera.stops++; }
  }
  class MicrophoneMonitor {
    constructor(onLevel, onUnavailable) { audio.onLevel = onLevel; audio.onUnavailable = onUnavailable; }
    start() { audio.active = true; audio.starts++; audio.onLevel(audio.level); }
    stop() { audio.active = false; audio.stops++; }
  }
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        textContent: "", dataset: {}, hidden: true, handlers: {},
        addEventListener(type, handler) { this.handlers[type] = handler; },
        focus() {},
        replaceChildren(...children) { this.children = children; },
      });
    }
    return elements.get(id);
  };
  class Recognition {
    constructor() { sessions.push(this); }
    start() { if (failures.start) throw new Error("Simulated start failure"); }
    abort() { this.aborted = true; }
  }
  const appSource = diagnostics
    ? source.replace("const SHOW_VISION_DIAGNOSTICS = false;", "const SHOW_VISION_DIAGNOSTICS = true;")
    : source;
  vm.runInNewContext(appSource, {
    PaceTracker, SessionMeasurements, createReview, AstraReview, formatDuration, SpokenCues,
    assessDelivery, createCoachState, PauseDetector, MicrophoneMonitor, analyseFillers, CameraMonitor, VISION_SETTINGS,
    window: {webkitSpeechRecognition: supported ? Recognition : undefined, addEventListener() {}},
    document: {getElementById: element, createElement: () => ({textContent: "", append(...children) { this.children = children; }})},
    performance: {now: () => time * 1000},
    setInterval(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(callback, delay) {
      timeouts.set(++nextTimer, {callback, at: time + delay / 1000});
      return nextTimer;
    },
    clearTimeout(id) { timeouts.delete(id); },
  });
  return {
    element, sessions, timers, timeouts, failures, audio, camera, astra, voice,
    click() { element("listen-button").handlers.click(); },
    advance(seconds) {
      while (true) {
        const next = [...timeouts].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > seconds) break;
        time = next[1].at;
        if (audio.active) audio.onLevel(audio.level);
        if (camera.active) camera.onObservation({state: camera.state, observedAt: time, active: true});
        timeouts.delete(next[0]);
        next[1].callback();
      }
      time = seconds;
      if (audio.active) audio.onLevel(audio.level);
      if (camera.active) camera.onObservation({state: camera.state, observedAt: time, active: true});
      for (const callback of timers.values()) callback();
    },
    words(count) {
      sessions.at(-1).onresult({results: [[{transcript: Array(count).fill("word").join(" ")}]]});
    },
  };
}

test("timer lowers live pace during silence and replaces stale numbers", () => {
  const app = createApp();
  app.click();
  app.sessions[0].onstart();
  assert.equal(app.element("pace-value").textContent, "Measuring...");
  app.advance(1);
  app.words(30);
  app.advance(10);
  app.words(60);
  app.advance(20);
  assert.equal(app.element("pace-value").textContent, "180 WPM");
  app.advance(22);
  assert.equal(app.element("pace-value").textContent, "90 WPM");
  app.advance(30);
  assert.equal(app.element("pace-value").textContent, "Waiting for speech...");
});

test("Stop shows summary, clears timer and rejects late callbacks; restart resets", () => {
  const app = createApp();
  app.click();
  const old = app.sessions[0];
  old.onstart();
  app.advance(1);
  app.words(60);
  app.advance(20);
  app.click();
  assert.equal(app.element("session-summary").hidden, false);
  assert.equal(app.element("session-duration").textContent, "20 sec");
  assert.equal(app.element("average-pace").textContent, "180 WPM");
  assert.equal(app.element("total-words").textContent, "60");
  assert.equal(app.timers.size, 0);
  assert.equal(old.aborted, true);
  old.onstart();
  old.onerror({error: "network"});
  old.onend();
  assert.equal(app.element("status-label").textContent, "Stopped");
  app.click();
  assert.equal(app.element("session-summary").hidden, true);
  app.advance(25);
  app.sessions[1].onstart();
  old.onresult({results: [[{transcript: "late old words"}]]});
  app.advance(26);
  app.words(2);
  app.advance(30);
  app.click();
  assert.equal(app.element("session-duration").textContent, "5 sec");
  assert.equal(app.element("total-words").textContent, "2");
});

test("explicit recognition errors stop safely without automatic recovery", () => {
  for (const code of ["network", "not-allowed"]) {
    const app = createApp();
    app.click();
    app.sessions[0].onstart();
    app.advance(1);
    app.words(60);
    app.advance(20);
    app.sessions[0].onerror({error: code});
    app.sessions[0].onend();
    assert.equal(app.timers.size, 0);
    assert.equal(app.element("pace-value").textContent, "Waiting for speech...");
    assert.match(app.element("summary-note").textContent, /interrupted/);
    assert.equal(app.timeouts.size, 0);
  }
});

test("normal end schedules exactly one delayed restart while presentation remains active", () => {
  const app = createApp();
  app.click();
  const old = app.sessions[0];
  old.onstart();
  app.advance(99);
  old.onend();
  old.onend();
  assert.equal(app.element("status-label").textContent, "Reconnecting");
  assert.equal(app.element("listen-button").textContent, "STOP LISTENING");
  assert.equal(app.element("session-summary").hidden, true);
  assert.equal(app.timers.size, 1);
  assert.equal(app.timeouts.size, 1);
  app.advance(99.4);
  assert.equal(app.sessions.length, 1);
  app.advance(99.5);
  assert.equal(app.sessions.length, 2);
});

test("successful recovery preserves transcript, word timestamps and session duration", () => {
  const app = createApp();
  app.click();
  app.sessions[0].onstart();
  app.advance(1);
  app.words(60);
  app.advance(20);
  const old = app.sessions[0];
  old.onend();
  app.advance(20.5);
  app.sessions[1].onstart();
  assert.equal(app.element("pace-value").textContent, "180 WPM");
  app.advance(22);
  app.words(10);
  app.words(10);
  old.onresult({results: [[{transcript: "ignored old words"}]]});
  old.onstart();
  old.onerror({error: "network"});
  old.onend();
  assert.equal(app.element("status-label").textContent, "Listening");
  assert.equal(app.element("pace-value").textContent, "30 WPM");
  assert.equal(app.element("transcript").textContent.split(" ").length, 70);
  assert.equal(app.timers.size, 1);
  app.advance(30);
  app.click();
  assert.equal(app.element("session-duration").textContent, "30 sec");
  assert.equal(app.element("total-words").textContent, "70");
  assert.equal(app.element("average-pace").textContent, "140 WPM");
});

test("Stop cancels delayed restart and even a previously queued timer callback", () => {
  const app = createApp();
  app.click();
  const old = app.sessions[0];
  old.onstart();
  old.onend();
  const queued = [...app.timeouts.values()][0].callback;
  app.click();
  queued();
  old.onend();
  app.advance(10);
  assert.equal(app.sessions.length, 1);
  assert.equal(app.timeouts.size, 0);
  assert.equal(app.element("status-label").textContent, "Stopped");
  app.click();
  queued();
  assert.equal(app.sessions.length, 2);
});

test("Stop during a pending automatic start rejects its late callbacks", () => {
  const app = createApp();
  app.click();
  app.sessions[0].onstart();
  app.sessions[0].onend();
  app.advance(0.5);
  const pending = app.sessions[1];
  app.click();
  pending.onstart();
  pending.onend();
  app.advance(20);
  assert.equal(pending.aborted, true);
  assert.equal(app.sessions.length, 2);
  assert.equal(app.timers.size, 0);
  assert.equal(app.timeouts.size, 0);
});

test("three failed start attempts stop safely with bounded delays", () => {
  const app = createApp();
  app.click();
  app.sessions[0].onstart();
  app.failures.start = true;
  app.sessions[0].onend();
  app.advance(0.5);
  assert.equal(app.sessions.length, 2);
  app.advance(1.5);
  assert.equal(app.sessions.length, 3);
  app.advance(3.5);
  assert.equal(app.sessions.length, 4);
  assert.equal(app.element("status-label").textContent, "Recognition error");
  assert.match(app.element("status-message").textContent, /three restart attempts/);
  assert.equal(app.timers.size, 0);
  assert.equal(app.timeouts.size, 0);
  app.advance(100);
  assert.equal(app.sessions.length, 4);
});

test("rapid successful starts followed by ends cannot bypass retry limit", () => {
  const app = createApp();
  app.click();
  app.sessions[0].onstart();
  app.sessions[0].onend();
  for (const time of [0.5, 1.5, 3.5]) {
    app.advance(time);
    app.sessions.at(-1).onstart();
    app.sessions.at(-1).onend();
  }
  assert.equal(app.sessions.length, 4);
  assert.equal(app.element("status-label").textContent, "Recognition error");
  assert.equal(app.timeouts.size, 0);
});

test("stable recovery restores retry allowance for a later normal end", () => {
  const app = createApp();
  app.click();
  app.sessions[0].onstart();
  app.sessions[0].onend();
  app.advance(0.5);
  app.sessions[1].onstart();
  app.advance(11);
  app.sessions[1].onend();
  app.advance(11.5);
  assert.equal(app.sessions.length, 3);
});

test("automatic start that never responds times out safely", () => {
  const app = createApp();
  app.click();
  app.sessions[0].onstart();
  app.sessions[0].onend();
  app.advance(8.5);
  assert.equal(app.element("status-label").textContent, "Recognition error");
  assert.match(app.element("status-message").textContent, /did not reconnect in time/);
  assert.equal(app.sessions[1].aborted, true);
  assert.equal(app.timeouts.size, 0);
  assert.equal(app.timers.size, 0);
});

test("permission denial and unsupported recognition do not create a pace session", () => {
  const unavailable = createApp(false);
  assert.equal(unavailable.element("listen-button").disabled, true);
  assert.equal(unavailable.timers.size, 0);
  const app = createApp();
  app.click();
  app.sessions[0].onerror({error: "not-allowed"});
  assert.equal(app.element("status-label").textContent, "Microphone permission denied");
  assert.equal(app.element("session-summary").hidden, true);
  assert.equal(app.timers.size, 0);
});

function speakFast(app, start, end, offset = 0) {
  for (let time = start; time <= end; time++) {
    app.advance(time);
    app.words((time - offset) * 4);
  }
}

test("live cue appears after persistence, lasts three seconds and respects cooldown", () => {
  const app = createApp();
  app.click();
  app.sessions[0].onstart();
  speakFast(app, 1, 27);
  assert.equal(app.element("coach-cue").textContent, "Coach standing by");
  speakFast(app, 28, 28);
  assert.equal(app.element("coach-cue").textContent, "SLOW DOWN");
  speakFast(app, 29, 30);
  assert.equal(app.element("coach-cue").textContent, "SLOW DOWN");
  speakFast(app, 31, 65);
  assert.equal(app.element("coach-cue").textContent, "Coach standing by");
  speakFast(app, 66, 66);
  assert.equal(app.element("coach-cue").textContent, "SLOW DOWN");
});

test("Stop hides cue, cancels its timer and a new session has no old cooldown", () => {
  const app = createApp();
  app.click();
  app.sessions[0].onstart();
  speakFast(app, 1, 28);
  const oldCueTimer = [...app.timeouts.values()][0].callback;
  app.click();
  assert.equal(app.element("coach-cue").textContent, "Coach standing by");
  assert.equal(app.timeouts.size, 0);
  app.click();
  app.sessions[1].onstart();
  speakFast(app, 29, 56, 28);
  assert.equal(app.element("coach-cue").textContent, "SLOW DOWN");
  oldCueTimer();
  assert.equal(app.element("coach-cue").textContent, "SLOW DOWN");
});

test("recognition recovery hides an active cue while keeping its cooldown", () => {
  const app = createApp();
  app.click();
  app.sessions[0].onstart();
  speakFast(app, 1, 28);
  app.sessions[0].onend();
  assert.equal(app.element("coach-cue").textContent, "Coach standing by");
  app.advance(28.5);
  app.sessions[1].onstart();
  speakFast(app, 29, 57, 28);
  assert.equal(app.element("coach-cue").textContent, "Coach standing by");
});

test("recognition gap clears pending persistence before recovery", () => {
  const app = createApp();
  app.click();
  app.sessions[0].onstart();
  speakFast(app, 1, 26);
  app.sessions[0].onend();
  app.advance(26.5);
  app.sessions[1].onstart();
  speakFast(app, 27, 34, 26);
  assert.equal(app.element("coach-cue").textContent, "Coach standing by");
  speakFast(app, 35, 35, 26);
  assert.equal(app.element("coach-cue").textContent, "SLOW DOWN");
});

function feedAudio(app, from, through, level = 0.1) {
  app.audio.level = level;
  for (let tick = Math.round(from * 10); tick <= Math.round(through * 10); tick++) app.advance(tick / 10);
}

test("pause history survives recognition restart and produces PAUSE after 25 seconds", () => {
  const app = createApp();
  app.audio.level = 0.1;
  app.click();
  app.sessions[0].onstart();
  feedAudio(app, 0.1, 24);
  assert.equal(app.element("coach-cue").textContent, "Coach standing by");
  app.sessions[0].onend();
  feedAudio(app, 24.1, 24.5);
  app.sessions[1].onstart();
  feedAudio(app, 24.6, 25);
  assert.equal(app.element("coach-cue").textContent, "PAUSE");
  assert.equal(app.audio.starts, 1);
  assert.equal(app.audio.stops, 0);
  feedAudio(app, 25.1, 28.1);
  assert.equal(app.element("coach-cue").textContent, "Coach standing by");
  feedAudio(app, 28.2, 54.9);
  assert.equal(app.element("coach-cue").textContent, "Coach standing by");
});

test("meaningful audio pause clears the issue before a cue is due", () => {
  const app = createApp();
  app.audio.level = 0.1;
  app.click();
  app.sessions[0].onstart();
  feedAudio(app, 0.1, 24);
  feedAudio(app, 24.1, 24.8, 0);
  feedAudio(app, 24.9, 30);
  assert.equal(app.element("coach-cue").textContent, "Coach standing by");
});

test("manual Stop releases audio, clears pause state and new session starts fresh", () => {
  const app = createApp();
  app.audio.level = 0.1;
  app.click();
  app.sessions[0].onstart();
  feedAudio(app, 0.1, 24);
  app.click();
  assert.equal(app.audio.active, false);
  assert.equal(app.audio.stops, 1);
  app.click();
  app.sessions[1].onstart();
  feedAudio(app, 24.1, 48.9);
  assert.equal(app.element("coach-cue").textContent, "Coach standing by");
  feedAudio(app, 49, 49);
  assert.equal(app.element("coach-cue").textContent, "PAUSE");
});

test("missing microphone analysis suppresses coaching and explains how to recover", () => {
  const app = createApp();
  app.click();
  app.sessions[0].onstart();
  app.audio.active = false;
  app.audio.onUnavailable("audio-interrupted");
  speakFast(app, 1, 40);
  assert.equal(app.element("coach-cue").textContent, "Coach standing by");
  assert.match(app.element("audio-status").textContent, /stop and start again/);
});

function recogniseText(app, text) {
  app.sessions.at(-1).onresult({results: [[{transcript: text}]]});
}

test("filler feedback stays hidden live and uses the revised transcript after Stop", () => {
  const app = createApp();
  app.click();
  app.sessions[0].onstart();
  app.advance(1);
  recogniseText(app, "um um um");
  recogniseText(app, "um you know");
  recogniseText(app, "um you know");
  assert.equal(app.element("session-summary").hidden, true);
  assert.equal(app.element("filler-total").textContent, "");
  assert.equal(app.element("coach-cue").textContent, "Coach standing by");
  app.advance(2);
  app.click();
  assert.equal(app.element("filler-total").textContent, "Total: 2");
  assert.deepEqual(app.element("filler-breakdown").children.map((item) => item.textContent), ["um: 1", "you know: 1"]);
  assert.match(app.element("filler-rate").textContent, /not shown for fewer than 20/);
});

test("summary displays the correct filler rate for a sufficient transcript", () => {
  const app = createApp();
  app.click();
  app.sessions[0].onstart();
  app.advance(1);
  recogniseText(app, "um uh " + Array(18).fill("word").join(" "));
  app.click();
  assert.equal(app.element("filler-rate").textContent, "Filler rate: 10.0 per 100 words");
  assert.equal(app.element("total-words").textContent, "20");
});

test("no filler and empty transcripts give neutral feedback safely", () => {
  for (const text of ["", "Today we present our project."]) {
    const app = createApp();
    app.click();
    app.sessions[0].onstart();
    app.advance(1);
    recogniseText(app, text);
    app.click();
    assert.equal(app.element("filler-total").textContent, "Total: 0");
    assert.equal(app.element("filler-message").textContent, "No common filler words detected.");
    assert.equal(app.element("filler-breakdown").hidden, true);
  }
});

test("new session and Clear transcript cannot leave stale filler feedback visible", () => {
  const app = createApp();
  app.click();
  app.sessions[0].onstart();
  app.advance(1);
  recogniseText(app, "um um");
  app.click();
  app.click();
  assert.equal(app.element("session-summary").hidden, true);
  app.sessions[1].onstart();
  app.advance(2);
  recogniseText(app, "welcome everyone");
  app.click();
  assert.equal(app.element("filler-total").textContent, "Total: 0");
  app.element("clear-button").handlers.click();
  assert.equal(app.element("session-summary").hidden, true);
});

test("recognition recovery preserves filler occurrences without duplicate callbacks inflating them", () => {
  const app = createApp();
  app.click();
  app.sessions[0].onstart();
  app.advance(1);
  recogniseText(app, "um");
  app.sessions[0].onend();
  app.advance(1.5);
  app.sessions[1].onstart();
  app.advance(2);
  recogniseText(app, "uh");
  recogniseText(app, "uh");
  app.click();
  assert.equal(app.element("filler-total").textContent, "Total: 2");
});

test("camera starts only on Start; Stop releases it and new session resets persistence", () => {
  const app = createApp();
  assert.equal(app.camera.starts, 0);
  app.click();
  app.sessions[0].onstart();
  app.camera.state = "face_visible_not_facing";
  feedAudio(app, 0.1, 26, 0);
  assert.equal(app.element("coach-cue").textContent, "LOOK UP");
  app.click();
  assert.equal(app.camera.active, false);
  assert.equal(app.element("camera-preview").hidden, true);
  app.camera.onObservation({state: "face_visible_not_facing", observedAt: 26});
  assert.equal(app.element("camera-status").textContent, "Camera unavailable");
  app.click();
  app.sessions[1].onstart();
  feedAudio(app, 26.1, 51.9, 0);
  assert.equal(app.element("coach-cue").textContent, "Coach standing by");
  feedAudio(app, 52, 52, 0);
  assert.equal(app.element("coach-cue").textContent, "LOOK UP");
  assert.equal(app.camera.starts, 2);
});

test("recognition restart preserves camera stream and pending look-away episode", () => {
  const app = createApp();
  app.click();
  app.sessions[0].onstart();
  app.camera.state = "face_visible_not_facing";
  feedAudio(app, 0.1, 24, 0);
  app.sessions[0].onend();
  feedAudio(app, 24.1, 24.5, 0);
  app.sessions[1].onstart();
  feedAudio(app, 24.6, 26, 0);
  assert.equal(app.element("coach-cue").textContent, "LOOK UP");
  assert.equal(app.camera.starts, 1);
  assert.equal(app.camera.stops, 0);
  feedAudio(app, 26.1, 29, 0);
  assert.equal(app.element("coach-cue").textContent, "Coach standing by");
});

test("camera cannot cue while initial recognition start is still pending", () => {
  const app = createApp();
  app.click();
  app.camera.state = "face_visible_not_facing";
  feedAudio(app, 0.1, 30, 0);
  assert.equal(app.element("coach-cue").textContent, "Coach standing by");
});

test("post-session profile counts actual cues and resets on a new presentation", () => {
  const app = createApp();
  app.click(); app.sessions[0].onstart();
  assert.equal(app.element("live-pace").hidden, true);
  app.camera.state = "face_visible_not_facing";
  feedAudio(app, 0.1, 26, 0);
  assert.equal(app.element("session-summary").hidden, true);
  app.click();
  assert.equal(app.element("cue-total").textContent, "Total live cues: 1");
  assert.match(app.element("camera-facing").textContent, /^0%/);
  app.click(); app.sessions[1].onstart();
  app.camera.state = "face_visible_and_facing";
  feedAudio(app, 26.1, 27, 0);
  app.click();
  assert.equal(app.element("cue-total").textContent, "Total live cues: 0");
  assert.match(app.element("camera-facing").textContent, /insufficient/);
});
test("review captures pause totals before Stop resets the detector", () => {
  const app = createApp();
  app.click(); app.sessions[0].onstart();
  feedAudio(app,0.1,5,0.1);
  feedAudio(app,5.1,6,0);
  app.click();
  assert.equal(app.element("pause-count").textContent, "1");
  assert.equal(app.element("pause-longest").textContent, "4.9 seconds");
});
test("automatic recovery is disclosed in final review and totals persist", () => {
  const app = createApp();
  app.click(); app.sessions[0].onstart();
  feedAudio(app,0.1,5,0);
  app.sessions[0].onend(); app.advance(5.5); app.sessions[1].onstart();
  feedAudio(app,5.6,10,0);
  app.click();
  assert.ok(app.element("review-quality").children.some(item => /Recognition was interrupted/.test(item.textContent)));
  assert.equal(app.element("pace-interpretation").textContent, "Not enough reliable data");
});

for (const [startAt,expected,label] of [[0,"100.0%","Reliable"],[18,"82.0%","Partial"],[40,"60.0%","Insufficient"]]) {
  test(`profile renders ${label.toLowerCase()} coverage and filler wording`, () => {
    const app=createApp();app.click();app.advance(startAt);app.sessions[0].onstart();
    app.advance(startAt+1);recogniseText(app,"um " + Array(199).fill("word").join(" "));
    app.advance(100);app.click();
    assert.match(app.element("recognition-coverage").textContent,new RegExp(expected.replace(".","\\.")+" — "+label));
    assert.equal(app.element("quality-section").hidden,false);
    if(label==="Partial") {
      assert.match(app.element("pace-interpretation").textContent,/Partial recognition coverage/);
      assert.match(app.element("filler-rate").textContent,/0.5 per 100 words — Partial/);
    } else if(label==="Insufficient") {
      assert.match(app.element("pace-interpretation").textContent,/Not enough reliable data/);
      assert.match(app.element("filler-rate").textContent,/not shown because recognition coverage is insufficient/);
      assert.equal(app.element("filler-total").textContent,"Total: 1");
    } else assert.equal(app.element("filler-rate").textContent,"Filler rate: 0.5 per 100 words");
  });
}
test("late old recognition events cannot affect coverage during recovery or a new session", () => {
  const app=createApp();app.click();const old=app.sessions[0];old.onstart();
  app.advance(20);old.onend();app.advance(20.5);app.sessions[1].onstart();
  old.onstart();old.onend();old.onerror({error:"network"});
  app.advance(100);app.click();
  assert.match(app.element("recognition-coverage").textContent,/99.5% — Reliable/);
  const saved=app.element("recognition-coverage").textContent;
  app.advance(200);old.onstart();assert.equal(app.element("recognition-coverage").textContent,saved);
  app.click();app.sessions[2].onstart();old.onend();old.onstart();
  app.advance(220);app.click();
  assert.match(app.element("recognition-coverage").textContent,/100.0% — Reliable/);
});

test("review renders heading and sentence items and clears them on a later session", () => {
  const app=createApp();app.click();app.sessions[0].onstart();
  app.advance(1);recogniseText(app,"um " + Array(99).fill("word").join(" "));
  app.advance(40);app.click();
  const list=app.element("review-improvements");
  assert.equal(list.hidden,false);
  assert.equal(list.children[0].children[0].textContent,"Filler words");
  assert.match(list.children[0].children[1].textContent,/review where they appeared/);
  assert.equal(app.element("review-improvement").hidden,true);
  app.click();app.sessions[1].onstart();app.advance(41);recogniseText(app,Array(100).fill("word").join(" "));
  app.advance(80);app.click();
  assert.equal(list.children.length,0);
  assert.equal(list.hidden,true);
  assert.equal(app.element("review-improvement").textContent,"No major delivery issue detected in this session.");
});

test("Astra request occurs only after manual Stop releases capture and shows profile", () => {
  const app=createApp();app.click();app.sessions[0].onstart();
  app.advance(1);recogniseText(app,"hello everyone");
  assert.equal(app.astra.requests.length,0);
  app.sessions[0].onend();app.advance(1.5);app.sessions[1].onstart();
  assert.equal(app.astra.requests.length,0);
  app.advance(10);app.click();
  assert.equal(app.astra.requests.length,1);
  assert.equal(app.astra.requests[0][0],"hello everyone");
  assert.equal(app.audio.active,false);assert.equal(app.camera.active,false);
  assert.equal(app.element("session-summary").hidden,false);
  app.click();assert.equal(app.astra.resets,2);
});
test("automatic recognition failure never launches an Astra request", () => {
  const app=createApp();app.click();app.sessions[0].onstart();
  app.sessions[0].onerror({error:"network"});
  assert.equal(app.astra.requests.length,0);
});

test("sustained no face displays LOOK UP, diagnostics and visibility note; new session resets", () => {
  const app = createApp();
  app.camera.state = "no_face";
  app.click();
  app.sessions[0].onstart();
  for (let now = 1; now <= 26; now++) app.advance(now);
  assert.equal(app.element("coach-cue").textContent, "LOOK UP");
  app.advance(27);
  assert.equal(app.element("coach-cue").textContent, "LOOK UP");
  assert.equal(app.element("vision-no_face").textContent, "27");
  assert.equal(app.element("vision-current").textContent, "Current vision state: no_face");
  app.click();
  assert.equal(app.element("camera-not-visible-note").hidden, false);
  assert.match(app.element("camera-not-visible-note").textContent, /not visible to the camera/);
  assert.match(app.element("camera-facing").textContent, /insufficient/);
  assert.equal(app.element("coach-cue").textContent, "Coach standing by");
  app.click();
  assert.equal(app.element("vision-no_face").textContent, "0");
  app.sessions[1].onstart();
  app.advance(28);
  app.click();
  assert.equal(app.element("camera-not-visible-note").hidden, true);
});

test("missing camera callbacks become stale in diagnostics and cannot cue", () => {
  const app = createApp();
  app.click();
  app.sessions[0].onstart();
  app.advance(20);
  app.camera.active = false;
  app.advance(22);
  assert.equal(app.element("vision-current").textContent, "Current vision state: stale");
  assert.equal(app.element("vision-stale").textContent, "1");
  app.advance(24);
  assert.equal(app.element("vision-stale").textContent, "1");
  assert.equal(app.element("coach-cue").textContent, "Coach standing by");
});

test("approved LOOK_UP displays text before voice and preserves shared cooldown", () => {
  const app = createApp();
  assert.equal(app.element("spoken-cues").value, "off");
  app.element("spoken-cues").value = "on";
  app.element("spoken-cues").handlers.change();
  assert.equal(app.voice.enabled, true);
  app.click(); app.sessions[0].onstart();
  app.camera.state = "no_face";
  for (let now = 1; now <= 26; now++) app.advance(now);
  assert.equal(app.voice.cues.length, 1);
  assert.equal(app.voice.cues[0].type, "LOOK_UP");
  assert.equal(app.voice.cues[0].displayed, "LOOK UP");
  assert.equal(app.voice.cues[0].expiresAt - app.voice.cues[0].at, 3000);
  for (let now = 27; now <= 55; now++) app.advance(now);
  assert.equal(app.voice.cues.length, 1);
  app.advance(56);
  assert.equal(app.voice.cues.length, 1); // Existing rules require fresh persistence after cooldown.
  for (let now = 57; now <= 62; now++) app.advance(now);
  assert.equal(app.voice.cues.length, 2);
});

test("voice failure cannot interrupt visual LOOK_UP, Stop or Astra review", () => {
  const app = createApp(); app.voice.fail = true;
  app.click(); app.sessions[0].onstart(); app.camera.state = "no_face";
  for (let now = 1; now <= 26; now++) app.advance(now);
  assert.equal(app.element("coach-cue").textContent, "LOOK UP");
  assert.match(app.element("voice-status").textContent, /unavailable/);
  app.click();
  assert.equal(app.voice.stops, 1);
  assert.equal(app.astra.requests.length, 1);
  assert.equal(app.element("session-summary").hidden, false);
});

test("looking back withdraws voice with the existing visual cue", () => {
  const app = createApp(); app.click(); app.sessions[0].onstart();
  app.camera.state = "no_face";
  for (let now = 1; now <= 26; now++) app.advance(now);
  const before = app.voice.cancels;
  app.camera.state = "face_visible_and_facing"; app.advance(27);
  assert.equal(app.element("coach-cue").textContent, "Coach standing by");
  assert.equal(app.voice.cancels, before + 1);
});

test("recognition recovery keeps voice in the same presentation", () => {
  const app = createApp(); app.click(); app.sessions[0].onstart();
  app.advance(12); app.sessions[0].onend(); app.advance(12.5);
  app.sessions[1].onstart();
  assert.equal(app.voice.starts, 1);
  assert.equal(app.voice.stops, 0);
  app.click();
  assert.equal(app.voice.stops, 1);
});

test("vision diagnostics and preview stay hidden by default while observations continue", () => {
  const app = createApp();
  assert.equal(app.element("vision-diagnostics").hidden, true);
  const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  assert.match(html, /<details id="vision-diagnostics" hidden>/);
  app.click();
  app.sessions[0].onstart();
  app.camera.state = "no_face";
  feedAudio(app, 0.1, 26, 0);
  assert.equal(app.element("coach-cue").textContent, "LOOK UP");
  assert.equal(app.element("vision-diagnostics").hidden, true);
  assert.equal(app.element("camera-preview").hidden, true);
  app.click();
  assert.equal(app.element("vision-diagnostics").hidden, true);
});

test("live view hides setup and transcript, then reveals the unchanged transcript after Stop", () => {
  const app = createApp();
  assert.equal(app.element("setup-guidance").hidden, false);
  app.click();
  app.sessions[0].onstart();
  recogniseText(app, "UMMMM welcome everyone UHHH");
  assert.equal(app.element("setup-guidance").hidden, true);
  assert.equal(app.element("coach-panel").hidden, false);
  assert.equal(app.element("transcript-section").hidden, true);
  app.sessions[0].onend();
  assert.equal(app.element("transcript-section").hidden, true);
  app.advance(0.5);
  app.sessions[1].onstart();
  app.advance(67.6);
  app.click();
  assert.equal(app.element("session-duration").textContent, "1 min 8 sec");
  assert.equal(app.astra.requests[0][1].duration, 67.6);
  assert.equal(app.astra.requests[0][0], "UMMMM welcome everyone UHHH");
  assert.equal(app.element("transcript").textContent, "UMMMM welcome everyone UHHH");
  assert.equal(app.element("transcript-section").hidden, false);
  assert.equal(app.element("coach-panel").hidden, true);
  assert.equal(app.element("live-pace").hidden, true);
  app.element("clear-button").handlers.click();
  assert.equal(app.element("transcript-section").hidden, true);
  assert.equal(app.element("setup-guidance").hidden, false);
});

test("recognition error reveals captured words and retains recovery guidance", () => {
  const app = createApp();
  app.click();
  app.sessions[0].onstart();
  recogniseText(app, "My original words");
  app.advance(10);
  app.sessions[0].onerror({error: "network"});
  assert.equal(app.element("transcript-section").hidden, false);
  assert.match(app.element("status-message").textContent, /connection/);
  assert.equal(app.astra.requests.length, 0);
});

test("review avoids repeated pause advice but retains incomplete-data warnings", () => {
  const app = createApp();
  app.audio.level = 0.1;
  app.click();
  app.sessions[0].onstart();
  feedAudio(app, 0.1, 26);
  recogniseText(app, "ummm " + Array(59).fill("word").join(" "));
  app.click();
  assert.equal(app.element("pause-feedback").hidden, true);
  assert.equal(app.element("filler-message").hidden, true);
  assert.ok(app.element("review-improvements").children.some(item => item.children[0].textContent === "Pauses"));
  app.click();
  app.sessions[1].onstart();
  app.audio.onUnavailable("audio-interrupted");
  app.advance(27);
  app.click();
  assert.equal(app.element("pause-feedback").hidden, false);
  assert.equal(app.element("pause-feedback").textContent, "Not enough reliable pause data to assess this session.");
  assert.equal(app.element("filler-message").hidden, false);
  assert.ok(app.element("review-quality").children.some(item => /Audio monitoring/.test(item.textContent)));
});

test("empty deterministic strengths use natural conservative wording across sessions", () => {
  const app = createApp();
  for (const wordCount of [0, 2]) {
    app.click(); app.sessions.at(-1).onstart();
    app.words(wordCount); app.advance(wordCount + 1); app.click();
    assert.equal(app.element("review-strengths").children.length, 0);
    assert.equal(app.element("strengths-note").textContent,
      "There wasn’t enough reliable data to identify a clear strength in this session.");
  }
});

test("camera percentage display uses detected-face wording", () => {
  const app = createApp(); app.click(); app.sessions[0].onstart();
  feedAudio(app, 0.1, 26, 0); app.click();
  assert.match(app.element("camera-facing").textContent, /^100% when your face was detected/);
});

for (const [raw, rounded] of [[19.295183138421258, 19], [125.4, 125], [125.5, 126], [125.6, 126], [126.5, 127]]) {
  test(`profile displays ${rounded} WPM while keeping fractional ${raw} pace`, () => {
    const app = createApp(); app.click(); app.sessions[0].onstart();
    app.advance(1); app.words(100);
    const duration = 6000 / raw;
    app.advance(duration); app.click();
    assert.equal(app.element("average-pace").textContent, `${rounded} WPM`);
    const [, snapshot, profile] = app.astra.requests[0];
    const calculated = 100 / duration * 60;
    assert.equal(snapshot.averageWpm, calculated);
    assert.equal(profile.pace.averageWpm, calculated);
    assert.notEqual(snapshot.averageWpm, rounded);
  });
}

test("diagnostics stay hidden before and after Stop, including recognition errors", () => {
  for (const interrupted of [false, true]) {
    const app = createApp();
    assert.equal(app.element("vision-diagnostics").hidden, true);
    app.click(); app.sessions[0].onstart(); app.advance(1);
    assert.equal(app.element("vision-diagnostics").hidden, true);
    if (interrupted) app.sessions[0].onerror({error: "network"}); else app.click();
    assert.equal(app.element("vision-diagnostics").hidden, true);
  }
});

test("developer diagnostics switch still exposes observations before and after Stop", () => {
  const app = createApp(true, true);
  assert.equal(app.element("vision-diagnostics").hidden, false);
  app.click(); app.sessions[0].onstart(); app.advance(1);
  assert.equal(app.element("vision-diagnostics").hidden, false);
  assert.equal(app.element("vision-face_visible_and_facing").textContent, "1");
  app.click();
  assert.equal(app.element("vision-diagnostics").hidden, false);
});
