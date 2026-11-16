// Argus console. Views (in the address after #):
//   checks            every check, grouped by app
//   check/<action>    one check: status, history, how it behaves
//   apps/<APP>        one app's settings: checks on/off, notifications, app login
//   channels          who each alert channel sends as
//   activity          who changed what, by day
//   people            accounts (admins)
//   account           your password
// Everything comes from the console API (console/server.js); nothing is cached in the browser.
const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const enc = encodeURIComponent;
let me = null;
let status = null;
let statusAt = null;
const CRED_FIELDS = [
  ['URL', 'App address', 'https://app.example.com'],
  ['LOGIN_URL', 'Login page (if different)', 'https://app.example.com/login'],
  ['EMAIL', 'Test account email', 'test@example.com'],
  ['USERNAME', 'Test account username', 'only if it signs in with a username'],
  ['PASSWORD', 'Test account password', ''],
];
const FORMATS = 'Formats: bitrix:chat1234 (group chat), bitrix:57 (a person), email:name@company.com, telegram:-100…, slack, teams, googlechat, webhook.';

// ---------- helpers ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Argus': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('Please sign in.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}
let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}
// A button that needs a second click within 4 s; the first click asks.
function confirmClick(btn, question, fn) {
  if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; return fn(); }
  btn.dataset.label = btn.textContent; btn.dataset.armed = '1'; btn.textContent = question;
  setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; } }, 4000);
}
const MYT = { timeZone: 'Asia/Kuala_Lumpur' };
const dayKey = (d) => d.toLocaleDateString('en-CA', MYT);
function dayLabel(d) {
  const k = dayKey(d);
  if (k === dayKey(new Date())) return 'Today';
  if (k === dayKey(new Date(Date.now() - 86400_000))) return 'Yesterday';
  if (k === dayKey(new Date(Date.now() + 86400_000))) return 'Tomorrow';
  return d.toLocaleDateString('en-GB', { ...MYT, weekday: 'short', day: 'numeric', month: 'short' });
}
const clock = (d) => d.toLocaleTimeString('en-GB', { ...MYT, hour: '2-digit', minute: '2-digit' });
const when = (d) => `${dayLabel(d)}, ${clock(d)}`;
const runDate = (start) => new Date(start.replace(' ', 'T') + '+08:00');   // log times are MYT
// "16/11/2026 09:01:50" (core/report.js state) -> Date
const stateDate = (s) => { const m = String(s || '').match(/^(\d\d)\/(\d\d)\/(\d{4}) (\d\d:\d\d)/); return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:00+08:00`) : null; };
const stateWhen = (s) => { const d = stateDate(s); return d ? when(d) : s; };
const took = (s) => (s == null ? '' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const appName = (app) => status?.checks.find((c) => c.app === app)?.appName || app;
const appsOf = () => [...new Set(status.checks.map((c) => c.app).filter(Boolean))];
const label = (t) => `${t.channel}${t.to ? `:${t.to}` : ''}`;
const appInfo = (app) => status.apps.find((x) => x.app === app) || { alerts: status.defaultAlerts, reports: { enabled: false, targets: [], problems: [] } };
// "[nginx] 16/11/2026 16:20:01 OK — …" -> "OK — …": the run's time is already in its own column.
const tidy = (s) => String(s || '').replace(/^\[[\w-]+\]\s*(\d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d\s*)?/, '');
const chipsRO = (targets) => targets.map((t) => `<span class="dest ro ${t.ok ? '' : 'bad'}"${t.ok ? '' : ' title="This channel isn\'t set up on the server"'}>${esc(label(t))}</span>`).join('');

// ---------- Checks ----------
function stateOf(c) {
  if (c.retired) return ['idle', 'Retired'];
  if (c.paused) return ['idle', 'Paused'];
  if (c.running) return ['warn', 'Running now'];
  if (c.state?.status === 'fail') return ['fail', 'Failing'];
  if (!c.runs.some((r) => !r.skipped)) return ['idle', 'No runs yet'];
  return ['pass', 'Passing'];
}
const eyes = (c) => {
  const runs = c.runs.filter((r) => !r.skipped).slice(0, 5).reverse();
  const pad = Array.from({ length: 5 - runs.length }, () => '<span class="eye none" title="No run"></span>');
  return `<span class="eyes" aria-label="Last runs">${pad.join('')}${runs.map((r) => `<span class="eye ${r.exit ? 'fail' : ''}" title="${esc(when(runDate(r.start)))}: ${r.exit ? 'failed' : 'passed'}"></span>`).join('')}</span>`;
};
const chev = '<svg class="chev" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderChecks() {
  const v = $('#view-checks');
  if (!status) { v.innerHTML = '<p class="muted">Loading checks…</p>'; return; }
  const checks = status.checks.filter((c) => !c.retired);
  const retired = status.checks.filter((c) => c.retired);
  const failing = checks.filter((c) => c.state?.status === 'fail' && !c.paused);
  const paused = checks.filter((c) => c.paused);
  const next = checks.filter((c) => c.next).sort((a, b) => a.next.localeCompare(b.next))[0];
  const groups = [...appsOf().map((app) => [app, checks.filter((c) => c.app === app)]), [null, checks.filter((c) => !c.app)]].filter(([, list]) => list.length);
  v.innerHTML = `
    <div class="page-head">
      <div class="lead">
        <h1>${failing.length ? `${plural(failing.length, 'check')} failing` : `All ${checks.length - paused.length} checks passing`}</h1>
        <p>${paused.length ? `${plural(paused.length, 'check')} paused. ` : ''}${next ? `Next: ${esc(next.name)}, ${esc(when(new Date(next.next)))}.` : ''}</p>
      </div>
      <p class="hint">Updated ${esc(clock(statusAt))} · refreshes every minute</p>
    </div>
    ${groups.map(([app, list]) => `<section class="group" aria-label="${esc(app ? appName(app) : 'Other checks')}">
      <div class="group-head"><h2>${esc(app ? appName(app) : 'Other checks')}</h2><span class="hint">${plural(list.length, 'check')}</span>${app ? `<a href="#apps/${esc(app)}">Settings</a>` : ''}</div>
      <div class="ledger" role="list">
        <div class="ledger-head" aria-hidden="true"><span>Status</span><span>Check</span><span>Schedule</span><span>Last run</span><span>Last 5 runs</span><span></span></div>
        ${list.map(rowHTML).join('')}
      </div></section>`).join('')}
    ${retired.length ? `<section class="group" aria-label="Retired checks">
      <div class="group-head"><h2>Retired</h2><span class="hint">${plural(retired.length, 'check')} · not running</span></div>
      <div class="ledger" role="list">${retired.map(rowHTML).join('')}</div></section>` : ''}`;
}

function rowHTML(c) {
  const [cls, text] = stateOf(c);
  const last = c.runs.find((r) => !r.skipped);
  return `<div class="row" role="listitem"><a class="row-main" href="#check/${enc(c.action)}">
      <span class="c-status"><span class="pill ${cls}">${text}</span></span>
      <span class="name"><b>${esc(c.name)}${c.changesData ? '<span class="tag write">Changes data</span>' : ''}</b><small>${esc(c.site || c.action)}</small></span>
      <span class="cell c-sched">${c.retired ? 'Retired' : esc(c.scheduleText)}<small>${c.retired ? 'Not running' : c.paused ? 'Paused' : c.next ? `Next: ${esc(when(new Date(c.next)))}` : 'Runs when started'}</small></span>
      <span class="cell c-last">${last ? esc(when(runDate(last.start))) : '—'}<small>${last ? `${last.exit ? 'Failed' : 'Passed'} · ${esc(took(last.seconds))}` : ''}</small></span>
      ${eyes(c)}
      ${chev}
    </a></div>`;
}

// ---------- one check ----------
function renderCheck(action) {
  const v = $('#view-check');
  if (!status) { v.innerHTML = '<p class="muted">Loading…</p>'; return; }
  const c = status.checks.find((x) => x.action === action);
  if (!c) { v.innerHTML = '<p class="msg err">That check isn\'t in Argus any more.</p><p><a href="#checks">Back to all checks</a></p>'; return; }
  const [cls, text] = stateOf(c);
  const last = c.runs.find((r) => !r.skipped);
  const info = appInfo(c.app);
  const s = c.state;
  const days = c.daily.slice(0, 14);
  const runs14 = days.reduce((n, d) => n + d.runs, 0), failed14 = days.reduce((n, d) => n + d.failed, 0);
  const frequent = c.totalRuns > 60;
  const runNote = c.changesData ? 'Run now is off because this check changes data. It only runs on its schedule.' : c.running ? 'It\'s running right now.' : '';
  const admin = me?.role === 'admin';
  const canSchedule = !c.retired && (!c.changesData || admin);
  const stateLine = !s ? 'No result saved yet'
    : s.status === 'fail' ? `Since ${esc(stateWhen(s.since))} · ${plural(s.failedRuns, 'failed run')} in a row · last alert ${esc(s.lastAlert)}`
      : `Since ${esc(stateWhen(s.since))}`;
  v.innerHTML = `
    <nav class="crumbs" aria-label="Breadcrumb"><a href="#checks">Checks</a><span aria-hidden="true">/</span>${c.app ? `<a href="#apps/${esc(c.app)}">${esc(appName(c.app))}</a><span aria-hidden="true">/</span>` : ''}<span aria-current="page">${esc(c.name)}</span></nav>
    <div class="page-head">
      <div class="lead"><h1>${esc(c.name)}${c.changesData ? '<span class="tag write">Changes data</span>' : ''}</h1><p>${esc(c.description || c.site)}</p></div>
      <div class="actions">${c.retired
        ? (admin ? `<button class="btn primary" data-act="unretire" data-action="${esc(c.action)}">Bring back</button>` : '')
        : `<button class="btn primary" data-act="run" data-action="${esc(c.action)}" ${c.changesData || c.paused || c.running ? 'disabled' : ''}>Run now</button>
        <button class="btn" data-act="pause" data-action="${esc(c.action)}" data-paused="${c.paused ? '1' : ''}">${c.paused ? 'Resume' : 'Pause'}</button>`}
      </div>
    </div>
    ${c.retired ? `<p class="msg warn">Retired by ${esc(c.retired.by || 'someone')}${c.retired.at ? ` on ${esc(when(new Date(c.retired.at)))}` : ''}. It doesn't run any more; its code and history are kept.${admin ? ` Bring back restores its schedule${c.retired.schedule ? ` (${esc(describeCron(c.retired.schedule))})` : ''}.` : ''}</p>` : ''}
    ${c.paused ? `<p class="msg warn">Paused by ${esc(c.paused.by || 'someone')}${c.paused.at ? ` on ${esc(when(new Date(c.paused.at)))}` : ''}. It won't run until it's resumed.</p>` : ''}
    ${runNote ? `<p class="hint">${esc(runNote)}</p>` : ''}
    <div class="stats">
      <div class="stat"><span>Status</span><b><span class="pill ${cls}">${text}</span></b><small>${stateLine}</small></div>
      <div class="stat"><span>Schedule</span><b>${c.retired ? 'Retired' : esc(c.scheduleText)}</b><small>${c.retired ? 'Not running' : c.paused ? 'Paused' : c.next ? `Next: ${esc(when(new Date(c.next)))}` : 'Runs when started'}${canSchedule ? ' · <button class="link-btn" type="button" data-act="sched-open">Change</button>' : ''}</small></div>
      <div class="stat"><span>Last run</span><b>${last ? esc(when(runDate(last.start))) : '—'}</b><small>${last ? `${last.exit ? 'Failed' : 'Passed'} · took ${esc(took(last.seconds))}` : 'No runs yet'}</small></div>
      <div class="stat"><span>Last 14 days</span><b>${plural(runs14, 'run')}</b><small>${failed14 ? `${failed14} failed` : 'None failed'}</small></div>
    </div>
    ${canSchedule ? schedEditor(c) : ''}
    <div class="split">
      <section class="card">
        <header><h2>${frequent ? 'Latest runs' : 'Run history'}</h2><p>Open a report to see every step${c.noBrowser ? '' : ', and the screenshot when a run failed'}.</p></header>
        <div class="tbl-wrap"><table class="runs">
          <thead><tr><th>When (MYT)</th><th>Result</th><th>Took</th><th>Summary</th><th><span class="sr">Report</span></th></tr></thead>
          <tbody>${c.runs.slice(0, frequent ? 10 : 20).map((r) => `<tr>
            <td class="num">${esc(when(runDate(r.start)))}</td>
            <td>${r.skipped ? '<span class="pill idle">Skipped</span>' : r.exit ? '<span class="pill fail">Failed</span>' : '<span class="pill pass">Passed</span>'}</td>
            <td class="num">${esc(took(r.seconds))}</td>
            <td class="sum"><span title="${esc(r.skipped || tidy(r.summary))}">${esc(r.skipped || tidy(r.summary))}</span>${r.retried ? '<small>Retried once</small>' : ''}</td>
            <td>${r.skipped ? '' : `<button class="btn small" data-act="report" data-action="${esc(c.action)}" data-start="${esc(r.start)}">Report</button>`}</td>
          </tr>`).join('') || '<tr><td colspan="5" class="muted">No runs in the logs yet.</td></tr>'}</tbody>
        </table></div>
        ${frequent ? `<h3>Per day</h3><div class="tbl-wrap"><table>
          <thead><tr><th>Day</th><th>Runs</th><th>Failed</th></tr></thead>
          <tbody>${days.map((d) => `<tr><td class="num">${esc(dayLabel(new Date(d.date + 'T12:00:00+08:00')))}</td><td class="num">${d.runs}</td><td class="num">${d.failed ? `<span class="pill fail">${d.failed}</span>` : '0'}</td></tr>`).join('')}</tbody>
        </table></div>` : ''}
      </section>
      <aside class="card side" aria-label="How it works">
        ${c.steps.length ? `<div class="side-sec"><h3>What it checks</h3><ol class="steps">${c.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></div>` : ''}
        <div class="side-sec"><h3>When it fails</h3><p>${esc(c.retry)}. While it keeps failing it alerts at most once a day, and sends "passing again" when it recovers.</p></div>
        <div class="side-sec"><h3>Failure alerts go to</h3><div class="dests">${chipsRO(info.alerts.targets) || '<span class="muted">Nowhere</span>'}${info.alerts.source.startsWith('default') ? '<span class="hint">default chat</span>' : ''}</div></div>
        <div class="side-sec"><h3>Run reports</h3>${info.reports.enabled ? `<div class="dests">${chipsRO(info.reports.targets)}</div><p class="hint">Every run's report, passed or failed.</p>` : '<p class="muted">Off</p>'}</div>
        ${c.app ? `<a class="btn" href="#apps/${esc(c.app)}">Change notifications or login</a>` : ''}
        <p class="hint">Runs as <span class="mono">run.sh ${esc(c.action)}</span>${c.changesData ? '. It changes data, so it never retries.' : ''}${c.changesData && !admin ? ' Only an admin can change its schedule.' : ''}</p>
        ${admin && !c.retired ? `<div class="side-sec retire"><button class="btn small danger" type="button" data-act="retire" data-action="${esc(c.action)}">Retire this check</button><p class="hint">Stops it for good and removes its schedule. Its code and history stay, and you can bring it back.</p></div>` : ''}
      </aside>
    </div>`;
}

// ---------- schedule editor ----------
// Cron in words, as the agent says it (console/agent.js describeCron).
function describeCron(expr) {
  const [mi, h, dom, mon, dow] = String(expr).split(/\s+/);
  const days = dow === '*' ? 'Every day' : dow === '1-5' ? 'Mon–Fri' : dow === '0,6' || dow === '6,0' ? 'Weekends' : `Days ${dow}`;
  if (/^\*\/\d+$/.test(mi) && h === '*') return `Every ${mi.slice(2)} min${dow === '*' ? ', all days' : `, ${days}`}`;
  if (mi === '0' && h === '*') return `Every hour${dow === '*' ? ', all days' : `, ${days}`}`;
  if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom === '*' && mon === '*') return `${days} ${h.padStart(2, '0')}:${mi.padStart(2, '0')}`;
  return expr;
}
function schedEditor(c) {
  const cur = c.schedule || '';
  let mode = cur ? 'custom' : 'none', time = '09:15', every = '15', days = '*', m;
  if ((m = cur.match(/^(\d+) (\d+) \* \* (1-5|\*)$/))) { mode = m[3] === '*' ? 'daily' : 'weekdays'; time = `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`; }
  else if ((m = cur.match(/^\*\/(5|10|15|20|30) \* \* \* (1-5|\*)$/))) { mode = 'every'; [, every, days] = m; }
  else if ((m = cur.match(/^0 \* \* \* (1-5|\*)$/))) { mode = 'every'; every = '60'; days = m[1]; }
  const opt = (v, text, sel) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${text}</option>`;
  return `<section class="card narrow" id="sched-editor" hidden>
    <header><h2>Change schedule</h2><p>Times are Malaysia time (MYT). Runs must be at least 5 minutes apart. The change applies from the next run and is recorded in Activity.${c.changesData ? ' This check changes data: every run clocks the account in or out.' : ''}</p></header>
    <form class="form" data-act="sched-save" data-action="${esc(c.action)}">
      <label>Runs<select name="mode">${opt('weekdays', 'On weekdays, at a set time', mode)}${opt('daily', 'Every day, at a set time', mode)}${opt('every', 'Every few minutes', mode)}${opt('custom', 'Custom (cron)', mode)}${opt('none', 'Only when started (no schedule)', mode)}</select></label>
      <label data-for="weekdays daily">Time<input type="time" name="time" value="${time}" step="60"></label>
      <label data-for="every">How often<select name="every">${['5', '10', '15', '20', '30', '60'].map((n) => opt(n, n === '60' ? 'Every hour' : `Every ${n} minutes`, every)).join('')}</select></label>
      <label data-for="every">On<select name="days">${opt('*', 'All days', days)}${opt('1-5', 'Weekdays only', days)}</select></label>
      <label data-for="custom">Cron<small>Five fields: minute, hour, day, month, weekday. For example 15 9 * * 1-5.</small><input type="text" name="cron" class="mono-input" value="${esc(mode === 'custom' ? cur : '')}" autocomplete="off"></label>
      <p class="hint" data-preview></p>
      <div class="actions"><button class="btn primary" type="submit">Save schedule</button><button class="btn" type="button" data-act="sched-close">Cancel</button></div>
    </form></section>`;
}
// The form as a cron expression; null = no schedule, '' = incomplete.
function schedFromForm(f) {
  const d = Object.fromEntries(new FormData(f));
  if (d.mode === 'none') return null;
  if (d.mode === 'weekdays' || d.mode === 'daily') {
    const [h, mi] = String(d.time || '').split(':').map(Number);
    return Number.isInteger(h) && Number.isInteger(mi) ? `${mi} ${h} * * ${d.mode === 'weekdays' ? '1-5' : '*'}` : '';
  }
  if (d.mode === 'every') return d.every === '60' ? `0 * * * ${d.days}` : `*/${d.every} * * * ${d.days}`;
  return String(d.cron || '').trim().replace(/\s+/g, ' ');
}
function syncSched(f) {
  for (const l of f.querySelectorAll('[data-for]')) l.hidden = !l.dataset.for.split(' ').includes(f.mode.value);
  const expr = schedFromForm(f);
  $('[data-preview]', f).textContent = expr === null ? 'It will only run when someone presses Run now.' : expr ? `Will run: ${describeCron(expr)} (cron ${expr})` : '';
}

