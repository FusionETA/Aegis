// Argus console — the web app at https://argus.fusioneta.com.my (behind Caddy).
//
// Runs as the unprivileged user argus-web (systemd: argus-console.service) on
// 127.0.0.1:3200. It owns sign-in, people, sessions and the change log
// (console/store.js); everything about Argus itself — check status, logs, pausing,
// alert destinations, app logins — is asked of the root agent (console/agent.js)
// over its Unix socket, which only this user can open.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';

const PORT = Number(process.env.CONSOLE_PORT || 3200);
const HOST = process.env.CONSOLE_HOST || '127.0.0.1';
const PUBLIC_URL = (process.env.CONSOLE_URL || 'https://argus.fusioneta.com.my').replace(/\/$/, '');
const AGENT_SOCKET = process.env.AGENT_SOCKET || '/run/argus-agent/agent.sock';
const SECURE_COOKIE = process.env.CONSOLE_INSECURE_COOKIE !== '1';   // only local tests over plain http turn this off
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const COOKIE = 'argus_session';

// ---------- agent client ----------
let nextId = 1;
function agent(op, args, actor) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(AGENT_SOCKET);
    let buf = '';
    const timer = setTimeout(() => { conn.destroy(); reject(new UserError(504, 'Argus took too long to answer. Try again.')); }, 110_000);
    conn.setEncoding('utf8');
    conn.on('data', (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      clearTimeout(timer); conn.end();
      const res = JSON.parse(buf.slice(0, buf.indexOf('\n')));
      res.ok ? resolve(res.result) : reject(new UserError(400, res.error));
    });
    conn.on('error', () => { clearTimeout(timer); reject(new UserError(503, 'The Argus agent isn\'t running on the server.')); });
    conn.write(JSON.stringify({ id: nextId++, op, args, actor }) + '\n');
  });
}

// ---------- http helpers ----------
class UserError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS, ...extra });
  res.end(data);
}

function cookieToken(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`));
  return m ? m[1] : null;
}
const setCookie = (token) => `${COOKIE}=${token}; HttpOnly; ${SECURE_COOKIE ? 'Secure; ' : ''}SameSite=Lax; Path=/; Max-Age=${store.SESSION_MAX_MS / 1000}`;
const clearCookie = () => `${COOKIE}=; HttpOnly; ${SECURE_COOKIE ? 'Secure; ' : ''}SameSite=Lax; Path=/; Max-Age=0`;

async function body(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw new UserError(413, 'Request too large.'); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new UserError(400, 'Bad request.'); }
}

// Changes must come from the console's own pages: same origin, plus a custom header
// that a form on another site can't send.
function checkSameOrigin(req) {
  const origin = req.headers.origin;
  const allowed = [PUBLIC_URL, `http://${HOST}:${PORT}`, `http://localhost:${PORT}`];
  if (req.headers['x-argus'] !== '1' || (origin && !allowed.includes(origin))) throw new UserError(403, 'Request refused.');
}

// Tries per client address on the sign-in form, so a password can't be guessed fast.
const attempts = new Map();
function throttle(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60_000);
  if (list.length >= 20) throw new UserError(429, 'Too many sign-in attempts from your network. Wait 15 minutes.');
  list.push(now);
  attempts.set(ip, list);
}
// Caddy appends the real client address last; earlier entries can be set by the client.
const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',').at(-1).trim();

const actorOf = (u) => `${u.name} <${u.email}>`;
const link = (token) => `${PUBLIC_URL}/setup#t=${token}`;

// ---------- pages ----------
const PAGES = { '/': 'app.html', '/login': 'login.html', '/setup': 'setup.html' };
const ASSETS = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function serveFile(res, name) {
  const f = path.join(PUBLIC_DIR, name);
  if (!f.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(f)) return send(res, 404, 'Not found', 'text/plain');
  const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : ASSETS[path.extname(name)] || 'application/octet-stream';
  send(res, 200, fs.readFileSync(f), type);
}

