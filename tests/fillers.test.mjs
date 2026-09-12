import assert from "node:assert/strict";
import test from "node:test";
import { analyseFillers } from "../app/fillers.mjs";

test("no fillers returns zero", () => {
  assert.equal(analyseFillers("Today we present our project.").totalFillers, 0);
});
test("single filler is counted", () => {
  const result = analyseFillers("Um, welcome.");
  assert.equal(result.totalFillers, 1);
  assert.equal(result.counts.um, 1);
});
test("repeated filler counts each occurrence", () => {
  assert.equal(analyseFillers("um um um").counts.um, 3);
});
test("matching is case insensitive", () => {
  assert.equal(analyseFillers("UM Um um ACTUALLY Actually").totalFillers, 5);
});
test("whole-word matching rejects substrings and contractions", () => {
  const result = analyseFillers("aluminium unlike likelihood actually's actually");
  assert.equal(result.totalFillers, 1);
  assert.equal(result.counts.actually, 1);
});
test("you know is one occurrence but two recognised words", () => {
  const result = analyseFillers("you know");
  assert.equal(result.totalFillers, 1);
  assert.equal(result.counts["you know"], 1);
  assert.equal(result.totalWords, 2);
});
test("multiple types produce a complete correct breakdown", () => {
  const result = analyseFillers("Um uh erm like you know basically actually um");
  assert.equal(result.totalFillers, 8);
  assert.deepEqual(result.counts, {um: 2, uh: 1, erm: 1, ah: 0, like: 1, "you know": 1, basically: 1, actually: 1});
});
test("two occurrences in 20 words give 10 per 100 words", () => {
  const result = analyseFillers("um uh " + Array(18).fill("word").join(" "));
  assert.equal(result.totalWords, 20);
  assert.equal(result.ratePer100Words, 10);
});
test("fewer than 20 words returns count but no meaningful rate", () => {
  const result = analyseFillers("um " + Array(18).fill("word").join(" "));
  assert.equal(result.totalWords, 19);
  assert.equal(result.totalFillers, 1);
  assert.equal(result.ratePer100Words, null);
});
test("empty transcript is safe and has no rate", () => {
  const result = analyseFillers("");
  assert.equal(result.totalFillers, 0);
  assert.equal(result.totalWords, 0);
  assert.equal(result.ratePer100Words, null);
});
test("revised and duplicate snapshots never accumulate counts", () => {
  assert.equal(analyseFillers("um um").totalFillers, 2);
  assert.equal(analyseFillers("um welcome").totalFillers, 1);
  assert.equal(analyseFillers("um welcome").totalFillers, 1);
  assert.equal(analyseFillers("welcome").totalFillers, 0);
});
test("longest configured phrase wins overlapping phrase matches", () => {
  const result = analyseFillers("you know what you know", ["you know", "you know what", "know what"]);
  assert.deepEqual(result.counts, {"you know": 1, "you know what": 1, "know what": 0});
  assert.equal(result.totalFillers, 2);
});
test("explicitly configured single words can also count inside a phrase", () => {
  const result = analyseFillers("you know", ["you know", "you", "know"]);
  assert.equal(result.totalFillers, 3);
  assert.deepEqual(result.counts, {"you know": 1, you: 1, know: 1});
});
test("duplicate configuration entries do not double count", () => {
  const result = analyseFillers("um you know", ["UM", "um", " you   know ", "you know"]);
  assert.equal(result.totalFillers, 2);
});
test("punctuation and whitespace separate adjacent phrase tokens", () => {
  assert.equal(analyseFillers("You, KNOW! You\nknow.").counts["you know"], 2);
  assert.equal(analyseFillers("you really know").totalFillers, 0);
});
test("empty configuration disables matches without changing word count", () => {
  const result = analyseFillers("um actually", []);
  assert.equal(result.totalFillers, 0);
  assert.equal(result.totalWords, 2);
});
test("invalid inputs fail clearly", () => {
  for (const text of [null, undefined, 42]) assert.throws(() => analyseFillers(text), TypeError);
  for (const list of [null, "um", [""], ["..."], [42]]) assert.throws(() => analyseFillers("hello", list), TypeError);
});

