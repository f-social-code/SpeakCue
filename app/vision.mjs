// Configurable demo settings, not measures of attention, identity or emotion.
export const VISION_SETTINGS = Object.freeze({
  maxFacingAngle: 30,
  lookAwaySeconds: 6,
  maxObservationAge: 1.5,
});

/** Convert local face geometry to a coarse head-facing state; never eye gaze. */
export function classifyFacing(result, settings = VISION_SETTINGS) {
  const faces = result?.faceLandmarks;
  if (!Array.isArray(faces)) return "unavailable";
  if (faces.length === 0) return "no_face";
  if (faces.length !== 1) return "unavailable";
  const matrix = result.facialTransformationMatrixes?.[0];
  if (matrix?.rows !== 4 || matrix?.columns !== 4 || matrix.data?.length !== 16 ||
      Array.from(matrix.data).some((value) => !Number.isFinite(value))) return "unavailable";
  // The transformed face-normal axis gives combined yaw/pitch deviation.
  // A roll (tilted head) alone does not change this angle. Ignore translation.
  const data = matrix.data;
  const length = Math.hypot(data[8], data[9], data[10]);
  if (length < 0.001) return "unavailable";
  const angle = Math.acos(Math.max(-1, Math.min(1, data[10] / length))) * 180 / Math.PI;
  return angle <= settings.maxFacingAngle ? "face_visible_and_facing" : "face_visible_not_facing";
}

/** Track fresh camera evidence using supplied seconds, independently of audio. */
export function trackFacing(observation, previous, now, settings = VISION_SETTINGS) {
  const cleared = {lookAwaySince: null, notVisibleSince: null, lastVisionAt: null, candidate: false};
  const lastVisionAt = previous.lastVisionAt ?? null;
  if (!Number.isFinite(now) || !Number.isFinite(observation?.observedAt) ||
      observation.observedAt < 0 || observation.observedAt > now ||
      now - observation.observedAt > settings.maxObservationAge ||
      (lastVisionAt !== null && observation.observedAt < lastVisionAt) ||
      observation.active === false) return cleared;
  const noFace = observation.state === "no_face" && observation.active === true;
  const away = observation.state === "face_visible_not_facing";
  if (!away && !noFace) return {...cleared, lastVisionAt: observation.observedAt};
  // Each classification needs its own continuous episode; never combine them.
  const key = noFace ? "notVisibleSince" : "lookAwaySince";
  const gap = lastVisionAt === null || observation.observedAt - lastVisionAt > settings.maxObservationAge;
  const since = gap ? observation.observedAt : previous[key] ?? observation.observedAt;
  return {
    ...cleared,
    [key]: since,
    lastVisionAt: observation.observedAt,
    candidate: observation.observedAt - since >= settings.lookAwaySeconds,
  };
}
