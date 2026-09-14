import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const references = JSON.parse(await readFile(new URL("../public/growth-data.json", import.meta.url), "utf8"));
const publishedPercentiles = JSON.parse(await readFile(new URL("./fixtures/who-bmi-head-percentiles.json", import.meta.url), "utf8"));
const sourceStart = html.indexOf("    function referenceLmsAtAge");
const sourceEnd = html.indexOf("    function smoothLine", sourceStart);
assert.notEqual(sourceStart, -1);
assert.notEqual(sourceEnd, -1);

// Exercise the date helpers used by the real frontend, including UTC day arithmetic.
const dateSource = html.slice(html.indexOf("    function daysBetween"), html.indexOf("    function formatAge"));
const createHelpers = new Function(
  "state", "todayIso", "METRICS", "document", "metricRows",
  dateSource + html.slice(sourceStart, sourceEnd) +
    "\nreturn { referenceLmsAtAge, normalCdf, lmsZScore, measurementPercentile, percentileForMeasurement, relativeMeasurementDate, renderChartSummaries, daysBetween };"
);

function fixture({ value = 89, sex = "male", metric = "length", born = "2024-05-19", measured = "2026-09-14", today = "2026-10-07" } = {}) {
  const row = { type: metric, measuredOn: measured, valueMetric: value };
  const summary = { textContent: "" };
  const state = { profile: { sex, dateOfBirth: born }, references };
  const helpers = createHelpers(
    state,
    () => today,
    { [metric]: { currentLabel: "Length/height", canonicalUnit: "cm", decimals: 1 } },
    { querySelector: () => summary },
    () => [row]
  );
  return { helpers, row, summary, state };
}