async function openReport(action, start) {
  const c = status.checks.find((x) => x.action === action);
  const ov = $('#overlay');
  ov.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="rep-title">
    <div class="dialog-head"><h2 id="rep-title">${esc(c?.name || action)} · ${esc(when(runDate(start)))}</h2><button class="icon-btn" data-act="close" aria-label="Close">×</button></div>
    <div class="dialog-body"><p class="muted">Loading the report…</p></div></div>`;
  ov.hidden = false;
  $('.icon-btn', ov).focus();
  try {
    const { text } = await api(`/api/report?action=${enc(action)}&start=${enc(start)}`);
    const shots = [...text.matchAll(/logs\/screenshots\/([\w.-]+\.jpg)/g)].map((m) => m[1]);
    const body = $('.dialog-body', ov);
    body.innerHTML = `${shots.map((s) => `<figure><img src="/api/screenshot/${enc(s)}" alt="Screenshot at the moment of failure"><figcaption class="hint">${esc(s)}</figcaption></figure>`).join('')}<pre class="out"></pre>`;
    $('pre', body).textContent = text;
  } catch (err) {
    $('.dialog-body', ov).innerHTML = `<p class="msg err">${esc(err.message)}</p>`;
  }
}
const closeOverlay = () => { $('#overlay').hidden = true; $('#overlay').innerHTML = ''; };

async function refreshStatus() {
  try {
    status = await api('/api/status');
    statusAt = new Date();
  } catch (err) {
    if (!status) $('#view-checks').innerHTML = `<p class="msg err">${esc(err.message)}</p>`;
    return;
  }
  const { v, arg } = parseHash();
  if (v === 'checks') renderChecks();
  if (v === 'check' && $('#sched-editor')?.hidden !== false) renderCheck(arg);   // not while the schedule is being edited
}

// ---------- Apps ----------
async function renderApps(app) {
  const v = $('#view-apps');
  if (!status) await refreshStatus();
  const apps = appsOf();
  if (!apps.includes(app)) app = apps[0];
  v.innerHTML = `<div class="lead"><h1>Apps</h1><p>Each app's checks, where its notifications go, and the test account its checks sign in with. Changes apply straight away and are recorded in Activity.</p></div>
    ${apps.length > 1 ? `<nav class="tabs" aria-label="Apps">${apps.map((a) => `<a href="#apps/${esc(a)}" ${a === app ? 'aria-current="page"' : ''}>${esc(appName(a))}<small>${plural(status.checks.filter((c) => c.app === a).length, 'check')}</small></a>`).join('')}</nav>` : ''}
    <div id="app-body" class="cards" data-app="${esc(app || '')}">${app ? '<p class="muted">Loading…</p>' : '<p class="muted">No apps yet.</p>'}</div>`;
  if (app) loadApp(app);
}

async function loadApp(app) {
  const box = $('#app-body');
  if (!box || box.dataset.app !== app) return;
  let s;
  try { s = await api(`/api/apps/${app}`); } catch (err) { box.innerHTML = `<p class="msg err">${esc(err.message)}</p>`; return; }
  const checks = status.checks.filter((c) => c.app === app);
  const signsIn = checks.some((c) => !c.noBrowser);   // checks without a browser never use an app login
  const usingDefault = !s.notify.length;
  const chip = (act, d, i, targets) => {
    const t = targets.find((x) => label(x) === d.replace(/^whatsapp:\+?/, 'whatsapp:').replace(/\s|-/g, ''));
    return `<span class="dest ${t && !t.ok ? 'bad' : ''}">${esc(d)}<button type="button" data-act="${act}" data-app="${esc(app)}" data-i="${i}" aria-label="Remove ${esc(d)}">×</button></span>`;
  };
  const r = s.reports, vol = s.volume;
  const per = vol.perCheck.map((c) => `${esc(c.name)} ${c.perWeekday}${c.paused ? ' (paused, not counted)' : ''}`).join(' · ');
  const msgs = vol.perWeekday * Math.max(r.destinations.length, 1);
  box.innerHTML = `
    <section class="card">
      <header><h2>Checks</h2><p>On means it runs on its schedule. Turn one off to pause it. Change when it runs on its own page.</p></header>
      <ul class="check-list">${checks.map((c) => `<li>
        ${c.retired ? `<span class="toggle"><span><b>${esc(c.name)}</b><small>Retired</small></span></span>` : `<label class="toggle"><input type="checkbox" data-act="pause-toggle" data-app="${esc(app)}" data-action="${esc(c.action)}" ${c.paused ? '' : 'checked'} aria-label="${esc(c.name)} is ${c.paused ? 'paused' : 'on'}">
          <span><b>${esc(c.name)}</b><small>${c.paused ? '<span class="paused">Paused</span>' : esc(c.scheduleText)}</small></span></label>`}
        <a href="#check/${enc(c.action)}">Schedule and history</a></li>`).join('')}</ul>
    </section>

    <section class="card">
      <header><h2>Notifications</h2><p>Failure alerts go out when a run fails. Run reports, if switched on, go out after every run.</p></header>
      <div class="notif">
        <div class="panel">
          <div class="panel-head"><h3>Failure alerts</h3><span class="pill pass">Always on</span></div>
          <p class="hint">Each destination gets the failure (at most once a day while it keeps failing) and the "passing again" message.</p>
          <div class="dests">${usingDefault
            ? `${chipsRO(s.alerts.targets)}<span class="hint">default chat</span>`
            : s.notify.map((d, i) => chip('dest-remove', d, i, s.alerts.targets)).join('')}</div>
          ${usingDefault ? '<p class="hint">Using the default chat. Adding a destination keeps the default chat in this list too; remove it if this app shouldn\'t alert there.</p>' : ''}
          ${s.alerts.problems.length ? `<p class="msg warn">${s.alerts.problems.map(esc).join('<br>')}</p>` : ''}
          <form class="inline-form" data-act="dest-add" data-app="${esc(app)}"><input type="text" class="mono-input" placeholder="bitrix:chat1234" aria-label="Add a failure-alert destination for ${esc(appName(app))}"><button class="btn" type="submit">Add</button></form>
          <div class="actions"><button class="btn small" type="button" data-act="test-alert" data-app="${esc(app)}">Send test alert</button></div>
          <pre class="out" data-out="${esc(app)}" hidden></pre>
        </div>
        <div class="panel">
          <div class="panel-head"><h3>Run reports</h3><label class="toggle"><input type="checkbox" data-act="reports-toggle" data-app="${esc(app)}" ${r.enabled ? 'checked' : ''} aria-label="Send ${esc(appName(app))} a report after every run"> ${r.enabled ? '<b>On</b>' : '<span class="muted">Off</span>'}</label></div>
          <p class="hint">Every run's report, passed or failed, to its own list. About ${plural(vol.perWeekday, 'run')} a weekday${per ? ` (${per})` : ''}.</p>
          <div class="dests">${r.destinations.map((d, i) => chip('rdest-remove', d, i, r.targets)).join('') || '<span class="hint">No destinations yet. Add one, then switch it on.</span>'}</div>
          ${r.problems.length ? `<p class="msg warn">${r.problems.map(esc).join('<br>')}</p>` : ''}
          ${vol.perWeekday > 50 ? `<p class="msg warn">That's about ${msgs} messages a weekday${r.destinations.length > 1 ? ` across ${r.destinations.length} destinations` : ''}. Use a chat nobody needs to watch closely.</p>` : ''}
          <form class="inline-form" data-act="rdest-add" data-app="${esc(app)}"><input type="text" class="mono-input" placeholder="bitrix:chat1234" aria-label="Add a run-report destination for ${esc(appName(app))}"><button class="btn" type="submit">Add</button></form>
          <div class="actions"><button class="btn small" type="button" data-act="test-report" data-app="${esc(app)}" ${r.destinations.length ? '' : 'disabled'}>Send test report</button></div>
          <pre class="out" data-out-r="${esc(app)}" hidden></pre>
        </div>
      </div>
      <p class="hint">${FORMATS} Who each channel sends as: <a href="#channels">Channels</a>.</p>
    </section>

    ${signsIn ? `<section class="card">
      <header><h2>App login</h2><p>The test account these checks sign in with. The password is stored on the server and never shown.</p></header>
      <div class="tbl-wrap"><table class="cred-table"><tbody>${CRED_FIELDS
        .filter(([f]) => f !== 'USERNAME' || s.credentials.USERNAME || !s.credentials.EMAIL)   // username only when an app uses one
        .map(([f, text]) => {
          const val = s.credentials[f];
          const shown = f === 'PASSWORD'
            ? (val ? '<span class="mono">••••••••</span>' : '<span class="muted">not set</span>')
            : val ? `<span class="mono">${esc(val)}</span>` : `<span class="muted">${f === 'LOGIN_URL' ? 'not set (uses the app address)' : 'not set'}</span>`;
          return `<tr><th scope="row">${esc(text)}</th><td>${shown}</td><td class="cred-act"><button class="btn small" type="button" data-act="cred-edit" data-app="${esc(app)}" data-field="${f}" data-has="${val ? '1' : ''}" data-value="${f === 'PASSWORD' ? '' : esc(val || '')}">${val ? (f === 'PASSWORD' ? 'Change' : 'Edit') : 'Add'}</button></td></tr>`;
        }).join('')}</tbody></table></div>
    </section>` : ''}`;
}

// ---------- Channels ----------
const PLACEHOLDER = {
  BITRIX_WEBHOOK_URL: 'https://fusioneta.bitrix24.com/rest/57/abc123…/', BITRIX_DIALOG_ID: 'chat6356',
  SMTP_HOST: 'smtp.office365.com', SMTP_PORT: '587', SMTP_USER: 'argus@fusioneta.com', SMTP_FROM: 'Argus <argus@fusioneta.com>',
  TELEGRAM_BOT_TOKEN: '123456789:AA…', SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/…', TEAMS_WEBHOOK_URL: 'https://….logic.azure.com/…',
  GOOGLECHAT_WEBHOOK_URL: 'https://chat.googleapis.com/v1/spaces/…', WEBHOOK_URL: 'https://n8n.example.com/webhook/argus',
};
const TEST_TO = { bitrix: 'chat1234 or a user number (empty: the default chat)', email: 'you@fusioneta.com', telegram: 'Chat ID, e.g. -1001234567890' };

async function renderChannels() {
  const v = $('#view-channels');
  const admin = me?.role === 'admin';
  const head = `<div class="lead"><h1>Channels</h1><p>Who Argus sends notifications as, per channel. Apps without their own list use the default chat.
    ${admin ? 'Webhook URLs, tokens and passwords are saved on the server and never shown again.' : 'Admins set up and change channels.'}</p></div>`;
  v.innerHTML = `${head}<p class="muted">Checking each channel…</p>`;
  let data;
  try { data = await api('/api/channels'); } catch (err) { v.innerHTML = `${head}<p class="msg err">${esc(err.message)}</p>`; return; }
  const pill = (s) => ({ connected: '<span class="pill pass">Connected</span>', 'set-up': '<span class="pill pass">Set up</span>', error: '<span class="pill fail">Not working</span>' }[s] || '<span class="pill idle">Needs setup</span>');
  const ready = data.channels.filter((c) => c.status !== 'needs-setup');
  const rest = data.channels.filter((c) => c.status === 'needs-setup');
  const form = (c) => `<form class="form chan-form" data-act="chan-save" data-ch="${c.channel}" hidden>
      ${c.fields.map((f) => `<label>${esc(f.label)}${f.secret ? `<small>${f.set ? `Saved${f.hint ? ` (${esc(f.hint)})` : ''}. Leave empty to keep it.` : 'Saved on the server and never shown again.'}</small>` : ''}
        <input name="${f.key}" type="${f.secret ? 'password' : 'text'}" class="mono-input" autocomplete="off" data-was="${f.secret ? '' : esc(f.value || '')}" value="${f.secret ? '' : esc(f.value || '')}" placeholder="${esc(PLACEHOLDER[f.key] || '')}"></label>`).join('')}
      <div class="actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-act="chan-close" data-ch="${c.channel}">Cancel</button>
        ${c.status !== 'needs-setup' && c.channel !== 'bitrix' ? `<button class="btn danger" type="button" data-act="chan-clear" data-ch="${c.channel}">Remove channel</button>` : ''}</div>
    </form>`;
  const test = (c) => `<form class="inline-form" data-act="chan-test" data-ch="${c.channel}" hidden>
      ${TEST_TO[c.channel] ? `<input type="text" class="mono-input" placeholder="${esc(TEST_TO[c.channel])}" aria-label="Send the test to">` : ''}
      <button class="btn" type="submit">Send test</button></form>
    <pre class="out" data-out-ch="${c.channel}" hidden></pre>`;
  const tools = (c) => (!admin || !c.fields?.length ? '' : `<div class="actions">
      <button class="btn small" type="button" data-act="chan-edit" data-ch="${c.channel}">${c.status === 'needs-setup' ? 'Set up' : 'Change settings'}</button>
      ${c.status !== 'needs-setup' ? `<button class="btn small" type="button" data-act="chan-test-open" data-ch="${c.channel}">Send a test</button>` : ''}</div>
    ${form(c)}${c.status !== 'needs-setup' ? test(c) : ''}`);
  v.innerHTML = `${head}
    <div class="cards">${ready.map((c) => `<section class="card channel" id="ch-${c.channel}">
      <div class="panel-head"><h2>${esc(c.label)}</h2>${pill(c.status)}</div>
      <dl>
        <dt>Sends as</dt><dd>${c.sender ? `${esc(c.sender)}${c.senderDetail ? ` <span class="hint">${esc(c.senderDetail)}</span>` : ''}` : '—'}</dd>
        ${c.defaults?.length ? `<dt>Default chat</dt><dd>${c.defaults.map((d) => `${d.name ? esc(d.name) : '<span class="muted">unknown chat</span>'} <span class="hint mono">${esc(c.channel)}:${esc(d.id)}</span>${d.ok ? '' : `<br><span class="hint">⚠ ${esc(d.problem)}</span>`}`).join('<br>')}</dd>` : ''}
        <dt>Screenshots</dt><dd>${c.screenshots ? 'Attached to failure alerts' : 'Named in the message, not attached'}</dd>
        ${c.overriddenBy?.length ? `<dt>Own sender</dt><dd>${esc(c.overriddenBy.join(', '))}</dd>` : ''}
      </dl>
      ${c.note ? `<p class="hint">${esc(c.note)}</p>` : ''}
      ${tools(c)}
    </section>`).join('')}
    ${!rest.length ? '' : admin
    ? `<h2 class="sub">Not set up</h2>${rest.map((c) => `<section class="card channel" id="ch-${c.channel}">
        <div class="panel-head"><h3>${esc(c.label)}</h3>${pill(c.status)}</div>
        ${c.note ? `<p class="hint">${esc(c.note)}</p>` : ''}${tools(c)}</section>`).join('')}`
    : `<section class="card"><header><h2>Not set up</h2><p>These channels can't be used until an admin sets them up.</p></header>
      <div class="tbl-wrap"><table><tbody>${rest.map((c) => `<tr><th scope="row" class="plain">${esc(c.label)}</th><td>${esc(c.note || '')}</td></tr>`).join('')}</tbody></table></div></section>`}
    </div>`;
}

// ---------- Activity ----------
async function renderActivity() {
  const v = $('#view-activity');
  const head = '<div class="lead"><h1>Activity</h1><p>Who changed what in the console, newest first.</p></div>';
  v.innerHTML = `${head}<p class="muted">Loading…</p>`;
  try {
    const rows = await api('/api/audit');
    if (!status) await refreshStatus();
    const names = new Map((status?.checks || []).flatMap((c) => [[c.app, c.appName], [c.action, c.name]]).filter(([k, n]) => k && n));
    const target = (t) => String(t || '').replace(/^[A-Za-z0-9_/-]+/, (k) => names.get(k) || k);
    const days = [];
    for (const r of rows) {
      const k = dayKey(new Date(r.at));
      if (days.at(-1)?.k !== k) days.push({ k, label: dayLabel(new Date(r.at)), rows: [] });
      days.at(-1).rows.push(r);
    }
    v.innerHTML = `${head}${days.map((d) => `<section class="day"><h2>${esc(d.label)}</h2>
      <div class="tbl-wrap"><table class="activity"><tbody>${d.rows.map((r) => `<tr>
        <td class="num">${esc(clock(new Date(r.at)))}</td>
        <td class="who-cell" title="${esc(r.actor)}">${esc(String(r.actor).replace(/\s*<[^>]*>$/, ''))}</td>
        <td>${esc(r.action[0].toUpperCase() + r.action.slice(1))}${r.target || r.detail ? `<br><span class="hint mono">${esc([target(r.target), r.detail].filter(Boolean).join(' · '))}</span>` : ''}</td>
      </tr>`).join('')}</tbody></table></div></section>`).join('') || '<p class="muted">Nothing yet.</p>'}`;
  } catch (err) { v.innerHTML = `${head}<p class="msg err">${esc(err.message)}</p>`; }
}

// ---------- People ----------
let lastLink = null;
let inviteOpen = false;
async function renderPeople() {
  const v = $('#view-people');
  if (me.role !== 'admin') { v.innerHTML = '<p class="msg err">Only admins can manage people.</p>'; return; }
  let people;
  try { people = await api('/api/people'); } catch (err) { v.innerHTML = `<p class="msg err">${esc(err.message)}</p>`; return; }
  v.innerHTML = `<div class="page-head"><div class="lead"><h1>People</h1><p>Who can use the console. Members see everything and can change apps; admins also manage people.</p></div>
      <div class="actions"><button class="btn primary" type="button" data-act="invite-open" ${inviteOpen ? 'hidden' : ''}>Invite someone</button></div></div>
    <div id="linkbox" hidden></div>
    <section class="card narrow" id="invite-card" ${inviteOpen ? '' : 'hidden'}><header><h2>Invite someone</h2><p>They get a one-time link (24 hours) to choose their own password. With a Bitrix user ID, Argus sends it to them as a Bitrix message.</p></header>
      <form class="form" id="invite">
        <label>Name<input type="text" name="name" required></label>
        <label>Work email<input type="email" name="email" required></label>
        <label>Bitrix user ID<small>Optional. The number in their Bitrix profile address, e.g. …/company/personal/user/57/</small><input type="text" name="bitrixId" inputmode="numeric"></label>
        <label>Role<select name="role"><option value="member">Member: sees everything, can change apps</option><option value="admin">Admin: also manages people</option></select></label>
        <div class="actions"><button class="btn primary" type="submit">Send invite</button><button class="btn" type="button" data-act="invite-close">Cancel</button></div>
        <p class="msg err" id="invite-err" hidden></p>
      </form>
    </section>
    <div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Last sign-in</th><th><span class="sr">Actions</span></th></tr></thead>
      <tbody>${people.map((p) => `<tr>
        <td><b>${esc(p.name)}</b>${p.id === me.id ? ' <span class="hint">(you)</span>' : ''}<br><span class="hint">${esc(p.email)}</span></td>
        <td>${p.role === 'admin' ? 'Admin' : 'Member'}</td>
        <td>${p.active ? '<span class="pill pass">Active</span>' : '<span class="pill idle">Invited</span>'}</td>
        <td class="num">${p.lastSignIn ? esc(when(new Date(p.lastSignIn))) : '—'}</td>
        <td><div class="actions end">
          <button class="btn small" data-act="person-reset" data-id="${p.id}" data-name="${esc(p.name)}">${p.active ? 'Send reset link' : 'Send new invite'}</button>
          ${p.id !== me.id ? `<button class="btn small" data-act="person-role" data-id="${p.id}" data-role="${p.role === 'admin' ? 'member' : 'admin'}">${p.role === 'admin' ? 'Make member' : 'Make admin'}</button>
          <button class="btn small danger" data-act="person-remove" data-id="${p.id}" data-name="${esc(p.name)}">Remove</button>` : ''}
        </div></td></tr>`).join('')}</tbody></table></div>`;
  if (lastLink) showLink(lastLink.link, lastLink.sent, lastLink.name);
}
function showLink(link, sent, name) {
  const box = $('#linkbox');
  if (!box) return;
  box.hidden = false;
  box.className = 'linkbox';
  box.innerHTML = `<p><b>${sent ? `Sent to ${esc(name)} as a Bitrix message.` : `Send this link to ${esc(name)} yourself, e.g. in a Bitrix message.`}</b> It works once, for 24 hours, and isn't shown again after you leave this page.</p><code></code><div class="actions"><button class="btn small" type="button" data-act="copy-link">Copy link</button></div>`;
  $('code', box).textContent = link;
}

