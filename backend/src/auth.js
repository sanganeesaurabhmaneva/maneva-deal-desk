// auth.js -- per-rep login. Each rep signs in with an email + password and gets a
// short-lived token (JWT) that the app sends on every request. No shared key.
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "";
const TOKEN_TTL = process.env.TOKEN_TTL || "12h";

// Users come from either the APP_USERS env var (a JSON array) or a users.json file.
// Each user: { "email": "...", "name": "...", "passwordHash": "<bcrypt hash>" }.
// Use scripts/add-user.js to create hashed users.
function loadUsers() {
  if (process.env.APP_USERS) {
    try { return JSON.parse(process.env.APP_USERS); } catch (_) { /* fall through */ }
  }
  const candidates = [
    process.env.USERS_FILE,
    path.join(__dirname, "..", "users.json"),
    "/data/users.json",
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { /* skip */ }
  }
  return [];
}

async function login(email, password) {
  if (!JWT_SECRET) throw new Error("Server sign-in is not configured (JWT_SECRET missing).");
  const users = loadUsers();
  const user = users.find(
    (u) => (u.email || "").toLowerCase() === String(email || "").toLowerCase()
  );
  if (!user) return null;
  const ok = await bcrypt.compare(String(password || ""), user.passwordHash || "");
  if (!ok) return null;
  const profile = { email: user.email, name: user.name || user.email };
  const token = jwt.sign(profile, JWT_SECRET, { expiresIn: TOKEN_TTL });
  return { token, user: profile };
}

function requireAuth(req, res, next) {
  if (!JWT_SECRET) return res.status(500).json({ error: "Server sign-in is not configured." });
  const header = req.headers.authorization || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: "Please sign in." });
  try {
    req.user = jwt.verify(m[1], JWT_SECRET);
    next();
  } catch (_) {
    return res.status(401).json({ error: "Your session expired. Please sign in again." });
  }
}

module.exports = { login, requireAuth, loadUsers };
