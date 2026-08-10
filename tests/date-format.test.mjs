import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const sourceStart = html.indexOf("    function formatDate");
const sourceEnd = html.indexOf("    function daysBetween", sourceStart);

assert.notEqual(sourceStart, -1, "date formatter should be present in the application script");
assert.notEqual(sourceEnd, -1, "date formatter should end before daysBetween");

const formatDate = new Function(html.slice(sourceStart, sourceEnd) + "\nreturn formatDate;")();

test("graph table dates use year, abbreviated month, and day", () => {
  assert.equal(formatDate("2026-05-28", false), "2026 May 28");
});
