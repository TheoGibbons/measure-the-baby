import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const sourceStart = html.indexOf("    function chartAgeRange() {");
const sourceEnd = html.indexOf("    function referenceRows", sourceStart);

assert.notEqual(sourceStart, -1, "chartAgeRange should be present in the application script");
assert.notEqual(sourceEnd, -1, "chartAgeRange should end before referenceRows");

const source = html.slice(sourceStart, sourceEnd);
const calculateRange = new Function("state", "ageMonths", "niceStep", source + "\nreturn chartAgeRange();");
const niceStep = () => 20;

function rangeFor(measurements, hasDateOfBirth = true) {
  return calculateRange(
    { profile: hasDateOfBirth ? { dateOfBirth: "2024-01-01" } : {}, measurements },
    (measuredOn) => Number(measuredOn),
    niceStep
  );
}

test("chart range uses the latest measurement across every metric", () => {
  const measurements = [
    { type: "length", measuredOn: 18 },
    { type: "weight", measuredOn: 26 },
    { type: "head", measuredOn: 24 },
    { type: "bmi", measuredOn: 20 }
  ];

  assert.deepEqual(rangeFor(measurements), { max: 30, step: 6 });
});

test("chart range leaves space after a measurement on a tick", () => {
  assert.deepEqual(rangeFor([{ type: "length", measuredOn: 24 }]), { max: 27, step: 3 });
});

test("chart range stays compact when there are no measurements", () => {
  assert.deepEqual(rangeFor([]), { max: 2, step: 1 });
  assert.deepEqual(rangeFor([{ type: "length", measuredOn: 26 }], false), { max: 2, step: 1 });
});
