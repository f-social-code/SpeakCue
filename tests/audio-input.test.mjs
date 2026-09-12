import assert from "node:assert/strict";
import test from "node:test";
import { MicrophoneMonitor, rootMeanSquare } from "../app/audio-input.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function setup() {
  const permission = deferred();
  const timers = new Map();
  const levels = [];
  const errors = [];
  const track = {readyState: "live", enabled: true, muted: false, stopped: false,
    handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; },
    stop() { this.stopped = true; this.readyState = "ended"; }};
  const stream = {getTracks: () => [track], getAudioTracks: () => [track]};
  const source = {target: null, disconnected: false,
    connect(target) { this.target = target; }, disconnect() { this.disconnected = true; }};
  const analyser = {fftSize: 0, getFloatTimeDomainData(buffer) { buffer.fill(0.1); }};
  let context;
  let constraints;
  const runtime = {
    navigator: {mediaDevices: {getUserMedia(options) { constraints = options; return permission.promise; }}},
    AudioContext: class {
      constructor() { this.state = "running"; context = this; }
      async resume() {}
      createAnalyser() { return analyser; }
      createMediaStreamSource() { return source; }
      async close() { this.state = "closed"; }
    },
    setInterval(callback, delay) { assert.equal(delay, 50); timers.set(1, callback); return 1; },
    clearInterval(id) { timers.delete(id); },
  };
  const monitor = new MicrophoneMonitor((level) => levels.push(level), (reason) => errors.push(reason), runtime);
  return {monitor, permission, stream, track, source, analyser, timers, levels, errors,
    context: () => context, constraints: () => constraints};
}

test("RMS arithmetic handles waveform samples and rejects invalid data", () => {
  assert.equal(rootMeanSquare([0, 0]), 0);
  assert.equal(rootMeanSquare([0.5, -0.5]), 0.5);
  assert.equal(rootMeanSquare([]), null);
  assert.equal(rootMeanSquare([NaN]), null);
});

test("monitor samples locally with audio-only constraints and releases all resources", async () => {
  const app = setup();
  const starting = app.monitor.start();
  app.permission.resolve(app.stream);
  await starting;
  assert.deepEqual(app.constraints(), {audio: true, video: false});
  assert.equal(app.source.target, app.analyser);
  assert.ok(Math.abs(app.levels[0] - 0.1) < 0.00001);
  const lateSample = [...app.timers.values()][0];
  app.monitor.stop();
  lateSample();
  assert.equal(app.levels.length, 1);
  assert.equal(app.track.stopped, true);
  assert.equal(app.source.disconnected, true);
  assert.equal(app.context().state, "closed");
  assert.equal(app.timers.size, 0);
});

test("Stop before microphone permission resolves releases the late stream", async () => {
  const app = setup();
  const starting = app.monitor.start();
  await Promise.resolve();
  app.monitor.stop();
  app.permission.resolve(app.stream);
  await starting;
  assert.equal(app.track.stopped, true);
  assert.equal(app.context().state, "closed");
  assert.equal(app.levels.length, 0);
  assert.equal(app.errors.length, 0);
});

test("permission rejection produces useful error category and closes context", async () => {
  const app = setup();
  const starting = app.monitor.start();
  await Promise.resolve();
  app.permission.reject(Object.assign(new Error("private browser detail"), {name: "NotAllowedError"}));
  await starting;
  assert.deepEqual(app.errors, ["permission-denied"]);
  assert.equal(app.context().state, "closed");
});

test("muted or ended audio and a suspended context never masquerade as silence", async () => {
  for (const interrupt of [
    (app) => { app.track.muted = true; },
    (app) => { app.track.readyState = "ended"; },
    (app) => { app.context().state = "suspended"; },
  ]) {
    const app = setup();
    const starting = app.monitor.start();
    app.permission.resolve(app.stream);
    await starting;
    interrupt(app);
    [...app.timers.values()][0]();
    assert.deepEqual(app.errors, ["audio-interrupted"]);
    assert.equal(app.levels.length, 1);
    assert.equal(app.track.stopped, true);
  }
});

test("track ended event stops analysis and late events are ignored", async () => {
  const app = setup();
  const starting = app.monitor.start();
  app.permission.resolve(app.stream);
  await starting;
  app.track.handlers.ended();
  app.track.handlers.ended();
  assert.deepEqual(app.errors, ["audio-interrupted"]);
  assert.equal(app.timers.size, 0);
});

test("unsupported browser reports unavailability without requesting audio", async () => {
  const errors = [];
  const monitor = new MicrophoneMonitor(() => assert.fail("unexpected samples"), (reason) => errors.push(reason), {});
  await monitor.start();
  assert.deepEqual(errors, ["audio-unavailable"]);
});