// ---------- API ----------
async function api(req, res, url, user) {
  const p = url.pathname;
  const m = req.method;
  const need = (role) => { if (!user) throw new UserError(401, 'Please sign in.'); if (role === 'admin' && user.role !== 'admin') throw new UserError(403, 'Only admins can do that.'); };
  if (m !== 'GET') checkSameOrigin(req);

  // --- sign-in and accounts
  if (p === '/api/login' && m === 'POST') {
    throttle(clientIp(req));
    const { email, password } = await body(req);
    let u;
    try { u = store.checkPassword(email, password); } catch (err) { store.audit(String(email || '').slice(0, 120), 'sign-in failed'); throw new UserError(401, err.message); }
    store.audit(actorOf(u), 'signed in');
    return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': setCookie(store.createSession(u.id)) });
  }
  if (p === '/api/logout' && m === 'POST') {
    store.endSession(cookieToken(req));
    return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': clearCookie() });
  }
  if (p === '/api/setup' && m === 'GET') {
    const found = store.peekLink(url.searchParams.get('t'));
    if (!found) throw new UserError(400, 'This link has expired or was already used. Ask an admin for a new one.');
    return send(res, 200, { name: found.user.name, email: found.user.email, kind: found.kind });
  }
  if (p === '/api/setup' && m === 'POST') {
    const { token, password } = await body(req);
    const found = store.peekLink(token);
    if (!found) throw new UserError(400, 'This link has expired or was already used. Ask an admin for a new one.');
    const problem = store.passwordProblem(password, found.user);
    if (problem) throw new UserError(400, problem);
    store.useLink(token);
    const u = store.setPassword(found.user.id, password);
    store.audit(actorOf(u), found.kind === 'reset' ? 'reset their password' : 'set up their account');
    return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': setCookie(store.createSession(u.id)) });
  }

  need('member');
  if (p === '/api/me' && m === 'GET') return send(res, 200, store.publicUser(user));
  if (p === '/api/me/password' && m === 'POST') {
    const { current, next } = await body(req);
    if (!store.verifyCurrentPassword(user, current)) throw new UserError(400, 'Your current password is incorrect.');
    const problem = store.passwordProblem(next, user);
    if (problem) throw new UserError(400, problem);
    store.setPassword(user.id, next);
    store.audit(actorOf(user), 'changed their password');
    return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': setCookie(store.createSession(user.id)) });
  }

  // --- Argus, through the agent
  const actor = actorOf(user);
  if (p === '/api/status' && m === 'GET') return send(res, 200, await agent('status', {}, actor));
  if (p === '/api/report' && m === 'GET') {
    return send(res, 200, await agent('report', { action: url.searchParams.get('action'), start: url.searchParams.get('start') }, actor));
  }
  let mm;
  if ((mm = p.match(/^\/api\/screenshot\/([A-Za-z0-9_.-]+)$/)) && m === 'GET') {
    const { base64 } = await agent('screenshot', { name: mm[1] }, actor);
    return send(res, 200, Buffer.from(base64, 'base64'), 'image/jpeg');
  }
  if (p === '/api/checks/pause' && m === 'POST') {
    const { action, paused } = await body(req);
    const r = await agent('setPaused', { action, paused: !!paused }, actor);
    store.audit(actor, paused ? 'paused check' : 'resumed check', action);
    return send(res, 200, r);
  }
  if (p === '/api/checks/run' && m === 'POST') {
    const { action } = await body(req);
    const r = await agent('runNow', { action }, actor);
    store.audit(actor, 'ran check now', action);
    return send(res, 200, r);
  }
  if ((mm = p.match(/^\/api\/apps\/([A-Z][A-Z0-9_]*)(\/[a-z-]+)?$/))) {
    const [, app, sub] = mm;
    if (!sub && m === 'GET') return send(res, 200, await agent('appSettings', { app }, actor));
    if (sub === '/alerts' && m === 'POST') {
      const { destinations } = await body(req);
      const r = await agent('setNotify', { app, destinations }, actor);
      store.audit(actor, 'changed alert destinations', app, (destinations || []).join(', ') || 'default chat');
      return send(res, 200, r);
    }
    if (sub === '/test-alert' && m === 'POST') {
      const r = await agent('testAlert', { app }, actor);
      store.audit(actor, 'sent a test alert', app);
      return send(res, 200, r);
    }
    if (sub === '/login' && m === 'POST') {
      const { field, value } = await body(req);
      const r = await agent('setCredential', { app, field, value: value === null ? null : String(value ?? '') }, actor);
      store.audit(actor, value === null ? 'cleared an app login field' : 'set an app login field', `${app}_${field}`);
      return send(res, 200, r);
    }
  }
  if (p === '/api/channels' && m === 'GET') return send(res, 200, await agent('channels', {}, actor));
  if (p === '/api/audit' && m === 'GET') return send(res, 200, store.recentAudit(300));

  // --- people (admins)
  if (p === '/api/people' && m === 'GET') { need('admin'); return send(res, 200, store.users().map(store.publicUser)); }
  if (p === '/api/people' && m === 'POST') {
    need('admin');
    const { name, email, role, bitrixId } = await body(req);
    let u;
    try { u = store.addUser({ name, email, role: role === 'admin' ? 'admin' : 'member', bitrixId: bitrixId || null, createdBy: actor }); }
    catch (err) { throw new UserError(400, err.message); }
    const invite = link(store.createLink(u.id, 'invite'));
    store.audit(actor, 'invited', `${u.name} <${u.email}>`, u.role);
    const sent = await deliverLink(u, invite, 'invite', actor);
    return send(res, 200, { person: store.publicUser(u), link: invite, sentByBitrix: sent });
  }
  if ((mm = p.match(/^\/api\/people\/([0-9a-f-]{36})(\/[a-z]+)?$/))) {
    need('admin');
    const [, id, sub] = mm;
    const target = store.findUser((u) => u.id === id);
    if (!target) throw new UserError(404, 'That person isn\'t in the console any more.');
    if (sub === '/reset' && m === 'POST') {
      const l = link(store.createLink(id, target.passHash ? 'reset' : 'invite'));
      store.audit(actor, target.passHash ? 'sent a reset link to' : 'sent a new invite to', `${target.name} <${target.email}>`);
      const sent = await deliverLink(target, l, target.passHash ? 'reset' : 'invite', actor);
      return send(res, 200, { link: l, sentByBitrix: sent });
    }
    if (sub === '/role' && m === 'POST') {
      const { role } = await body(req);
      if (!['admin', 'member'].includes(role)) throw new UserError(400, 'Unknown role.');
      if (target.role === 'admin' && role !== 'admin' && store.adminCount() <= 1) throw new UserError(400, 'The console needs at least one admin.');
      store.updateUser(id, { role });
      store.audit(actor, `made ${role}`, `${target.name} <${target.email}>`);
      return send(res, 200, { ok: true });
    }
    if (!sub && m === 'DELETE') {
      if (id === user.id) throw new UserError(400, 'You can\'t remove yourself. Ask another admin.');
      if (target.role === 'admin' && store.adminCount() <= 1) throw new UserError(400, 'The console needs at least one admin.');
      store.removeUser(id);
      store.audit(actor, 'removed', `${target.name} <${target.email}>`);
      return send(res, 200, { ok: true });
    }
  }
  throw new UserError(404, 'Not found.');
}

