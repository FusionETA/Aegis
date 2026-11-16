// Sign-in page.
const $ = (s) => document.querySelector(s);
$('#login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#err'), go = $('#go');
  err.hidden = true; go.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Argus': '1' },
      body: JSON.stringify({ email: $('#email').value, password: $('#password').value }),
    });
    if (res.ok) { location.href = '/'; return; }
    err.textContent = (await res.json().catch(() => ({}))).error || 'Couldn\'t sign in. Try again.';
  } catch {
    err.textContent = 'Couldn\'t reach the console. Check your connection and try again.';
  }
  err.hidden = false; go.disabled = false; $('#password').select();
});
