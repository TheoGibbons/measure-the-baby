import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("profile deletion is visible, connected, and requires confirmation", () => {
  assert.match(html, /id="deleteProfileButton"[^>]*>Delete profile<\/button>/);
  assert.match(html, /byId\("deleteProfileButton"\)\.addEventListener\("click", deleteProfile\)/);

  const deleteStart = html.indexOf("    async function deleteProfile() {");
  const deleteEnd = html.indexOf("    async function signOut()", deleteStart);
  const deleteSource = html.slice(deleteStart, deleteEnd);

  assert.match(deleteSource, /if \(!confirm\([\s\S]*?\)\) return;/);
  assert.match(deleteSource, /method: "DELETE"/);
});
