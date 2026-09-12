import assert from "node:assert/strict";
import test from "node:test";
import { assessDelivery, createCoachState } from "../app/coach.mjs";

function observation(now, pauseNeeded = false, wpm = 150) {
  return {active: true, pace: {state: "ready", wpm, observedAt: now},
    audio: {state: "speaking", observedAt: now, continuousSeconds: pauseNeeded ? 25 : 10, pauseNeeded}};
}

test("PAUSE starts the shared 30-second cooldown", () => {
  const result = assessDelivery(observation(25, true), createCoachState(), 25);
  assert.equal(result.decision, "PAUSE");
  assert.equal(result.reason, "cue_pause");
  assert.equal(result.nextState.cooldownUntil, 55);
});

test("neither PAUSE nor SLOW DOWN repeats during shared cooldown", () => {
  let state = assessDelivery(observation(25, true), createCoachState(), 25).nextState;
  for (let now = 26; now < 55; now++) {
    const result = assessDelivery(observation(now, true, 210), state, now);
    state = result.nextState;
    assert.equal(result.decision, "QUIET");
    assert.equal(result.reason, "cooldown");
  }
});

test("SLOW DOWN still requires eight seconds when no pause candidate exists", () => {
  let state = createCoachState();
  for (let now = 0; now <= 8; now++) {
    const result = assessDelivery(observation(now, false, 210), state, now);
    state = result.nextState;
    assert.equal(result.decision, now === 8 ? "SLOW_DOWN" : "QUIET");
  }
});

test("PAUSE wins when both cues qualify; priority is configurable", () => {
  let state = createCoachState();
  for (let now = 17; now < 25; now++) state = assessDelivery(observation(now, false, 210), state, now).nextState;
  const both = observation(25, true, 210);
  assert.equal(assessDelivery(both, state, 25).decision, "PAUSE");
  assert.equal(assessDelivery(both, state, 25, ["SLOW_DOWN", "PAUSE"]).decision, "SLOW_DOWN");
});

test("meaningful pause clears candidate; do not tell an already silent speaker to pause", () => {
  const current = observation(26, false);
  current.audio.state = "silent";
  current.audio.continuousSeconds = 0;
  assert.equal(assessDelivery(current, createCoachState(), 26).decision, "QUIET");
});

test("missing, invalid or stale audio suppresses all coaching", () => {
  for (const audio of [null, undefined, {}, {state: "unavailable"},
    {...observation(0).audio, observedAt: NaN}, observation(0, true).audio]) {
    const current = observation(25, true, 210);
    current.audio = audio;
    const result = assessDelivery(current, {fastSince: 17, cooldownUntil: 0, lastEvaluatedAt: 24}, 25);
    assert.equal(result.decision, "QUIET");
    assert.equal(result.nextState.fastSince, null);
  }
});

test("fresh audio can request PAUSE while transcript recognition is reconnecting", () => {
  const current = observation(25, true);
  current.pace = {state: "waiting", wpm: null, observedAt: null};
  assert.equal(assessDelivery(current, createCoachState(), 25).decision, "PAUSE");
});

test("warm-up, Stop and repeated evaluation never produce an extra PAUSE", () => {
  const current = observation(25, true);
  const first = assessDelivery(current, createCoachState(), 25);
  assert.equal(assessDelivery(current, first.nextState, 25).decision, "QUIET");
  current.pace.state = "measuring";
  assert.equal(assessDelivery(current, createCoachState(), 25).decision, "QUIET");
  current.active = false;
  assert.deepEqual(assessDelivery(current, first.nextState, 25).nextState, createCoachState());
});

test("same-time normal pace still clears a pending fast episode", () => {
  const previous = {fastSince: 0, cooldownUntil: 0, lastEvaluatedAt: 6};
  const result = assessDelivery(observation(6, false, 150), previous, 6);
  assert.equal(result.nextState.fastSince, null);
});
