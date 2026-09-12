import assert from "node:assert/strict";
import test from "node:test";
import { SpokenCues, SPOKEN_PHRASES } from "../app/spoken-cues.mjs";

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return {promise, resolve};
}

function fixture(overrides = {}) {
  let time = 1000;
  let timerId = 0;
  const timers = new Map();
  const requests = [];
  const clients = [];
  const contexts = [];
  const statuses = [];
  const delays = [];
  const signals = [];
  const voice = new SpokenCues({
    now: () => time,
    setTimer(fn, delay) { timers.set(++timerId, {fn, at: time + delay}); return timerId; },
    clearTimer(id) { timers.delete(id); },
    onStatus: (message) => statuses.push(message),
    onDelay: (delay) => delays.push(delay),
    fetchToken: async (signal) => {
      signals.push(signal);
      return {ok: true, json: async () => ({value: "ek_test", expires_at: Date.now() / 1000 + 60})};
    },
    createAudioContext() {
      const context = {
        state: "running", sources: [], destination: {}, outputLatency: 0.02,
        async resume() {},
        async close() { this.state = "closed"; },
        createBuffer(channels, count) { return {getChannelData: () => new Float32Array(count)}; },
        createBufferSource() {
          const source = {starts: 0, stops: 0, connect() {}, disconnect() {},
            start() { this.starts++; }, stop() { this.stops++; }};
          this.sources.push(source);
          return source;
        },
      };
      contexts.push(context);
      return context;
    },
    loadClient: async () => {
      const client = {
        closed: false, cancellations: 0,
        async connect(key, receive, fail) { this.receive = receive; this.fail = fail; },
        request(event) { requests.push(event); },
        cancel() { this.cancellations++; },
        close() { this.closed = true; },
      };
      clients.push(client);
      return client;
    },
    ...overrides,
  });
  const cue = (type = "LOOK_UP", id = 1) => voice.cue({id, type, at: time, expiresAt: time + 3000});
  const complete = (phrase = "Look up.", id = "response-1", request = requests.at(-1)) => {
    const receive = clients.at(-1).receive;
    receive({type: "response.created", response: {id, metadata: {cueId: request.cueId, sessionId: request.sessionId}}});
    const delta = {type: "response.output_audio.delta", event_id: "delta-" + id, response_id: id,
      item_id: "item-" + id, output_index: 0, content_index: 0, delta: Buffer.alloc(4800).toString("base64")};
    receive(delta);
    const done = {type: "response.done", response: {id, status: "completed", output: [{id: "item-" + id,
      type: "message", role: "assistant", content: [{type: "audio", transcript: phrase}]}]}};
    receive(done);
    return {delta, done};
  };
  return {
    voice, cue, complete, requests, clients, contexts, statuses, delays, signals, timers,
    async enable() { voice.startSession(); voice.setEnabled(true); await flush(); assert.equal(voice.ready, true); },
    advance(value) {
      time = value;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= time) { timers.delete(id); timer.fn(); }
      }
    },
  };
}

test("Off by default: no SDK, credential, audio context or speech", async () => {
  const f = fixture();
  f.voice.startSession(); f.cue(); await flush();
  assert.equal(f.voice.enabled, false);
  assert.equal(f.clients.length + f.contexts.length + f.signals.length + f.requests.length, 0);
});

test("default browser timers are called without binding them to the controller", () => {
  const savedSet = globalThis.setTimeout;
  const savedClear = globalThis.clearTimeout;
  let scheduled = 0;
  try {
    globalThis.setTimeout = function () { assert.equal(this, undefined); scheduled++; return 1; };
    globalThis.clearTimeout = function () { assert.equal(this, undefined); };
    const voice = new SpokenCues({createAudioContext: () => ({
      resume: () => new Promise(() => {}), close: async () => {},
    })});
    assert.doesNotThrow(() => voice.startSession());
    voice.setEnabled(true);
    assert.equal(scheduled, 1);
    assert.doesNotThrow(() => voice.stopSession());
  } finally {
    globalThis.setTimeout = savedSet;
    globalThis.clearTimeout = savedClear;
  }
});

