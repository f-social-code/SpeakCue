import assert from "node:assert/strict";
import test from "node:test";
import { createReview } from "../app/review.mjs";
import { SessionMeasurements } from "../app/session-measurements.mjs";
import { analyseFillers } from "../app/fillers.mjs";

function session(overrides = {}) {
  return {recognitionCoverage: {availableSeconds:40,totalSeconds:40}, duration: 40, words: 100, averageWpm: 150, recognitionInterrupted: false,
    pauses: {available: true, incomplete: false, count: 3, longestSeconds: 15},
    fillers: analyseFillers(Array(100).fill("word").join(" ")),
    camera: {valid: 100, facing: 90, spanSeconds: 35, incomplete: false},
    cues: {PAUSE: 1, LOOK_UP: 2, SLOW_DOWN: 1}, ...overrides};
}
for (const [wpm, label] of [[100,"Slow"], [120,"Target range"], [150,"Target range"],
  [160,"Target range"], [160.1,"Fast"], [180,"Fast"], [180.1,"Very fast"]]) {
  test(`pace ${wpm} is ${label}`, () => assert.equal(createReview(session({averageWpm:wpm})).pace.label, label));
}

test("regular meaningful pauses give neutral feedback", () => {
  assert.equal(createReview(session()).pauses.feedback, "Regular pauses detected");
});
test("long unpaused speaking gives pause feedback", () => {
  const review = createReview(session({pauses: {available: true, incomplete: false, count: 0, longestSeconds: 30}}));
  assert.equal(review.pauses.feedback, "Consider adding more intentional pauses");
  assert.match(review.improvements[0].message, /intentional pauses/);
});
test("filler summary uses existing canonical breakdown and rate", () => {
  const fillers = analyseFillers("umm uh you know " + Array(96).fill("word").join(" "));
  const review = createReview(session({fillers}));
  assert.equal(review.fillers.total, 3);
  assert.equal(review.fillers.counts.um, 1);
  assert.equal(review.fillers.counts["you know"], 1);
  assert.equal(review.fillers.ratePer100Words, 3);
});
test("low filler rate can be a measured strength", () => {
  const review = createReview(session({averageWpm: 110, pauses: {available:true,incomplete:false,count:0,longestSeconds:10}}));
  assert.match(review.strengths[0], /Few common filler/);
});
test("high filler rate suggests reviewing patterns", () => {
  const fillers = analyseFillers(Array(6).fill("um").concat(Array(94).fill("word")).join(" "));
  assert.match(createReview(session({fillers})).improvements[0].message, /filler patterns/);
});
test("camera percentage counts valid observations only", () => {
  assert.equal(createReview(session()).camera.percent, 90);
});
test("unavailable, sparse and invalid camera data never invent a percentage", () => {
  for (const camera of [undefined, {valid:0,facing:0,spanSeconds:0}, {valid:14,facing:14,spanSeconds:10},
    {valid:100,facing:90,spanSeconds:2}, {valid:20,facing:21,spanSeconds:10}]) {
    const review = createReview(session({camera}));
    assert.equal(review.camera.percent, null);
    assert.ok(review.dataQuality.some(text => /Camera/.test(text)));
  }
});
test("cue counts and total reflect displayed cues", () => {
  assert.deepEqual(createReview(session()).cues, {PAUSE:1,LOOK_UP:2,SLOW_DOWN:1,total:4});
});
test("strengths have fixed order and never exceed two", () => {
  assert.deepEqual(createReview(session()).strengths, [
    "Estimated average pace was within the target range.", "Meaningful pauses were used."]);
});
test("first improvement follows pace then pauses then camera then fillers", () => {
  const s = session({averageWpm:200, pauses:{available:true,incomplete:false,count:0,longestSeconds:30},
    camera:{valid:100,facing:30,spanSeconds:35,incomplete:false},
    fillers:analyseFillers(Array(10).fill("um").concat(Array(90).fill("word")).join(" "))});
  assert.match(createReview(s).improvements[0].message, /slower delivery/);
  s.averageWpm = 150;
  assert.match(createReview(s).improvements[0].message, /intentional pauses/);
  s.pauses.longestSeconds = 10;
  assert.match(createReview(s).improvements[0].message, /facing the camera/);
  s.camera.facing = 90;
  assert.match(createReview(s).improvements[0].message, /filler patterns/);
});
test("complete data without a priority issue gives the no-major-issue message", () => {
  assert.equal(createReview(session()).improvementMessage, "No major delivery issue detected in this session.");
});
test("insufficient coverage suppresses transcript conclusions", () => {
  const review = createReview(session({recognitionInterrupted:true, averageWpm:220, recognitionCoverage:{availableSeconds:20,totalSeconds:40}}));
  assert.equal(review.pace.reliable, false);
  assert.equal(review.fillers.reliable, false);
  assert.ok(review.improvements.every(item => item.heading !== "Pace"));
  assert.ok(review.dataQuality.some(text => /Recognition was interrupted/.test(text)));
});
test("short transcript retains counts but suppresses filler rate and pace interpretation", () => {
  const review = createReview(session({words:2,fillers:analyseFillers("um hello"),averageWpm:6}));
  assert.equal(review.fillers.total, 1);
  assert.equal(review.fillers.ratePer100Words, null);
  assert.equal(review.pace.reliable, false);
  assert.ok(review.dataQuality.some(text => /too short/.test(text)));
});
test("incomplete audio and camera do not generate unsupported strengths", () => {
  const review = createReview(session({averageWpm:110,
    pauses:{available:false,incomplete:true,count:0,longestSeconds:null},
    camera:{valid:100,facing:100,spanSeconds:35,incomplete:true}}));
  assert.equal(review.camera.percent, 100);
  assert.equal(review.camera.reliable, false);
  assert.ok(review.strengths.every(text => !/Camera|pauses/.test(text)));
  assert.ok(review.dataQuality.some(text => /Audio monitoring/.test(text)));
});
test("empty and invalid input are handled safely without praise", () => {
  for (const input of [null, {}, {duration:NaN,averageWpm:Infinity,words:-1}]) {
    const review = createReview(input);
    assert.equal(review.pace.averageWpm, null);
    assert.deepEqual(review.strengths, []);
    assert.deepEqual(review.improvements, []);
    assert.ok(review.dataQuality.length > 0);
  }
});
test("review settings are configurable and invalid ranges rejected", () => {
  assert.equal(createReview(session(), {targetMax:140}).pace.label,"Fast");
  assert.throws(() => createReview(session(), {targetMin:200}), RangeError);
});
test("review creates detached results and cannot retain a prior session", () => {
  const s = session();
  const review = createReview(s);
  review.fillers.counts.um = 99;
  assert.equal(s.fillers.counts.um, 0);
  assert.equal(createReview({}).cues.total, 0);
});
test("measurement collector deduplicates camera callbacks and excludes unknown frames", () => {
  const m = new SessionMeasurements();
  const frame = {state:"face_visible_and_facing",observedAt:1};
  m.camera(frame,1); m.camera(frame,1);
  m.camera({state:"no_face",observedAt:2},2);
  m.camera({state:"face_visible_not_facing",observedAt:3},3);
  assert.equal(m.summary(3).camera.valid,2);
  assert.equal(m.summary(3).camera.facing,1);
  assert.equal(m.summary(3).camera.incomplete,true);
});
test("collector retains longest observed run and pause counts across episodes", () => {
  const m = new SessionMeasurements();
  m.audio({state:"speaking",observedAt:0,continuousSeconds:0,pauseCount:0},0);
  m.audio({state:"speaking",observedAt:0.1,continuousSeconds:0.1,pauseCount:0},0.1);
  m.audio({state:"silent",observedAt:0.2,continuousSeconds:0.2,pauseCount:1},0.2);
  assert.equal(m.summary(0.2).pauses.longestSeconds,0.1);
  assert.equal(m.summary(0.2).pauses.count,1);
  assert.equal(m.summary(2).pauses.incomplete,true);
});
test("collector reset clears cues, interruptions, audio and camera history", () => {
  const m = new SessionMeasurements();
  m.cue("PAUSE");m.cue("QUIET");m.recognitionInterrupted=true;
  m.camera({state:"face_visible_and_facing",observedAt:1},1);
  m.reset(2);
  assert.equal(m.summary(2).camera.valid,0);
  assert.equal(m.summary(2).pauses.available,false);
  assert.equal(m.summary(2).cues.PAUSE,0);
  assert.equal(m.summary(2).recognitionInterrupted,false);
});
test("invalid, stale and out-of-order camera frames do not inflate totals", () => {
  const m = new SessionMeasurements();
  m.camera({state:"face_visible_and_facing",observedAt:2},2);
  for (const at of [1,NaN,20]) m.camera({state:"face_visible_and_facing",observedAt:at},3);
  m.camera({state:"face_visible_and_facing",observedAt:3},10);
  assert.equal(m.summary(10).camera.valid,1);
});


