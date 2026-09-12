export const ASTRA_UNAVAILABLE = "Astra coaching is unavailable. Your measured Speaker Profile is still available.";
const DIAGNOSTIC_MESSAGES = Object.freeze({
  missing_api_key: "missing API key", invalid_api_key: "invalid API key",
  quota_problem: "API quota or billing problem", rate_limited: "API rate limit reached",
  model_access_denied: "model access denied", model_not_found: "model not found",
  model_unavailable: "model not found or not accessible", access_denied: "API access denied",
  malformed_request: "malformed request", schema_validation_failure: "response validation failed",
  timeout: "request timed out", network_failure: "network failure", other_api_error: "OpenAI API error",
});

/** Render only known development categories, never server or provider prose. */
export function astraFailureMessage(value) {
  if (value?.development !== true || !Object.hasOwn(DIAGNOSTIC_MESSAGES, value.category)) return ASTRA_UNAVAILABLE;
  return "Astra coaching unavailable: " + DIAGNOSTIC_MESSAGES[value.category] +
    ". Your measured Speaker Profile is still available.";
}

const AREAS = ["pace", "pauses", "fillers", "camera", "opening", "mainPoints", "transitions", "conclusion"];
const PARTS = ["opening", "mainPoints", "transitions", "conclusion"];
const STATES = ["present", "weak", "not_detected", "insufficient_evidence"];
const text = (value, max = 600, empty = false) => typeof value === "string" && value.length <= max && (empty || value.length > 0);
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const strings = (value, max, length = 600) => Array.isArray(value) && value.length <= max && value.every(item => text(item, length));

/** Send only the approved text, measurements and quality fields. */
export function astraPayload(transcript, snapshot, profile, requestId) {
  return structuredClone({schemaVersion: 1, requestId, transcript,
    measuredFacts: {
      durationSeconds: snapshot.duration, words: snapshot.words, pace: profile.pace,
      recognitionCoverage: profile.recognitionCoverage,
      recognitionInterrupted: snapshot.recognitionInterrupted,
      pauses: {count: profile.pauses.count, longestSeconds: profile.pauses.longestSeconds,
        reliable: profile.pauses.reliable, available: snapshot.pauses.available, incomplete: snapshot.pauses.incomplete},
      fillers: {total: snapshot.fillers.totalFillers, counts: snapshot.fillers.counts,
        observedRate: snapshot.fillers.ratePer100Words, representativeRate: profile.fillers.ratePer100Words,
        reliable: profile.fillers.reliable},
      cameraFacing: {percent: profile.camera.percent, validObservations: profile.camera.validObservations,
        reliable: profile.camera.reliable, incomplete: snapshot.camera.incomplete},
      cues: profile.cues,
    }, dataQuality: profile.dataQuality});
}

/** Reject malformed responses before constructing any review elements. */
export function validateAstraResponse(value, requestId) {
  if (!keys(value, ["requestId", "model", "review"]) || value.requestId !== requestId || !text(value.model, 80)) return false;
  const r = value.review;
  if (!keys(r, ["coachSummary", "strengths", "improvements", "structure", "readableTranscript", "limitations"]) ||
      !text(r.coachSummary, 1000) || r.coachSummary.trim().split(/\s+/).length > 80 || /[\r\n]/.test(r.coachSummary) ||
      !text(r.readableTranscript, 60000) || !strings(r.limitations, 40) || !keys(r.structure, PARTS)) return false;
  for (const name of PARTS) {
    const p = r.structure[name];
    if (!keys(p, ["status", "feedback", "transcriptQuote"]) || !STATES.includes(p.status) ||
        !text(p.feedback) || !text(p.transcriptQuote, 400, true)) return false;
  }
  for (const [name, limit, fields] of [
    ["strengths", 2, ["area", "heading", "feedback", "evidenceRefs"]],
    ["improvements", 3, ["area", "heading", "evidence", "suggestion", "evidenceRefs"]],
  ]) {
    if (!Array.isArray(r[name]) || r[name].length > limit) return false;
    for (const item of r[name]) {
      if (!keys(item, fields) || !AREAS.includes(item.area) || !text(item.heading, 60) ||
          !strings(item.evidenceRefs, 3, 80) || item.evidenceRefs.length === 0 ||
          !text(item.feedback ?? item.evidence) || (name === "improvements" && !text(item.suggestion))) return false;
    }
  }
  return true;
}

