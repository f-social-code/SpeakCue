// Extend this allowlist only after the LOOK_UP live acceptance test passes.
export const SPOKEN_PHRASES = Object.freeze({LOOK_UP: "Look up."});
const UNAVAILABLE = "Spoken cues unavailable. Text coaching continues. Turn Off, then On to retry.";
const SAMPLE_RATE = 24000;
const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * 3;

function safely(action) {
  try { const result = action(); result?.catch?.(() => {}); } catch { /* Voice is optional. */ }
}

function words(text) {
  return typeof text === "string" ? text.toLowerCase().replace(/[.!?,]/g, "").trim().replace(/\s+/g, " ") : "";
}

/** Own one optional connection and one approved cue; never accept microphone data. */
export class SpokenCues {
  constructor({
    loadClient = async () => (await import("./vendor/spoken-cues-sdk.mjs")).createRealtimeClient(),
    fetchToken = (signal) => fetch("/api/voice-token", {
      method: "POST", headers: {"Content-Type": "application/json"}, body: "{}",
      credentials: "same-origin", cache: "no-store", signal,
    }),
    createAudioContext = () => new AudioContext(),
    now = () => performance.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (id) => clearTimeout(id),
    onStatus = () => {},
    onDelay = () => {},
  } = {}) {
    Object.assign(this, {loadClient, fetchToken, createAudioContext, now, setTimer, clearTimer, onStatus, onDelay});
    this.enabled = false;
    this.active = false;
    this.generation = 0;
    this.sessionNumber = 0;
    this.lastCueId = 0;
    this.ready = false;
    this.client = null;
    this.context = null;
    this.pending = null;
    this.source = null;
    this.abort = null;
    this.connectionTimer = null;
  }

  status(message) { safely(() => this.onStatus(message)); }

