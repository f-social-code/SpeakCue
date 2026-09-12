import assert from "node:assert/strict";
import test from "node:test";
import { AstraReview, astraPayload, validateAstraResponse, ASTRA_UNAVAILABLE, astraFailureMessage } from "../app/astra-review.mjs";
import { createReview } from "../app/review.mjs";
import { analyseFillers } from "../app/fillers.mjs";

const transcript = "um " + Array(99).fill("word").join(" ");
function snapshot() {
  return {duration:40, words:100, averageWpm:150, recognitionInterrupted:false,
    recognitionCoverage:{availableSeconds:40,totalSeconds:40,percent:100,reliability:"reliable"},
    pauses:{available:true,incomplete:false,count:2,longestSeconds:15},
    camera:{valid:100,facing:90,spanSeconds:35,incomplete:false},
    fillers:analyseFillers(transcript), cues:{PAUSE:1,LOOK_UP:0,SLOW_DOWN:0}};
}
function validResponse(requestId = "1") {
  return {requestId,model:"gpt-6-astra",review:{coachSummary:"Introduce each idea clearly.",strengths:[],improvements:[],
    structure:Object.fromEntries(["opening","mainPoints","transitions","conclusion"].map(name=>[name,
      {status:"insufficient_evidence",feedback:"No clear evidence.",transcriptQuote:""}])),
    readableTranscript:transcript,limitations:[]}};
}
function setup(fetch) {
  const elements=new Map();
  const node=()=>({textContent:"",hidden:false,children:[],append(...children){this.children.push(...children);},
    replaceChildren(...children){this.children=children;}});
  const document={createElement:node,getElementById(id){if(!elements.has(id))elements.set(id,node());return elements.get(id);}};
  const timers=new Map();let id=0;
  const runtime={fetch,AbortController,setTimeout(fn){timers.set(++id,fn);return id;},clearTimeout(id){timers.delete(id);}};
  return {review:new AstraReview(document,runtime),document,timers};
}

test("request payload excludes frames, audio and arbitrary fields and preserves facts",()=>{
  const raw=snapshot();const profile=createReview(raw);raw.rawAudio="must not send";raw.landmarks=[1,2];
  const payload=astraPayload(transcript,raw,profile,"test");
  assert.equal(payload.measuredFacts.pace.averageWpm,150);
  assert.equal(payload.measuredFacts.fillers.total,1);
  assert.equal(JSON.stringify(payload).includes("must not send"),false);
  payload.measuredFacts.fillers.counts.um=900;
  assert.equal(raw.fillers.counts.um,1);
});
test("valid structured response passes browser validation",()=>{
  assert.equal(validateAstraResponse(validResponse(),"1"),true);
});
test("invalid response fields and changed request identity are rejected",()=>{
  for(const change of [r=>{r.requestId="old";},r=>{delete r.review.structure;},r=>{r.review.pace=20;},
    r=>{r.review.structure.opening.status="great";},r=>{r.review.coachSummary="word ".repeat(81);},
    r=>{r.review.strengths=Array(3).fill({});},r=>{r.review.improvements=Array(4).fill({});}]) {
    const response=validResponse();change(response);assert.equal(validateAstraResponse(response,"1"),false);
  }
});
test("success renders plain text and retains measured profile",async()=>{
  const app=setup(async()=>({ok:true,json:async()=>validResponse()}));
  app.document.getElementById("session-summary").hidden=false;
  app.document.getElementById("average-pace").textContent="150 WPM";
  const raw=snapshot();await app.review.request(transcript,raw,createReview(raw));
  assert.equal(app.document.getElementById("astra-status").textContent,"Coaching review ready.");
  assert.equal(app.document.getElementById("session-summary").hidden,false);
  assert.equal(app.document.getElementById("average-pace").textContent,"150 WPM");
  assert.equal(app.document.getElementById("astra-content").children.length,7);
});
for (const [name,fetch] of [
  ["API failure",async()=>({ok:false})],
  ["network failure",async()=>{throw Error("secret provider detail");}],
  ["invalid JSON",async()=>({ok:true,json:async()=>{throw Error("bad json");}})],
  ["invalid structure",async()=>({ok:true,json:async()=>({})})],
]) {
  test(`${name} shows safe error and retains profile`,async()=>{
    const app=setup(fetch);app.document.getElementById("session-summary").hidden=false;
    const raw=snapshot();await app.review.request(transcript,raw,createReview(raw));
    assert.equal(app.document.getElementById("astra-status").textContent,ASTRA_UNAVAILABLE);
    assert.equal(app.document.getElementById("session-summary").hidden,false);
    assert.equal(app.document.getElementById("astra-content").children.length,0);
  });
}
test("timeout aborts request and late success cannot render",async()=>{
  let resolve;let signal;
  const app=setup((url,options)=>{signal=options.signal;return new Promise(yes=>{resolve=yes;});});
  const raw=snapshot();const waiting=app.review.request(transcript,raw,createReview(raw));
  assert.equal(app.document.getElementById("astra-status").textContent,"Preparing your coaching review...");
  [...app.timers.values()][0]();assert.equal(signal.aborted,true);
  resolve({ok:true,json:async()=>validResponse()});await waiting;
  assert.equal(app.document.getElementById("astra-status").textContent,ASTRA_UNAVAILABLE);
  assert.equal(app.document.getElementById("astra-content").children.length,0);
});
test("new session resets UI and ignores late previous review",async()=>{
  let resolve;
  const app=setup(()=>new Promise(yes=>{resolve=yes;}));const raw=snapshot();
  const waiting=app.review.request(transcript,raw,createReview(raw));app.review.reset();
  resolve({ok:true,json:async()=>validResponse()});await waiting;
  assert.equal(app.document.getElementById("astra-section").hidden,true);
  assert.equal(app.document.getElementById("astra-content").children.length,0);
});
test("empty transcript does not call the API",async()=>{
  let calls=0;const app=setup(()=>{calls++;});const raw=snapshot();
  await app.review.request("",raw,createReview(raw));assert.equal(calls,0);
  assert.equal(app.document.getElementById("astra-status").textContent,ASTRA_UNAVAILABLE);
});

