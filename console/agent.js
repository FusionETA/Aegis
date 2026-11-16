// Argus console agent — the only part of the console that touches Argus itself.
//
// Runs as root (systemd: argus-agent.service) and answers a fixed list of
// operations over a Unix socket that only the console's own user can open. The web
// console (console/server.js, user argus-web) has no access to /root/argus; it asks
// this agent instead. Every input is validated here, never trusted from the caller,
// and every change is appended to logs/console-changes.log (who, what, never values).
//
// Protocol: one JSON object per line, {id, op, args, actor} -> {id, ok, result|error}.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const HOME = process.env.ARGUS_HOME || '/root/argus';
const SOCKET = process.env.AGENT_SOCKET || '/run/argus-agent/agent.sock';
const SOCKET_GROUP = process.env.AGENT_GROUP ?? 'argus-web';
const NODE = process.env.ARGUS_NODE || '/opt/node24/bin/node';
const CONSOLE_URL = (process.env.CONSOLE_URL || 'https://argus.fusioneta.com.my').replace(/\/$/, '');
const ENV_FILE = path.join(HOME, '.env');
const CRED_FIELDS = ['URL', 'LOGIN_URL', 'EMAIL', 'USERNAME', 'PASSWORD'];

const requireHome = createRequire(path.join(HOME, 'package.json'));
const dotenv = requireHome('dotenv');
const { resolveTargets, resolveReportTargets } = await import(path.join(HOME, 'core', 'report.js'));

// ---------- helpers ----------
class Refused extends Error {}
const refuse = (msg) => { throw new Refused(msg); };
const readEnv = () => (fs.existsSync(ENV_FILE) ? dotenv.parse(fs.readFileSync(ENV_FILE)) : {});

// Runs fn with process.env = the agent's own env + the current .env (so report.js
// resolves destinations exactly as a check would), then restores it.
const BASE_ENV = { ...process.env };
function withArgusEnv(fn, extra = {}) {
  const parsed = { ...readEnv(), ...extra };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, BASE_ENV, parsed);
  try { return fn(); } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, BASE_ENV);
  }
}

