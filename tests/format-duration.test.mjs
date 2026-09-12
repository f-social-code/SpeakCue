import assert from "node:assert/strict";
import test from "node:test";
import { formatDuration } from "../app/format-duration.mjs";

test("duration under one minute uses seconds", () => {
  assert.equal(formatDuration(0), "0 sec");
  assert.equal(formatDuration(45), "45 sec");
});

test("exactly one minute omits zero seconds", () => {
  assert.equal(formatDuration(60), "1 min");
});

test("duration combines minutes with rounded seconds", () => {
  assert.equal(formatDuration(67.6), "1 min 8 sec");
  assert.equal(formatDuration(125), "2 min 5 sec");
});

test("long duration retains total minutes", () => {
  assert.equal(formatDuration(3600), "60 min");
  assert.equal(formatDuration(7325), "122 min 5 sec");
});

test("rounding carries into the next minute", () => {
  assert.equal(formatDuration(59.4), "59 sec");
  assert.equal(formatDuration(59.5), "1 min");
  assert.equal(formatDuration(119.9), "2 min");
});

test("invalid duration has a safe display fallback", () => {
  for (const value of [-1, NaN, Infinity, null, undefined, "60"]) {
    assert.equal(formatDuration(value), "Unavailable");
  }
});
