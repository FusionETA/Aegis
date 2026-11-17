// Accounts, sessions, one-time links and the change log for the Aegis console.
//
// Small JSON files in DATA_DIR (/var/lib/aegis-console, owned by aegis-web):
//   users.json     people: name, email, role, Bitrix ID, scrypt password hash
//   sessions.json  signed-in browsers: sha256 of the cookie token, created, last seen, remember
//   tokens.json    one-time setup / reset links: sha256 of the token, expiry
//   audit.jsonl    who did what, newest last (never passwords or other secret values)
// Every write goes to a temp file first and is renamed into place.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.CONSOLE_DATA_DIR || '/var/lib/aegis-console';
export const SESSION_MAX_MS = 12 * 3600_000;   // signed out 12 h after signing in
export const SESSION_IDLE_MS = 4 * 3600_000;   // ...or after 4 h without activity
export const REMEMBER_MAX_MS = 30 * 24 * 3600_000;   // "Keep me signed in on this device": 30 days
export const REMEMBER_IDLE_MS = 7 * 24 * 3600_000;   // ...as long as it's used at least once a week
export const LINK_TTL_MS = 24 * 3600_000;      // setup / reset links work once, for 24 h
const LOCK_AFTER = 5;                          // wrong passwords in a row before a lockout
const LOCK_MS = 15 * 60_000;

const file = (name) => path.join(DATA_DIR, name);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('base64url');