function issues(overrides = {}) {
  return session({pauses:{available:true,incomplete:false,count:1,longestSeconds:30},
    camera:{valid:100,facing:30,spanSeconds:35,incomplete:false}, ...overrides});
}
const headings = review => review.improvements.map(item => item.heading);

test("pause and camera issues appear together", () => {
  assert.deepEqual(headings(createReview(issues())), ["Pauses", "Camera facing"]);
});
test("pause, camera and detected filler patterns appear together", () => {
  const fillers=analyseFillers(Array(4).fill("um").concat(Array(96).fill("word")).join(" "));
  assert.deepEqual(headings(createReview(issues({fillers}))), ["Pauses", "Camera facing", "Filler words"]);
});
test("four qualifying areas return only the top three in order", () => {
  const fillers=analyseFillers(Array(10).fill("um").concat(Array(90).fill("word")).join(" "));
  const result=createReview(issues({averageWpm:200,fillers}));
  assert.deepEqual(headings(result), ["Pace", "Pauses", "Camera facing"]);
  assert.ok(result.strengths.length<=2);
});
test("LOOK UP supports low camera facing but cue counts alone never qualify", () => {
  const result=createReview(issues());
  assert.match(result.improvements[1].message,/camera facing.*LOOK UP/);
  assert.deepEqual(createReview(session()).improvements,[]);
});
test("low filler rate produces neutral count-based wording", () => {
  const fillers=analyseFillers("um " + Array(99).fill("word").join(" "));
  const result=createReview(session({fillers}));
  assert.deepEqual(result.improvements,[{heading:"Filler words",
    message:"1 common filler pattern was detected; review where they appeared and whether they were needed."}]);
});
test("high filler rate gives a stronger practice suggestion", () => {
  const fillers=analyseFillers(Array(6).fill("um").concat(Array(94).fill("word")).join(" "));
  assert.match(createReview(session({fillers})).improvements[0].message,/practise replacing unneeded occurrences with a pause/);
});
test("no detected fillers produce no filler improvement", () => {
  assert.ok(!headings(createReview(issues())).includes("Filler words"));
});
test("insufficient or incomplete camera evidence produces no camera improvement", () => {
  for(const camera of [{valid:2,facing:0,spanSeconds:1,incomplete:false},
    {valid:100,facing:0,spanSeconds:35,incomplete:true}]) {
    assert.ok(!headings(createReview(issues({camera}))).includes("Camera facing"));
  }
});
test("partial or insufficient recognition coverage suppresses pace and filler improvements", () => {
  for(const availableSeconds of [32,20]) {
    const fillers=analyseFillers(Array(10).fill("um").concat(Array(90).fill("word")).join(" "));
    const result=createReview(issues({averageWpm:220,fillers,recognitionCoverage:{availableSeconds,totalSeconds:40}}));
    assert.deepEqual(headings(result),["Pauses","Camera facing"]);
  }
});
test("incomplete pause evidence cannot create an improvement conclusion", () => {
  const result=createReview(session({pauses:{available:true,incomplete:true,count:1,longestSeconds:30}}));
  assert.deepEqual(result.improvements,[]);
  assert.equal(result.pauses.feedback,"Not enough reliable pause data to assess this session.");
});

