// Classic worker: MediaPipe's local WASM loader uses importScripts.
let detector = null;
let classifyFacing;
let inputCanvas;

self.onmessage = async ({data}) => {
  if (data.kind === "init") {
    try {
      const vision = await import("./vendor/mediapipe/vision_bundle.mjs");
      ({classifyFacing} = await import("./vision.mjs"));
      const local = (path) => new URL(path, self.location.href).href;
      detector = await vision.FaceLandmarker.createFromOptions({
        wasmLoaderPath: local("./vendor/mediapipe/wasm/vision_wasm_internal.js"),
        wasmBinaryPath: local("./vendor/mediapipe/wasm/vision_wasm_internal.wasm"),
      }, {
        baseOptions: {modelAssetPath: local("./vendor/mediapipe/face_landmarker.task"), delegate: "CPU"},
        canvas: new OffscreenCanvas(640, 480),
        runningMode: "VIDEO",
        numFaces: 1,
        minFaceDetectionConfidence: 0.6,
        minFacePresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: true,
      });
      inputCanvas = new OffscreenCanvas(640, 480);
      self.postMessage({kind: "ready"});
    } catch {
      self.postMessage({kind: "error"});
    }
    return;
  }
  if (data.kind !== "frame") return;
  try {
    if (!detector) throw new Error("Model unavailable");
    inputCanvas.getContext("2d").drawImage(data.frame, 0, 0, 640, 480);
    const result = detector.detectForVideo(inputCanvas, data.observedAt * 1000);
    // Only the coarse state leaves this worker; no landmarks or images are retained.
    self.postMessage({kind: "observation", state: classifyFacing(result), observedAt: data.observedAt});
  } catch {
    self.postMessage({kind: "error"});
  } finally {
    data.frame.close();
  }
};
