import { RealtimeAgent, RealtimeSession, OpenAIRealtimeWebSocket } from "@openai/agents-realtime";

export const MODEL = "gpt-realtime-2.1";
export const VOICE = "marin";
const INSTRUCTIONS = "Say exactly the supplied cue phrase, once. No greeting, explanation, extra words or conversation.";

/** A second boundary: this socket cannot send microphone or conversation items. */
export function createOutputSocket({url, apiKey}, Socket = globalThis.WebSocket) {
  const socket = new Socket(url, ["realtime", "openai-insecure-api-key." + apiKey]);
  const send = socket.send.bind(socket);
  socket.send = (data) => {
    const event = JSON.parse(data);
    if (!["session.update", "response.create", "response.cancel"].includes(event.type)) {
      throw new Error("Voice input event blocked");
    }
    // The SDK separately confirms tracing is disabled after session.created.
    const tracingOnly = event.type === "session.update" &&
      Object.keys(event.session).every((key) => ["type", "tracing"].includes(key)) &&
      event.session.tracing === null;
    if (event.type === "session.update" && !tracingOnly &&
        (event.session.audio?.input?.turn_detection !== null ||
         event.session.audio?.input?.transcription !== null ||
         event.session.tools?.length !== 0)) {
      throw new Error("Unexpected voice configuration");
    }
    if (event.type === "response.create") {
      const response = event.response;
      const input = response?.input;
      if (response?.conversation !== "none" || input?.length !== 1 ||
          input[0].role !== "user" || input[0].content?.length !== 1 ||
          input[0].content[0].type !== "input_text" ||
          input[0].content[0].text !== "Look up." ||
          !response.metadata?.cueId || !response.metadata?.sessionId) {
        throw new Error("Unapproved voice response blocked");
      }
    }
    send(data);
  };
  return socket;
}

/** Output only: no MediaStream, microphone capture, sendAudio or automatic playback. */
export function createRealtimeClient({createWebSocket = createOutputSocket} = {}) {
  const transport = new OpenAIRealtimeWebSocket({createWebSocket});
  const agent = new RealtimeAgent({name: "SpeakCue spoken cues", voice: VOICE, instructions: INSTRUCTIONS});
  const session = new RealtimeSession(agent, {
    transport,
    model: MODEL,
    tracingDisabled: true,
    historyStoreAudio: false,
    automaticallyTriggerResponseForMcpToolCalls: false,
    config: {
      outputModalities: ["audio"],
      toolChoice: "none",
      providerData: {tools: []},
      audio: {
        input: {turnDetection: null, transcription: null},
        output: {voice: VOICE, format: {type: "audio/pcm", rate: 24000}},
      },
    },
  });
  let closed = false;
  let rejectConnection = null;
  return {
    async connect(apiKey, onEvent, onFailure) {
      const configured = new Promise((resolve, reject) => {
        rejectConnection = reject;
        session.on("transport_event", (event) => {
          if (closed) return;
          if (event.type === "session.updated") {
            const settings = event.session;
            if (settings?.audio?.input?.turn_detection !== null ||
                settings.audio.input.transcription !== null ||
                settings.audio.output?.format?.type !== "audio/pcm" ||
                settings.audio.output.format.rate !== 24000 ||
                settings.tools?.length !== 0) {
              reject(new Error("Unexpected voice configuration"));
              onFailure();
              return;
            }
            resolve();
          }
          onEvent(event);
        });
        session.on("error", () => { if (!closed) { reject(new Error("Voice unavailable")); onFailure(); } });
        transport.on("connection_change", (status) => {
          if (!closed && status === "disconnected") {
            reject(new Error("Voice disconnected"));
            onFailure();
          }
        });
      });
      // Observe both promises immediately: socket-open alone is not readiness.
      await Promise.all([configured, session.connect({apiKey})]);
    },
    request({sessionId, cueId, phrase}) {
      if (closed || phrase !== "Look up.") throw new Error("Unapproved cue");
      transport.sendEvent({
        type: "response.create",
        response: {
          conversation: "none",
          output_modalities: ["audio"],
          max_output_tokens: 128,
          instructions: INSTRUCTIONS,
          metadata: {sessionId, cueId},
          input: [{type: "message", role: "user", content: [{type: "input_text", text: phrase}]}],
        },
      });
    },
    cancel() {
      if (!closed) transport.sendEvent({type: "response.cancel"});
    },
    close() {
      if (closed) return;
      closed = true;
      rejectConnection?.(new Error("Voice closed"));
      session.close();
    },
  };
}
