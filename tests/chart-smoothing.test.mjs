import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const sourceStart = html.indexOf("    function smoothLine(context, points) {");
const sourceEnd = html.indexOf("    function drawChart(metric) {", sourceStart);

assert.notEqual(sourceStart, -1, "smoothLine should be present in the application script");
assert.notEqual(sourceEnd, -1, "smoothLine should end before drawChart");

const source = html.slice(sourceStart, sourceEnd);
const smoothLine = new Function(source + "\nreturn smoothLine;")();

function draw(points) {
  const calls = [];
  const context = {
    beginPath() {},
    moveTo() {},
    lineTo(...args) { calls.push({ type: "line", args }); },
    bezierCurveTo(...args) { calls.push({ type: "bezier", args }); },
    stroke() {}
  };
  smoothLine(context, points);
  return calls;
}

test("smooth chart curves keep control points inside uneven age intervals", () => {
  const points = [
    { x: 0, y: 35 },
    { x: 2, y: 40 },
    { x: 4, y: 42 },
    { x: 6, y: 44 },
    { x: 22, y: 47.6 }
  ];
  const curves = draw(points);

  assert.equal(curves.length, points.length - 1);
  curves.forEach(function (curve, index) {
    assert.equal(curve.type, "bezier");
    assert.ok(curve.args[0] >= points[index].x && curve.args[0] <= points[index + 1].x);
    assert.ok(curve.args[2] >= points[index].x && curve.args[2] <= points[index + 1].x);
  });
});

test("smooth chart curves do not overshoot monotone measurements", () => {
  const points = [
    { x: 0, y: 35 },
    { x: 2, y: 40 },
    { x: 4, y: 42 },
    { x: 6, y: 44 },
    { x: 22, y: 47.6 }
  ];
  const curves = draw(points);

  curves.forEach(function (curve, index) {
    const lower = Math.min(points[index].y, points[index + 1].y);
    const upper = Math.max(points[index].y, points[index + 1].y);
    assert.ok(curve.args[1] >= lower && curve.args[1] <= upper);
    assert.ok(curve.args[3] >= lower && curve.args[3] <= upper);
  });
});

test("duplicate ages are joined without invalid curve math", () => {
  const calls = draw([
    { x: 0, y: 35 },
    { x: 2, y: 40 },
    { x: 2, y: 41 },
    { x: 6, y: 44 }
  ]);

  assert.deepEqual(calls.map(function (call) { return call.type; }), ["line", "line", "line"]);
  calls.forEach(function (call) {
    call.args.forEach(function (value) { assert.ok(Number.isFinite(value)); });
  });
});