// ---------- Account ----------
function renderAccount() {
  $('#view-account').innerHTML = `<div class="lead"><h1>Your account</h1><p>${esc(me.name)} · ${esc(me.email)} · ${me.role === 'admin' ? 'Admin' : 'Member'}</p></div>
    <section class="card narrow"><header><h2>Change password</h2><p>You'll stay signed in here; other browsers are signed out.</p></header>
      <form class="form" id="pwform">
        <label>Current password<input type="password" name="current" autocomplete="current-password" required></label>
        <label>New password<small>At least 10 characters.</small><input type="password" name="next" autocomplete="new-password" required></label>
        <label>Type it again<input type="password" name="again" autocomplete="new-password" required></label>
        <div class="actions"><button class="btn primary" type="submit">Change password</button></div>
        <p class="msg" id="pw-msg" hidden></p>
      </form></section>
    <section class="card narrow"><header><h2>Sign out</h2><p>Signs you out in this browser.</p></header>
      <div class="actions"><button class="btn" type="button" data-act="signout">Sign out</button></div></section>`;
}

// ---------- events ----------
async function sendTest(el, reports) {
  const out = $(reports ? `pre[data-out-r="${el.dataset.app}"]` : `pre[data-out="${el.dataset.app}"]`);
  el.disabled = true; out.hidden = false;
  out.textContent = reports ? 'Sending a test run report to every run-report destination…' : 'Sending a test alert to every destination…';
  const r = await api(`/api/apps/${el.dataset.app}/test-alert`, { method: 'POST', body: { reports } });
  out.textContent = r.output.join('\n');
  el.disabled = false;
}
async function afterAppChange(app) { await refreshStatus(); loadApp(app); }

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'FORM' || (el.tagName === 'INPUT' && el.type === 'checkbox')) return;
  const act = el.dataset.act;
  try {
    if (act === 'report') openReport(el.dataset.action, el.dataset.start);
    if (act === 'close') closeOverlay();
    if (act === 'run') {
      el.disabled = true;
      await api('/api/checks/run', { method: 'POST', body: { action: el.dataset.action } });
      toast('Started. The result appears here when it finishes.');
      setTimeout(refreshStatus, 3000);
    }
    if (act === 'pause') {
      const pausing = !el.dataset.paused;
      const go = async () => {
        await api('/api/checks/pause', { method: 'POST', body: { action: el.dataset.action, paused: pausing } });
        toast(pausing ? 'Paused. It won\'t run until resumed.' : 'Resumed. It runs on its schedule again.');
        await refreshStatus();
      };
      pausing ? confirmClick(el, 'Click again to pause', go) : await go();
    }
    if (act === 'dest-remove') {
      const s = await api(`/api/apps/${el.dataset.app}`);
      const list = s.notify.filter((_, i) => i !== Number(el.dataset.i));
      const r = await api(`/api/apps/${el.dataset.app}/alerts`, { method: 'POST', body: { destinations: list } });
      toast(r.warnings?.length ? r.warnings.join(' ') : list.length ? 'Removed.' : 'Removed. Alerts now go to the default chat.');
      await afterAppChange(el.dataset.app);
    }
    if (act === 'rdest-remove') {
      const s = await api(`/api/apps/${el.dataset.app}`);
      const list = s.reports.destinations.filter((_, i) => i !== Number(el.dataset.i));
      const enabled = s.reports.enabled && list.length > 0;
      await api(`/api/apps/${el.dataset.app}/reports`, { method: 'POST', body: { enabled, destinations: list } });
      toast(s.reports.enabled && !enabled ? 'Removed. Run reports are off: no destinations left.' : 'Removed.');
      await afterAppChange(el.dataset.app);
    }
    if (act === 'test-alert') await sendTest(el, false);
    if (act === 'test-report') await sendTest(el, true);
    if (act === 'cred-edit') {
      // Turn this row into a small form; the password box always starts empty.
      const row = el.closest('tr'), f = el.dataset.field, app = el.dataset.app;
      const [, text, ph] = CRED_FIELDS.find(([k]) => k === f);
      const type = f === 'PASSWORD' ? 'password' : f.endsWith('URL') ? 'url' : f === 'EMAIL' ? 'email' : 'text';
      row.cells[1].innerHTML = `<form class="inline-form" data-act="cred-save" data-app="${esc(app)}" data-field="${f}">
        <input type="${type}" autocomplete="${f === 'PASSWORD' ? 'new-password' : 'off'}" placeholder="${esc(ph)}" aria-label="${esc(text)}">
        <button class="btn small primary" type="submit">Save</button>
        <button class="btn small" type="button" data-act="cred-cancel" data-app="${esc(app)}">Cancel</button>
        ${el.dataset.has ? `<button class="btn small danger" type="button" data-act="cred-clear" data-app="${esc(app)}" data-field="${f}">Remove</button>` : ''}
      </form>`;
      row.cells[2].innerHTML = '';
      const input = $('input', row.cells[1]);
      input.value = el.dataset.value || '';
      input.focus();
    }
    if (act === 'cred-cancel') loadApp(el.dataset.app);
    if (act === 'cred-clear') {
      confirmClick(el, 'Click again to remove', async () => {
        await api(`/api/apps/${el.dataset.app}/login`, { method: 'POST', body: { field: el.dataset.field, value: null } });
        toast('Cleared.'); loadApp(el.dataset.app);
      });
    }
    if (act === 'sched-open') {
      const ed = $('#sched-editor'); ed.hidden = false; syncSched($('form', ed));
      ed.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); $('select', ed).focus();
    }
    if (act === 'sched-close') { $('#sched-editor').hidden = true; await refreshStatus(); }
    if (act === 'retire') {
      confirmClick(el, 'Click again to retire', async () => {
        await api('/api/checks/retire', { method: 'POST', body: { action: el.dataset.action, retired: true } });
        toast('Retired. It won\'t run again unless an admin brings it back.'); await refreshStatus();
      });
    }
    if (act === 'unretire') {
      el.disabled = true;
      await api('/api/checks/retire', { method: 'POST', body: { action: el.dataset.action, retired: false } });
      toast('Brought back, with its old schedule.'); await refreshStatus();
    }
    if (act === 'chan-edit' || act === 'chan-close') {
      const f = $(`form[data-act="chan-save"][data-ch="${el.dataset.ch}"]`);
      f.hidden = act === 'chan-close';
      if (!f.hidden) $('input', f).focus();
    }
    if (act === 'chan-test-open') {
      const f = $(`form[data-act="chan-test"][data-ch="${el.dataset.ch}"]`);
      f.hidden = !f.hidden;
      if (!f.hidden) ($('input', f) || $('button', f)).focus();
    }
    if (act === 'chan-clear') {
      confirmClick(el, 'Click again to remove', async () => {
        const values = Object.fromEntries([...$(`form[data-act="chan-save"][data-ch="${el.dataset.ch}"]`).querySelectorAll('input')].map((i) => [i.name, null]));
        await api(`/api/channels/${el.dataset.ch}`, { method: 'POST', body: { values } });
        toast('Removed. Apps using this channel now show it as not set up.'); renderChannels();
      });
    }
    if (act === 'invite-open' || act === 'invite-close') {
      inviteOpen = act === 'invite-open';
      $('#invite-card').hidden = !inviteOpen;
      $('[data-act="invite-open"]').hidden = inviteOpen;
      if (inviteOpen) $('#invite [name="name"]').focus();
    }
    if (act === 'person-reset') {
      const r = await api(`/api/people/${el.dataset.id}/reset`, { method: 'POST', body: {} });
      lastLink = { link: r.link, sent: r.sentByBitrix, name: el.dataset.name };
      await renderPeople(); toast(r.sentByBitrix ? 'Link sent by Bitrix.' : 'Link created. Copy it from the box above.');
    }
    if (act === 'person-role') {
      await api(`/api/people/${el.dataset.id}/role`, { method: 'POST', body: { role: el.dataset.role } });
      toast('Role changed.'); renderPeople();
    }
    if (act === 'person-remove') {
      confirmClick(el, `Remove ${el.dataset.name}?`, async () => {
        await api(`/api/people/${el.dataset.id}`, { method: 'DELETE', body: {} });
        toast(`${el.dataset.name} was removed and signed out.`); renderPeople();
      });
    }
    if (act === 'copy-link') {
      const code = $('#linkbox code');
      navigator.clipboard.writeText(code.textContent).then(() => toast('Link copied.'), () => {
        const r = document.createRange(); r.selectNodeContents(code); getSelection().removeAllRanges(); getSelection().addRange(r);
        toast('Copy was blocked. The link is selected; press Ctrl+C (⌘C on Mac).');
      });
    }
  } catch (err) {
    toast(err.message);
    if ('disabled' in el) el.disabled = false;
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.act === 'reports-toggle') {
    try {
      const s = await api(`/api/apps/${el.dataset.app}`);
      const r = await api(`/api/apps/${el.dataset.app}/reports`, { method: 'POST', body: { enabled: el.checked, destinations: s.reports.destinations } });
      toast(el.checked ? `On. Every run's report now goes to the list below.${r.warnings?.length ? ` But: ${r.warnings.join(' ')}` : ''}` : 'Off. Only failures alert now.');
      await afterAppChange(el.dataset.app);
    } catch (err) { toast(err.message); el.checked = !el.checked; }
  }
  if (el.dataset.act === 'pause-toggle') {
    try {
      // The switch shows "on" (running on schedule); turning it off pauses the check.
      await api('/api/checks/pause', { method: 'POST', body: { action: el.dataset.action, paused: !el.checked } });
      toast(el.checked ? 'Turned on. It runs on its schedule again.' : 'Paused. It won\'t run until it\'s turned back on.');
      await afterAppChange(el.dataset.app);
    } catch (err) { toast(err.message); el.checked = !el.checked; }
  }
});