test("On before Start waits; connection itself has no greeting or speech", async () => {
  const f = fixture();
  f.voice.setEnabled(true); await flush();
  assert.equal(f.clients.length, 0);
  f.voice.startSession(); await flush();
  assert.equal(f.voice.ready, true);
  assert.equal(f.requests.length, 0);
});

test("only LOOK_UP is enabled; QUIET, PAUSE and SLOW_DOWN stay silent", async () => {
  assert.deepEqual(SPOKEN_PHRASES, {LOOK_UP: "Look up."});
  const f = fixture(); await f.enable();
  ["QUIET", "PAUSE", "SLOW_DOWN", "unknown"].forEach((type, index) => f.cue(type, index + 1));
  assert.equal(f.requests.length, 0);
  f.cue("LOOK_UP", 5); assert.equal(f.requests[0].phrase, "Look up.");
});

test("validated audio plays once; duplicate cue and response cannot replay it", async () => {
  const f = fixture(); await f.enable(); f.cue(); f.cue();
  const {done, delta} = f.complete();
  f.clients[0].receive(delta); f.clients[0].receive(done);
  assert.equal(f.requests.length, 1);
  assert.equal(f.contexts[0].sources.length, 1);
  assert.equal(f.contexts[0].sources[0].starts, 1);
});

test("playback over 1.5 seconds is accepted while relevant and delay is measured", async () => {
  const f = fixture(); await f.enable(); f.cue(); f.advance(3100); f.complete();
  assert.equal(f.delays[0].delayMs, 2100);
  assert.equal(f.delays[0].outputLatencyMs, 20);
  assert.equal(f.contexts[0].sources[0].starts, 1);
});

test("audio stays buffered until the complete phrase has been checked", async () => {
  const f = fixture(); await f.enable(); f.cue();
  const pending = f.requests[0];
  f.clients[0].receive({type: "response.created", response: {id: "r", metadata: pending}});
  const event = {type: "response.output_audio.delta", response_id: "r", event_id: "d", item_id: "i",
    output_index: 0, content_index: 0, delta: Buffer.alloc(100).toString("base64")};
  f.clients[0].receive(event); f.clients[0].receive(event);
  assert.equal(f.voice.pending.bytes, 100);
  assert.equal(f.contexts[0].sources.length, 0);
});

for (const phrase of ["Hello. Look up.", "Look up please.", "Pause.", "", undefined]) {
  test(`unapproved or missing transcript is never played: ${String(phrase)}`, async () => {
    const f = fixture(); await f.enable(); f.cue();
    f.complete(phrase === undefined ? null : phrase);
    assert.equal(f.contexts[0].sources.length, 0);
  });
}

test("case and punctuation variations preserve the approved words", async () => {
  const f = fixture(); await f.enable(); f.cue(); f.complete(" LOOK UP! ");
  assert.equal(f.contexts[0].sources.length, 1);
});

test("cue expiration discards late audio and stops currently playing audio", async () => {
  const late = fixture(); await late.enable(); late.cue(); late.advance(4000); late.complete();
  assert.equal(late.contexts[0].sources.length, 0);
  assert.equal(late.clients[0].cancellations, 1);
  const playing = fixture(); await playing.enable(); playing.cue(); playing.complete(); playing.advance(4000);
  assert.equal(playing.contexts[0].sources[0].stops, 1);
});

test("withdrawn LOOK_UP is cancelled immediately; old output cannot resume it", async () => {
  const f = fixture(); await f.enable(); f.cue(); f.voice.cancelCue(); f.complete();
  assert.equal(f.contexts[0].sources.length, 0);
  assert.equal(f.clients[0].cancellations, 1);
});

for (const action of ["stopSession", "off"]) {
  test(`${action} cancels generation and active playback`, async () => {
    for (const playing of [false, true]) {
      const f = fixture(); await f.enable(); f.cue(); if (playing) f.complete();
      if (action === "off") f.voice.setEnabled(false); else f.voice.stopSession();
      assert.equal(f.clients[0].closed, true);
      assert.equal(f.signals[0].aborted, true);
      assert.equal(f.contexts[0].state, "closed");
      assert.equal(f.timers.size, 0);
      if (playing) assert.equal(f.contexts[0].sources[0].stops, 1);
      else { f.complete(); assert.equal(f.contexts[0].sources.length, 0); }
    }
  });
}

