// One-time setup / reset page. The token is in the address after "#", which the
// browser never sends to the server; it's taken out of the address bar right away.
const $ = (s) => document.querySelector(s);
const token = new URLSearchParams(location.hash.slice(1)).get('t') || '';
history.replaceState(null, '', '/setup');
const fail = (msg) => { $('#err').textContent = msg; $('#err').hidden = false; };

(async () => {
  if (!token) { $('#intro').textContent = ''; return fail('This page needs the link from your invite or reset message.'); }
  const res = await fetch(`/api/setup?t=${encodeURIComponent(token)}`).catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  if (!res || !res.ok) { $('#intro').textContent = ''; return fail(data.error || 'Couldn\'t check your link. Try again.'); }
  $('#title').textContent = data.kind === 'reset' ? 'Choose a new password' : 'Choose your password';
  $('#intro').textContent = `${data.name} (${data.email}). This link works once.`;
  $('#fields').hidden = false;
  $('#pw1').focus();
})();

$('#setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#err').hidden = true;
  if ($('#pw1').value !== $('#pw2').value) return fail('The two passwords don\'t match.');
  $('#go').disabled = true;
  const res = await fetch('/api/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Argus': '1' },
    body: JSON.stringify({ token, password: $('#pw1').value }),
  }).catch(() => null);
  if (res && res.ok) { location.href = '/'; return; }
  fail((res && (await res.json().catch(() => ({}))).error) || 'Couldn\'t save. Try again.');
  $('#go').disabled = false;
});
