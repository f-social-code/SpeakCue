// Demo thresholds: tune for the laptop and room, not universal speaking standards.
export const PAUSE_SETTINGS = Object.freeze({
  silenceLevel: 0.015,
  meaningfulSeconds: 0.6,
  continuousSeconds: 25,
  maxSampleGap: 0.3,
});

/** Measure silence from local RMS levels with caller-supplied seconds. */
export class PauseDetector {
  constructor(settings = PAUSE_SETTINGS) {
    this.settings = {...PAUSE_SETTINGS, ...settings};
    if (Object.values(this.settings).some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new RangeError("Pause thresholds must be positive numbers.");
    }
    this.reset();
  }

  reset() {
    this.pauseCount = 0;
    this.invalidate();
  }

  /** Missing audio breaks evidence; it must never be interpreted as silence. */
  invalidate() {
    this.lastSampleAt = null;
    this.speakingSince = null;
    this.silentSince = null;
    this.state = "unavailable";
  }

  observe(level, now) {
    if (!Number.isFinite(level) || level < 0 || !Number.isFinite(now) || now < 0 ||
        (this.lastSampleAt !== null && now < this.lastSampleAt)) {
      this.invalidate();
      return this.observation(now);
    }
    if (this.lastSampleAt !== null && now - this.lastSampleAt > this.settings.maxSampleGap) {
      this.invalidate();
    }
    this.lastSampleAt = now;
    if (level >= this.settings.silenceLevel) {
      this.state = "speaking";
      this.silentSince = null;
      if (this.speakingSince === null) this.speakingSince = now;
    } else {
      this.state = "silent";
      if (this.silentSince === null) this.silentSince = now;
      if (this.speakingSince !== null && now - this.silentSince + 1e-9 >= this.settings.meaningfulSeconds) {
        this.pauseCount++;
        this.speakingSince = null;
      }
    }
    return this.observation(now);
  }

  observation(now) {
    const valid = Number.isFinite(now) && this.lastSampleAt !== null &&
      now >= this.lastSampleAt && now - this.lastSampleAt <= this.settings.maxSampleGap;
    const continuousSeconds = valid && this.speakingSince !== null ? now - this.speakingSince : 0;
    return {
      state: valid ? this.state : "unavailable",
      observedAt: this.lastSampleAt,
      continuousSeconds,
      pauseNeeded: valid && this.state === "speaking" && continuousSeconds >= this.settings.continuousSeconds,
      pauseCount: this.pauseCount,
    };
  }
}
