import assert from "node:assert/strict";
import test from "node:test";
import { SessionMeasurements, recognitionCoverage } from "../app/session-measurements.mjs";
import { createReview } from "../app/review.mjs";
import { analyseFillers } from "../app/fillers.mjs";

function review(percent, interrupted = false) {
  return createReview({duration:100,words:200,averageWpm:120,
    recognitionCoverage:recognitionCoverage(percent,100), recognitionInterrupted:interrupted,
    fillers:analyseFillers("um " + Array(199).fill("word").join(" ")),
    pauses:{available:true,incomplete:false,count:4,longestSeconds:20},
    camera:{valid:100,facing:90,spanSeconds:90,incomplete:false}});
}
for (const [percent,label] of [[100,"reliable"],[90,"reliable"],[89,"partial"],[70,"partial"],[69.9,"insufficient"]]) {
  test(`${percent}% coverage is ${label}`, () => {
    assert.equal(recognitionCoverage(percent,100).reliability,label);
  });
}
test("short reconnect retains reliable coverage", () => {
  const m = new SessionMeasurements();
  m.recognition(true,0);m.recognition(false,99);m.recognition(true,100);m.stopRecognitionCoverage(300);
  assert.equal(m.coverage(300).availableSeconds,299);
  assert.equal(m.coverage(300).reliability,"reliable");
});
test("several reconnect gaps subtract only unavailable time", () => {
  const m = new SessionMeasurements();
  m.recognition(true,5);m.recognition(false,30);m.recognition(true,35);
  m.recognition(false,60);m.recognition(true,70);m.stopRecognitionCoverage(100);
  assert.deepEqual(m.coverage(100),{availableSeconds:80,totalSeconds:100,percent:80,reliability:"partial"});
});
test("manual Stop freezes coverage and ignores subsequent transitions", () => {
  const m = new SessionMeasurements();m.recognition(true,0);m.stopRecognitionCoverage(20);
  m.recognition(true,30);m.recognition(false,40);m.stopRecognitionCoverage(50);
  assert.deepEqual(m.coverage(60),recognitionCoverage(20,20));
});
test("new session resets open periods and totals", () => {
  const m = new SessionMeasurements();m.recognition(true,0);m.reset(50);
  assert.deepEqual(m.coverage(60),recognitionCoverage(0,10));
});
test("duplicate and invalid transitions cannot inflate coverage", () => {
  const m = new SessionMeasurements();m.recognition(true,0);m.recognition(true,10);
  m.recognition(false,NaN);m.recognition(false,5);m.recognition(false,20);m.recognition(false,20);
  assert.deepEqual(m.coverage(30),recognitionCoverage(20,30));
});
test("zero duration and invalid coverage are insufficient", () => {
  for (const [available,total] of [[0,0],[-1,10],[11,10],[NaN,10],[0,Infinity]]) {
    assert.equal(recognitionCoverage(available,total).reliability,"insufficient");
    assert.equal(recognitionCoverage(available,total).percent,null);
  }
});
test("coverage thresholds are configurable and validated", () => {
  assert.equal(recognitionCoverage(85,100,{reliablePercent:80,partialPercent:60}).reliability,"reliable");
  assert.throws(()=>recognitionCoverage(90,100,{reliablePercent:60,partialPercent:70}),RangeError);
});
for (const [percent,label] of [[95,"reliable"],[82,"partial"],[60,"insufficient"]]) {
  test(`${label} coverage controls pace interpretation`, () => {
    const result=review(percent);
    assert.equal(result.pace.label,percent<70?"Not enough reliable data":"Target range");
    assert.equal(result.pace.reliable,percent>=90);
    assert.equal(result.pace.coverageNote,percent>=90?"":percent>=70?"Partial recognition coverage":"Insufficient recognition coverage");
  });
  test(`${label} coverage controls filler rate without losing observed count`, () => {
    const result=review(percent);
    assert.equal(result.fillers.total,1);
    assert.equal(result.fillers.ratePer100Words,percent<70?null:0.5);
    assert.equal(result.fillers.reliable,percent>=90);
    assert.equal(result.fillers.coverageNote,result.pace.coverageNote);
  });
}
test("interruption note coexists with reliable pace and filler results", () => {
  const result=review(99,true);
  assert.equal(result.pace.reliable,true);assert.equal(result.fillers.reliable,true);
  assert.ok(result.dataQuality.some(text=>text.startsWith("Recognition was interrupted")));
  assert.equal(result.improvements[0].heading,"Filler words");
});
test("recognition coverage does not change camera review", () => {
  assert.deepEqual(review(20).camera,review(100).camera);
});
test("recognition coverage does not change pause review", () => {
  assert.deepEqual(review(20).pauses,review(100).pauses);
});
test("missing coverage does not invent reliability", () => {
  assert.equal(createReview({}).recognitionCoverage.percent,null);
});
