import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const sourceStart = html.indexOf("    function referenceValuesAtAge");
const sourceEnd = html.indexOf("    function smoothLine", sourceStart);

assert.notEqual(sourceStart, -1, "chart summary helpers should be present in the application script");
assert.notEqual(sourceEnd, -1, "chart summary helpers should end before smoothLine");

const source = html.slice(sourceStart, sourceEnd);
const createHelpers = new Function(
  "state",
  "ageMonths",
  "daysBetween",
  "todayIso",
  "METRICS",
  "document",
  "metricRows",
  source + "\nreturn { percentileForMeasurement, relativeMeasurementDate, renderChartSummaries };"
);

function fixture(value = 50, daysAgo = 23) {
  const row = { type: "length", measuredOn: "2026-07-16", valueMetric: value };
  const summary = { textContent: "" };
  const state = {
    profile: { sex: "male", dateOfBirth: "2024-01-01" },
    references: {
      data: {
        male: {
          length: [
            { month: 0, p3: 3, p15: 15, p50: 50, p85: 85, p97: 97 },
            { month: 2, p3: 13, p15: 25, p50: 60, p85: 95, p97: 107 }
          ]
        }
      }
    }
  };
  const metrics = {
    length: { currentLabel: "Length/height", canonicalUnit: "cm", decimals: 1 }
  };
  const helpers = createHelpers(
    state,
    () => 1,
    () => daysAgo,
    () => "2026-08-08",
    metrics,
    { querySelector: () => summary },
    () => [row]
  );
  return { helpers, row, summary };
}

test("chart summary interpolates an age-matched percentile", () => {
  const { helpers, row } = fixture();
  assert.equal(helpers.percentileForMeasurement(row, "length"), "45th percentile");
});

test("chart summary labels values beyond the outer reference curves", () => {
  const below = fixture(7);
  const above = fixture(103);
  assert.equal(below.helpers.percentileForMeasurement(below.row, "length"), "<3rd percentile");
  assert.equal(above.helpers.percentileForMeasurement(above.row, "length"), ">97th percentile");
});

test("chart header shows the current value, percentile, and relative date", () => {
  const { helpers, summary } = fixture();
  helpers.renderChartSummaries();
  assert.equal(summary.textContent, "Current Length/height 50 cm (45th percentile) · 23 days ago");
});

test("relative measurement dates use friendly labels", () => {
  assert.equal(fixture(50, 0).helpers.relativeMeasurementDate("2026-08-08"), "today");
  assert.equal(fixture(50, 1).helpers.relativeMeasurementDate("2026-08-07"), "yesterday");
});
