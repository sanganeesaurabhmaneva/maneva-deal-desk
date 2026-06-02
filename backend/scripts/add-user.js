// add-user.js -- create or update a rep login.
// Usage:  node scripts/add-user.js "rep@maneva.ai" "Rep Name" "their-password"
// Writes a hashed entry into users.json, which the app reads at sign-in.
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const [, , email, name, password] = process.argv;
if (!email || !password) {
  console.error('Usage: node scripts/add-user.js "<email>" "<name>" "<password>"');
  process.exit(1);
}
const file = path.join(__dirname, "..", "users.json");
let users = [];
try { users = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { users = []; }

const record = { email, name: name || email, passwordHash: bcrypt.hashSync(password, 10) };
const i = users.findIndex((u) => (u.email || "").toLowerCase() === email.toLowerCase());
if (i >= 0) users[i] = record; else users.push(record);

fs.writeFileSync(file, JSON.stringify(users, null, 2));
console.log(`Saved ${email} to ${file}. Total reps: ${users.length}.`);