  setEnabled(enabled) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.disconnect();
    if (enabled && this.active) void this.connect();
    else this.status(enabled ? "On — starts with your presentation. LOOK UP only." : "Spoken cues off.");
  }

  startSession() {
    this.disconnect();
    this.active = true;
    this.sessionNumber++;
    this.lastCueId = 0;
    if (this.enabled) void this.connect();
  }

  stopSession() {
    this.active = false;
    this.disconnect();
    this.status(this.enabled ? "Spoken cues stopped. Starts again with a new presentation." : "Spoken cues off.");
  }

  async connect() {
    const generation = this.generation;
    const current = () => generation === this.generation && this.active && this.enabled;
    this.status("Connecting spoken cues. Text coaching is ready.");
    try {
      this.abort = new AbortController();
      const signal = this.abort.signal;
      this.connectionTimer = this.setTimer(() => { if (current()) this.fail(); }, 15000);
      // Called from Start/On so browser audio permission follows a user gesture.
      this.context = this.createAudioContext();
      await this.context.resume();
      if (!current()) return;
      const client = await this.loadClient();
      if (!current()) { safely(() => client.close()); return; }
      this.client = client;
      const response = await this.fetchToken(signal);
      if (!current()) return;
      if (!response.ok) throw new Error("Credential unavailable");
      const token = await response.json();
      if (!current()) return;
      if (typeof token.value !== "string" || !token.value.startsWith("ek_") ||
          !Number.isFinite(token.expires_at) || token.expires_at * 1000 <= Date.now()) {
        throw new Error("Invalid credential");
      }
      await client.connect(token.value,
        (event) => { if (current()) this.receive(event); },
        () => { if (current()) this.fail(); });
      if (!current()) return;
      this.clearTimer(this.connectionTimer);
      this.connectionTimer = null;
      this.ready = true;
      this.status("Spoken cues ready — LOOK UP only.");
    } catch { if (current()) this.fail(); }
  }

  fail() {
    this.disconnect();
    this.status(UNAVAILABLE);
  }

  /** Called once after text is displayed. Events skipped here are never queued. */
  cue({id, type, at, expiresAt}) {
    if (!this.active || !Number.isInteger(id) || id <= this.lastCueId) return;
    this.lastCueId = id;
    this.cancelCue();
    const phrase = SPOKEN_PHRASES[type];
    if (!phrase || !this.enabled) return;
    if (!this.ready) { this.status("LOOK UP voice skipped — connection not ready. Text coaching continues."); return; }
    if (!Number.isFinite(at) || !Number.isFinite(expiresAt) || at > this.now() || expiresAt <= this.now()) return;
    const pending = {
      cueId: String(id), sessionId: String(this.sessionNumber) + ":" + this.generation,
      phrase, at, expiresAt, responseId: null, itemId: null, chunks: [], bytes: 0,
      events: new Set(), timer: null, completed: false,
    };
    this.pending = pending;
    pending.timer = this.setTimer(() => {
      if (this.pending === pending) this.cancelCue();
    }, expiresAt - this.now());
    try { this.client.request(pending); } catch { this.fail(); }
  }

  receive(event) {
    try { this.handleEvent(event); } catch { this.fail(); }
  }

  handleEvent(event) {
    const pending = this.pending;
    if (!pending || !this.ready || pending.completed) return;
    if (this.now() >= pending.expiresAt) { this.cancelCue(); return; }
    if (event.type === "response.created") {
      const response = event.response;
      if (response?.metadata?.cueId === pending.cueId && response.metadata.sessionId === pending.sessionId &&
          typeof response.id === "string" && pending.responseId === null) pending.responseId = response.id;
      return;
    }
    if (!pending.responseId || (event.response_id ?? event.response?.id) !== pending.responseId) return;
    if (event.event_id) {
      if (pending.events.has(event.event_id)) return;
      pending.events.add(event.event_id);
    }
    if (event.type === "response.output_audio.delta") {
      if (event.output_index !== 0 || event.content_index !== 0 || typeof event.item_id !== "string" ||
          (pending.itemId !== null && pending.itemId !== event.item_id) || typeof event.delta !== "string" ||
          event.delta.length > MAX_AUDIO_BYTES * 2) throw new Error("Invalid audio");
      pending.itemId = event.item_id;
      const bytes = Uint8Array.from(atob(event.delta), (char) => char.charCodeAt(0));
      pending.bytes += bytes.length;
      if (pending.bytes > MAX_AUDIO_BYTES) throw new Error("Oversized audio");
      pending.chunks.push(bytes);
    }
    if (event.type === "response.done") {
      pending.completed = true;
      const output = event.response.output;
      const item = output?.[0];
      const part = item?.content?.[0];
      if (event.response.status !== "completed" || output?.length !== 1 || item.type !== "message" ||
          item.role !== "assistant" || item.id !== pending.itemId || item.content?.length !== 1 ||
          !["audio", "output_audio"].includes(part?.type) || words(part.transcript) !== words(pending.phrase) ||
          !pending.bytes || pending.bytes % 2) {
        this.cancelCue();
        this.status("LOOK UP voice skipped — response did not match the approved phrase.");
        return;
      }
      this.play(pending);
    }
  }

  play(pending) {
    if (this.pending !== pending || !this.active || !this.enabled || this.now() >= pending.expiresAt) return;
    if (this.context.state !== "running") { this.fail(); return; }
    const bytes = new Uint8Array(pending.bytes);
    let offset = 0;
    for (const chunk of pending.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    pending.chunks = [];
    const samples = new DataView(bytes.buffer);
    const buffer = this.context.createBuffer(1, pending.bytes / 2, SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) channel[i] = samples.getInt16(i * 2, true) / 32768;
    const source = this.context.createBufferSource();
    this.source = source;
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = () => { if (this.source === source) { safely(() => source.disconnect()); this.source = null; } };
    source.start();
    const delayMs = this.now() - pending.at;
    const outputLatencyMs = Math.max(0, this.context.outputLatency || 0) * 1000;
    safely(() => this.onDelay({delayMs, outputLatencyMs}));
    this.status("LOOK UP spoken. Text coaching continues.");
  }

  cancelCue() {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      this.clearTimer(pending.timer);
      pending.chunks = [];
      if (!pending.completed) safely(() => this.client?.cancel());
      if (!pending.completed) this.status("LOOK UP voice discarded — cue ended before audio was ready.");
    }
    const source = this.source;
    this.source = null;
    if (source) { source.onended = null; safely(() => source.stop()); safely(() => source.disconnect()); }
  }

  disconnect() {
    this.generation++;
    this.ready = false;
    this.cancelCue();
    this.clearTimer(this.connectionTimer);
    this.connectionTimer = null;
    this.abort?.abort();
    this.abort = null;
    safely(() => this.client?.close());
    this.client = null;
    safely(() => this.context?.close());
    this.context = null;
  }
}