// Set (or with value null, remove) one KEY in .env, keeping every other line as is.
function writeEnvKey(key, value) {
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split('\n') : [];
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (value === null) {
    if (idx >= 0) lines.splice(idx, 1);
  } else {
    const line = `${key}=${quote(value)}`;
    if (idx >= 0) lines[idx] = line;
    else {
      while (lines.length && lines.at(-1) === '') lines.pop();
      lines.push(line, '');
    }
  }
  const tmp = `${ENV_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
  fs.renameSync(tmp, ENV_FILE);
}

// Quotes a value so both dotenv and `node --env-file` read it back exactly.
function quote(v) {
  if (/^[A-Za-z0-9_.,:/@+=-]*$/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"') && !v.includes('\\')) return `"${v}"`;
  refuse('That value contains both a single quote and a double quote or backslash, which the settings file can\'t store safely. Please use a different value.');
}

function logChange(actor, op, target, detail = '') {
  const line = JSON.stringify({ at: new Date().toISOString(), actor, op, target, detail });
  fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true });
  fs.appendFileSync(path.join(HOME, 'logs', 'console-changes.log'), line + '\n');
}

// ---------- checks ----------
const scriptFor = (action) => path.join(HOME, 'plugins', action.includes('/') ? `${action}.js` : `altomatehr/${action}.js`);
const fileName = (action) => action.replace('/', '-');                       // logs/<this>.log, config/paused/<this>
const stateName = (action) => {                                               // logs/state/<this>.json (core/check.js)
  const s = scriptFor(action);
  return `${path.basename(path.dirname(s))}-${path.basename(s, '.js')}`;
};
const validAction = (a) => typeof a === 'string' && /^[a-z0-9-]+(\/[a-z0-9-]+)?$/.test(a) && fs.existsSync(scriptFor(a));

function registry() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'checks.json'), 'utf8')); } catch { return []; }
}

const crontab = () => spawnSync('crontab', ['-l'], { encoding: 'utf8' }).stdout || '';
function cronEntries() {
  const entries = [];
  for (const line of crontab().split('\n')) {
    const m = line.match(/^\s*([^#\s]\S*\s+\S+\s+\S+\s+\S+\s+\S+)\s+\S*\/run\.sh\s+(\S+)\s*$/);
    if (m) entries.push({ schedule: m[1], action: m[2] });
  }
  return entries;
}

function knownActions() {
  const set = new Set([...registry().map((c) => c.action), ...cronEntries().map((e) => e.action)]);
  return [...set].filter(validAction);
}
function requireAction(a) {
  if (!validAction(a) || !knownActions().includes(a)) refuse('Unknown check.');
  return a;
}
function knownApps() {
  return [...new Set(registry().map((c) => c.app).filter(Boolean))];
}
function requireApp(app) {
  if (typeof app !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(app) || !knownApps().includes(app)) refuse('Unknown app.');
  return app;
}

function markers(action) {
  const src = fs.existsSync(scriptFor(action)) ? fs.readFileSync(scriptFor(action), 'utf8') : '';
  return {
    changesData: src.includes('argus:changes-data'),
    noRetry: src.includes('argus:no-retry'),
    noBrowser: src.includes('argus:no-browser'),
  };
}

function isRunning(action) {
  const lock = `/run/lock/argus-${fileName(action)}.lock`;
  if (!fs.existsSync(lock)) return false;
  return spawnSync('flock', ['-n', lock, 'true']).status !== 0;
}

// --- cron schedule -> words, and its next time (MYT = server time)
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function describeCron(expr) {
  const [mi, h, dom, mon, dow] = expr.split(/\s+/);
  const days = dow === '*' ? 'Every day' : dow === '1-5' ? 'Mon–Fri' : dow === '0,6' || dow === '6,0' ? 'Weekends' : `Days ${dow}`;
  if (/^\*\/\d+$/.test(mi) && h === '*') return `Every ${mi.slice(2)} min${dow === '*' ? ', all days' : `, ${days}`}`;
  if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom === '*' && mon === '*') return `${days} ${h.padStart(2, '0')}:${mi.padStart(2, '0')}`;
  return expr;
}
function cronField(field, min, max) {
  const vals = new Set();
  for (const part of field.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = Number(stepStr || 1);
    let [lo, hi] = range === '*' ? [min, max] : range.split('-').map(Number);
    if (hi === undefined) hi = stepStr ? max : lo;
    for (let v = lo; v <= hi; v += step) vals.add(v);
  }
  return vals;
}
function nextRun(expr, from = new Date()) {
  const [mi, h, dom, mon, dow] = expr.split(/\s+/);
  const M = cronField(mi, 0, 59), H = cronField(h, 0, 23), D = cronField(dom, 1, 31), MO = cronField(mon, 1, 12);
  const W = new Set([...cronField(dow, 0, 7)].map((d) => d % 7));
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 8; i++) {
    t.setMinutes(t.getMinutes() + 1);
    if (M.has(t.getMinutes()) && H.has(t.getHours()) && D.has(t.getDate()) && MO.has(t.getMonth() + 1) && W.has(t.getDay())) return t.toISOString();
  }
  return null;
}

// --- log parsing: blocks between "===== <action> @ <ts> =====" and "... exit N @ <time> ====="
function parseRuns(action) {
  const base = path.join(HOME, 'logs', `${fileName(action)}.log`);
  const text = [`${base}.1`, base].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const runs = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const head = line.match(/^===== (\S+) @ (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) \S+ =====$/);
    const skipped = line.match(/^===== (\S+) @ (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) \S+: (.+) =====$/);
    const foot = line.match(/^===== (\S+) exit (\d+) @ (\d\d:\d\d:\d\d) \S+ =====$/);
    if (head) { cur = { start: head[2], body: [] }; continue; }
    if (skipped) { runs.push({ start: skipped[2], end: null, exit: null, skipped: skipped[3] }); cur = null; continue; }
    if (foot && cur) {
      const startT = new Date(cur.start.replace(' ', 'T') + '+08:00');
      const endT = new Date(`${cur.start.slice(0, 10)}T${foot[3]}+08:00`);
      if (endT < startT) endT.setDate(endT.getDate() + 1);
      const body = cur.body.join('\n');
      runs.push({
        start: cur.start, exit: Number(foot[2]), seconds: Math.round((endT - startT) / 1000),
        summary: summarize(body), screenshots: [...body.matchAll(/logs\/screenshots\/([\w.-]+\.jpg)/g)].map((m) => m[1]),
        retried: body.includes('retrying in'),
      });
      cur = null;
      continue;
    }
    if (cur) cur.body.push(line);
  }
  return runs;
}

function summarize(body) {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const pick = (re) => lines.filter((l) => re.test(l)).at(-1);
  return pick(/^\[nginx\] .*(OK|problem)/) || pick(/^❌ Error:/) || pick(/^🔴/) || pick(/^🧭/) || pick(/^⏱️/) || lines.at(-1) || '';
}

function reportText(action, start) {
  const base = path.join(HOME, 'logs', `${fileName(action)}.log`);
  const text = [`${base}.1`, base].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`===== ${action} @ ${start} `));
  if (at < 0) refuse('That run is no longer in the logs.');
  const out = [];
  for (let i = at; i < lines.length; i++) {
    out.push(lines[i]);
    if (i > at && /^===== \S+ exit \d+ @/.test(lines[i])) break;
    if (out.length > 400) break;
  }
  return out.join('\n');
}

// run.sh's retry delay: ARGUS_RETRY_DELAY in the crontab, else 300 s.
function retryDelayText() {
  const m = crontab().match(/^\s*ARGUS_RETRY_DELAY=["']?(\d+)/m);
  const sec = m ? Number(m[1]) : 300;
  return sec % 60 ? `${sec} seconds` : `${sec / 60} minute${sec === 60 ? '' : 's'}`;
}
function retryText(m, delay) {
  if (m.changesData) return 'No retry: it changes data, so it alerts on the first failure';
  if (m.noRetry) return 'Re-checks itself before alerting (no retry between runs)';
  return `Retries once after ${delay} before alerting`;
}

// Runs on a weekday for a cron schedule (minutes x hours), for the run-report volume estimate.
function runsPerWeekday(expr) {
  const [mi, h, dom, , dow] = expr.split(/\s+/);
  const days = new Set([...cronField(dow, 0, 7)].map((d) => d % 7));
  if (![1, 2, 3, 4, 5].some((d) => days.has(d))) return 0;
  const n = cronField(mi, 0, 59).size * cronField(h, 0, 23).size;
  return dom === '*' ? n : Math.ceil(n / 30);
}

function alertStatus(app) {
  return withArgusEnv(() => {
    const r = resolveTargets(app);
    return { source: r.source, targets: r.targets, problems: r.problems };
  });
}

function reportStatus(app) {
  return withArgusEnv(() => {
    const r = resolveReportTargets(app);
    return { enabled: r.enabled, targets: r.targets, problems: r.problems };
  });
}

function status() {
  const delay = retryDelayText();
  const reg = new Map(registry().map((c) => [c.action, c]));
  const cron = new Map(cronEntries().map((e) => [e.action, e.schedule]));
  const checks = knownActions().map((action) => {
    const info = reg.get(action) || {};
    const m = markers(action);
    const pausedFile = path.join(HOME, 'config', 'paused', fileName(action));
    let paused = null;
    if (fs.existsSync(pausedFile)) { try { paused = JSON.parse(fs.readFileSync(pausedFile, 'utf8')); } catch { paused = {}; } }
    let state = null;
    try { state = JSON.parse(fs.readFileSync(path.join(HOME, 'logs', 'state', `${stateName(action)}.json`), 'utf8')); } catch {}
    const runs = parseRuns(action);
    const daily = {};
    for (const r of runs) {
      if (r.skipped) continue;
      const d = r.start.slice(0, 10);
      daily[d] ??= { date: d, runs: 0, failed: 0 };
      daily[d].runs++;
      if (r.exit) daily[d].failed++;
    }
    const schedule = cron.get(action) || null;
    return {
      action, app: info.app || null, appName: info.appName || info.app || null, name: info.name || action, site: info.site || '', description: info.description || '',
      steps: info.steps || [], schedule, scheduleText: schedule ? describeCron(schedule) : 'On demand',
      next: schedule && !paused ? nextRun(schedule) : null,
      ...m, retry: retryText(m, delay), paused, running: isRunning(action), state,
      runs: runs.slice(-40).reverse(), daily: Object.values(daily).slice(-14).reverse(),
      totalRuns: runs.filter((r) => !r.skipped).length, failedRuns: runs.filter((r) => r.exit).length,
    };
  });
  const apps = knownApps().map((app) => ({ app, alerts: alertStatus(app), reports: reportStatus(app) }));
  return { generatedAt: new Date().toISOString(), checks, apps, defaultAlerts: alertStatus(undefined) };
}

// ---------- alert channels ----------
// Who each alert channel sends as, for the console's "Alert channels" section. Reads
// the settings and asks Bitrix / Telegram who the sender is (cached 5 minutes). Never
// returns a secret: no webhook URLs, tokens or passwords.
const CHANNEL_KEYS = {
  bitrix: ['BITRIX_WEBHOOK_URL'], email: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'], telegram: ['TELEGRAM_BOT_TOKEN'],
  slack: ['SLACK_WEBHOOK_URL'], teams: ['TEAMS_WEBHOOK_URL'], googlechat: ['GOOGLECHAT_WEBHOOK_URL'],
  webhook: ['WEBHOOK_URL'], whatsapp: ['WAZZUP_API_KEY', 'WAZZUP_CHANNEL_ID'],
};
let channelCache = { key: '', at: 0, data: null };
const getJson = (url) => fetch(url, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => ({}));

async function channels() {
  const env = readEnv();
  const key = JSON.stringify(Object.values(CHANNEL_KEYS).flat().map((k) => env[k] || ''));
  if (channelCache.key === key && Date.now() - channelCache.at < 5 * 60_000) return channelCache.data;
  const has = (k) => !!(env[k] || '').trim();
  const named = (prefix) => Object.keys(env).filter((k) => k.startsWith(`${prefix}_`) && env[k]).map((k) => k.slice(prefix.length + 1).toLowerCase());
  const reg = registry();
  const overrides = (ch) => [...new Set(reg.filter((c) => c.app && CHANNEL_KEYS[ch].some((k) => env[`${c.app}_${k}`])).map((c) => c.appName || c.app))];
  const list = [];

  // Bitrix24: the webhook's user is the sender; BITRIX_DIALOG_ID is the default destination.
  const hook = (env.BITRIX_WEBHOOK_URL || '').trim().replace(/\/+$/, '');
  if (hook) {
    const [profile, scope] = await Promise.all([getJson(`${hook}/profile.json`), getJson(`${hook}/scope.json`)]);
    const defaults = [];
    for (const id of (env.BITRIX_DIALOG_ID || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const d = await getJson(`${hook}/im.dialog.get.json?DIALOG_ID=${encodeURIComponent(id)}`);
      // Only blame chat membership when the webhook itself works.
      const problem = d.result ? null : profile.result ? 'the sender isn\'t a member of this chat' : null;
      defaults.push({ id, name: d.result?.name || null, ok: !!d.result || !profile.result, problem });
    }
    const p = profile.result;
    list.push({
      channel: 'bitrix', label: 'Bitrix24', status: p ? 'connected' : 'error',
      sender: p ? `${p.NAME || ''} ${p.LAST_NAME || ''}`.trim() || `User ${p.ID}` : null, senderDetail: p ? `Bitrix user ${p.ID}` : null,
      defaults, screenshots: Array.isArray(scope.result) && scope.result.includes('disk'),
      note: p ? null : 'Bitrix didn\'t accept the webhook. It may have been deleted or regenerated.',
    });
  } else list.push({ channel: 'bitrix', label: 'Bitrix24', status: 'needs-setup', note: 'Needs an inbound webhook with the im and disk permissions.' });

  if (has('SMTP_HOST') && has('SMTP_USER') && has('SMTP_PASSWORD')) {
    list.push({ channel: 'email', label: 'Email', status: 'set-up', sender: env.SMTP_FROM || env.SMTP_USER, senderDetail: `via ${env.SMTP_HOST}:${env.SMTP_PORT || 587}`, screenshots: true, note: 'Not verified until a test alert is sent.' });
  } else list.push({ channel: 'email', label: 'Email', status: 'needs-setup', note: 'Needs a sender mailbox\'s SMTP settings on the server.' });

  if (has('TELEGRAM_BOT_TOKEN')) {
    const me = await getJson(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN.trim()}/getMe`);
    list.push({ channel: 'telegram', label: 'Telegram', status: me.ok ? 'connected' : 'error', sender: me.ok ? `@${me.result.username}` : null, senderDetail: me.ok ? me.result.first_name : null, screenshots: true, note: me.ok ? null : 'Telegram didn\'t accept the bot token.' });
  } else list.push({ channel: 'telegram', label: 'Telegram', status: 'needs-setup', note: 'Needs a bot token from @BotFather.' });

  for (const [ch, label, prefix] of [['slack', 'Slack', 'SLACK_WEBHOOK_URL'], ['teams', 'Microsoft Teams', 'TEAMS_WEBHOOK_URL'], ['googlechat', 'Google Chat', 'GOOGLECHAT_WEBHOOK_URL'], ['webhook', 'Generic webhook', 'WEBHOOK_URL']]) {
    const names = named(prefix);
    if (has(prefix) || names.length) {
      list.push({ channel: ch, label, status: 'set-up', sender: 'Incoming webhook', senderDetail: [has(prefix) ? 'default' : null, ...names.map((n) => `${ch}:${n}`)].filter(Boolean).join(', '), screenshots: false, note: 'Posts as whatever the webhook was created for. Not verified until a test alert is sent.' });
    } else list.push({ channel: ch, label, status: 'needs-setup', note: ch === 'webhook' ? 'Needs a URL to POST alerts to (n8n, Zapier, an in-house app).' : `Needs an incoming webhook URL from ${label}.` });
  }

  if (has('WAZZUP_API_KEY') && has('WAZZUP_CHANNEL_ID')) {
    list.push({ channel: 'whatsapp', label: 'WhatsApp (Wazzup)', status: 'set-up', sender: 'Shared Wazzup account', screenshots: false, note: 'Not verified until a test alert is sent.' });
  } else list.push({ channel: 'whatsapp', label: 'WhatsApp (Wazzup)', status: 'needs-setup', note: 'Per app: an app that wants WhatsApp adds its own Wazzup key and channel ID.' });

  for (const c of list) c.overriddenBy = overrides(c.channel);
  channelCache = { key, at: Date.now(), data: { channels: list } };
  return channelCache.data;
}