test("Stop during credential fetch aborts it and late credential cannot connect", async () => {
  const token = deferred();
  const f = fixture({fetchToken: () => token.promise});
  f.voice.startSession(); f.voice.setEnabled(true); await flush();
  f.voice.stopSession();
  token.resolve({ok: true, json: async () => ({value: "ek_late", expires_at: Date.now() / 1000 + 60})});
  await flush();
  assert.equal(f.clients[0].receive, undefined);
  assert.equal(f.voice.ready, false);
});

test("Off during SDK loading closes the late client and makes no credential request", async () => {
  const loaded = deferred(); let closed = 0;
  const f = fixture({loadClient: () => loaded.promise});
  f.voice.startSession(); f.voice.setEnabled(true); await flush();
  f.voice.setEnabled(false); loaded.resolve({close() { closed++; }}); await flush();
  assert.equal(closed, 1); assert.equal(f.signals.length, 0);
});

test("cue while connecting is skipped permanently", async () => {
  const token = deferred();
  const f = fixture({fetchToken: () => token.promise});
  f.voice.startSession(); f.voice.setEnabled(true); await flush(); f.cue();
  token.resolve({ok: true, json: async () => ({value: "ek_late", expires_at: Date.now() / 1000 + 60})});
  await flush(); f.cue();
  assert.equal(f.voice.ready, true); assert.equal(f.requests.length, 0);
});

test("new session ignores old callbacks but allows a fresh approved cue", async () => {
  const f = fixture(); await f.enable(); f.cue();
  const old = f.clients[0]; const oldRequest = f.requests[0];
  f.voice.stopSession(); f.voice.startSession(); await flush(); f.cue();
  old.fail(); old.receive({type: "response.created", response: {id: "old", metadata: oldRequest}});
  assert.equal(f.voice.ready, true); assert.equal(f.voice.pending.responseId, null);
  f.complete(); assert.equal(f.contexts[1].sources.length, 1);
});

test("credential, SDK loading and playback failures never throw into the app", async () => {
  for (const overrides of [
    {fetchToken: async () => ({ok: false})},
    {loadClient: async () => { throw new Error("missing bundle"); }},
    {createAudioContext: () => { throw new Error("device denied"); }},
    {fetchToken: async () => ({ok: true, json: async () => ({value: "not-ephemeral"})})},
  ]) {
    const f = fixture(overrides); f.voice.startSession(); f.voice.setEnabled(true); await flush();
    assert.equal(f.voice.ready, false); assert.match(f.statuses.at(-1), /unavailable/);
    assert.doesNotThrow(() => f.cue());
  }
  const f = fixture(); await f.enable(); f.cue(); f.contexts[0].state = "suspended"; f.complete();
  assert.equal(f.voice.ready, false);
});

test("connection timeout releases resources without automatic retries", async () => {
  const loaded = deferred();
  const f = fixture({loadClient: () => loaded.promise});
  f.voice.startSession(); f.voice.setEnabled(true); await flush(); f.advance(16000);
  assert.equal(f.voice.ready, false); assert.equal(f.contexts[0].state, "closed");
  assert.equal(f.timers.size, 0);
});

test("malformed or oversized audio fails safely without playback", async () => {
  const f = fixture(); await f.enable(); f.cue();
  f.clients[0].receive({type: "response.created", response: {id: "r", metadata: f.requests[0]}});
  f.clients[0].receive({type: "response.output_audio.delta", response_id: "r", output_index: 0,
    content_index: 0, item_id: "i", delta: Buffer.alloc(144002).toString("base64")});
  assert.equal(f.voice.ready, false); assert.equal(f.contexts[0].sources.length, 0);
});

test("uncorrelated responses and unsolicited greetings are ignored", async () => {
  const f = fixture(); await f.enable(); f.cue();
  f.clients[0].receive({type: "response.created", response: {id: "unwanted", metadata: {cueId: "wrong"}}});
  f.clients[0].receive({type: "response.output_audio.delta", response_id: "unwanted", delta: "hello"});
  assert.equal(f.voice.pending.bytes, 0);
  assert.equal(f.contexts[0].sources.length, 0);
});