test("um and umm use the canonical um label", () => {
  const result = analyseFillers("um umm");
  assert.equal(result.counts.um, 2);
  assert.equal(result.totalFillers, 2);
  assert.equal(Object.hasOwn(result.counts, "umm"), false);
});

test("uh and uhh use the canonical uh label", () => {
  const result = analyseFillers("uh uhh");
  assert.equal(result.counts.uh, 2);
  assert.equal(result.totalFillers, 2);
  assert.equal(Object.hasOwn(result.counts, "uhh"), false);
});

test("uppercase vocal variants normalise case insensitively", () => {
  const result = analyseFillers("UM UMM Uh UHH AH ERM");
  assert.equal(result.counts.um, 2);
  assert.equal(result.counts.uh, 2);
  assert.equal(result.counts.ah, 1);
  assert.equal(result.counts.erm, 1);
  assert.equal(result.totalFillers, 6);
});

test("mixed variants match the requested canonical breakdown", () => {
  const result = analyseFillers("umm umm uh uhh ah");
  const detected = Object.fromEntries(Object.entries(result.counts).filter(([, count]) => count > 0));
  assert.deepEqual(detected, {um: 2, uh: 2, ah: 1});
  assert.equal(result.totalWords, 5);
});

test("ah and erm count as distinct canonical fillers", () => {
  const result = analyseFillers("ah erm ah");
  assert.equal(result.counts.ah, 2);
  assert.equal(result.counts.erm, 1);
  assert.equal(result.totalFillers, 3);
});

test("variants never match inside larger words or unsupported spellings", () => {
  const result = analyseFillers("summer humming aluminium uhhuh ahead perhaps ermine ahh ummm's uhhh2");
  assert.equal(result.totalFillers, 0);
});

test("vocal variants coexist with the existing phrase fillers", () => {
  const result = analyseFillers("UMM you know basically actually like UHH");
  assert.equal(result.totalFillers, 6);
  for (const name of ["um", "you know", "basically", "actually", "like", "uh"]) {
    assert.equal(result.counts[name], 1);
  }
});

test("configured aliases deduplicate and report canonical labels", () => {
  const result = analyseFillers("umm um uh uhh", ["umm", "um", "UHH", "uh"]);
  assert.deepEqual(result.counts, {um: 2, uh: 2});
  assert.equal(result.totalFillers, 4);
});

test("variant normalisation preserves recognised word count and rate arithmetic", () => {
  const result = analyseFillers("ummmmm uhhhh " + Array(18).fill("word").join(" "));
  assert.equal(result.totalWords, 20);
  assert.equal(result.ratePer100Words, 10);
});

test("all repeated m forms use the canonical um label", () => {
  const result = analyseFillers("um umm ummm ummmm ummmmm");
  assert.equal(result.counts.um, 5);
  assert.equal(result.totalFillers, 5);
  assert.equal(result.totalWords, 5);
});

test("all repeated h forms use the canonical uh label", () => {
  const result = analyseFillers("uh uhh uhhh uhhhh");
  assert.equal(result.counts.uh, 4);
  assert.equal(result.totalFillers, 4);
});

test("long uppercase variants coexist with existing fillers and phrases", () => {
  const result = analyseFillers("UMMMM, UHHHH! ERM ah like you know basically actually");
  assert.equal(result.totalFillers, 8);
  assert.equal(result.totalWords, 9);
  for (const count of Object.values(result.counts)) assert.equal(count, 1);
});

test("long configured variants deduplicate without rewriting the transcript", () => {
  const transcript = "UMMMM uhHHH";
  const result = analyseFillers(transcript, ["ummmmm", "um", "uhhhh", "uh"]);
  assert.deepEqual(result.counts, {um: 1, uh: 1});
  assert.equal(transcript, "UMMMM uhHHH");
});