test("development diagnostics are allowlisted and production stays generic", () => {
  for (const category of ["missing_api_key", "invalid_api_key", "model_access_denied", "quota_problem", "timeout", "schema_validation_failure"]) {
    assert.notEqual(astraFailureMessage({development:true,category}), ASTRA_UNAVAILABLE);
    assert.equal(astraFailureMessage({category}), ASTRA_UNAVAILABLE);
  }
  for (const category of ["secret transcript", "__proto__", "constructor"]) {
    assert.equal(astraFailureMessage({development:true,category,error:"sk-secret"}), ASTRA_UNAVAILABLE);
  }
});

test("safe development failure preserves deterministic profile and ignores raw error", async () => {
  const app=setup(async()=>({ok:false,json:async()=>({development:true,category:"quota_problem",error:"sk-secret transcript"})}));
  app.document.getElementById("session-summary").hidden=false;
  app.document.getElementById("average-pace").textContent="150 WPM";
  const raw=snapshot(); await app.review.request(transcript,raw,createReview(raw));
  assert.match(app.document.getElementById("astra-status").textContent,/quota or billing problem/);
  assert.doesNotMatch(app.document.getElementById("astra-status").textContent,/sk-secret/);
  assert.equal(app.document.getElementById("session-summary").hidden,false);
  assert.equal(app.document.getElementById("average-pace").textContent,"150 WPM");
});

test("Astra payload keeps original fractional pace in measured facts", () => {
  const raw = snapshot();
  raw.averageWpm = 125.6;
  const before = structuredClone(raw);
  const profile = createReview(raw);
  const payload = astraPayload(transcript, raw, profile, "fractional-pace");
  assert.equal(payload.measuredFacts.pace.averageWpm, 125.6);
  assert.equal(profile.pace.averageWpm, 125.6);
  assert.deepEqual(raw, before);
});

test("review uses readable structure labels and hides empty feedback without hiding limitations", () => {
  const app = setup();
  const response = validResponse();
  response.review.structure.mainPoints.status = "weak";
  response.review.limitations = ["Recognition coverage was partial."];
  app.review.render(response);
  const sections = app.document.getElementById("astra-content").children;
  assert.equal(sections[1].hidden, true);
  assert.equal(sections[2].hidden, true);
  assert.equal(sections[3].hidden, false);
  assert.equal(sections[3].children[1].textContent, "Recognition coverage was partial.");
  assert.match(sections[4].children[2].textContent, /^Not enough evidence/);
  assert.match(sections[4].children[4].textContent, /^Needs development/);
  assert.equal(sections[5].children[0].textContent, "Readable transcript");
  assert.equal(sections[5].children[1].textContent, transcript);
  assert.equal(sections[6].textContent, "Contextual review powered by GPT-6 Astra.");
});

test("structure explanations appear once while practical suggestions remain visible", () => {
  const app = setup();
  const response = validResponse();
  response.review.structure.opening = {status: "present", feedback: "You state the topic clearly.", transcriptQuote: "um"};
  response.review.structure.conclusion = {status: "weak", feedback: "The ending trails off.", transcriptQuote: "word"};
  response.review.strengths = [{area: "opening", heading: "Opening", feedback: "You state the topic clearly.", evidenceRefs: ["structure.opening"]}];
  response.review.improvements = [{area: "conclusion", heading: "Conclusion", evidence: "The ending trails off.", suggestion: "Finish with a clear next step.", evidenceRefs: ["structure.conclusion"]}];
  app.review.render(response);
  const sections = app.document.getElementById("astra-content").children;
  assert.equal(sections[1].hidden, true);
  assert.equal(sections[2].hidden, false);
  assert.equal(sections[2].children[2].textContent, "Finish with a clear next step.");
  assert.equal(sections[2].children.length, 3);
  assert.match(sections[4].children[2].textContent, /You state the topic clearly/);
  assert.match(sections[4].children[8].textContent, /The ending trails off/);
});
