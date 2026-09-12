import assert from "node:assert/strict";
import test from "node:test";
import { classifyFacing, trackFacing, VISION_SETTINGS } from "../app/vision.mjs";
import { assessDelivery, createCoachState } from "../app/coach.mjs";

function stepper() {
  let state = createCoachState();
  return (now, visionState = "face_visible_not_facing", options = {}) => {
    const result = assessDelivery({active: options.active ?? true,
      pace: {state: options.warm ? "measuring" : "ready", wpm: options.wpm ?? 150, observedAt: now},
      audio: {state: "speaking", observedAt: now, continuousSeconds: 25, pauseNeeded: options.pause ?? false},
      vision: {active: options.cameraActive ?? true, state: visionState, observedAt: options.observedAt ?? now},
    }, state, now);
    state = result.nextState;
    return result;
  };
}

test("facing camera stays quiet", () => {
  const step = stepper();
  for (let now = 0; now < 10; now++) assert.equal(step(now, "face_visible_and_facing").decision, "QUIET");
});
test("brief look-away and less than six seconds stay quiet", () => {
  const step = stepper();
  for (let now = 0; now < 6; now++) assert.equal(step(now).decision, "QUIET");
  assert.equal(step(5.99).decision, "QUIET");
});
test("six seconds looking away gives LOOK_UP and shared cooldown", () => {
  const step = stepper();
  for (let now = 0; now < 6; now++) step(now);
  const result = step(6);
  assert.equal(result.decision, "LOOK_UP");
  assert.equal(result.reason, "cue_look_up");
  assert.equal(result.nextState.cooldownUntil, 36);
});
test("looking back clears pending persistence", () => {
  const step = stepper();
  for (let now = 0; now < 5; now++) step(now);
  assert.equal(step(5, "face_visible_and_facing").nextState.lookAwaySince, null);
  for (let now = 6; now < 12; now++) assert.equal(step(now).decision, "QUIET");
  assert.equal(step(12).decision, "LOOK_UP");
});
test("no repeated LOOK_UP during cooldown and fresh persistence afterwards", () => {
  const step = stepper();
  for (let now = 0; now <= 6; now++) step(now);
  for (let now = 7; now < 42; now++) assert.equal(step(now).decision, "QUIET");
  assert.equal(step(42).decision, "LOOK_UP");
});
test("PAUSE wins over LOOK_UP", () => {
  const step = stepper();
  for (let now = 0; now < 6; now++) step(now);
  assert.equal(step(6, "face_visible_not_facing", {pause: true}).decision, "PAUSE");
});
test("LOOK_UP wins over SLOW_DOWN and PAUSE wins when all three qualify", () => {
  for (const pause of [false, true]) {
    const step = stepper();
    for (let now = 0; now < 8; now++) step(now, now < 2 ? "face_visible_and_facing" : "face_visible_not_facing", {wpm: 210});
    assert.equal(step(8, "face_visible_not_facing", {wpm: 210, pause}).decision, pause ? "PAUSE" : "LOOK_UP");
  }
});
test("brief no face and under six seconds stay quiet; six seconds cues", () => {
  const step = stepper();
  for (let now = 0; now < 6; now++) assert.equal(step(now, "no_face").decision, "QUIET");
  assert.equal(step(5.99, "no_face").decision, "QUIET");
  assert.equal(step(6, "no_face").decision, "LOOK_UP");
  for (let now = 7; now < 42; now++) assert.equal(step(now, "no_face").decision, "QUIET");
  assert.equal(step(42, "no_face").decision, "LOOK_UP");
});
test("either visible state clears no-face persistence without combining episodes", () => {
  for (const visible of ["face_visible_and_facing", "face_visible_not_facing"]) {
    const step = stepper();
    for (let now = 0; now < 5; now++) step(now, "no_face");
    assert.equal(step(5, visible).nextState.notVisibleSince, null);
    assert.equal(step(6, "no_face").nextState.notVisibleSince, 6);
  }
});
test("unavailable, explicit stale, old frames, inactive camera and warmup cannot build no-face episodes", () => {
  for (const [state, options] of [["unavailable", {}], ["stale", {}],
    ["no_face", {observedAt: 0}], ["no_face", {cameraActive: false}], ["no_face", {warm: true}]]) {
    const step = stepper();
    for (let now = 1; now <= 10; now++) assert.equal(step(now, state, options).decision, "QUIET");
    assert.equal(step(11, "no_face").nextState.notVisibleSince, 11);
  }
});
test("PAUSE retains priority over sustained no face", () => {
  const step = stepper();
  for (let now = 0; now < 6; now++) step(now, "no_face");
  assert.equal(step(6, "no_face", {pause: true}).decision, "PAUSE");
});
test("manual Stop and new session reset no-face state", () => {
  const step = stepper();
  step(0, "no_face");
  assert.deepEqual(step(1, "no_face", {active: false}).nextState, createCoachState());
  assert.equal(step(2, "no_face").nextState.notVisibleSince, 2);
  assert.equal(stepper()(10, "no_face").nextState.notVisibleSince, 10);
});
test("unavailable and stale camera observations clear look-away evidence", () => {
  for (const visionState of ["unavailable", "face_visible_not_facing"]) {
    const step = stepper();
    for (let now = 0; now < 6; now++) step(now);
    const result = step(6, visionState, {observedAt: 3});
    assert.equal(result.decision, "QUIET");
    assert.equal(result.nextState.lookAwaySince, null);
  }
});
test("warm-up never builds look-away persistence", () => {
  const step = stepper();
  for (let now = 0; now < 20; now++) step(now, "face_visible_not_facing", {warm: true});
  for (let now = 20; now < 26; now++) assert.equal(step(now).decision, "QUIET");
  assert.equal(step(26).decision, "LOOK_UP");
});
test("Stop and a fresh session clear look-away state", () => {
  const step = stepper();
  for (let now = 0; now <= 6; now++) step(now);
  assert.deepEqual(step(7, "face_visible_not_facing", {active: false}).nextState, createCoachState());
  assert.equal(stepper()(8).nextState.lookAwaySince, 8);
});
test("duplicate frames cannot establish persistence; missing frames break it", () => {
  const step = stepper();
  step(0);
  for (let now = 1; now <= 6; now++) assert.equal(step(now, "face_visible_not_facing", {observedAt: 0}).decision, "QUIET");
  assert.equal(step(7).nextState.lookAwaySince, 7);
});
test("geometry classification handles facing, turning, missing and invalid data", () => {
  const matrix = (degrees) => {
    const angle = degrees * Math.PI / 180;
    return {faceLandmarks: [[]], facialTransformationMatrixes: [{rows: 4, columns: 4,
      data: [Math.cos(angle), 0, -Math.sin(angle), 0, 0, 1, 0, 0, Math.sin(angle), 0, Math.cos(angle), 0, 0, 0, 0, 1]}]};
  };
  assert.equal(classifyFacing(matrix(0)), "face_visible_and_facing");
  assert.equal(classifyFacing(matrix(45)), "face_visible_not_facing");
  assert.equal(classifyFacing(matrix(-45)), "face_visible_not_facing");
  assert.equal(classifyFacing({faceLandmarks: []}), "no_face");
  assert.equal(classifyFacing({faceLandmarks: [[], []]}), "unavailable");
  assert.equal(classifyFacing({faceLandmarks: [[]]}), "unavailable");
});
