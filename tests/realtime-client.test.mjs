import assert from "node:assert/strict";
import test from "node:test";
import { createOutputSocket, createRealtimeClient, MODEL } from "../voice/realtime-client.mjs";

class Socket extends EventTarget {
  constructor(url, protocols) { super(); this.url = url; this.protocols = protocols; this.sent = []; this.readyState = 0; }
  send(text) { this.sent.push(JSON.parse(text)); }
  emit(type, fields = {}) { const event = new Event(type); Object.assign(event, fields); this.dispatchEvent(event); }
  open() { this.readyState = 1; this.emit("open"); }
  receive(event) { this.emit("message", {data: JSON.stringify(event)}); }
  close() { this.readyState = 3; this.emit("close"); }
}
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

test("outgoing boundary rejects microphone buffers and conversation messages", () => {
  const socket = createOutputSocket({url: "wss://example.invalid", apiKey: "ek_test"}, Socket);
  for (const event of [
    {type: "input_audio_buffer.append", audio: "secret"},
    {type: "input_audio_buffer.commit"},
    {type: "conversation.item.create", item: {type: "message"}},
    {type: "response.create"},
    {type: "session.update", session: {audio: {input: {turn_detection: {type: "server_vad"}}}}},
  ]) assert.throws(() => socket.send(JSON.stringify(event)));
  assert.equal(socket.sent.length, 0);
});

test("installed SDK sends configuration and approved text only, with no microphone access", async () => {
  let socket;
  let microphoneCalls = 0;
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {configurable: true, value: {
    mediaDevices: {getUserMedia() { microphoneCalls++; throw new Error("Unexpected microphone access"); }},
  }});
  const client = createRealtimeClient({createWebSocket(options) {
    socket = createOutputSocket(options, Socket); return socket;
  }});
  try {
    const connection = client.connect("ek_test", () => {}, () => {});
    connection.catch(() => {}); // Keep setup assertions from leaving an unobserved rejection.
    await flush(); socket.open(); await flush();
    const config = socket.sent.find((event) => event.type === "session.update").session;
    assert.equal(config.model, MODEL);
    assert.equal(config.audio.input.turn_detection, null);
    assert.equal(config.audio.input.transcription, null);
    assert.deepEqual(config.tools, []);
    assert.equal(config.tool_choice, "none");
    assert.notEqual(config.tracing, "auto");
    socket.receive({type: "session.created", event_id: "created", session: {...config, id: "s", tracing: null}});
    assert.equal(socket.sent.filter((event) => event.type === "response.create").length, 0);
    socket.receive({type: "session.updated", event_id: "s", session: {...config, id: "s"}});
    await connection;
    client.request({sessionId: "s1", cueId: "1", phrase: "Look up."});
    const request = socket.sent.find((event) => event.type === "response.create").response;
    assert.equal(request.conversation, "none");
    assert.equal(request.input[0].content[0].text, "Look up.");
    assert.equal(JSON.stringify(request).includes("audio_buffer"), false);
    assert.throws(() => client.request({sessionId: "s1", cueId: "2", phrase: "Pause."}));
    client.cancel();
    assert.equal(microphoneCalls, 0);
    assert.ok(socket.sent.every((event) => ["session.update", "response.create", "response.cancel"].includes(event.type)));
  } finally {
    client.close();
    if (original) Object.defineProperty(globalThis, "navigator", original); else delete globalThis.navigator;
  }
});

test("SDK connection stays unready until configuration acknowledgement and can be closed", async () => {
  let socket;
  const client = createRealtimeClient({createWebSocket(options) { socket = createOutputSocket(options, Socket); return socket; }});
  let ready = false;
  const connection = client.connect("ek_test", () => {}, () => {}).then(() => { ready = true; });
  const rejected = assert.rejects(connection);
  await flush(); socket.open(); await flush();
  assert.equal(ready, false);
  client.close(); await rejected;
  assert.equal(socket.readyState, 3);
});
