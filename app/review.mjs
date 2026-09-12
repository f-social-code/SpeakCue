import { MIN_RATE_WORDS } from "./fillers.mjs";
import { recognitionCoverage } from "./session-measurements.mjs";

// Presentation demo choices, not universal scientific standards or live thresholds.
export const REVIEW_SETTINGS = Object.freeze({
  targetMin: 120, targetMax: 160, fastMax: 180, longRunSeconds: 25,
  minimumDuration: 20, cameraMinObservations: 15, cameraMinSpan: 5,
  lowFacingPercent: 60, highFacingPercent: 80, lowFillerRate: 2, highFillerRate: 5,
});
const nonnegative = (value) => Number.isFinite(value) && value >= 0;
const count = (value) => Number.isInteger(value) && value >= 0;

/** Build deterministic feedback from a session snapshot, without APIs or a clock. */
export function createReview(summary = {}, settings = REVIEW_SETTINGS) {
  const s = summary ?? {};
  const rules = {...REVIEW_SETTINGS, ...settings};
  if (Object.values(rules).some((value) => !nonnegative(value)) ||
      rules.targetMin > rules.targetMax || rules.targetMax > rules.fastMax ||
      rules.lowFacingPercent > rules.highFacingPercent || rules.highFacingPercent > 100 ||
      rules.lowFillerRate > rules.highFillerRate) throw new RangeError("Invalid review settings.");
  const durationSeconds = nonnegative(s.duration) ? s.duration : null;
  const words = count(s.words) ? s.words : 0;
  const short = words < MIN_RATE_WORDS || durationSeconds === null || durationSeconds < rules.minimumDuration;
  const paceValid = nonnegative(s.averageWpm) && words > 0 && durationSeconds > 0;
  const coverage = recognitionCoverage(s.recognitionCoverage?.availableSeconds, s.recognitionCoverage?.totalSeconds);
  const coverageReliable = coverage.reliability === "reliable";
  const coverageUsable = coverage.reliability !== "insufficient";
  const coverageNote = coverage.reliability === "partial" ? "Partial recognition coverage" :
    coverageUsable ? "" : "Insufficient recognition coverage";
  const paceReliable = paceValid && !short && coverageReliable;
  const label = !(paceValid && !short && coverageUsable) ? "Not enough reliable data" :
    s.averageWpm < rules.targetMin ? "Slow" : s.averageWpm <= rules.targetMax ? "Target range" :
      s.averageWpm <= rules.fastMax ? "Fast" : "Very fast";
  const pauses = s.pauses ?? {};
  const pauseValid = pauses.available === true && count(pauses.count);
  const longest = nonnegative(pauses.longestSeconds) ? pauses.longestSeconds : null;
  const longRun = pauseValid && longest !== null && longest >= rules.longRunSeconds;
  const pauseReliable = pauseValid && pauses.incomplete === false;
  const pauseFeedback = !pauseReliable ? "Not enough reliable pause data to assess this session."
    : longRun ? "Consider adding more intentional pauses"
      : pauses.count >= 2 ? "Regular pauses detected" : pauses.count === 1
        ? "One meaningful pause detected" : "No meaningful pauses detected";
  const fillers = s.fillers ?? {};
  const fillerValid = count(fillers.totalFillers) && count(fillers.totalWords) &&
    fillers.totalWords === words && fillers.counts && typeof fillers.counts === "object" &&
    Object.values(fillers.counts).every(count) &&
    Object.values(fillers.counts).reduce((sum, value) => sum + value, 0) === fillers.totalFillers;
  const fillerRate = coverageUsable && fillerValid && words >= MIN_RATE_WORDS && nonnegative(fillers.ratePer100Words)
    ? fillers.ratePer100Words : null;
  const fillerReliable = fillerRate !== null && coverageReliable;
  const camera = s.camera ?? {};
  const cameraValid = count(camera.valid) && count(camera.facing) && camera.facing <= camera.valid;
  const cameraEnough = cameraValid && camera.valid >= rules.cameraMinObservations &&
    nonnegative(camera.spanSeconds) && camera.spanSeconds >= rules.cameraMinSpan;
  const percent = cameraEnough ? camera.facing / camera.valid * 100 : null;
  const cameraReliable = cameraEnough && camera.incomplete === false;
  const cues = Object.fromEntries(["PAUSE", "LOOK_UP", "SLOW_DOWN"].map(key =>
    [key, count(s.cues?.[key]) ? s.cues[key] : 0]));
  const dataQuality = [];
  if (!coverageReliable) dataQuality.push(coverageNote + ". Pace and filler results describe observed speech only.");
  if (s.recognitionInterrupted) dataQuality.push("Recognition was interrupted, including any automatic recovery. Availability during those gaps is reflected in recognition coverage.");
  if (short) dataQuality.push("The transcript or session is too short for a reliable pace interpretation. Filler rates require at least 20 recognised words.");
  if (!paceValid) dataQuality.push("Estimated average pace is unavailable.");
  if (!fillerValid) dataQuality.push("Filler analysis is unavailable.");
  if (!pauseReliable) dataQuality.push("Audio monitoring was unavailable or incomplete. Pause totals cover observed audio only.");
  if (!cameraEnough) dataQuality.push(cameraValid && camera.valid > 0
    ? "Camera observations were insufficient for a percentage (15 valid observations spanning five seconds required)."
    : "Camera facing data was unavailable; no valid face-facing observations were collected.");
  else if (!cameraReliable) dataQuality.push("Camera coverage was incomplete. The percentage describes valid observations only; missing faces and unavailable frames are excluded.");
  const strengths = [];
  if (paceReliable && label === "Target range") strengths.push("Estimated average pace was within the target range.");
  if (pauseReliable && pauses.count > 0) strengths.push("Meaningful pauses were used.");
  if (fillerReliable && fillerRate <= rules.lowFillerRate) strengths.push("Few common filler words were detected in the transcript.");
  if (cameraReliable && percent >= rules.highFacingPercent) strengths.push("Camera facing was high when your face was detected.");
  // Add supported areas in review priority order; cue counts alone never qualify.
  const improvements = [];
  if (paceReliable && label === "Very fast") {
    improvements.push({heading: "Pace", message: "Try a slower delivery pace."});
  }
  if (pauseReliable && longRun) {
    improvements.push({heading: "Pauses", message: "Add more intentional pauses during longer speaking periods."});
  }
  if (cameraReliable && percent < rules.lowFacingPercent) {
    improvements.push({heading: "Camera facing", message: cues.LOOK_UP > 0
      ? "Low camera facing and a LOOK UP cue were recorded; practise facing the camera more often."
      : "Low camera facing was recorded; practise facing the camera more often."});
  }
  if (fillerReliable && fillers.totalFillers > 0) {
    improvements.push({heading: "Filler words", message: fillerRate > rules.highFillerRate
      ? "Review recurring filler patterns in the transcript and practise replacing unneeded occurrences with a pause."
      : fillers.totalFillers + " common filler " + (fillers.totalFillers === 1 ? "pattern was" : "patterns were") +
        " detected; review where they appeared and whether they were needed."});
  }
  return {
    durationSeconds, words, recognitionCoverage: coverage,
    pace: {averageWpm: paceValid ? s.averageWpm : null, label, reliable: paceReliable, coverageNote},
    pauses: {count: pauseValid ? pauses.count : null, longestSeconds: longest,
      feedback: pauseFeedback, reliable: pauseReliable},
    fillers: {total: fillerValid ? fillers.totalFillers : null,
      counts: fillerValid ? {...fillers.counts} : {}, ratePer100Words: fillerRate, reliable: fillerReliable, coverageNote},
    camera: {percent, validObservations: cameraValid ? camera.valid : 0, reliable: cameraReliable},
    cues: {...cues, total: Object.values(cues).reduce((sum, value) => sum + value, 0)},
    strengths: strengths.slice(0, 2), improvements: improvements.slice(0, 3),
    improvementMessage: improvements.length ? "" : "No major delivery issue detected in this session.", dataQuality,
  };
}