// ---------- operations ----------
const OPS = {
  status: () => status(),

  channels: () => channels(),

  report: ({ action, start }) => {
    requireAction(action);
    if (typeof start !== 'string' || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(start)) refuse('Bad run time.');
    return { text: reportText(action, start) };
  },

  screenshot: ({ name }) => {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]+-\d{8}-\d{6}\.jpg$/.test(name)) refuse('Bad screenshot name.');
    const f = path.join(HOME, 'logs', 'screenshots', name);
    if (!fs.existsSync(f)) refuse('That screenshot has been deleted (they are kept 30 days).');
    return { base64: fs.readFileSync(f).toString('base64') };
  },

  setPaused: ({ action, paused }, actor) => {
    requireAction(action);
    const dir = path.join(HOME, 'config', 'paused');
    const f = path.join(dir, fileName(action));
    if (paused) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ by: actor, at: new Date().toISOString() }));
    } else if (fs.existsSync(f)) fs.unlinkSync(f);
    logChange(actor, paused ? 'pause' : 'resume', action);
    return { paused: !!paused };
  },

  runNow: ({ action }, actor) => {
    requireAction(action);
    if (markers(action).changesData) refuse('This check changes data, so it can only run on its schedule.');
    if (fs.existsSync(path.join(HOME, 'config', 'paused', fileName(action)))) refuse('This check is paused. Resume it first.');
    if (isRunning(action)) refuse('This check is already running.');
    const child = spawn(path.join(HOME, 'run.sh'), [action], {
      cwd: HOME, detached: true, stdio: 'ignore', env: { ...BASE_ENV, ARGUS_NODE: NODE },
    });
    child.unref();
    logChange(actor, 'run-now', action);
    return { started: true };
  },

  appSettings: ({ app }) => {
    requireApp(app);
    const env = readEnv();
    // Addresses and the sign-in name are shown in the console; the password is only ever reported as set or not.
    const credentials = Object.fromEntries(CRED_FIELDS.map((f) => [f, f === 'PASSWORD' ? !!env[`${app}_${f}`] : env[`${app}_${f}`] || null]));
    const notify = env[`${app}_NOTIFY`] ? env[`${app}_NOTIFY`].split(',').map((s) => s.trim()).filter(Boolean) : [];
    const reportList = env[`${app}_REPORTS`] ? env[`${app}_REPORTS`].split(',').map((s) => s.trim()).filter(Boolean) : [];
    // Run-report volume: one message per destination per run (retries don't add one).
    const cron = new Map(cronEntries().map((e) => [e.action, e.schedule]));
    const perCheck = registry().filter((c) => c.app === app && cron.has(c.action) && validAction(c.action)).map((c) => ({
      name: c.name || c.action, perWeekday: runsPerWeekday(cron.get(c.action)),
      paused: fs.existsSync(path.join(HOME, 'config', 'paused', fileName(c.action))),
    }));
    return {
      app, notify, alerts: alertStatus(app), credentials,
      reports: { destinations: reportList, ...reportStatus(app) },
      volume: { perCheck, perWeekday: perCheck.filter((c) => !c.paused).reduce((n, c) => n + c.perWeekday, 0) },
    };
  },

  // Run reports: every run's report (passed or failed) to its own list. Switching it off
  // keeps the list, so switching back on restores it.
  setReports: ({ app, enabled, destinations }, actor) => {
    requireApp(app);
    if (!Array.isArray(destinations) || destinations.length > 20) refuse('Bad destination list.');
    const list = destinations.map((d) => String(d).trim()).filter(Boolean);
    if (list.some((d) => d.length > 200 || /[\n\r,]/.test(d))) refuse('Bad destination.');
    if (enabled && !list.length) refuse('Add a destination for run reports first.');
    const value = list.join(', ');
    const check = withArgusEnv(() => resolveReportTargets(app), { [`${app}_REPORTS`]: value, [`${app}_REPORTS_ENABLED`]: enabled ? '1' : '' });
    const errors = check.problems.filter((p) => !p.includes(': missing '));
    if (list.length && errors.length) refuse(errors.join(' '));
    writeEnvKey(`${app}_REPORTS`, list.length ? value : null);
    writeEnvKey(`${app}_REPORTS_ENABLED`, enabled ? '1' : null);
    logChange(actor, 'set-run-reports', app, `${enabled ? 'on' : 'off'}${list.length ? `: ${value}` : ''}`);
    return { enabled: !!enabled, warnings: check.problems.filter((p) => p.includes(': missing ')) };
  },

  setNotify: ({ app, destinations }, actor) => {
    requireApp(app);
    if (!Array.isArray(destinations) || destinations.length > 20) refuse('Bad destination list.');
    const list = destinations.map((d) => String(d).trim()).filter(Boolean);
    if (list.some((d) => d.length > 200 || /[\n\r,]/.test(d))) refuse('Bad destination.');
    const value = list.join(', ');
    const check = withArgusEnv(() => resolveTargets(app), { [`${app}_NOTIFY`]: value });
    const errors = list.length ? check.problems.filter((p) => !p.includes(': missing ')) : [];
    if (errors.length) refuse(errors.join(' '));
    writeEnvKey(`${app}_NOTIFY`, list.length ? value : null);
    logChange(actor, 'set-alerts', app, list.length ? value : '(default chat)');
    return { warnings: list.length ? check.problems.filter((p) => p.includes(': missing ')) : [] };
  },

  setCredential: ({ app, field, value }, actor) => {
    requireApp(app);
    if (!CRED_FIELDS.includes(field)) refuse('Unknown field.');
    if (value !== null && (typeof value !== 'string' || !value.length || value.length > 500 || /[\n\r\0]/.test(value))) {
      refuse('Values must be 1–500 characters on one line.');
    }
    if (field.endsWith('URL') && value !== null && !/^https?:\/\/\S+$/.test(value)) refuse('That isn\'t a web address (it should start with https://).');
    writeEnvKey(`${app}_${field}`, value);
    logChange(actor, value === null ? 'clear-login-field' : 'set-login-field', `${app}_${field}`);
    return { set: value !== null };
  },

  testAlert: ({ app, reports }, actor) => {
    requireApp(app);
    const out = spawnSync(NODE, [`--env-file=${ENV_FILE}`, path.join(HOME, 'tools', 'notify.js'), '--app', app, '--test', ...(reports ? ['--reports'] : [])], {
      cwd: HOME, encoding: 'utf8', timeout: 90_000, env: { ...BASE_ENV },
    });
    logChange(actor, reports ? 'test-run-report' : 'test-alert', app);
    return { output: `${out.stdout || ''}${out.stderr || ''}`.trim().split('\n').slice(-30) };
  },

  // Sends a console invite or password-reset link to a person as a Bitrix direct message.
  notifyUser: ({ bitrixId, link, name, kind }, actor) => {
    if (typeof bitrixId !== 'string' || !/^\d{1,10}$/.test(bitrixId)) refuse('Bad Bitrix user ID.');
    if (typeof link !== 'string' || !link.startsWith(`${CONSOLE_URL}/setup#t=`) || link.length > 300) refuse('Bad link.');
    const who = String(name || '').slice(0, 80).replace(/[\n\r]/g, ' ');
    const text = kind === 'reset'
      ? `🔑 Argus console: a password reset was requested for ${who}.\nSet a new password here (works once, for 24 hours):\n${link}`
      : `👋 ${who}, you've been invited to the Argus console.\nChoose your password here (works once, for 24 hours):\n${link}`;
    const hook = (readEnv().BITRIX_WEBHOOK_URL || '').trim().replace(/\/+$/, '');
    if (!hook) refuse('Bitrix isn\'t set up on the server.');
    return fetch(`${hook}/im.message.add.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ DIALOG_ID: bitrixId, MESSAGE: text }),
    }).then(async (res) => {
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) refuse(`Bitrix didn't accept the message (${json.error || res.status}).`);
      logChange(actor, kind === 'reset' ? 'send-reset-link' : 'send-invite', `bitrix:${bitrixId}`);
      return { sent: true };
    });
  },
};

