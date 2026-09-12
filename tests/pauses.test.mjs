import assert from "node:assert/strict";
import test from "node:test";
import { PauseDetector, PAUSE_SETTINGS } from "../app/pauses.mjs";
import { assessDelivery, createCoachState } from "../app/coach.mjs";

function feed(detector, level, from, through) {
  for (let tick = Math.round(from * 10); tick <= Math.round(through * 10); tick++) {
    detector.observe(level, tick / 10);
  }
  return detector.observation(through);
}

test("silence shorter than 0.6 seconds is not a meaningful pause", () => {
  const detector = new PauseDetector();
  feed(detector, 0.1, 0, 1);
  const result = feed(detector, 0, 1.1, 1.6);
  assert.equal(result.pauseCount, 0);
  assert.equal(result.continuousSeconds, 1.6);
});

test("0.6 seconds of silence counts once and clears continuous speech", () => {
  const detector = new PauseDetector();
  feed(detector, 0.1, 0, 1);
  const result = feed(detector, 0, 1.1, 1.7);
  assert.equal(result.pauseCount, 1);
  assert.equal(result.continuousSeconds, 0);
  assert.equal(feed(detector, 0, 1.8, 5).pauseCount, 1);
});

test("continuous speech below 25 seconds is not a candidate; 25 seconds is", () => {
  const detector = new PauseDetector();
  assert.equal(feed(detector, 0.1, 0, 24.9).pauseNeeded, false);
  assert.equal(detector.observe(0.1, 25).pauseNeeded, true);
});

test("meaningful pause clears pending issue and next speech starts fresh", () => {
  const detector = new PauseDetector();
  feed(detector, 0.1, 0, 25);
  const result = feed(detector, 0, 25.1, 25.7);
  assert.equal(result.pauseNeeded, false);
  assert.equal(result.continuousSeconds, 0);
  assert.equal(detector.observe(0.1, 25.8).continuousSeconds, 0);
});

test("initial silence never counts as a presentation pause", () => {
  const detector = new PauseDetector();
  assert.equal(feed(detector, 0, 0, 30).pauseCount, 0);
});

test("missing, invalid and stale samples do not imply speech or silence", () => {
  for (const level of [null, NaN, Infinity, -1]) {
    const detector = new PauseDetector();
    feed(detector, 0.1, 0, 25);
    assert.equal(detector.observe(level, 25.1).state, "unavailable");
    assert.equal(detector.observe(0.1, 25.2).pauseNeeded, false);
  }
  const detector = new PauseDetector();
  feed(detector, 0.1, 0, 25);
  assert.equal(detector.observation(26).state, "unavailable");
  assert.equal(detector.observe(0.1, 26).continuousSeconds, 0);
});

test("reset clears pause history for Stop or a new session", () => {
  const detector = new PauseDetector();
  feed(detector, 0.1, 0, 25);
  feed(detector, 0, 25.1, 26);
  detector.reset();
  assert.equal(detector.observation(27).pauseCount, 0);
  assert.equal(detector.observation(27).state, "unavailable");
  assert.equal(detector.observe(0.1, 27).pauseNeeded, false);
});

test("normal speech with regular meaningful pauses keeps the coach quiet", () => {
  const detector = new PauseDetector();
  let state = createCoachState();
  for (let tick = 0; tick <= 600; tick++) {
    const now = tick / 10;
    const audio = detector.observe(now % 10 < 9 ? 0.1 : 0, now);
    const result = assessDelivery({active: true, pace: {state: "ready", wpm: 150, observedAt: now}, audio}, state, now);
    state = result.nextState;
    assert.equal(result.decision, "QUIET");
  }
  assert.equal(detector.pauseCount, 6);
});

test("demo thresholds can be configured and invalid settings are rejected", () => {
  const detector = new PauseDetector({...PAUSE_SETTINGS, continuousSeconds: 5});
  assert.equal(feed(detector, 0.1, 0, 5).pauseNeeded, true);
  assert.throws(() => new PauseDetector({...PAUSE_SETTINGS, silenceLevel: 0}), RangeError);
});
