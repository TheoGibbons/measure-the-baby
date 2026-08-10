import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("printing establishes paper-sized chart geometry before redrawing", () => {
  const prepareStart = html.indexOf("    function preparePrint() {");
  const prepareEnd = html.indexOf("    function finishPrint()", prepareStart);
  const prepareSource = html.slice(prepareStart, prepareEnd);

  assert.match(prepareSource, /classList\.add\("print-layout"\)/);
  assert.ok(
    prepareSource.indexOf('classList.add("print-layout")') < prepareSource.indexOf("drawAllCharts()"),
    "print layout must be applied before chart canvases are redrawn"
  );
  assert.match(html, /html\.print-layout \.page-shell \{ width: 7\.86in;/);
  assert.match(html, /html\.print-layout \.chart-card \{[\s\S]*?height: 4\.65in;/);
});

test("print cleanup restores the responsive chart layout", () => {
  const finishStart = html.indexOf("    function finishPrint() {");
  const finishEnd = html.indexOf("    function printCharts()", finishStart);
  const finishSource = html.slice(finishStart, finishEnd);

  assert.match(finishSource, /classList\.remove\("print-layout"\)/);
  assert.match(finishSource, /scheduleDraw\(\)/);
});

test("the print table shares the chart plot's bottom-right margins", () => {
  assert.match(html, /html\.print-layout \.chart-table-wrap \{\s*right: 20px;\s*bottom: 42px;/);
  assert.match(html, /var margin = \{ left: rect\.width < 480 \? 43 : 50, right: 20, top: 19, bottom: 42 \};/);
});