function closeTo(actual, expected, tolerance = 0.00001) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should be within ${tolerance} of ${expected}`);
}

test("848-day comparison agrees with WHO daily LMS values and an independent normal CDF", () => {
  // Expected percentages computed independently with Python math.erf from WHO day 848.
  const cases = [
    ["male", "weight", 11.9, [-0.0331, 12.904, 0.11655], 24.32444537162396, "24th percentile"],
    ["male", "length", 89, [1, 90.3026, 0.03638], 34.58664431218275, "35th percentile"],
    ["female", "weight", 11.9, [-0.3054, 12.2775, 0.12501], 40.09014484460559, "40th percentile"],
    ["female", "length", 89, [1, 88.9874, 0.03848], 50.14679661782997, "50th percentile"],
  ];
  for (const [sex, metric, value, lms, expected, label] of cases) {
    const { helpers, row } = fixture({ sex, metric, value });
    assert.equal(helpers.daysBetween("2024-05-19", row.measuredOn), 848);
    assert.deepEqual(helpers.referenceLmsAtAge(metric, 848), lms);
    closeTo(helpers.measurementPercentile(row, metric), expected);
    assert.equal(helpers.percentileForMeasurement(row, metric), label);
  }
});

test("daily tables cover both sexes and all metrics with valid parameters and median ranks", () => {
  for (const sex of ["male", "female"]) {
    for (const metric of ["length", "weight", "head", "bmi"]) {
      const rows = references.lms[sex][metric];
      assert.equal(rows.length, 1857);
      for (const [l, m, s] of rows) {
        assert.ok([l, m, s].every(Number.isFinite) && m > 0 && s > 0);
      }
      for (const day of [0, 1, 90, 365, 730, 731, 848, 1826]) {
        const measured = new Date(Date.parse("2020-01-01") + day * 86400000).toISOString().slice(0, 10);
        const { helpers, row } = fixture({ sex, metric, born: "2020-01-01", measured, value: rows[day][1] });
        assert.equal(helpers.percentileForMeasurement(row, metric), "50th percentile");
      }
    }
  }
});

test("BMI and head circumference agree with independent WHO published percentiles", () => {
  // These measurements come from WHO's separate percentile workbooks, not our LMS generator.
  // WHO publishes them to 0.001 kg/m² or cm, which introduces a small inverse-CDF error.
  for (const { sex, metric, rows } of publishedPercentiles.sources) {
    for (const [day, values] of rows) {
      const measured = new Date(Date.parse("2020-01-01") + day * 86400000).toISOString().slice(0, 10);
      for (const [index, value] of values.entries()) {
        const expected = publishedPercentiles.percentiles[index];
        const { helpers, row } = fixture({ sex, metric, born: "2020-01-01", measured, value });
        closeTo(helpers.measurementPercentile(row, metric), expected, 0.025);
        assert.equal(helpers.percentileForMeasurement(row, metric),
          expected < 3 ? "<3rd percentile" : expected > 97 ? ">97th percentile" : `${expected}th percentile`);
      }
    }
  }
});

test("length and BMI preserve WHO's day 730/731 measurement transition", () => {
  const { helpers } = fixture();
  assert.deepEqual(helpers.referenceLmsAtAge("length", 730), [1, 87.8018, 0.03479]);
  assert.deepEqual(helpers.referenceLmsAtAge("length", 731), [1, 87.1303, 0.03508]);
  for (const sex of ["male", "female"]) {
    for (const metric of ["length", "bmi"]) {
      const curves = references.data[sex][metric];
      for (const day of [730, 731]) {
        const curve = curves.find((r) => r.month === day / 30.4375);
        assert.ok(curve, `${sex} ${metric} needs a chart point at day ${day}`);
        closeTo(curve.p50, references.lms[sex][metric][day][1]);
      }
    }
  }
});

test("normal CDF and LMS handle symmetry, skew, L=0, and WHO extended tails", () => {
  const { helpers } = fixture();
  closeTo(helpers.normalCdf(-1), 0.15865525393145707, 1e-7);
  closeTo(helpers.normalCdf(1), 0.8413447460685429, 1e-7);
  closeTo(helpers.lmsZScore(10 * Math.exp(0.2), [0, 10, 0.1], "weight"), 2);
  // L=1/2, M=10, S=.2: +2SD=14.4, +3SD=16.9; -2SD=6.4, -3SD=4.9.
  closeTo(helpers.lmsZScore(19.4, [0.5, 10, 0.2], "weight"), 4);
  closeTo(helpers.lmsZScore(3.4, [0.5, 10, 0.2], "bmi"), -4);
});

test("missing setup, invalid values, and ages outside 0–60 months have no percentile", () => {
  for (const options of [
    { sex: null }, { born: null }, { measured: null }, { measured: "invalid" },
    { measured: "2024-05-18" }, { measured: "2030-05-19" },
    { value: null }, { value: 0 }, { value: -1 }, { value: NaN }, { value: Infinity }
  ]) {
    const { helpers, row } = fixture(options);
    assert.equal(helpers.percentileForMeasurement(row, "length"), null);
  }
  const { helpers, row, state } = fixture();
  assert.equal(helpers.referenceLmsAtAge("length", 1827), null);
  assert.equal(helpers.referenceLmsAtAge("length", 848.5), null);
  assert.equal(helpers.percentileForMeasurement(null, "length"), null);
  state.references = null;
  assert.equal(helpers.percentileForMeasurement(row, "length"), null);
});

test("date arithmetic includes leap days and is unaffected by daylight saving", () => {
  const { helpers } = fixture();
  assert.equal(helpers.daysBetween("2024-02-28", "2024-03-01"), 2);
  assert.equal(helpers.daysBetween("2026-03-07", "2026-03-09"), 2);
});

test("chart summary labels values beyond the outer reference curves", () => {
  const below = fixture({ value: 75 });
  const above = fixture({ value: 105 });
  assert.equal(below.helpers.percentileForMeasurement(below.row, "length"), "<3rd percentile");
  assert.equal(above.helpers.percentileForMeasurement(above.row, "length"), ">97th percentile");
});

test("chart header shows the current value, percentile, and relative date", () => {
  const { helpers, summary } = fixture();
  helpers.renderChartSummaries();
  assert.equal(summary.textContent, "Current Length/height 89 cm (35th percentile) · 23 days ago");
});

test("relative measurement dates use friendly labels", () => {
  assert.equal(fixture().helpers.relativeMeasurementDate("2026-10-07"), "today");
  assert.equal(fixture().helpers.relativeMeasurementDate("2026-10-06"), "yesterday");
});