// ---------- socket server ----------
fs.mkdirSync(path.dirname(SOCKET), { recursive: true });
if (fs.existsSync(SOCKET)) fs.unlinkSync(SOCKET);
const server = net.createServer((conn) => {
  let buf = '';
  conn.setEncoding('utf8');
  conn.on('data', async (chunk) => {
    buf += chunk;
    if (buf.length > 1_000_000) return conn.destroy();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let req;
      try { req = JSON.parse(line); } catch { conn.write(JSON.stringify({ ok: false, error: 'Bad request.' }) + '\n'); continue; }
      const { id, op, args = {}, actor = 'unknown' } = req;
      try {
        if (!Object.hasOwn(OPS, op)) refuse('Unknown operation.');
        const result = await OPS[op](args, String(actor).slice(0, 120));
        conn.write(JSON.stringify({ id, ok: true, result }) + '\n');
      } catch (err) {
        if (!(err instanceof Refused)) console.error(`[agent] ${op} failed:`, err);
        conn.write(JSON.stringify({ id, ok: false, error: err instanceof Refused ? err.message : 'The agent hit an error. Details are in its log.' }) + '\n');
      }
    }
  });
  conn.on('error', () => {});
});
server.listen(SOCKET, () => {
  if (SOCKET_GROUP) {
    const gid = Number(spawnSync('getent', ['group', SOCKET_GROUP], { encoding: 'utf8' }).stdout.split(':')[2]);
    if (Number.isInteger(gid)) fs.chownSync(SOCKET, 0, gid);
    fs.chmodSync(SOCKET, 0o660);
  }
  console.log(`[agent] listening on ${SOCKET} (Argus at ${HOME})`);
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); process.exit(0); });
