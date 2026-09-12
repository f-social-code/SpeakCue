import assert from "node:assert/strict";
import test from "node:test";
import { assessPace, createCoachState } from "../app/coach.mjs";

function runner() {
  let state = createCoachState();
  return (now, overrides = {}) => {
    const result = assessPace({active: true, state: "ready", wpm: 210, observedAt: now, ...overrides}, state, now);
    state = result.nextState;
    return result;
  };
}

function sustained(step, start = 0, end = 8) {
  let result;
  for (let time = start; time <= end; time++) result = step(time);
  return result;
}

test("normal pace, including exactly 180 WPM, stays quiet", () => {
  for (const wpm of [0, 150, 180]) {
    const result = runner()(0, {wpm});
    assert.equal(result.decision, "QUIET");
    assert.equal(result.reason, "normal_pace");
  }
});
test("brief fast burst stays quiet", () => {
  const step = runner();
  assert.equal(step(0).decision, "QUIET");
  assert.equal(step(1, {wpm: 160}).decision, "QUIET");
});
test("fast pace for less than eight seconds stays quiet", () => {
  const step = runner();
  for (let time = 0; time <= 7; time++) assert.equal(step(time).reason, "building_persistence");
  assert.equal(step(7.99).decision, "QUIET");
});
test("eight seconds of sustained fast pace produces one cue", () => {
  const result = sustained(runner());
  assert.equal(result.decision, "SLOW_DOWN");
  assert.equal(result.reason, "cue_slow_down");
  assert.equal(result.nextState.cooldownUntil, 38);
  assert.equal(result.nextState.fastSince, null);
});
test("continued fast pace throughout cooldown stays quiet", () => {
  const step = runner();
  sustained(step);
  for (let time = 9; time < 38; time++) {
    const result = step(time);
    assert.equal(result.reason, "cooldown");
    assert.equal(result.nextState.fastSince, null);
  }
});
test("improvement before persistence completes clears the pending episode", () => {
  const step = runner();
  sustained(step, 0, 6);
  assert.equal(step(7, {wpm: 170}).nextState.fastSince, null);
  assert.equal(sustained(step, 8, 15).decision, "QUIET");
  assert.equal(step(16).decision, "SLOW_DOWN");
});
test("improvement after a cue stays quiet and preserves cooldown", () => {
  const step = runner();
  sustained(step);
  const result = step(9, {wpm: 150});
  assert.equal(result.reason, "normal_pace");
  assert.equal(result.nextState.fastSince, null);
  assert.equal(result.nextState.cooldownUntil, 38);
});
test("cooldown expiry requires a new full eight-second episode", () => {
  const step = runner();
  sustained(step);
  sustained(step, 9, 37);
  assert.equal(step(38).reason, "building_persistence");
  assert.equal(sustained(step, 39, 45).decision, "QUIET");
  assert.equal(step(46).decision, "SLOW_DOWN");
});
test("warm-up never contributes to persistence", () => {
  const step = runner();
  for (let time = 0; time < 20; time++) assert.equal(step(time, {state: "measuring"}).reason, "warm_up");
  assert.equal(sustained(step, 20, 27).decision, "QUIET");
  assert.equal(step(28).decision, "SLOW_DOWN");
});
test("stale data clears pending persistence", () => {
  const step = runner();
  sustained(step, 0, 6);
  assert.equal(step(7, {state: "waiting", wpm: null}).reason, "stale_observation");
  assert.equal(step(20, {observedAt: 0}).nextState.fastSince, null);
});
test("invalid observations never cue", () => {
  for (const overrides of [{wpm: NaN}, {wpm: Infinity}, {wpm: -1}, {wpm: "210"},
    {observedAt: null}, {observedAt: 2}, {state: "unknown"}, {active: null}]) {
    const result = runner()(1, overrides);
    assert.equal(result.decision, "QUIET");
    assert.equal(result.reason, "invalid_observation");
  }
  assert.equal(assessPace(null, createCoachState(), 0).decision, "QUIET");
});
test("stopped session stays quiet and resets all state", () => {
  const step = runner();
  sustained(step);
  const result = step(9, {active: false});
  assert.equal(result.reason, "session_stopped");
  assert.deepEqual(result.nextState, createCoachState());
});
test("new session starts without previous persistence or cooldown", () => {
  sustained(runner());
  const step = runner();
  assert.equal(step(10).nextState.fastSince, 10);
  assert.equal(sustained(step, 11, 18).decision, "SLOW_DOWN");
});
test("same-time evaluations cannot build persistence or duplicate cues", () => {
  const step = runner();
  step(0);
  for (let count = 0; count < 20; count++) assert.equal(step(0).decision, "QUIET");
  assert.equal(sustained(step, 1, 8).decision, "SLOW_DOWN");
  for (let count = 0; count < 20; count++) assert.equal(step(8).decision, "QUIET");
});
test("a long evaluation gap starts fresh persistence", () => {
  const step = runner();
  step(0);
  assert.equal(step(8).decision, "QUIET");
  assert.equal(step(8).nextState.fastSince, 8);
});
test("invalid or backwards time stays quiet and clears persistence", () => {
  const step = runner();
  step(10);
  for (const now of [NaN, -1, 9]) {
    const result = step(now);
    assert.equal(result.reason, "invalid_time");
    assert.equal(result.nextState.fastSince, null);
  }
});
test("evaluation does not mutate the supplied state or observation", () => {
  const previous = Object.freeze(createCoachState());
  const observation = Object.freeze({active: true, state: "ready", wpm: 210, observedAt: 0});
  assessPace(observation, previous, 0);
  assert.deepEqual(previous, createCoachState());
});