document.addEventListener('input', (e) => { if (e.target.form?.dataset.act === 'sched-save') syncSched(e.target.form); });
document.addEventListener('change', (e) => { if (e.target.form?.dataset.act === 'sched-save') syncSched(e.target.form); });

document.addEventListener('submit', async (e) => {
  const f = e.target;
  e.preventDefault();
  try {
    if (f.dataset.act === 'sched-save') {
      const schedule = schedFromForm(f);
      if (schedule === '') return toast('Fill in the schedule first.');
      const r = await api('/api/checks/schedule', { method: 'POST', body: { action: f.dataset.action, schedule } });
      toast(r.schedule ? `Saved. It now runs ${r.text}.` : 'Saved. It now only runs when someone presses Run now.');
      $('#sched-editor').hidden = true; await refreshStatus();
    }
    if (f.dataset.act === 'chan-save') {
      const values = {};
      for (const i of f.querySelectorAll('input')) {
        const val = i.value.trim();
        if (i.type === 'password') { if (val) values[i.name] = val; } else if (val !== i.dataset.was) values[i.name] = val || null;
      }
      if (!Object.keys(values).length) return toast('Nothing changed.');
      await api(`/api/channels/${f.dataset.ch}`, { method: 'POST', body: { values } });
      toast('Saved. Use "Send a test" to check it works.'); renderChannels();
    }
    if (f.dataset.act === 'chan-test') {
      const out = $(`pre[data-out-ch="${f.dataset.ch}"]`), btn = $('button', f);
      btn.disabled = true; out.hidden = false; out.textContent = 'Sending a test message…';
      try {
        const r = await api(`/api/channels/${f.dataset.ch}/test`, { method: 'POST', body: { to: $('input', f)?.value.trim() || '' } });
        out.textContent = r.output.join('\n');
      } finally { btn.disabled = false; }
    }
    if (f.dataset.act === 'dest-add' || f.dataset.act === 'rdest-add') {
      const input = $('input', f);
      const value = input.value.trim();
      if (!value) return;
      const s = await api(`/api/apps/${f.dataset.app}`);
      if (f.dataset.act === 'dest-add') {
        // An app's first destination keeps the default chat alongside it, so nothing goes quiet by accident.
        const base = s.notify.length ? s.notify : s.alerts.targets.map(label);
        const r = await api(`/api/apps/${f.dataset.app}/alerts`, { method: 'POST', body: { destinations: [...base.filter((d) => d !== value), value] } });
        toast(r.warnings?.length ? `Added, but: ${r.warnings.join(' ')}`
          : s.notify.length ? 'Added. Use "Send test alert" to check it arrives.' : 'Added, alongside the default chat. Remove the default chat if this app shouldn\'t alert there.');
      } else {
        const r = await api(`/api/apps/${f.dataset.app}/reports`, { method: 'POST', body: { enabled: s.reports.enabled, destinations: [...s.reports.destinations, value] } });
        toast(r.warnings?.length ? `Added, but: ${r.warnings.join(' ')}` : s.reports.enabled ? 'Added. It gets every run\'s report from now on.' : 'Added. Switch run reports on to start sending.');
      }
      await afterAppChange(f.dataset.app);
    }
    if (f.dataset.act === 'cred-save') {
      const input = $('input', f);
      if (!input.value) return toast('Type a value first.');
      await api(`/api/apps/${f.dataset.app}/login`, { method: 'POST', body: { field: f.dataset.field, value: input.value } });
      toast('Saved on the server.'); loadApp(f.dataset.app);
    }
    if (f.id === 'invite') {
      const data = Object.fromEntries(new FormData(f));
      const r = await api('/api/people', { method: 'POST', body: data });
      lastLink = { link: r.link, sent: r.sentByBitrix, name: r.person.name };
      inviteOpen = false;
      await renderPeople();
      toast(r.sentByBitrix ? `Invite sent to ${r.person.name} by Bitrix.` : 'Invite created. Copy the link from the box above.');
    }
    if (f.id === 'pwform') {
      const data = Object.fromEntries(new FormData(f));
      const msg = $('#pw-msg');
      if (data.next !== data.again) { msg.className = 'msg err'; msg.textContent = 'The two new passwords don\'t match.'; msg.hidden = false; return; }
      await api('/api/me/password', { method: 'POST', body: { current: data.current, next: data.next } });
      f.reset(); msg.className = 'msg ok'; msg.textContent = 'Password changed.'; msg.hidden = false;
    }
  } catch (err) {
    if (f.id === 'invite') { const m = $('#invite-err'); m.textContent = err.message; m.hidden = false; return; }
    if (f.id === 'pwform') { const m = $('#pw-msg'); m.className = 'msg err'; m.textContent = err.message; m.hidden = false; return; }
    toast(err.message);
  }
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#overlay').hidden) closeOverlay(); });
$('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeOverlay(); });
async function signOut() {
  await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
  location.href = '/login';
}
$('#signout').addEventListener('click', signOut);
document.addEventListener('click', (e) => { if (e.target.closest('[data-act="signout"]')) signOut(); });

// ---------- routing ----------
const VIEWS = ['checks', 'check', 'apps', 'channels', 'activity', 'people', 'account'];
const NAV_OF = { check: 'checks' };
function parseHash() {
  const [head, ...rest] = location.hash.slice(1).split('/');
  const v = head === 'setup' ? 'apps' : head;   // old links
  let arg = null;
  try { arg = rest.length ? decodeURIComponent(rest.join('/')) : null; } catch {}
  return VIEWS.includes(v) ? { v, arg } : { v: 'checks', arg: null };
}
let shown = '';
function route() {
  let { v, arg } = parseHash();
  if (v === 'people' && me?.role !== 'admin') v = 'checks';
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== v;
  for (const a of document.querySelectorAll('nav.views a')) {
    if (a.dataset.view === (NAV_OF[v] || v)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  if (`${v}/${arg}` !== shown) { window.scrollTo(0, 0); shown = `${v}/${arg}`; }
  if (v !== 'people') { lastLink = null; inviteOpen = false; }
  if (v === 'checks') renderChecks();
  if (v === 'check') renderCheck(arg);
  if (v === 'apps') renderApps(arg);
  if (v === 'channels') renderChannels();
  if (v === 'activity') renderActivity();
  if (v === 'people') renderPeople();
  if (v === 'account') renderAccount();
}
window.addEventListener('hashchange', route);

(async () => {
  try { me = await api('/api/me'); } catch { return; }
  const initials = me.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  $('#who').innerHTML = `<span class="initials" aria-hidden="true">${esc(initials)}</span><span class="who-name">${esc(me.name)}${me.role === 'admin' ? ' · Admin' : ''}</span>`;
  $('#who').setAttribute('aria-label', `Your account: ${me.name}`);
  $('nav.views a[data-view="people"]').hidden = me.role !== 'admin';
  route();
  await refreshStatus();
  setInterval(() => {
    const { v } = parseHash();
    if ((v === 'checks' || v === 'check') && document.visibilityState === 'visible') refreshStatus();
  }, 60_000);
})();