/** Independent request lifecycle; no microphone, camera or measurement writes. */
export class AstraReview {
  constructor(document, runtime = globalThis) {
    this.document = document;
    this.runtime = runtime;
    this.pending = null;
    this.generation = 0;
  }

  reset() {
    this.generation++;
    if (this.pending) {
      this.pending.controller.abort();
      this.runtime.clearTimeout(this.pending.timer);
    }
    this.pending = null;
    this.document.getElementById("astra-section").hidden = true;
    this.document.getElementById("astra-content").replaceChildren();
    this.document.getElementById("astra-status").textContent = "";
  }

  async request(transcript, snapshot, profile) {
    this.reset();
    const section = this.document.getElementById("astra-section");
    const status = this.document.getElementById("astra-status");
    section.hidden = false;
    status.textContent = "Preparing your coaching review...";
    if (!transcript.trim()) { status.textContent = ASTRA_UNAVAILABLE; return; }
    const run = {generation: this.generation, controller: new this.runtime.AbortController(), timer: null};
    this.pending = run;
    const requestId = String(run.generation);
    run.timer = this.runtime.setTimeout(() => {
      if (this.pending !== run) return;
      this.pending = null;
      run.controller.abort();
      status.textContent = ASTRA_UNAVAILABLE;
    }, 95000);
    try {
      const response = await this.runtime.fetch("/api/astra-review", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify(astraPayload(transcript, snapshot, profile, requestId)),
        signal: run.controller.signal,
      });
      if (this.pending !== run) return;
      if (!response.ok) {
        const failure = await response.json();
        if (this.pending === run) status.textContent = astraFailureMessage(failure);
        return;
      }
      const value = await response.json();
      if (this.pending !== run) return;
      if (!validateAstraResponse(value, requestId)) throw new Error("Invalid review");
      this.render(value);
      status.textContent = "Coaching review ready.";
    } catch {
      if (this.pending === run) status.textContent = ASTRA_UNAVAILABLE;
    } finally {
      this.runtime.clearTimeout(run.timer);
      if (this.pending === run) this.pending = null;
    }
  }

  render(value) {
    const root = this.document.getElementById("astra-content");
    const element = (tag, content) => {
      const node = this.document.createElement(tag);
      node.textContent = content;
      return node;
    };
    const section = (heading) => {
      const node = this.document.createElement("section");
      node.append(element("h3", heading));
      return node;
    };
    const r = value.review;
    const summary = section("Coach summary");
    summary.append(element("p", r.coachSummary));
    const strengths = section("What worked");
    const improvements = section("What to improve");
    for (const [items, container, fields] of [
      [r.strengths, strengths, ["feedback"]], [r.improvements, improvements, ["evidence", "suggestion"]],
    ]) {
      // Structure explanations appear once below; keep suggested actions here.
      const displayed = items.filter(item => !PARTS.includes(item.area) || fields.includes("suggestion"));
      container.hidden = displayed.length === 0;
      for (const item of displayed) {
        container.append(element("h4", item.heading));
        for (const field of fields) {
          if (!PARTS.includes(item.area) || field === "suggestion") container.append(element("p", item[field]));
        }
      }
    }
    const structure = section("Presentation structure");
    const names = {opening: "Opening", mainPoints: "Main points", transitions: "Transitions", conclusion: "Conclusion"};
    const labels = {present: "Present", weak: "Needs development", not_detected: "Not detected", insufficient_evidence: "Not enough evidence"};
    for (const key of PARTS) {
      const part = r.structure[key];
      structure.append(element("h4", names[key]), element("p", labels[part.status] + " — " + part.feedback));
    }
    const limitations = section("Review limitations");
    for (const note of r.limitations) limitations.append(element("p", note));
    limitations.hidden = r.limitations.length === 0;
    const transcript = section("Readable transcript");
    const readable = element("p", r.readableTranscript);
    readable.className = "readable-transcript";
    transcript.append(readable);
    const attribution = element("p", "Contextual review powered by " +
      (value.model === "gpt-6-astra" ? "GPT-6 Astra" : value.model) + ".");
    attribution.className = "note";
    root.replaceChildren(summary, strengths, improvements, limitations, structure, transcript, attribution);
  }
}
