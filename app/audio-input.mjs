/** Calculate signal level from one temporary waveform buffer. */
export function rootMeanSquare(samples) {
  if (!samples || samples.length === 0) return null;
  let sum = 0;
  for (const value of samples) {
    if (!Number.isFinite(value)) return null;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

/** Local microphone analysis only: no recorder, storage, network or speaker output. */
export class MicrophoneMonitor {
  constructor(onLevel, onUnavailable, runtime = globalThis) {
    this.onLevel = onLevel;
    this.onUnavailable = onUnavailable;
    this.runtime = runtime;
    this.run = null;
  }

  async start() {
    this.stop();
    const run = {stream: null, context: null, source: null, timer: null};
    this.run = run;
    try {
      const {navigator, AudioContext} = this.runtime;
      if (!navigator?.mediaDevices?.getUserMedia || !AudioContext) {
        throw new Error("audio-unavailable");
      }
      // Start/resume from the Start button's user gesture.
      run.context = new AudioContext();
      await run.context.resume();
      if (this.run !== run) return;
      const stream = await navigator.mediaDevices.getUserMedia({audio: true, video: false});
      if (this.run !== run) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      run.stream = stream;
      const tracks = stream.getAudioTracks();
      if (!tracks.length) throw new Error("audio-unavailable");
      const analyser = run.context.createAnalyser();
      analyser.fftSize = 2048;
      run.source = run.context.createMediaStreamSource(stream);
      run.source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const fail = () => this.fail(run, "audio-interrupted");
      tracks.forEach((track) => track.addEventListener("ended", fail));
      const sample = () => {
        if (this.run !== run) return;
        if (run.context.state !== "running" || tracks.some((track) => track.muted || !track.enabled || track.readyState !== "live")) {
          fail();
          return;
        }
        try {
          analyser.getFloatTimeDomainData(samples);
          this.onLevel(rootMeanSquare(samples));
        } catch {
          fail();
        }
      };
      run.timer = this.runtime.setInterval(sample, 50);
      sample();
    } catch (error) {
      this.fail(run, error?.name === "NotAllowedError" ? "permission-denied" : "audio-unavailable");
    }
  }

  fail(run, reason) {
    if (this.run !== run) return;
    this.stop();
    this.onUnavailable(reason);
  }

  stop() {
    const run = this.run;
    this.run = null;
    if (!run) return;
    if (run.timer !== null) this.runtime.clearInterval(run.timer);
    if (run.source) run.source.disconnect();
    if (run.stream) run.stream.getTracks().forEach((track) => track.stop());
    if (run.context && run.context.state !== "closed") {
      // Closing an already interrupted context must not leave an unhandled rejection.
      run.context.close().catch(() => {});
    }
  }
}
