import { trackFacing } from "./vision.mjs";

const FAST_WPM = 180;
const PERSISTENCE_SECONDS = 8;
const COOLDOWN_SECONDS = 30;
const STALE_SECONDS = 20;
const MAX_EVALUATION_GAP = 2.5;

// MVP preference: a pause may also reduce pace. This order is configurable,
// not a universal coaching rule. All cues share the existing 30-second cooldown.
export const COACH_PRIORITY = Object.freeze(["PAUSE", "LOOK_UP", "SLOW_DOWN"]);

/** @typedef {{fastSince: number|null, cooldownUntil: number, lastEvaluatedAt: number|null, lookAwaySince: number|null, notVisibleSince: number|null, lastVisionAt: number|null}} CoachState */
/** @typedef {{active: boolean, state: string, wpm: number|null, observedAt: number|null}} Observation */

/** Return independent state for a new or stopped presentation. */
export function createCoachState() {
  return {fastSince: null, cooldownUntil: 0, lastEvaluatedAt: null, lookAwaySince: null, notVisibleSince: null, lastVisionAt: null};
}

/**
 * Assess one pace observation without accessing a clock, microphone or page.
 * @param {Observation} observation - Pace state and latest word arrival time.
 * @param {CoachState} previous - State returned by the previous evaluation.
 * @param {number} now - Monotonic time in seconds, supplied by the caller.
 * @returns {{decision: string, reason: string, nextState: CoachState}}
 */
export function assessPace(observation, previous, now) {
  const nextState = {...previous};
  const quiet = (reason, clearEpisode = true) => {
    if (clearEpisode) nextState.fastSince = null;
    return {decision: "QUIET", reason, nextState};
  };

  if (observation?.active === false) {
    return {decision: "QUIET", reason: "session_stopped", nextState: createCoachState()};
  }
  if (!Number.isFinite(now) || now < 0 ||
      (previous.lastEvaluatedAt !== null && now < previous.lastEvaluatedAt)) {
    return quiet("invalid_time");
  }
  nextState.lastEvaluatedAt = now;
  if (!observation || observation.active !== true) return quiet("invalid_observation");
  if (observation.state === "measuring") return quiet("warm_up");
  if (observation.state === "waiting") return quiet("stale_observation");
  if (observation.state !== "ready" || !Number.isFinite(observation.wpm) || observation.wpm < 0 ||
      !Number.isFinite(observation.observedAt) || observation.observedAt < 0 || observation.observedAt > now) {
    return quiet("invalid_observation");
  }
  if (now - observation.observedAt >= STALE_SECONDS) return quiet("stale_observation");
  if (observation.wpm <= FAST_WPM) return quiet("normal_pace");
  if (now < nextState.cooldownUntil) return quiet("cooldown");
  if (now === previous.lastEvaluatedAt) return quiet("repeated_evaluation", false);

  // A suspended tab or missing evaluations cannot establish continuous evidence.
  if (previous.lastEvaluatedAt !== null && now - previous.lastEvaluatedAt > MAX_EVALUATION_GAP) {
    nextState.fastSince = null;
  }
  // Even if no evaluation occurred during cooldown, do not reuse an old episode.
  if (nextState.fastSince === null || nextState.fastSince < nextState.cooldownUntil) {
    nextState.fastSince = now;
  }
  if (now - nextState.fastSince < PERSISTENCE_SECONDS) return quiet("building_persistence", false);

  nextState.fastSince = null;
  nextState.cooldownUntil = now + COOLDOWN_SECONDS;
  return {decision: "SLOW_DOWN", reason: "cue_slow_down", nextState};
}

/** Choose one cue from independent audio and pace evidence, without browser APIs. */
export function assessDelivery(observation, previous, now, priority = COACH_PRIORITY) {
  const paceObservation = {...observation?.pace, active: observation?.active};
  const paceResult = assessPace(paceObservation, previous, now);
  if (paceResult.reason === "session_stopped" || paceResult.reason === "invalid_time") return paceResult;
  const facing = trackFacing(observation?.vision, previous, now);
  const visionState = {lookAwaySince: facing.lookAwaySince, notVisibleSince: facing.notVisibleSince, lastVisionAt: facing.lastVisionAt};
  const quiet = (reason) => ({
    decision: "QUIET", reason,
    nextState: {...previous, fastSince: null, lookAwaySince: null, notVisibleSince: null, lastVisionAt: null, lastEvaluatedAt: now},
  });
  const audio = observation?.audio;
  if (observation?.active !== true || !audio || !["speaking", "silent"].includes(audio.state) ||
      !Number.isFinite(audio.observedAt) || audio.observedAt < 0 || audio.observedAt > now ||
      !Number.isFinite(audio.continuousSeconds) || audio.continuousSeconds < 0 ||
      typeof audio.pauseNeeded !== "boolean") return quiet("invalid_observation");
  if (now - audio.observedAt > 0.3) return quiet("stale_observation");
  if (paceResult.reason === "warm_up") return quiet("warm_up");
  if (now < previous.cooldownUntil) return quiet("cooldown");
  if (now === previous.lastEvaluatedAt) {
    return {...paceResult, decision: "QUIET", reason: "repeated_evaluation",
      nextState: {...paceResult.nextState, ...visionState}};
  }

  const candidates = [];
  if (audio.state === "speaking" && audio.pauseNeeded) candidates.push("PAUSE");
  if (facing.candidate) candidates.push("LOOK_UP");
  if (paceResult.decision === "SLOW_DOWN") candidates.push("SLOW_DOWN");
  const decision = priority.find((cue) => candidates.includes(cue));
  if (decision) {
    return {
      decision,
      reason: {PAUSE: "cue_pause", LOOK_UP: "cue_look_up", SLOW_DOWN: "cue_slow_down"}[decision],
      nextState: {...createCoachState(), cooldownUntil: now + COOLDOWN_SECONDS, lastEvaluatedAt: now},
    };
  }
  return {...paceResult, nextState: {...paceResult.nextState, ...visionState}};
}
