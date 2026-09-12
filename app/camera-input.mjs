/** Local camera lifecycle and worker bridge. No recording or external requests. */
export class CameraMonitor {
  constructor(video, onObservation, runtime = globalThis) {
    this.video = video;
    this.onObservation = onObservation;
    this.runtime = runtime;
    this.run = null;
  }

  now() { return this.runtime.performance.now() / 1000; }

  async start() {
    this.stop();
    const run = {stream: null, worker: null, timer: null, watchdog: null,
      busy: false, lastVideoTime: -1, lastFrameAt: this.now()};
    this.run = run;
    try {
      const stream = await this.runtime.navigator.mediaDevices.getUserMedia({
        video: {width: {ideal: 640}, height: {ideal: 480}, facingMode: "user"}, audio: false,
      });
      if (this.run !== run) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      run.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
      if (this.run !== run) return;
      run.worker = new this.runtime.Worker(new URL("./vision-worker.js", import.meta.url));
      run.worker.onerror = () => this.fail(run);
      stream.getVideoTracks().forEach((track) => track.addEventListener("ended", () => this.fail(run)));
      run.worker.onmessage = ({data}) => {
        if (this.run !== run) return;
        this.runtime.clearTimeout(run.watchdog);
        run.watchdog = null;
        if (data.kind === "ready") {
          if (run.timer !== null) return;
          run.timer = this.runtime.setInterval(() => this.sample(run), 333);
          this.sample(run);
        } else if (data.kind === "observation") {
          run.busy = false;
          this.onObservation({state: data.state, observedAt: data.observedAt, active: true});
        } else {
          this.fail(run);
        }
      };
      run.watchdog = this.runtime.setTimeout(() => this.fail(run), 20000);
      run.worker.postMessage({kind: "init"});
    } catch {
      this.fail(run);
    }
  }

  async sample(run) {
    if (this.run !== run || run.busy) return;
    const tracks = run.stream.getVideoTracks();
    if (!tracks.length || tracks.some((track) => track.muted || !track.enabled || track.readyState !== "live")) {
      this.fail(run);
      return;
    }
    if (this.video.readyState < 2 || this.video.currentTime === run.lastVideoTime) {
      if (this.now() - run.lastFrameAt > 1.5) {
        this.onObservation({state: "stale", observedAt: this.now(), active: true});
      }
      return;
    }
    run.busy = true;
    const observedAt = this.now();
    run.lastVideoTime = this.video.currentTime;
    run.lastFrameAt = observedAt;
    run.watchdog = this.runtime.setTimeout(() => this.fail(run), 5000);
    let frame;
    try {
      frame = await this.runtime.createImageBitmap(this.video);
      if (this.run !== run) { frame.close(); return; }
      run.worker.postMessage({kind: "frame", frame, observedAt}, [frame]);
    } catch {
      if (frame) frame.close();
      this.fail(run);
    }
  }

  fail(run) {
    if (this.run !== run) return;
    this.stop();
    this.onObservation({state: "unavailable", observedAt: this.now(), active: false});
  }

  stop() {
    const run = this.run;
    this.run = null;
    if (!run) return;
    this.runtime.clearInterval(run.timer);
    this.runtime.clearTimeout(run.watchdog);
    if (run.worker) run.worker.terminate();
    if (run.stream) run.stream.getTracks().forEach((track) => track.stop());
    this.video.pause();
    this.video.srcObject = null;
  }
}
