// Runs every test the `test` check runs (.github/workflows/redline-self-test.yml), one after
// another, and exits 1 if any fails. It sits at the repository root, outside the paths the pin bump
// watches, so changing it moves no caller's pin. Keep the list equal to the workflow's.
import { spawnSync } from 'node:child_process';

const RUNS = [
  ['scripts/redline/review.test.mjs'],
  ['scripts/redline/post.test.mjs'],
  ['scripts/redline/local.test.mjs'],
  ['scripts/redline/public-text.test.mjs'],
  ['scripts/drift-report/report.test.mjs'],
  ['scripts/fleet-status/fleet-status.test.mjs'],
  ['scripts/fleet-status/check.test.mjs'],
  ['scripts/scorecard-publish/check.test.mjs'],
  ['scripts/redline/pin-bump.test.mjs'],
  // Every fuzz seed through its target, and the helpers that keep a broken contract apart from a refusal.
  ['fuzz/seeds.test.mjs'],
  // The run-account tests in fix.test.mjs need a second account to sudo to and skip without one.
  ['scripts/redline/fix.test.mjs'],
  ['scripts/redline/dump-tools.mjs', '--check'],
];

const failed = [];
for (const args of RUNS) {
  const name = args.join(' ');
  process.stdout.write(`== ${name}\n`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r.status !== 0) failed.push(`${name} (exit ${r.status ?? r.signal})`);
}
if (failed.length) {
  process.stdout.write(`\nfailed: ${failed.join(', ')}\n`);
  process.exit(1);
}
process.stdout.write(`\nall ${RUNS.length} passed\n`);
