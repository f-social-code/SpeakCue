import { PAUSE_SETTINGS } from "./pauses.mjs";
import { VISION_SETTINGS } from "./vision.mjs";

// Configurable MVP availability ranges, not word-recognition accuracy.
export const COVERAGE_SETTINGS = Object.freeze({reliablePercent: 90, partialPercent: 70});

/** Validate durations and classify recognition availability without a clock. */
export function recognitionCoverage(availableSeconds, totalSeconds, settings = COVERAGE_SETTINGS) {
  if (!Number.isFinite(settings.partialPercent) || !Number.isFinite(settings.reliablePercent) ||
      settings.partialPercent < 0 || settings.partialPercent > settings.reliablePercent || settings.reliablePercent > 100) {
    throw new RangeError("Invalid coverage thresholds.");
  }
  const valid = Number.isFinite(availableSeconds) && Number.isFinite(totalSeconds) &&
    totalSeconds > 0 && availableSeconds >= 0 && availableSeconds <= totalSeconds;
  const percent = valid ? availableSeconds / totalSeconds * 100 : null;
  const reliability = percent !== null && percent >= settings.reliablePercent ? "reliable" :
    percent !== null && percent >= settings.partialPercent ? "partial" : "insufficient";
  return {availableSeconds: valid ? availableSeconds : 0,
    totalSeconds: Number.isFinite(totalSeconds) && totalSeconds >= 0 ? totalSeconds : 0, percent, reliability};
}

/** In-memory session totals. Call only for observations from the active session. */
export class SessionMeasurements {
  constructor() { this.reset(0); }

  reset(now) {
    if (!Number.isFinite(now) || now < 0) throw new RangeError("Invalid session start time.");
    this.startedAt = now;
    this.coverageStartedAt = now;
    this.coverageLastAt = now;
    this.coverageStoppedAt = null;
    this.recognitionSince = null;
    this.recognitionSeconds = 0;
    this.audioLastAt = null;
    this.audioIncomplete = false;
    this.pauseCount = 0;
    this.longestSeconds = null;
    this.cameraLastAt = null;
    this.cameraFirstAt = null;
    this.cameraIncomplete = false;
    this.cameraValid = 0;
    this.cameraFacing = 0;
    this.recognitionInterrupted = false;
    this.cues = {PAUSE: 0, LOOK_UP: 0, SLOW_DOWN: 0};
  }

  /** Open or close an available interval. Duplicate transitions are harmless. */
  recognition(available, now) {
    if (this.coverageStoppedAt !== null || typeof available !== "boolean" ||
        !Number.isFinite(now) || now < this.coverageLastAt) return;
    this.coverageLastAt = now;
    if (available) {
      this.recognitionSince ??= now;
    } else if (this.recognitionSince !== null) {
      this.recognitionSeconds += now - this.recognitionSince;
      this.recognitionSince = null;
    }
  }

  stopRecognitionCoverage(now) {
    if (this.coverageStoppedAt !== null || !Number.isFinite(now) || now < this.coverageLastAt) return;
    this.recognition(false, now);
    this.coverageStoppedAt = now;
  }

  coverage(now) {
    const end = this.coverageStoppedAt ?? now;
    if (!Number.isFinite(end) || end < this.coverageLastAt) return recognitionCoverage(null, null);
    const available = this.recognitionSeconds + (this.recognitionSince === null ? 0 : end - this.recognitionSince);
    return recognitionCoverage(available, end - this.coverageStartedAt);
  }

  audio(observation, now) {
    const at = observation?.observedAt;
    if (!["speaking", "silent"].includes(observation?.state) || !Number.isFinite(at) ||
        at > now || at < this.startedAt || now - at > PAUSE_SETTINGS.maxSampleGap) {
      this.audioIncomplete = true;
      return;
    }
    if (this.audioLastAt !== null && at <= this.audioLastAt) return;
    if (at - (this.audioLastAt ?? this.startedAt) > PAUSE_SETTINGS.maxSampleGap) this.audioIncomplete = true;
    this.audioLastAt = at;
    if (Number.isInteger(observation.pauseCount) && observation.pauseCount >= 0) {
      this.pauseCount = Math.max(this.pauseCount, observation.pauseCount);
    }
    // Sample while speaking so trailing silence is not added to the longest run.
    if (observation.state === "speaking" && Number.isFinite(observation.continuousSeconds) && observation.continuousSeconds >= 0) {
      this.longestSeconds = Math.max(this.longestSeconds ?? 0, observation.continuousSeconds);
    }
  }

  camera(observation, now) {
    const at = observation?.observedAt;
    if (!["face_visible_and_facing", "face_visible_not_facing"].includes(observation?.state) ||
        !Number.isFinite(at) || at < this.startedAt || at > now || now - at > VISION_SETTINGS.maxObservationAge) {
      this.cameraIncomplete = true;
      return;
    }
    if (this.cameraLastAt !== null && at <= this.cameraLastAt) return;
    if (at - (this.cameraLastAt ?? this.startedAt) > VISION_SETTINGS.maxObservationAge) this.cameraIncomplete = true;
    this.cameraFirstAt ??= at;
    this.cameraLastAt = at;
    this.cameraValid++;
    if (observation.state === "face_visible_and_facing") this.cameraFacing++;
  }

  cue(decision) {
    if (Object.hasOwn(this.cues, decision)) this.cues[decision]++;
  }

  /** Return a detached snapshot before Stop releases and resets the sensors. */
  summary(now) {
    return {
      recognitionInterrupted: this.recognitionInterrupted,
      recognitionCoverage: this.coverage(now),
      pauses: {count: this.pauseCount, longestSeconds: this.longestSeconds,
        available: this.audioLastAt !== null,
        incomplete: this.audioIncomplete || this.audioLastAt === null || now - this.audioLastAt > PAUSE_SETTINGS.maxSampleGap},
      camera: {valid: this.cameraValid, facing: this.cameraFacing,
        spanSeconds: this.cameraLastAt === null ? 0 : this.cameraLastAt - this.cameraFirstAt,
        incomplete: this.cameraIncomplete || this.cameraLastAt === null || now - this.cameraLastAt > VISION_SETTINGS.maxObservationAge},
      cues: {...this.cues},
    };
  }
}
