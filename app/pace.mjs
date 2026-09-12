/** Count English words; punctuation alone is not a word. */
export function countWords(text) {
  if (typeof text !== "string") throw new TypeError("Expected transcript text.");
  return (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []).length;
}

/** Rolling pace based on word arrival times, not exact spoken-word timestamps. */
export class PaceTracker {
  constructor() {
    this.windowSeconds = 20;
    this.reset(0);
  }

  /** @param {number} now - Monotonic time in seconds. */
  reset(now) {
    if (!Number.isFinite(now) || now < 0) throw new RangeError("Invalid start time.");
    this.startedAt = now;
    this.lastObservedAt = now;
    this.lastWordAt = null;
    this.wordTimes = [];
    this.valid = true;
  }

  /** Replace the complete ordered result snapshot, including revised interim text. */
  observe(phrases, now) {
    if (!Number.isFinite(now) || now < this.lastObservedAt ||
        !Array.isArray(phrases) || phrases.some((text) => typeof text !== "string")) {
      this.valid = false;
      return false;
    }
    this.wordTimes = phrases.map((text, index) => {
      const count = countWords(text);
      const times = (this.wordTimes[index] || []).slice(0, count);
      // Keep existing word positions at their original arrival times. A final
      // result or duplicate callback must not move old words into a new window.
      while (times.length < count) times.push(now);
      return times;
    });
    const times = this.wordTimes.flat();
    this.lastWordAt = times.length ? times.reduce((latest, time) => Math.max(latest, time)) : null;
    this.lastObservedAt = now;
    this.valid = true;
    return true;
  }

  /** Return a display state and optional WPM without using a browser or clock. */
  estimate(now) {
    if (!this.valid || !Number.isFinite(now) || now < this.lastObservedAt) {
      return {state: "waiting", wpm: null};
    }
    if (now - this.startedAt < this.windowSeconds) {
      return {state: "measuring", wpm: null};
    }
    if (this.lastWordAt === null || now - this.lastWordAt >= this.windowSeconds) {
      return {state: "waiting", wpm: null};
    }
    const words = this.wordTimes.flat().filter(
      (time) => time > now - this.windowSeconds && time <= now
    ).length;
    return {state: "ready", wpm: words / this.windowSeconds * 60};
  }

  /** Summarise the whole listening interval, including pauses. */
  summary(now) {
    const duration = now - this.startedAt;
    const words = this.wordTimes.reduce((total, times) => total + times.length, 0);
    const usable = this.valid && Number.isFinite(now) && now >= this.lastObservedAt && duration > 0;
    return {
      duration: Number.isFinite(duration) && duration >= 0 ? duration : 0,
      words,
      averageWpm: usable && words > 0 ? words / duration * 60 : null,
    };
  }
}
