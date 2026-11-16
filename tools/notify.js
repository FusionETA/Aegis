// Argus alert destinations for one app: list them, or send a test alert to all.
//
//   node --env-file=/root/argus/.env tools/notify.js --app <app> --check
//       Lists <APP>_NOTIFY's destinations and what's missing. Exit 1 on any problem.
//   node --env-file=/root/argus/.env tools/notify.js --app <app> --test
//       Sends a clearly-labelled test message to every destination.
// Add --reports to do the same for the app's run-report list (<APP>_REPORTS) instead.
//   node --env-file=/root/argus/.env tools/notify.js --to "<channel:to>, …" --check | --test
//       The same for an explicit destination list (the console's channel tests).
// <app> is the plugin folder name (my-app) or its env prefix (MY_APP). Omit --app
// for the default destination the AltomateHR scripts use. Never prints secrets.
import { parseList, resolveReportTargets, resolveTargets, sendReport } from '../core/report.js';
import { nowMYT } from '../core/time.js';

const args = process.argv.slice(2);
const appArg = args.includes('--app') ? args[args.indexOf('--app') + 1] : '';
const mode = args.includes('--test') ? 'test' : args.includes('--check') ? 'check' : null;
const reports = args.includes('--reports');
const toArg = args.includes('--to') ? args[args.indexOf('--to') + 1] || '' : '';
if (!mode || (args.includes('--app') && !/^[A-Za-z0-9_-]+$/.test(appArg || '')) || (reports && !appArg) || (args.includes('--to') && !toArg.trim())) {
  console.error('usage: notify.js [--app <app>] [--reports] | --to "<channel:to>, …"  --check | --test   (--reports needs --app)');
  process.exit(2);
}
const app = appArg ? appArg.toUpperCase().replace(/-/g, '_') : undefined;

const resolved = toArg ? { source: '--to', ...parseList(app, toArg) } : reports ? resolveReportTargets(app) : resolveTargets(app);
const { source, targets, problems } = resolved;
console.log(`${reports ? 'run-report destinations' : 'destinations'} for ${app ?? 'the default (AltomateHR)'}, from ${source}:`);
if (reports) console.log(`  run reports are switched ${resolved.enabled ? 'on' : 'off'}`);
for (const t of targets) console.log(`  ${t.ok ? '✓' : '✗'} ${t.channel}${t.to ? `:${t.to}` : ''}`);
for (const p of problems) console.log(`  problem: ${p}`);

if (mode === 'test') {
  const what = toArg ? 'message' : reports ? 'run report' : 'alert';
  await sendReport(
    [
      `🧪 Argus test ${what}${app ? ` for ${app}` : ''} — please ignore.`,
      `📅 ${nowMYT()} (MYT)`,
      toArg
        ? 'If you can read this, this Argus channel works and reaches this destination.'
        : reports
        ? 'If you can read this, Argus run reports (every run, passed or failed) reach this destination.'
        : 'If you can read this, Argus failure alerts reach this destination.',
    ].join('\n'),
    { app, resolved, subject: `[Argus] test ${what}${app ? ` for ${app}` : ''} — please ignore` },
  );
}
process.exitCode = problems.length || !targets.length ? 1 : 0;
