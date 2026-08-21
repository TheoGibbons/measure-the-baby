import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);
const DATABASE_PATH = process.env.DATABASE_PATH || join(ROOT, "data", "growth.sqlite");
// Five years, leap day included. Signing in once should be the last time a
// parent has to think about it.
const SESSION_DAYS = Math.max(1, Number(process.env.SESSION_DAYS || 1826));
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
const SESSION_COOKIE = "growth_session";
const MAX_BODY_BYTES = 1_000_000;
const METRICS = new Set(["length", "weight", "head", "bmi"]);
const UNITS = {
  length: new Set(["cm", "in"]),
  weight: new Set(["kg", "lb"]),
  head: new Set(["cm", "in"]),
  bmi: new Set(["kg/m2"]),
};
const LIMITS = {
  length: [20, 250],
  weight: [0.25, 250],
  head: [20, 80],
  bmi: [5, 80],
};
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

await mkdir(dirname(DATABASE_PATH), { recursive: true });
const db = new DatabaseSync(DATABASE_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS sessions_token_idx ON sessions(token_hash);
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT,
    sex TEXT CHECK (sex IN ('male', 'female') OR sex IS NULL),
    date_of_birth TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS profiles_user_idx ON profiles(user_id);
  CREATE TABLE IF NOT EXISTS measurements (
    id INTEGER PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('length', 'weight', 'head', 'bmi')),
    measured_on TEXT NOT NULL,
    value_metric REAL NOT NULL,
    unit_entered TEXT NOT NULL,
    comments TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS measurements_profile_date_idx
    ON measurements(profile_id, measured_on, id);
`);
db.prepare("DELETE FROM sessions WHERE datetime(expires_at) <= datetime('now')").run();

const authAttempts = new Map();

function securityHeaders(extra = {}) {
  return {
    "Content-Security-Policy": "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; manifest-src 'self'; worker-src 'self'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...extra,
  };
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, securityHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  }));
  res.end(JSON.stringify(value));
}

function fail(res, status, message, code = "request_error") {
  json(res, status, { error: message, code });
}

function parseCookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function currentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  return db.prepare(`
    SELECT users.id, users.email, sessions.expires_at AS sessionExpiresAt
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND datetime(sessions.expires_at) > datetime('now')
  `).get(tokenHash(token)) || null;
}

function sessionCookie(token, maxAgeSeconds) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (COOKIE_SECURE) parts.push("Secure");
  return parts.join("; ");
}

// Browsers refuse to hold a cookie as long as the stored session lasts, and
// Chromium clamps any Max-Age past 400 days down to that ceiling. Re-issuing the
// cookie whenever the app checks its session pushes the ceiling forward, so
// opening the app once a year carries the full five-year term.
function renewedSessionCookie(req, user) {
  const token = parseCookies(req)[SESSION_COOKIE];
  const remaining = Math.floor((Date.parse(user.sessionExpiresAt) - Date.now()) / 1000);
  if (!token || !Number.isFinite(remaining) || remaining <= 0) return {};
  return { "Set-Cookie": sessionCookie(token, remaining) };
}

function verifySameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readJson(req) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error("Request is too large."), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request must contain valid JSON."), { status: 400 });
  }
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function profileForUser(id, userId) {
  return db.prepare(`
    SELECT id, name, sex, date_of_birth AS dateOfBirth, created_at AS createdAt, updated_at AS updatedAt
    FROM profiles WHERE id = ? AND user_id = ?
  `).get(id, userId) || null;
}

function listProfiles(userId) {
  return db.prepare(`
    SELECT id, name, sex, date_of_birth AS dateOfBirth, created_at AS createdAt, updated_at AS updatedAt
    FROM profiles WHERE user_id = ? ORDER BY created_at, id
  `).all(userId);
}

function listMeasurements(profileId) {
  return db.prepare(`
    SELECT id, type, measured_on AS measuredOn, value_metric AS valueMetric,
           unit_entered AS unitEntered, comments, created_at AS createdAt, updated_at AS updatedAt
    FROM measurements WHERE profile_id = ? ORDER BY measured_on, id
  `).all(profileId);
}

function canonicalValue(type, value, unit) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw Object.assign(new Error("Enter a positive numeric value."), { status: 400 });
  let result = numeric;
  if ((type === "length" || type === "head") && unit === "in") result = numeric * 2.54;
  if (type === "weight" && unit === "lb") result = numeric * 0.45359237;
  const [min, max] = LIMITS[type];
  if (result < min || result > max) {
    throw Object.assign(new Error(`That ${type} value is outside the supported range.`), { status: 400 });
  }
  return Math.round(result * 10000) / 10000;
}

function cleanComment(value) {
  return String(value || "").trim().slice(0, 500);
}

function validateMeasurement(type, input, profile) {
  if (!METRICS.has(type)) throw Object.assign(new Error("Unknown measurement type."), { status: 400 });
  const measuredOn = String(input.measuredOn || "");
  if (!isIsoDate(measuredOn)) throw Object.assign(new Error("Enter a valid measurement date."), { status: 400 });
  if (measuredOn > new Date().toISOString().slice(0, 10)) {
    throw Object.assign(new Error("A measurement cannot be dated in the future."), { status: 400 });
  }
  if (profile.dateOfBirth && measuredOn < profile.dateOfBirth) {
    throw Object.assign(new Error("A measurement cannot be dated before the date of birth."), { status: 400 });
  }
  const unit = String(input.unit || "");
  if (!UNITS[type].has(unit)) throw Object.assign(new Error("Choose a valid unit."), { status: 400 });
  return {
    measuredOn,
    valueMetric: canonicalValue(type, input.value, unit),
    unit,
    comments: cleanComment(input.comments),
  };
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function isRateLimited(req) {
  const key = clientIp(req);
  const now = Date.now();
  const windowStart = now - 15 * 60_000;
  const recent = (authAttempts.get(key) || []).filter((time) => time > windowStart);
  recent.push(now);
  authAttempts.set(key, recent);
  return recent.length > 12;
}

function clearRateLimit(req) {
  authAttempts.delete(clientIp(req));
}

function emailIsValid(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function routeMatch(pathname, pattern) {
  const match = pathname.match(pattern);
  return match ? match.slice(1) : null;
}

async function api(req, res, url) {
  if (!verifySameOrigin(req)) return fail(res, 403, "Cross-site request blocked.", "origin_mismatch");

  if (req.method === "POST" && url.pathname === "/api/auth") {
    if (isRateLimited(req)) return fail(res, 429, "Too many sign-in attempts. Try again later.", "rate_limited");
    const body = await readJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!emailIsValid(email)) return fail(res, 400, "Enter a valid email address.", "invalid_email");
    if (password.length < 8 || password.length > 128) return fail(res, 400, "Password must be 8 to 128 characters.", "invalid_password");

    let user = db.prepare("SELECT id, email, password_hash AS passwordHash, password_salt AS passwordSalt FROM users WHERE email = ?").get(email);
    let created = false;
    if (!user) {
      const salt = randomBytes(16).toString("hex");
      const passwordHash = scryptSync(password, salt, 64).toString("hex");
      try {
        const result = db.prepare("INSERT INTO users (email, password_hash, password_salt) VALUES (?, ?, ?)").run(email, passwordHash, salt);
        user = { id: Number(result.lastInsertRowid), email };
        created = true;
      } catch (error) {
        if (!String(error.message).includes("UNIQUE")) throw error;
        user = db.prepare("SELECT id, email, password_hash AS passwordHash, password_salt AS passwordSalt FROM users WHERE email = ?").get(email);
      }
    }
    if (!created) {
      const supplied = scryptSync(password, user.passwordSalt, 64);
      const stored = Buffer.from(user.passwordHash, "hex");
      if (stored.length !== supplied.length || !timingSafeEqual(stored, supplied)) {
        return fail(res, 401, "That password does not match this email.", "invalid_credentials");
      }
    }

    clearRateLimit(req);
    const token = randomBytes(32).toString("base64url");
    const maxAge = SESSION_DAYS * 24 * 60 * 60;
    const expires = new Date(Date.now() + maxAge * 1000).toISOString();
    db.prepare("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)").run(user.id, tokenHash(token), expires);
    return json(res, created ? 201 : 200, {
      user: { id: user.id, email: user.email },
      profiles: listProfiles(user.id),
      created,
    }, { "Set-Cookie": sessionCookie(token, maxAge) });
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
    return json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
  }

  const user = currentUser(req);
  if (req.method === "GET" && url.pathname === "/api/session") {
    if (!user) return json(res, 200, { user: null, profiles: [] });
    return json(res, 200, {
      user: { id: user.id, email: user.email },
      profiles: listProfiles(user.id),
    }, renewedSessionCookie(req, user));
  }
  if (!user) return fail(res, 401, "Sign in to continue.", "not_authenticated");

  if (req.method === "POST" && url.pathname === "/api/profiles") {
    const result = db.prepare("INSERT INTO profiles (user_id) VALUES (?)").run(user.id);
    const profile = profileForUser(Number(result.lastInsertRowid), user.id);
    return json(res, 201, { profile, measurements: [] });
  }

  const profileDetail = routeMatch(url.pathname, /^\/api\/profiles\/(\d+)$/);
  if (profileDetail && req.method === "GET") {
    const profile = profileForUser(Number(profileDetail[0]), user.id);
    if (!profile) return fail(res, 404, "Profile not found.", "not_found");
    return json(res, 200, { profile, measurements: listMeasurements(profile.id) });
  }

  if (profileDetail && req.method === "PATCH") {
    const id = Number(profileDetail[0]);
    const profile = profileForUser(id, user.id);
    if (!profile) return fail(res, 404, "Profile not found.", "not_found");
    const body = await readJson(req);
    const name = body.name == null || String(body.name).trim() === "" ? null : String(body.name).trim().slice(0, 80);
    const sex = body.sex == null || body.sex === "" ? null : String(body.sex);
    const dateOfBirth = body.dateOfBirth == null || body.dateOfBirth === "" ? null : String(body.dateOfBirth);
    if (sex && !["male", "female"].includes(sex)) return fail(res, 400, "Choose male or female.", "invalid_sex");
    if (dateOfBirth && !isIsoDate(dateOfBirth)) return fail(res, 400, "Enter a valid date of birth.", "invalid_date");
    if (dateOfBirth && dateOfBirth > new Date().toISOString().slice(0, 10)) return fail(res, 400, "Date of birth cannot be in the future.", "invalid_date");
    const firstMeasurement = db.prepare("SELECT MIN(measured_on) AS firstDate FROM measurements WHERE profile_id = ?").get(id)?.firstDate;
    if (dateOfBirth && firstMeasurement && dateOfBirth > firstMeasurement) {
      return fail(res, 400, "Date of birth cannot be after an existing measurement.", "invalid_date");
    }
    db.prepare(`UPDATE profiles SET name = ?, sex = ?, date_of_birth = ?, updated_at = datetime('now') WHERE id = ?`).run(name, sex, dateOfBirth, id);
    return json(res, 200, { profile: profileForUser(id, user.id) });
  }

  if (profileDetail && req.method === "DELETE") {
    const id = Number(profileDetail[0]);
    const profile = profileForUser(id, user.id);
    if (!profile) return fail(res, 404, "Profile not found.", "not_found");
    db.prepare("DELETE FROM profiles WHERE id = ? AND user_id = ?").run(id, user.id);
    return json(res, 200, { ok: true });
  }

  const measurementBatch = routeMatch(url.pathname, /^\/api\/profiles\/(\d+)\/measurements$/);
  if (measurementBatch && req.method === "POST") {
    const id = Number(measurementBatch[0]);
    const profile = profileForUser(id, user.id);
    if (!profile) return fail(res, 404, "Profile not found.", "not_found");
    const body = await readJson(req);
    const type = String(body.type || "");
    if (!Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > 250) {
      return fail(res, 400, "Add between 1 and 250 rows at a time.", "invalid_rows");
    }
    const rows = body.rows.map((row) => validateMeasurement(type, row, profile));
    const insert = db.prepare(`
      INSERT INTO measurements (profile_id, type, measured_on, value_metric, unit_entered, comments)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) insert.run(id, type, row.measuredOn, row.valueMetric, row.unit, row.comments);
      db.prepare("UPDATE profiles SET updated_at = datetime('now') WHERE id = ?").run(id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return json(res, 201, { measurements: listMeasurements(id) });
  }

  const measurementDetail = routeMatch(url.pathname, /^\/api\/measurements\/(\d+)$/);
  if (measurementDetail) {
    const measurementId = Number(measurementDetail[0]);
    const existing = db.prepare(`
      SELECT m.id, m.profile_id AS profileId, m.type
      FROM measurements m JOIN profiles p ON p.id = m.profile_id
      WHERE m.id = ? AND p.user_id = ?
    `).get(measurementId, user.id);
    if (!existing) return fail(res, 404, "Measurement not found.", "not_found");
    const profile = profileForUser(existing.profileId, user.id);
    if (req.method === "PATCH") {
      const body = await readJson(req);
      const row = validateMeasurement(existing.type, body, profile);
      db.prepare(`
        UPDATE measurements SET measured_on = ?, value_metric = ?, unit_entered = ?, comments = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(row.measuredOn, row.valueMetric, row.unit, row.comments, measurementId);
      return json(res, 200, { measurements: listMeasurements(existing.profileId) });
    }
    if (req.method === "DELETE") {
      db.prepare("DELETE FROM measurements WHERE id = ?").run(measurementId);
      db.prepare("UPDATE profiles SET updated_at = datetime('now') WHERE id = ?").run(existing.profileId);
      return json(res, 200, { measurements: listMeasurements(existing.profileId) });
    }
  }

  const exportMatch = routeMatch(url.pathname, /^\/api\/profiles\/(\d+)\/export\.csv$/);
  if (exportMatch && req.method === "GET") {
    const id = Number(exportMatch[0]);
    const profile = profileForUser(id, user.id);
    if (!profile) return fail(res, 404, "Profile not found.", "not_found");
    const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const rows = listMeasurements(id);
    const enteredValue = (row) => {
      let value = row.valueMetric;
      if ((row.type === "length" || row.type === "head") && row.unitEntered === "in") value /= 2.54;
      if (row.type === "weight" && row.unitEntered === "lb") value /= 0.45359237;
      return Math.round(value * 10000) / 10000;
    };
    const csv = [
      "type,date,value,unit,comments",
      ...rows.map((row) => [row.type, row.measuredOn, enteredValue(row), row.unitEntered, row.comments].map(escape).join(",")),
    ].join("\r\n");
    const filename = `${(profile.name || "growth-profile").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "growth-profile"}.csv`;
    res.writeHead(200, securityHeaders({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    }));
    return res.end(csv);
  }

  return fail(res, 404, "API endpoint not found.", "not_found");
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const relative = normalize(pathname).replace(/^[/\\]+/, "");
  const filename = resolve(PUBLIC_DIR, relative);
  const publicRoot = resolve(PUBLIC_DIR);
  if (filename !== publicRoot && !filename.startsWith(publicRoot + sep)) return fail(res, 403, "Forbidden.", "forbidden");
  try {
    const info = await stat(filename);
    if (!info.isFile()) throw new Error("not file");
    const content = await readFile(filename);
    const isIndex = extname(filename) === ".html";
    res.writeHead(200, securityHeaders({
      "Content-Type": MIME[extname(filename)] || "application/octet-stream",
      "Cache-Control": isIndex ? "no-cache" : "public, max-age=3600",
    }));
    res.end(req.method === "HEAD" ? undefined : content);
  } catch {
    fail(res, 404, "Page not found.", "not_found");
  }
}

export function createApp() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname === "/healthz") {
        res.writeHead(200, securityHeaders({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }));
        return res.end("ok");
      }
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (!["GET", "HEAD"].includes(req.method)) return fail(res, 405, "Method not allowed.", "method_not_allowed");
      return await serveStatic(req, res, url);
    } catch (error) {
      if (!error.status) console.error(error);
      fail(res, error.status || 500, error.status ? error.message : "Something went wrong.", error.status ? "invalid_request" : "server_error");
    }
  });
}

export function closeDatabase() {
  db.close();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createApp().listen(PORT, "0.0.0.0", () => {
    console.log(`Measure the Baby is running at http://localhost:${PORT}`);
  });
}
