import assert from "node:assert/strict";
import test from "node:test";
import { CameraMonitor } from "../app/camera-input.mjs";

function setup() {
  let resolvePermission;
  let rejectPermission;
  const permission = new Promise((resolve, reject) => { resolvePermission = resolve; rejectPermission = reject; });
  const observations = [];
  const timers = new Map();
  const workers = [];
  let id = 0;
  const track = {readyState: "live", enabled: true, muted: false,
    addEventListener() {}, stop() { this.readyState = "ended"; }};
  const stream = {getTracks: () => [track], getVideoTracks: () => [track]};
  const video = {readyState: 2, currentTime: 1, async play() {}, pause() { this.paused = true; }};
  let constraints;
  const runtime = {
    performance: {now: () => 1000},
    navigator: {mediaDevices: {getUserMedia(options) { constraints = options; return permission; }}},
    Worker: class {
      constructor() { workers.push(this); this.messages = []; }
      postMessage(message) { this.messages.push(message); }
      terminate() { this.terminated = true; }
    },
    async createImageBitmap() { return {close() {}}; },
    setTimeout(fn) { timers.set(++id, fn); return id; },
    setInterval(fn) { timers.set(++id, fn); return id; },
    clearTimeout(key) { timers.delete(key); },
    clearInterval(key) { timers.delete(key); },
  };
  const monitor = new CameraMonitor(video, item => observations.push(item), runtime);
  return {monitor, video, workers, track, stream, observations, timers,
    resolvePermission, rejectPermission, constraints: () => constraints};
}

test("camera permission is deferred until Start and late permission after Stop is released", async () => {
  const app = setup();
  assert.equal(app.constraints(), undefined);
  const starting = app.monitor.start();
  assert.equal(app.constraints().audio, false);
  app.monitor.stop();
  app.resolvePermission(app.stream);
  await starting;
  assert.equal(app.track.readyState, "ended");
  assert.equal(app.workers.length, 0);
  assert.equal(app.observations.length, 0);
});

test("camera Stop terminates worker, tracks and timers and ignores old callbacks", async () => {
  const app = setup();
  const starting = app.monitor.start();
  app.resolvePermission(app.stream);
  await starting;
  const worker = app.workers[0];
  worker.onmessage({data: {kind: "ready"}});
  await Promise.resolve();
  assert.equal(worker.messages.at(-1).kind, "frame");
  worker.onmessage({data: {kind: "observation", state: "no_face", observedAt: 1}});
  assert.equal(app.observations.length, 1);
  app.monitor.stop();
  worker.onmessage({data: {kind: "observation", state: "face_visible_not_facing", observedAt: 2}});
  worker.onerror();
  assert.equal(app.observations.length, 1);
  assert.equal(worker.terminated, true);
  assert.equal(app.track.readyState, "ended");
  assert.equal(app.timers.size, 0);
  assert.equal(app.video.srcObject, null);
});

test("camera denial reports unavailable safely", async () => {
  const app = setup();
  const starting = app.monitor.start();
  app.rejectPermission(new Error("permission denied"));
  await starting;
  assert.equal(app.observations[0].state, "unavailable");
  assert.equal(app.workers.length, 0);
});

test("model startup timeout releases camera and reports unavailable", async () => {
  const app = setup();
  const starting = app.monitor.start();
  app.resolvePermission(app.stream);
  await starting;
  [...app.timers.values()][0]();
  assert.equal(app.track.readyState, "ended");
  assert.equal(app.workers[0].terminated, true);
  assert.equal(app.observations[0].state, "unavailable");
});

test("fresh no-face frames carry active status; frozen video reports stale separately", async () => {
  const app = setup();
  const starting = app.monitor.start();
  app.resolvePermission(app.stream);
  await starting;
  const worker = app.workers[0];
  worker.onmessage({data: {kind: "ready"}});
  await Promise.resolve();
  worker.onmessage({data: {kind: "observation", state: "no_face", observedAt: 1}});
  assert.deepEqual(app.observations.at(-1), {state: "no_face", observedAt: 1, active: true});
  app.monitor.runtime.performance.now = () => 3000;
  await app.monitor.sample(app.monitor.run);
  assert.deepEqual(app.observations.at(-1), {state: "stale", observedAt: 3, active: true});
  app.monitor.fail(app.monitor.run);
  assert.deepEqual(app.observations.at(-1), {state: "unavailable", observedAt: 3, active: false});
});
