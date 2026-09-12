# Local vision dependency

MediaPipe Tasks Vision **0.10.32**, Apache-2.0. See LICENSE and manifest.json
for upstream URLs, exact byte sizes and SHA-256 checksums.

The JavaScript bundle, SIMD WASM loader/binary and Google face-landmarker
float16 model version 1 total 15,554,198 bytes (about 15.6 MB). Assets are
served from localhost. No CDN or model downloads occur during a presentation.
The SIMD build targets current desktop Microsoft Edge. Unsupported devices
fail to Camera unavailable; there is no downloaded fallback.

The model estimates face geometry. SpeakCue requests a transformation matrix
and disables blendshape output. It does not use identity or emotion inference.
Frames are transient in memory and are not recorded, saved or uploaded.

Inference runs in a dedicated worker at approximately three frames per second.
Only the coarse facing state and timestamp return to the page. Actual startup
latency, CPU use and head-facing thresholds require testing on the demo laptop.

Sources:
- https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js
- https://github.com/google-ai-edge/mediapipe