function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}
function save(name, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = file(`${name}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file(name));
}

// ---------- passwords ----------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
function passwordMatches(pw, stored) {
  if (!stored?.startsWith('scrypt$')) return false;
  const [, salt, key] = stored.split('$');
  const want = Buffer.from(key, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(got, want);
}
export function passwordProblem(pw, user) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 200) return 'Use at most 200 characters.';
  const name = user ? user.email.split('@')[0].toLowerCase() : '';
  if (name.length >= 4 && pw.toLowerCase().includes(name)) return 'Don\'t use your email name in your password.';
  return null;
}

// ---------- people ----------
export const users = () => load('users.json', []);
const saveUsers = (list) => save('users.json', list);
export const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role, bitrixId: u.bitrixId || null,
  active: !!u.passHash, createdAt: u.createdAt, createdBy: u.createdBy || null, lastSignIn: u.lastSignIn || null,
});
export const findUser = (pred) => users().find(pred) || null;

export function addUser({ name, email, role, bitrixId, createdBy }) {
  const list = users();
  email = String(email || '').trim().toLowerCase();
  name = String(name || '').trim().slice(0, 80);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That email address doesn\'t look right.');
  if (!name) throw new Error('Enter the person\'s name.');
  if (!['admin', 'member'].includes(role)) throw new Error('Unknown role.');
  if (bitrixId && !/^\d{1,10}$/.test(String(bitrixId))) throw new Error('The Bitrix user ID is the number in their profile address.');
  if (list.some((u) => u.email === email)) throw new Error('Someone with that email is already in the console.');
  const user = { id: crypto.randomUUID(), name, email, role, bitrixId: bitrixId ? String(bitrixId) : null, passHash: null, createdAt: new Date().toISOString(), createdBy };
  list.push(user);
  saveUsers(list);
  return user;
}

export function updateUser(id, patch) {
  const list = users();
  const u = list.find((x) => x.id === id);
  if (!u) throw new Error('That person isn\'t in the console any more.');
  Object.assign(u, patch);
  saveUsers(list);
  return u;
}

export function removeUser(id) {
  saveUsers(users().filter((u) => u.id !== id));
  saveSessions(sessions().filter((s) => s.userId !== id));
  save('tokens.json', load('tokens.json', []).filter((t) => t.userId !== id));
}

export const adminCount = () => users().filter((u) => u.role === 'admin').length;

// ---------- sign-in ----------
// Returns the user, or throws with the one message shown for every failure.
export function checkPassword(email, pw) {
  const generic = new Error('Email or password is incorrect.');
  const u = findUser((x) => x.email === String(email || '').trim().toLowerCase());
  if (!u || !u.passHash) { if (pw) hashPassword(String(pw)); throw generic; }   // same work either way
  if (u.lockedUntil && Date.parse(u.lockedUntil) > Date.now()) {
    throw new Error('Too many wrong passwords. Try again in 15 minutes, or ask an admin to send a reset link.');
  }
  if (!passwordMatches(String(pw || ''), u.passHash)) {
    const failed = (u.failed || 0) + 1;
    updateUser(u.id, { failed, lockedUntil: failed >= LOCK_AFTER ? new Date(Date.now() + LOCK_MS).toISOString() : null });
    throw generic;
  }
  return updateUser(u.id, { failed: 0, lockedUntil: null, lastSignIn: new Date().toISOString() });
}

export function setPassword(id, pw) {
  const u = updateUser(id, { passHash: hashPassword(pw), failed: 0, lockedUntil: null });
  saveSessions(sessions().filter((s) => s.userId !== id));   // sign out everywhere
  return u;
}
export const verifyCurrentPassword = (u, pw) => passwordMatches(String(pw || ''), u.passHash);

// ---------- sessions ----------
const sessions = () => load('sessions.json', []);
const saveSessions = (list) => save('sessions.json', list);
const isLive = (s, now) => (s.remember
  ? now - s.created < REMEMBER_MAX_MS && now - s.lastSeen < REMEMBER_IDLE_MS
  : now - s.created < SESSION_MAX_MS && now - s.lastSeen < SESSION_IDLE_MS);

// remember: "Keep me signed in on this device" was ticked (longer limits above).
export function createSession(userId, remember = false) {
  const token = newToken();
  const now = Date.now();
  const live = sessions().filter((s) => isLive(s, now));
  live.push({ hash: sha256(token), userId, created: now, lastSeen: now, remember: !!remember });
  saveSessions(live);
  return token;
}
export const sessionRemembers = (token) => !!sessions().find((s) => s.hash === sha256(String(token || '')))?.remember;

// The signed-in user for a cookie token, or null. Refreshes "last seen" at most once a minute.
export function sessionUser(token) {
  if (!token) return null;
  const list = sessions();
  const s = list.find((x) => x.hash === sha256(token));
  const now = Date.now();
  if (!s || !isLive(s, now)) return null;
  const u = findUser((x) => x.id === s.userId && x.passHash);
  if (!u) return null;
  if (now - s.lastSeen > 60_000) { s.lastSeen = now; saveSessions(list); }
  return u;
}

export function endSession(token) {
  if (token) saveSessions(sessions().filter((s) => s.hash !== sha256(token)));
}

// ---------- one-time links ----------
export function createLink(userId, kind) {
  const token = newToken();
  const list = load('tokens.json', []).filter((t) => t.userId !== userId && t.expires > Date.now());
  list.push({ hash: sha256(token), userId, kind, expires: Date.now() + LINK_TTL_MS });
  save('tokens.json', list);
  return token;
}

// Returns {user, kind} for a valid link without using it up.
export function peekLink(token) {
  const t = load('tokens.json', []).find((x) => x.hash === sha256(String(token || '')) && x.expires > Date.now());
  if (!t) return null;
  const user = findUser((u) => u.id === t.userId);
  return user ? { user, kind: t.kind } : null;
}
export function useLink(token) {
  const found = peekLink(token);
  if (found) save('tokens.json', load('tokens.json', []).filter((x) => x.hash !== sha256(String(token))));
  return found;
}

// ---------- change log ----------
export function audit(actor, action, target = '', detail = '') {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.appendFileSync(file('audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), actor, action, target, detail }) + '\n', { mode: 0o600 });
}
export function recentAudit(limit = 200) {
  try {
    return fs.readFileSync(file('audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l)).reverse();
  } catch { return []; }
}
