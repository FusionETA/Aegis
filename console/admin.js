// Aegis console accounts from the server's command line — for the first admin and
// for emergencies (everyone locked out). Day to day, admins use the People page.
//
//   node console/admin.js add-admin  <email> "<Full Name>"   -> prints a one-time setup link
//   node console/admin.js reset      <email>                 -> prints a one-time reset link
//   node console/admin.js remove     <email>
//   node console/admin.js list
// Run as root; files stay owned by the console's user (aegis-web).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as store from './store.js';

const PUBLIC_URL = (process.env.CONSOLE_URL || 'https://aegis.fusioneta.com.my').replace(/\/$/, '');
const OWNER = process.env.CONSOLE_USER ?? 'aegis-web';
const [cmd, email, name] = process.argv.slice(2);
const actor = 'server command line';

function fixOwnership() {
  if (!OWNER || process.getuid?.() !== 0) return;
  const [uid, gid] = ['-u', '-g'].map((f) => Number(spawnSync('id', [f, OWNER], { encoding: 'utf8' }).stdout));
  if (!Number.isInteger(uid) || !fs.existsSync(store.DATA_DIR)) return;
  fs.chownSync(store.DATA_DIR, uid, gid);
  for (const f of fs.readdirSync(store.DATA_DIR)) fs.chownSync(`${store.DATA_DIR}/${f}`, uid, gid);
}
const byEmail = (e) => store.findUser((u) => u.email === String(e || '').toLowerCase());

try {
  if (cmd === 'add-admin' && email && name) {
    const u = store.addUser({ name, email, role: 'admin', createdBy: actor });
    store.audit(actor, 'invited', `${u.name} <${u.email}>`, 'admin');
    console.log(`Added ${u.name} <${u.email}> as an admin.\nOne-time setup link (works once, for 24 hours):\n${PUBLIC_URL}/setup#t=${store.createLink(u.id, 'invite')}`);
  } else if (cmd === 'reset' && email) {
    const u = byEmail(email);
    if (!u) throw new Error(`No one with the email ${email}.`);
    const kind = u.passHash ? 'reset' : 'invite';
    store.updateUser(u.id, { failed: 0, lockedUntil: null });
    store.audit(actor, kind === 'reset' ? 'sent a reset link to' : 'sent a new invite to', `${u.name} <${u.email}>`);
    console.log(`One-time ${kind} link for ${u.name} (works once, for 24 hours):\n${PUBLIC_URL}/setup#t=${store.createLink(u.id, kind)}`);
  } else if (cmd === 'remove' && email) {
    const u = byEmail(email);
    if (!u) throw new Error(`No one with the email ${email}.`);
    if (u.role === 'admin' && store.adminCount() <= 1) throw new Error('That is the last admin; add another admin first.');
    store.removeUser(u.id);
    store.audit(actor, 'removed', `${u.name} <${u.email}>`);
    console.log(`Removed ${u.name} <${u.email}> and signed them out.`);
  } else if (cmd === 'list') {
    for (const u of store.users().map(store.publicUser)) {
      console.log(`${u.role.padEnd(6)} ${u.active ? 'active ' : 'invited'} ${u.email}  (${u.name})${u.lastSignIn ? `  last sign-in ${u.lastSignIn}` : ''}`);
    }
  } else {
    console.log('usage: admin.js add-admin <email> "<Full Name>" | reset <email> | remove <email> | list');
    process.exitCode = 2;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  fixOwnership();
}
