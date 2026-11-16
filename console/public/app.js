// Argus console: Checks, Setup, Activity, People (admins) and Account.
// Everything comes from the console API (console/server.js); nothing is cached in the browser.
const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
let me = null;
let status = null;
let statusAt = null;
const open = new Set();
const CRED_FIELDS = [
  ['URL', 'App address', 'https://app.example.com'],
  ['LOGIN_URL', 'Login page (if different)', 'https://app.example.com/login'],
  ['EMAIL', 'Test account email', 'test@example.com'],
  ['USERNAME', 'Test account username', 'only if it signs in with a username'],
  ['PASSWORD', 'Test account password', ''],
];

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
function when(d) {
  const today = dayKey(new Date()), tomorrow = dayKey(new Date(Date.now() + 86400_000)), yesterday = dayKey(new Date(Date.now() - 86400_000));
  const time = d.toLocaleTimeString('en-GB', { ...MYT, hour: '2-digit', minute: '2-digit' });
  const k = dayKey(d);
  if (k === today) return `Today, ${time}`;
  if (k === tomorrow) return `Tomorrow, ${time}`;
  if (k === yesterday) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString('en-GB', { ...MYT, weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
}
const runDate = (start) => new Date(start.replace(' ', 'T') + '+08:00');   // log times are MYT
const took = (s) => (s == null ? '' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);
const appName = (app) => status?.checks.find((c) => c.app === app)?.appName || app;

// ---------- Checks ----------
function stateOf(c) {
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

function alertsLine(app) {
  const a = status.apps.find((x) => x.app === app)?.alerts || status.defaultAlerts;
  const list = a.targets.map((t) => `${t.channel}${t.to ? `:${t.to}` : ''}${t.ok ? '' : ' (not set up)'}`).join(', ') || 'nowhere';
  return `${esc(list)}${a.source.startsWith('default') ? ' <span class="muted">(default chat)</span>' : ''}`;
}

function renderChecks() {
  const v = $('#view-checks');
  if (!status) { v.innerHTML = '<p class="muted">Loading checks…</p>'; return; }
  const checks = status.checks;
  const failing = checks.filter((c) => c.state?.status === 'fail' && !c.paused);
  const total = checks.reduce((n, c) => n + c.totalRuns, 0);
  const fails = checks.reduce((n, c) => n + c.failedRuns, 0);
  const next = checks.filter((c) => c.next).sort((a, b) => a.next.localeCompare(b.next))[0];
  v.innerHTML = `
    <div class="summary">
      <div class="lead">
        <h1>${failing.length ? `${failing.length} check${failing.length > 1 ? 's' : ''} failing` : `All ${checks.length} checks passing`}</h1>
        <p>${next ? `Next: ${esc(next.name)}, ${esc(when(new Date(next.next)))}. ` : ''}Updated ${esc(statusAt.toLocaleTimeString('en-GB', MYT))}; refreshes every minute.</p>
      </div>
      <div class="figures">
        <div class="fig"><span>Runs in the logs</span><b>${total}</b></div>
        <div class="fig"><span>Failed runs</span><b>${fails}</b></div>
      </div>
    </div>
    <div class="ledger" role="list">
      <div class="ledger-head" aria-hidden="true"><span>Status</span><span>Check</span><span>Schedule</span><span>Last run</span><span>Last runs</span><span></span></div>
      ${checks.map(rowHTML).join('')}
    </div>`;
}

function rowHTML(c) {
  const isOpen = open.has(c.action);
  const [cls, label] = stateOf(c);
  const last = c.runs.find((r) => !r.skipped);
  const id = c.action.replace('/', '-');
  return `<div class="row ${isOpen ? 'open' : ''}" role="listitem">
    <button class="row-main" data-act="toggle" data-action="${esc(c.action)}" aria-expanded="${isOpen}" aria-controls="d-${esc(id)}">
      <span class="c-status"><span class="pill ${cls}">${label}</span></span>
      <span class="name"><b>${esc(c.name)}${c.changesData ? '<span class="tag write">Changes data</span>' : ''}</b><small>${esc(c.site || c.action)}</small></span>
      <span class="cell c-sched">${esc(c.scheduleText)}<small>${c.paused ? 'Paused' : c.next ? `Next: ${esc(when(new Date(c.next)))}` : 'Runs when started'}</small></span>
      <span class="cell c-last">${last ? esc(when(runDate(last.start))) : '—'}<small>${last ? esc(took(last.seconds)) : ''}</small></span>
      ${eyes(c)}
      ${chev}
    </button>
    <div class="detail" id="d-${esc(id)}" ${isOpen ? '' : 'hidden'}>${isOpen ? detailHTML(c) : ''}</div>
  </div>`;
}

function detailHTML(c) {
  const runNote = c.changesData ? 'Run now is off: this check changes data.' : c.paused ? 'Resume it to run it now.' : c.running ? 'It\'s running right now.' : '';
  const frequent = c.totalRuns > 60;
  return `
    <div class="facts">
      ${c.description ? `<p>${esc(c.description)}</p>` : ''}
      ${c.paused ? `<p class="msg warn">Paused by ${esc(c.paused.by || 'someone')}${c.paused.at ? ` on ${esc(when(new Date(c.paused.at)))}` : ''}. It won't run until resumed.</p>` : ''}
      <dl>
        <dt>Command</dt><dd class="mono">run.sh ${esc(c.action)}</dd>
        <dt>Changes data</dt><dd>${c.changesData ? 'Yes. It never retries, and can\'t be run from here.' : 'No, read-only'}</dd>
        <dt>If it fails</dt><dd>${esc(c.retry)}</dd>
        <dt>Alerts to</dt><dd class="mono">${alertsLine(c.app)}</dd>
      </dl>
      ${c.steps.length ? `<div><h3>What it checks</h3><ol class="steps">${c.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div>` : ''}
      <div class="actions">
        <button class="btn" data-act="run" data-action="${esc(c.action)}" ${c.changesData || c.paused || c.running ? 'disabled' : ''}>Run now</button>
        <button class="btn" data-act="pause" data-action="${esc(c.action)}" data-paused="${c.paused ? '1' : ''}">${c.paused ? 'Resume' : 'Pause'}</button>
        <a class="btn" href="#setup">Alerts and login</a>
      </div>
      ${runNote ? `<p class="hint">${esc(runNote)}</p>` : ''}
    </div>
    <div class="history">
      <h3>${frequent ? 'Latest runs' : 'Run history'}</h3>
      <div class="tbl-wrap"><table>
        <thead><tr><th>When (MYT)</th><th>Took</th><th>Result</th><th>Notes</th><th></th></tr></thead>
        <tbody>${c.runs.slice(0, frequent ? 8 : 15).map((r) => `<tr>
          <td class="num">${esc(when(runDate(r.start)))}</td><td class="num">${esc(took(r.seconds))}</td>
          <td>${r.skipped ? '<span class="pill idle">Skipped</span>' : r.exit ? '<span class="pill fail">Failed</span>' : '<span class="pill pass">Passed</span>'}</td>
          <td>${esc(r.skipped || r.summary)}${r.retried ? ' <span class="hint">(retried)</span>' : ''}</td>
          <td>${r.skipped ? '' : `<button class="link-btn" data-act="report" data-action="${esc(c.action)}" data-start="${esc(r.start)}">Report</button>`}</td>
        </tr>`).join('') || '<tr><td colspan="5" class="muted">No runs in the logs yet.</td></tr>'}</tbody>
      </table></div>
      ${frequent ? `<h3>Per day</h3><div class="tbl-wrap"><table>
        <thead><tr><th>Day</th><th>Runs</th><th>Failed</th></tr></thead>
        <tbody>${c.daily.map((d) => `<tr><td class="num">${esc(new Date(d.date + 'T12:00:00+08:00').toLocaleDateString('en-GB', { ...MYT, weekday: 'short', day: 'numeric', month: 'short' }))}</td><td class="num">${d.runs}</td><td class="num">${d.failed ? `<span class="pill fail">${d.failed}</span>` : '0'}</td></tr>`).join('')}</tbody>
      </table></div>` : ''}
    </div>`;
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
    const { text } = await api(`/api/report?action=${encodeURIComponent(action)}&start=${encodeURIComponent(start)}`);
    const shots = [...text.matchAll(/logs\/screenshots\/([\w.-]+\.jpg)/g)].map((m) => m[1]);
    const body = $('.dialog-body', ov);
    body.innerHTML = `${shots.map((s) => `<figure><img src="/api/screenshot/${encodeURIComponent(s)}" alt="Screenshot at the moment of failure"><figcaption class="hint">${esc(s)}</figcaption></figure>`).join('')}<pre class="out"></pre>`;
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
  if (view() === 'checks') renderChecks();
}

// ---------- Setup ----------
async function renderSetup() {
  const v = $('#view-setup');
  if (!status) await refreshStatus();
  const apps = [...new Set(status.checks.map((c) => c.app).filter(Boolean))];
  v.innerHTML = `<div class="lead"><h1>Setup</h1><p>Changes here apply to Argus straight away and are recorded in Activity.</p></div>
    <div class="cards">${apps.map((app) => `<section class="card" id="app-${esc(app)}"><p class="muted">Loading ${esc(appName(app))}…</p></section>`).join('')}</div>`;
  for (const app of apps) loadAppCard(app);
}

async function loadAppCard(app) {
  const card = $(`#app-${app}`);
  if (!card) return;
  let s;
  try { s = await api(`/api/apps/${app}`); } catch (err) { card.innerHTML = `<p class="msg err">${esc(err.message)}</p>`; return; }
  const checks = status.checks.filter((c) => c.app === app);
  const def = status.defaultAlerts.targets.map((t) => `${t.channel}:${t.to}`).join(', ');
  const signsIn = checks.some((c) => !c.noBrowser);   // checks without a browser never use an app login
  card.innerHTML = `
    <header><h2>${esc(appName(app))}</h2><p>${checks.map((c) => esc(c.name)).join(' · ')}</p></header>
    <div class="set-row"><span class="lbl">Checks<small>On: runs on its schedule. Turn a check off to pause it; it won't run until it's turned back on.</small></span>
      <div class="cards">${checks.map((c) => `<label class="toggle"><input type="checkbox" data-act="pause-toggle" data-action="${esc(c.action)}" ${c.paused ? '' : 'checked'} aria-label="${esc(c.name)} is ${c.paused ? 'paused' : 'on'}"> ${esc(c.name)} · ${c.paused ? '<b class="paused">Paused</b>' : `<span class="muted">${esc(c.scheduleText)}</span>`}</label>`).join('')}</div></div>
    <div class="set-row"><span class="lbl">Where alerts go<small>Failures alert every destination here. Empty means the default chat.</small></span>
      <div class="cards">
        <div class="dests">${s.notify.length ? s.notify.map((d, i) => {
          const t = s.alerts.targets.find((x) => `${x.channel}${x.to ? `:${x.to}` : ''}` === d.replace(/^whatsapp:\+?/, 'whatsapp:').replace(/\s|-/g, ''));
          return `<span class="dest ${t && !t.ok ? 'bad' : ''}">${esc(d)}<button type="button" data-act="dest-remove" data-app="${esc(app)}" data-i="${i}" aria-label="Remove ${esc(d)}">×</button></span>`;
        }).join('') : `<span class="dest">${esc(def || 'default chat')}</span><span class="hint">default chat</span>`}</div>
        ${s.alerts.problems.length ? `<p class="msg warn">${s.alerts.problems.map(esc).join('<br>')}</p>` : ''}
        <form class="inline-form" data-act="dest-add" data-app="${esc(app)}"><input type="text" class="mono-input" placeholder="bitrix:chat1234 or email:ops@fusioneta.com" aria-label="Add an alert destination for ${esc(appName(app))}"><button class="btn" type="submit">Add</button><button class="btn" type="button" data-act="test-alert" data-app="${esc(app)}">Send test alert</button></form>
        <p class="hint">Formats: bitrix:chat1234 (group chat), bitrix:57 (a person), email:name@company.com, telegram:-100…, slack, teams, googlechat, webhook.</p>
        <pre class="out" data-out="${esc(app)}" hidden></pre>
      </div></div>
    ${signsIn ? '' : '<!-- no app login: this app\'s checks don\'t sign in -->'}
    <div class="set-row" ${signsIn ? '' : 'hidden'}><span class="lbl">App login<small>The test account checks sign in with. Stored on the server and never shown again.</small></span>
      <div class="cards">
        <div class="cred">${CRED_FIELDS.map(([f, label]) => `<span>${esc(label)}</span><span>${s.credentials[f] ? `<span class="set">✓ set</span> <button class="link-btn" type="button" data-act="cred-clear" data-app="${esc(app)}" data-field="${f}">clear</button>` : '<span class="muted">not set</span>'}</span>`).join('')}</div>
        <form class="inline-form" data-act="cred-set" data-app="${esc(app)}">
          <select aria-label="Which login detail">${CRED_FIELDS.map(([f, label]) => `<option value="${f}">${esc(label)}</option>`).join('')}</select>
          <input type="text" autocomplete="off" aria-label="New value">
          <button class="btn" type="submit">Save</button>
        </form>
      </div></div>`;
  const sel = $('form[data-act="cred-set"] select', card), inp = $('form[data-act="cred-set"] input', card);
  const syncType = () => {
    inp.type = sel.value === 'PASSWORD' ? 'password' : 'text';
    inp.autocomplete = sel.value === 'PASSWORD' ? 'new-password' : 'off';
    inp.placeholder = CRED_FIELDS.find(([f]) => f === sel.value)[2];
  };
  sel.addEventListener('change', syncType); syncType();
}

// ---------- Activity ----------
async function renderActivity() {
  const v = $('#view-activity');
  v.innerHTML = '<div class="lead"><h1>Activity</h1><p>Who changed what in the console, newest first.</p></div><p class="muted">Loading…</p>';
  try {
    const rows = await api('/api/audit');
    v.innerHTML = `<div class="lead"><h1>Activity</h1><p>Who changed what in the console, newest first.</p></div>
      <div class="tbl-wrap"><table><thead><tr><th>When (MYT)</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td class="num">${esc(when(new Date(r.at)))}</td><td>${esc(r.actor)}</td><td>${esc(r.action)}</td><td>${esc([r.target, r.detail].filter(Boolean).join(' · '))}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing yet.</td></tr>'}</tbody></table></div>`;
  } catch (err) { v.innerHTML = `<p class="msg err">${esc(err.message)}</p>`; }
}

// ---------- People ----------
let lastLink = null;
async function renderPeople() {
  const v = $('#view-people');
  if (me.role !== 'admin') { v.innerHTML = '<p class="msg err">Only admins can manage people.</p>'; return; }
  let people;
  try { people = await api('/api/people'); } catch (err) { v.innerHTML = `<p class="msg err">${esc(err.message)}</p>`; return; }
  v.innerHTML = `<div class="lead"><h1>People</h1><p>Who can use the console. Admins can also manage people.</p></div>
    <section class="card"><header><h2>Invite someone</h2><p>They get a one-time link (24 hours) to choose their own password. With a Bitrix user ID, Argus sends it to them as a Bitrix message.</p></header>
      <form class="form" id="invite">
        <label>Name<input type="text" name="name" required></label>
        <label>Work email<input type="email" name="email" required></label>
        <label>Bitrix user ID<small>Optional. The number in their Bitrix profile address, e.g. …/company/personal/user/57/</small><input type="text" name="bitrixId" inputmode="numeric"></label>
        <label>Role<select name="role"><option value="member">Member: sees everything, can change Setup</option><option value="admin">Admin: also manages people</option></select></label>
        <div class="actions"><button class="btn primary" type="submit">Send invite</button></div>
        <p class="msg err" id="invite-err" hidden></p>
      </form>
      <div id="linkbox" hidden></div>
    </section>
    <div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead>
      <tbody>${people.map((p) => `<tr>
        <td>${esc(p.name)}${p.id === me.id ? ' <span class="hint">(you)</span>' : ''}</td><td>${esc(p.email)}</td><td>${p.role === 'admin' ? 'Admin' : 'Member'}</td>
        <td>${p.active ? '<span class="pill pass">Active</span>' : '<span class="pill idle">Invited</span>'}</td>
        <td class="num">${p.lastSignIn ? esc(when(new Date(p.lastSignIn))) : '—'}</td>
        <td><div class="actions">
          <button class="btn small" data-act="person-reset" data-id="${p.id}">${p.active ? 'Send reset link' : 'Send new invite'}</button>
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
    <section class="card"><header><h2>Change password</h2><p>You'll stay signed in here; other browsers are signed out.</p></header>
      <form class="form" id="pwform">
        <label>Current password<input type="password" name="current" autocomplete="current-password" required></label>
        <label>New password<small>At least 10 characters.</small><input type="password" name="next" autocomplete="new-password" required></label>
        <label>Type it again<input type="password" name="again" autocomplete="new-password" required></label>
        <div class="actions"><button class="btn primary" type="submit">Change password</button></div>
        <p class="msg" id="pw-msg" hidden></p>
      </form></section>`;
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'FORM' || (el.tagName === 'INPUT' && el.type === 'checkbox')) return;
  const act = el.dataset.act;
  try {
    if (act === 'toggle') { open.has(el.dataset.action) ? open.delete(el.dataset.action) : open.add(el.dataset.action); renderChecks(); }
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
      toast(list.length ? 'Removed.' : 'Removed. Alerts now go to the default chat.');
      if (r.warnings?.length) toast(r.warnings.join(' '));
      await refreshStatus(); loadAppCard(el.dataset.app);
    }
    if (act === 'test-alert') {
      const out = $(`pre[data-out="${el.dataset.app}"]`);
      el.disabled = true; out.hidden = false; out.textContent = 'Sending a test alert to every destination…';
      const r = await api(`/api/apps/${el.dataset.app}/test-alert`, { method: 'POST', body: {} });
      out.textContent = r.output.join('\n');
      el.disabled = false;
    }
    if (act === 'cred-clear') {
      confirmClick(el, 'click again to clear', async () => {
        await api(`/api/apps/${el.dataset.app}/login`, { method: 'POST', body: { field: el.dataset.field, value: null } });
        toast('Cleared.'); loadAppCard(el.dataset.app);
      });
    }
    if (act === 'person-reset') {
      const r = await api(`/api/people/${el.dataset.id}/reset`, { method: 'POST', body: {} });
      const row = el.closest('tr');
      lastLink = { link: r.link, sent: r.sentByBitrix, name: row ? row.cells[0].textContent.replace(' (you)', '') : 'them' };
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
  if (el.dataset.act !== 'pause-toggle') return;
  try {
    // The switch shows "on" (running on schedule); turning it off pauses the check.
    await api('/api/checks/pause', { method: 'POST', body: { action: el.dataset.action, paused: !el.checked } });
    toast(el.checked ? 'Turned on. It runs on its schedule again.' : 'Paused. It won\'t run until it\'s turned back on.');
    await refreshStatus(); renderSetup();
  } catch (err) { toast(err.message); el.checked = !el.checked; }
});

document.addEventListener('submit', async (e) => {
  const f = e.target;
  e.preventDefault();
  try {
    if (f.dataset.act === 'dest-add') {
      const input = $('input', f);
      const value = input.value.trim();
      if (!value) return;
      const s = await api(`/api/apps/${f.dataset.app}`);
      const r = await api(`/api/apps/${f.dataset.app}/alerts`, { method: 'POST', body: { destinations: [...s.notify, value] } });
      toast(r.warnings?.length ? `Added, but: ${r.warnings.join(' ')}` : 'Added. Use "Send test alert" to check it arrives.');
      await refreshStatus(); loadAppCard(f.dataset.app);
    }
    if (f.dataset.act === 'cred-set') {
      const field = $('select', f).value, input = $('input', f);
      if (!input.value) return toast('Type a value first.');
      await api(`/api/apps/${f.dataset.app}/login`, { method: 'POST', body: { field, value: input.value } });
      input.value = '';
      toast('Saved on the server.'); loadAppCard(f.dataset.app);
    }
    if (f.id === 'invite') {
      const data = Object.fromEntries(new FormData(f));
      const r = await api('/api/people', { method: 'POST', body: data });
      lastLink = { link: r.link, sent: r.sentByBitrix, name: r.person.name };
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
$('#signout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
  location.href = '/login';
});

// ---------- routing ----------
const VIEWS = ['checks', 'setup', 'activity', 'people', 'account'];
const view = () => (VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'checks');
function route() {
  let v = view();
  if (v === 'people' && me?.role !== 'admin') v = 'checks';
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== v;
  for (const a of document.querySelectorAll('nav a')) {
    if (a.dataset.view === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  if (v !== 'people') lastLink = null;
  if (v === 'checks') renderChecks();
  if (v === 'setup') renderSetup();
  if (v === 'activity') renderActivity();
  if (v === 'people') renderPeople();
  if (v === 'account') renderAccount();
}
window.addEventListener('hashchange', route);

(async () => {
  try { me = await api('/api/me'); } catch { return; }
  $('#who').textContent = `${me.name}${me.role === 'admin' ? ' · Admin' : ''}`;
  $('nav a[data-view="people"]').hidden = me.role !== 'admin';
  route();
  await refreshStatus();
  setInterval(() => { if (view() === 'checks' && document.visibilityState === 'visible') refreshStatus(); }, 60_000);
})();