// Sends an invite/reset link by Bitrix DM when the person has a Bitrix ID. Never fails the request.
async function deliverLink(person, url, kind, actor) {
  if (!person.bitrixId) return false;
  try { await agent('notifyUser', { bitrixId: person.bitrixId, link: url, name: person.name, kind }, actor); return true; }
  catch { return false; }
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  try {
    const user = store.sessionUser(cookieToken(req));
    if (url.pathname.startsWith('/api/')) return await api(req, res, url, user);
    if (url.pathname.startsWith('/assets/') && req.method === 'GET') return serveFile(res, url.pathname.slice('/assets/'.length));
    if (PAGES[url.pathname] && req.method === 'GET') {
      if (url.pathname === '/' && !user) return send(res, 302, '', 'text/plain', { Location: '/login' });
      if (url.pathname === '/login' && user) return send(res, 302, '', 'text/plain', { Location: '/' });
      return serveFile(res, PAGES[url.pathname]);
    }
    send(res, 404, 'Not found', 'text/plain');
  } catch (err) {
    if (!(err instanceof UserError)) console.error('[console]', err);
    send(res, err.status || 500, { error: err instanceof UserError ? err.message : 'Something went wrong on the server.' });
  }
});
server.listen(PORT, HOST, () => console.log(`[console] listening on http://${HOST}:${PORT} (public ${PUBLIC_URL})`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