test("camera strength uses natural detected-face wording without changing coverage notes", () => {
  const raw = session({averageWpm: 110, fillers: undefined,
    pauses: {available: true, incomplete: false, count: 0, longestSeconds: 10}});
  assert.deepEqual(createReview(raw).strengths, [
    "Camera facing was high when your face was detected.",
  ]);
  raw.camera.incomplete = true;
  const incomplete = createReview(raw);
  assert.equal(incomplete.camera.percent, 90);
  assert.deepEqual(incomplete.strengths, []);
  assert.ok(incomplete.dataQuality.includes(
    "Camera coverage was incomplete. The percentage describes valid observations only; missing faces and unavailable frames are excluded."
  ));
});

test("unavailable and incomplete pause data use the same conservative wording", () => {
  for (const available of [false, true]) {
    const review = createReview(session({pauses: {available, incomplete: true, count: 1, longestSeconds: 30}}));
    assert.equal(review.pauses.feedback, "Not enough reliable pause data to assess this session.");
    assert.equal(review.pauses.reliable, false);
    assert.ok(review.dataQuality.includes("Audio monitoring was unavailable or incomplete. Pause totals cover observed audio only."));
  }
});

test("review preserves fractional pace and classifies using the raw value", () => {
  const raw = session({averageWpm: 160.4});
  const before = structuredClone(raw);
  const review = createReview(raw);
  assert.equal(review.pace.averageWpm, 160.4);
  assert.equal(review.pace.label, "Fast");
  assert.deepEqual(raw, before);
});
test("no qualifying issue gives the requested fallback", () => {
  const result=createReview(session());
  assert.deepEqual(result.improvements,[]);
  assert.equal(result.improvementMessage,"No major delivery issue detected in this session.");
});
