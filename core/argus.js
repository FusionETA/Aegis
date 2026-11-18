// Reports each check run to Argus (https://argus.fusioneta.com.my), FusionETA's supervisor for
// AI agents, where Aegis checks show as bots. run.sh calls it at the start, on a retry, and at
// the end of every run:
//   node core/argus.js start <app/action> <run>
//   node core/argus.js retry <app/action> <run> <exit code>
//   node core/argus.js end   <app/action> <run> <exit code> <log file>
// It needs ARGUS_URL and the check's own key, ARGUS_KEY_<ACTION> in .env (for example
// ARGUS_KEY_CLOCKIN, ARGUS_KEY_ARTEMIS_NGINX); without them it does nothing. It can never fail a
// check: every error is swallowed, each request gives up after 3 s, and run.sh adds a hard 5 s
// limit. The key goes in a request header, never on a command line or in a log.
import 'dotenv/config';
import fs from 'node:fs';

const [, , what, action, run, rc, logFile] = process.argv;

// The last useful line of this run's log: what went wrong, for the failed run's timeline.
function lastError() {
  try {
    const text = fs.readFileSync(logFile, 'utf8');
    const section = text.slice(text.lastIndexOf(`===== ${action} @`)).split('\n')
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('=====') && !l.startsWith('-----'));
    const line = [...section].reverse().find((l) => /error|fail|✗|❌|timeout|timed out|refused|unreachable/i.test(l)) || section.at(-1);
    return (line || '').slice(0, 500);
  } catch {
    return '';
  }
}

async function main() {
  const url = (process.env.ARGUS_URL || '').replace(/\/$/, '');
  const key = process.env[`ARGUS_KEY_${String(action).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`];
  if (!url || !key || !run) return;
  let title = action;
  try { title = JSON.parse(fs.readFileSync('checks.json', 'utf8')).find((c) => c.action === action)?.name || action; } catch { /* keep the action */ }
  const delay = Number(process.env.AEGIS_RETRY_DELAY || 300);
  const event = what === 'start' ? { type: 'start', title }
    : what === 'retry' ? { type: 'step', kind: 'other', text: `First try failed (exit ${rc}); trying again in ${delay >= 60 ? `${Math.round(delay / 60)} min` : `${delay} s`}` }
    : what === 'end' && rc === '0' ? { type: 'finish', text: 'Passed' }
    : what === 'end' ? { type: 'fail', error: lastError() || `Failed (exit ${rc})` }
    : null;
  if (!event) return;
  await fetch(`${url}/api/v1/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': 'aegis' },
    body: JSON.stringify({ ...event, run }),
    signal: AbortSignal.timeout(3000),
  });
}

main().catch(() => {}).finally(() => { process.exitCode = 0; });
