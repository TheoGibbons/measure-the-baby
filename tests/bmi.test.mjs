import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const references = JSON.parse(await readFile(new URL("../public/growth-data.json", import.meta.url), "utf8"));
const dateSource = html.slice(html.indexOf("    function daysBetween"), html.indexOf("    function formatAge"));
const measurementSource = html.slice(html.indexOf("    function displayNumber"), html.indexOf("    function tableRowHtml"));
const percentileSource = html.slice(html.indexOf("    function referenceLmsAtAge"), html.indexOf("    function relativeMeasurementDate"));
const createHelpers = new Function("state", "METRICS", dateSource + measurementSource + percentileSource +
  "\nreturn { derivedBmiRows, metricRows, displayNumber, measurementPercentile, percentileForMeasurement };");

function measurement(type, valueMetric, measuredOn = "2026-09-14", id = 1) {
  return { id, type, valueMetric, measuredOn, unitEntered: type === "weight" ? "kg" : type === "bmi" ? "kg/m2" : "cm" };
}

function fixture(measurements = [measurement("weight", 11.9), measurement("length", 89)]) {
  const state = { profile: { sex: "male", dateOfBirth: "2024-05-19" }, measurements, references };
  return { state, ...createHelpers(state, { bmi: { decimals: 1, canonicalUnit: "kg/m2" } }) };
}

test("BMI keeps full precision through the WHO percentile calculation and rounds only for display", () => {
  const helpers = fixture();
  const [bmi] = helpers.derivedBmiRows();
  assert.ok(Math.abs(bmi.valueMetric - 15.02335563691453) < 1e-12);
  assert.equal(bmi.unitEntered, "kg/m2");
  // Independent WHO day-848 LMS calculation, converted with Python math.erf.
  assert.ok(Math.abs(helpers.measurementPercentile(bmi, "bmi") - 23.812967751766962) < 0.00001);
  assert.equal(helpers.percentileForMeasurement(bmi, "bmi"), "24th percentile");
  assert.equal(helpers.displayNumber(bmi, "bmi"), "15 kg/m²");
});

test("premature BMI rounding cannot change the displayed percentile", () => {
  const helpers = fixture([measurement("weight", 13.12), measurement("length", 89)]);
  const [bmi] = helpers.derivedBmiRows();
  // Rounding BMI to 16.56 first incorrectly gave 70th instead of 71st.
  assert.ok(Math.abs(helpers.measurementPercentile(bmi, "bmi") - 70.54345014490335) < 0.00001);
  assert.equal(helpers.percentileForMeasurement(bmi, "bmi"), "71st percentile");
});

test("BMI uses same-day measurements and defers to a manually entered BMI", () => {
  const helpers = fixture([
    measurement("length", 89), measurement("weight", 11.9, "2026-09-13"),
    measurement("head", 48),
  ]);
  assert.deepEqual(helpers.metricRows("bmi"), []);
  helpers.state.measurements.push(measurement("weight", 11.9));
  assert.equal(helpers.metricRows("bmi").length, 1);
  const manual = measurement("bmi", 15.0234);
  helpers.state.measurements.push(manual);
  assert.deepEqual(helpers.metricRows("bmi"), [manual]);
});

test("BMI reflects the latest same-day entries, edits, and deletions", () => {
  // The API returns same-day entries in ascending ID order.
  const helpers = fixture([
    measurement("length", 88, "2026-09-14", 1), measurement("weight", 11.8, "2026-09-14", 2),
    measurement("length", 89, "2026-09-14", 3), measurement("weight", 11.9, "2026-09-14", 4),
  ]);
  assert.ok(Math.abs(helpers.derivedBmiRows()[0].valueMetric - 15.02335563691453) < 1e-12);
  helpers.state.measurements[3].valueMetric = 12;
  assert.ok(Math.abs(helpers.derivedBmiRows()[0].valueMetric - 12 / 0.89 ** 2) < 1e-12);
  helpers.state.measurements = helpers.state.measurements.filter((row) => row.type !== "length");
  assert.deepEqual(helpers.derivedBmiRows(), []);
});
