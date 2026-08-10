import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = await mkdtemp(join(tmpdir(), "measure-the-baby-test-"));
process.env.DATABASE_PATH = join(testDir, "test.sqlite");
process.env.PORT = "0";
const { createApp, closeDatabase } = await import("../server.mjs?test=" + Date.now());
const server = createApp();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

async function request(path, options = {}, cookie = "") {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body !== "string") {
    headers["content-type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  if (cookie) headers.cookie = cookie;
  const response = await fetch(baseUrl + path, { ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { response, body, cookie: response.headers.get("set-cookie")?.split(";")[0] || cookie };
}

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDatabase();
  await rm(testDir, { recursive: true, force: true });
});

test("health and static shell are available", async () => {
  const health = await request("/healthz");
  assert.equal(health.response.status, 200);
  assert.equal(health.body, "ok");
  const shell = await request("/");
  assert.equal(shell.response.status, 200);
  assert.match(shell.body, /Measure the Baby/);
});

test("signup-or-login, profile ownership, and measurement lifecycle", async () => {
  const signup = await request("/api/auth", {
    method: "POST",
    body: { email: "parent@example.com", password: "correct horse" },
  });
  assert.equal(signup.response.status, 201);
  assert.equal(signup.body.created, true);
  const cookie = signup.cookie;
  assert.match(cookie, /^growth_session=/);

  const created = await request("/api/profiles", { method: "POST", body: {} }, cookie);
  assert.equal(created.response.status, 201);
  assert.equal(created.body.profile.name, null);
  const profileId = created.body.profile.id;

  const updated = await request(`/api/profiles/${profileId}`, {
    method: "PATCH",
    body: { name: "Ada", sex: "female", dateOfBirth: "2025-01-15" },
  }, cookie);
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.profile.name, "Ada");

  const length = await request(`/api/profiles/${profileId}/measurements`, {
    method: "POST",
    body: {
      type: "length",
      rows: [
        { measuredOn: "2025-01-15", value: 20, unit: "in", comments: "Birth" },
        { measuredOn: "2025-02-15", value: 54.2, unit: "cm", comments: "One month" },
      ],
    },
  }, cookie);
  assert.equal(length.response.status, 201);
  assert.equal(length.body.measurements.length, 2);
  assert.equal(length.body.measurements[0].valueMetric, 50.8);

  const weight = await request(`/api/profiles/${profileId}/measurements`, {
    method: "POST",
    body: { type: "weight", rows: [{ measuredOn: "2025-01-15", value: 7.5, unit: "lb", comments: "" }] },
  }, cookie);
  assert.equal(weight.response.status, 201);
  assert.equal(weight.body.measurements.length, 3);

  const measurementId = weight.body.measurements.find((row) => row.type === "weight").id;
  const edited = await request(`/api/measurements/${measurementId}`, {
    method: "PATCH",
    body: { measuredOn: "2025-01-15", value: 3.5, unit: "kg", comments: "Corrected" },
  }, cookie);
  assert.equal(edited.response.status, 200);
  assert.equal(edited.body.measurements.find((row) => row.id === measurementId).comments, "Corrected");

  const exported = await request(`/api/profiles/${profileId}/export.csv`, {}, cookie);
  assert.equal(exported.response.status, 200);
  assert.match(exported.body, /type,date,value,unit,comments/);
  assert.match(exported.body, /"length","2025-01-15","20","in","Birth"/);
  assert.match(exported.body, /Corrected/);

  const otherSignup = await request("/api/auth", {
    method: "POST",
    body: { email: "other@example.com", password: "another password" },
  });
  const forbiddenByOwnership = await request(`/api/profiles/${profileId}`, {}, otherSignup.cookie);
  assert.equal(forbiddenByOwnership.response.status, 404);

  const disposable = await request("/api/profiles", { method: "POST", body: {} }, cookie);
  const deletedProfile = await request(`/api/profiles/${disposable.body.profile.id}`, { method: "DELETE" }, cookie);
  assert.equal(deletedProfile.response.status, 200);
  const deletedLookup = await request(`/api/profiles/${disposable.body.profile.id}`, {}, cookie);
  assert.equal(deletedLookup.response.status, 404);

  const removed = await request(`/api/measurements/${measurementId}`, { method: "DELETE" }, cookie);
  assert.equal(removed.response.status, 200);
  assert.equal(removed.body.measurements.length, 2);
});

test("validation and logout reject unsafe or invalid data", async () => {
  const login = await request("/api/auth", {
    method: "POST",
    body: { email: "parent@example.com", password: "correct horse" },
  });
  assert.equal(login.response.status, 200);
  const cookie = login.cookie;
  const profiles = await request("/api/session", {}, cookie);
  const profileId = profiles.body.profiles[0].id;

  const beforeBirth = await request(`/api/profiles/${profileId}/measurements`, {
    method: "POST",
    body: { type: "head", rows: [{ measuredOn: "2025-01-14", value: 34, unit: "cm" }] },
  }, cookie);
  assert.equal(beforeBirth.response.status, 400);

  const wrongPassword = await request("/api/auth", {
    method: "POST",
    body: { email: "parent@example.com", password: "definitely wrong" },
  });
  assert.equal(wrongPassword.response.status, 401);

  const logout = await request("/api/logout", { method: "POST" }, cookie);
  assert.equal(logout.response.status, 200);
  const afterLogout = await request(`/api/profiles/${profileId}`, {}, cookie);
  assert.equal(afterLogout.response.status, 401);
});
