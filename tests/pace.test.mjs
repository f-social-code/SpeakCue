import assert from "node:assert/strict";
import test from "node:test";
import { countWords, PaceTracker } from "../app/pace.mjs";

const words = (count) => Array(count).fill("word").join(" ");

test("English word counting ignores punctuation and keeps contractions", () => {
  assert.equal(countWords("Hello, world! I’m speaking. ..."), 4);
  assert.equal(countWords(""), 0);
});

test("60 words in 20 seconds = 180 WPM", () => {
  const pace = new PaceTracker();
  pace.observe([words(60)], 1);
  assert.deepEqual(pace.estimate(20), {state: "ready", wpm: 180});
  assert.equal(pace.summary(20).averageWpm, 180);
});

test("ordinary arithmetic: 40 words in 20 seconds = 120 WPM", () => {
  const pace = new PaceTracker();
  pace.observe([words(40)], 5);
  assert.equal(pace.estimate(20).wpm, 120);
});

test("warm-up lasts a full 20 seconds", () => {
  const pace = new PaceTracker();
  pace.observe([words(10)], 1);
  assert.deepEqual(pace.estimate(19), {state: "measuring", wpm: null});
});

test("words age out during pauses without needing more callbacks", () => {
  const pace = new PaceTracker();
  pace.observe([words(30)], 1);
  pace.observe([words(60)], 10);
  assert.equal(pace.estimate(20).wpm, 180);
  assert.equal(pace.estimate(22).wpm, 90);
  assert.deepEqual(pace.estimate(30), {state: "waiting", wpm: null});
});

test("interim growth, shrinking and finalisation replace word positions", () => {
  const pace = new PaceTracker();
  pace.observe(["one two"], 1);
  pace.observe(["one two three"], 2);
  pace.observe(["one four"], 3);
  pace.observe(["one four", "next words"], 4);
  pace.observe(["one four", "next words"], 5);
  assert.equal(pace.summary(20).words, 4);
  assert.equal(pace.estimate(20).wpm, 12);
  assert.equal(pace.estimate(22).wpm, 6);
});

test("duplicate callbacks neither inflate pace nor refresh old word times", () => {
  const pace = new PaceTracker();
  pace.observe([words(60)], 1);
  pace.observe([words(60)], 19);
  assert.equal(pace.estimate(20).wpm, 180);
  assert.deepEqual(pace.estimate(21), {state: "waiting", wpm: null});
});

test("removed interim results remove their words", () => {
  const pace = new PaceTracker();
  pace.observe(["final phrase", "temporary words"], 1);
  pace.observe(["final phrase"], 2);
  assert.equal(pace.summary(20).words, 2);
});

test("repeated real phrases at different result indexes are counted", () => {
  const pace = new PaceTracker();
  pace.observe(["hello world", "hello world"], 1);
  assert.equal(pace.summary(20).words, 4);
});

test("new session resets all observations and timing", () => {
  const pace = new PaceTracker();
  pace.observe([words(60)], 1);
  pace.reset(100);
  assert.deepEqual(pace.summary(100), {duration: 0, words: 0, averageWpm: null});
  assert.equal(pace.estimate(101).state, "measuring");
  assert.equal(pace.estimate(120).state, "waiting");
});

test("invalid and out-of-order observations suppress the metric", () => {
  for (const [phrases, time] of [[null, 3], [[null], 3], [["text"], NaN], [["text"], 1]]) {
    const pace = new PaceTracker();
    pace.observe([words(30)], 2);
    assert.equal(pace.observe(phrases, time), false);
    assert.deepEqual(pace.estimate(20), {state: "waiting", wpm: null});
    assert.equal(pace.summary(20).averageWpm, null);
  }
});

test("invalid query times and empty speech never yield a numeric pace", () => {
  const pace = new PaceTracker();
  assert.equal(pace.estimate(NaN).wpm, null);
  assert.equal(pace.estimate(-1).wpm, null);
  assert.equal(pace.estimate(30).wpm, null);
  assert.equal(pace.summary(30).averageWpm, null);
  assert.throws(() => pace.reset(-1), RangeError);
});

test("session average includes the pause after the last word", () => {
  const pace = new PaceTracker();
  pace.observe([words(60)], 1);
  assert.deepEqual(pace.summary(40), {duration: 40, words: 60, averageWpm: 90});
});
