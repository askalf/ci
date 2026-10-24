// Tests for check.mjs: the expression evaluator, the refresh-list rule, and the whole check over
// test-fixtures/caller (a caller that passes), then over copies of it with one thing broken each.
// Run: node scripts/fleet-status/check.test.mjs

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCaller, evalIf, homeOf, misfits, workflowRunList } from './check.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? `\n${detail}` : ''}`); fail++; }
}

const FIXTURE = fileURLToPath(new URL('./test-fixtures/caller', import.meta.url));
const failing = (results) => results.filter((r) => !r.ok).map((r) => r.name);
const scratch = [];
/** A copy of the fixture with `edit(file, text)` applied to the named files. */
function variant(edits) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-status-check-'));
  scratch.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  for (const [f, edit] of Object.entries(edits)) {
    if (edit === null) { rmSync(join(dir, f)); continue; }
    let y = '';
    try { y = readFileSync(join(dir, f), 'utf8'); } catch { /* a new file */ }
    const out = edit(y);
    if (out === y) throw new Error(`the edit to ${f} changed nothing`);
    writeFileSync(join(dir, f), out);
  }
  return dir;
}
/** The names that fail on a variant; each case expects exactly one rule to catch it. */
const caught = (edits, opts) => failing(checkCaller(variant(edits), opts));

console.log('\n  the evaluator');
check('reads literals, paths and functions',
  evalIf("contains(fromJSON('[\"a\",\"b\"]'), x.y[0]) && x.z == null && 'A' == 'a'", { x: { y: ['B'] } })
  && !evalIf("x.y != 'q' && x.y == 'q'", { x: { y: 'q' } }));
check('&& and || return operands, as Actions does', evalIf("(x && 'ubuntu-latest' || 'ours') == 'ours'", { x: false }));
check('startsWith compares case-insensitively', evalIf("startsWith(x, '## verification')", { x: '## Verification at abc' }));
let threw = false;
try { evalIf("unknownFn(x)", {}); } catch { threw = true; }
check('an unknown function throws instead of reading as false', threw);

console.log('\n  the refresh list');
const onPr = (name) => `name: ${name}\non:\n  pull_request:\n    types: [opened]\njobs: {}\n`;
const onTarget = (name) => `name: ${name}\non:\n  pull_request_target:\njobs: {}\n`;
const onPush = (name) => `name: ${name}\non:\n  push:\n  # pull_request: is off\njobs: {}\n`;
check('no list: a pull_request workflow beside it is not a misfit', misfits(null, [['review', onPr('review')], ['pulse', onPr('pulse')]]).length === 0);
check('a list must name every pull_request workflow', misfits(['review'], [['review', onPr('review')], ['pulse', onPr('pulse')]]).join() === 'pulse');
check('a list must name a pull_request_target workflow too', misfits(['review'], [['review', onPr('review')], ['triage', onTarget('triage')]]).join() === 'triage');
check('a push workflow, or a commented-out trigger, need not be listed', misfits([], [['deploy', onPush('deploy')]]).length === 0);
check('a list is read from the yaml', String(workflowRunList("on:\n  workflow_run:\n    workflows: [\"ci\", 'review']\n    types: [completed]\n")) === 'ci,review');

console.log('\n  the fixture passes');
{
  const results = checkCaller(FIXTURE);
  check('every check passes on the fixture', failing(results).length === 0, failing(results).join('\n'));
  check('the fixture exercises the matrix rule', results.some((r) => r.name.includes('Windows and macOS')));
  check('the home and label are read from the status job', JSON.stringify(homeOf(readFileSync(join(FIXTURE, 'fleet-status.yml'), 'utf8'))) === '{"home":"askalf/example","label":"example-exec"}');
  const crlf = variant(Object.fromEntries(['fleet-status.yml', 'fleet-review-relay.yml', 'ci.yml'].map((f) => [f, (y) => y.replace(/\n/g, '\r\n')])));
  check('a CRLF checkout passes the same', failing(checkCaller(crlf)).length === 0, failing(checkCaller(crlf)).join('\n'));
}

console.log('\n  each break is caught');
const STATUS = 'fleet-status.yml';
const cases = [
  ['a pull_request workflow missing from the refresh list', { 'lint.yml': () => onPr('lint') }, /are all listed \(missing: lint\)/],
  ['a fork pull_request let into the job', { [STATUS]: (y) => y.replace("github.event.pull_request.head.repo.full_name == github.repository)", 'true)') }, /fork's pull_request event does not run/],
  ['any comment let in', { [STATUS]: (y) => y.replace("(startsWith(github.event.comment.body, '## Verification at') ||", "(true ||") }, /any other comment does not run it/],
  ['a checkout step in the status job', { [STATUS]: (y) => y.replace('    steps:\n', '    steps:\n      - uses: actions/checkout@0000000000000000000000000000000000000000\n') }, /no other action/],
  ['a run step in the status job', { [STATUS]: (y) => `${y}      - run: node x.mjs\n` }, /has no run step/],
  ['the action at a branch, not a sha', { [STATUS]: (y) => y.replace(/fleet-status@[0-9a-f]{40}/, 'fleet-status@main') }, /at a full commit sha, and no other action/],
  ['the fork path without the head branch', { [STATUS]: (y) => y.replace(/\n {10}head-branch: .*/, '') }, /head repo and branch/],
  ['a step reading the PR head sha', { [STATUS]: (y) => y.replace('          head-branch:', '          sha: ${{ github.event.pull_request.head.sha }}\n          head-branch:') }, /PR head ref or sha/],
  ['cancel-in-progress on every run', { [STATUS]: (y) => y.replace("cancel-in-progress: ${{ github.event_name == 'workflow_run' }}", 'cancel-in-progress: ${{ true }}') }, /only a workflow_run run is cancelled/],
  ['a second job in fleet-status.yml', { [STATUS]: (y) => `${y}  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n` }, /runs only the status job/],
  ['another repository\'s runner label', { 'ci.yml': (y) => y.replace('fromJSON(\'["self-hosted","example-exec"]\') }}\n    steps:\n      - run: echo test', 'fromJSON(\'["self-hosted","other-exec"]\') }}\n    steps:\n      - run: echo test') }, /every self-hosted label named is example-exec \(not in: ci\.yml\)/],
  ['a fork repository sent to our runners', { 'ci.yml': (y) => y.replace("(github.repository != 'askalf/example' || github.event.pull_request", '(github.event.pull_request') }, /ci\.yml: in a fork repository every event runs on GitHub's/],
  ['Dependabot sent to our runners', { 'ci.yml': (y) => y.replace(" || github.event.pull_request.user.login == 'dependabot[bot]')) && 'ubuntu-latest' || fromJSON('[\"self-hosted\",\"example-exec\"]') }}\n    steps:\n      - run: echo test", ")) && 'ubuntu-latest' || fromJSON('[\"self-hosted\",\"example-exec\"]') }}\n    steps:\n      - run: echo test") }, /ci\.yml: a Dependabot PR runs on GitHub's/],
  ['the repository-only expression on a PR job', { 'ci.yml': (y) => y.replace(/runs-on: \$\{\{ \(github\.repository != 'askalf\/example' .*\n    steps:\n      - run: echo test/, "runs-on: ${{ github.repository == 'askalf/example' && fromJSON('[\"self-hosted\",\"example-exec\"]') || 'ubuntu-latest' }}\n    steps:\n      - run: echo test") }, /ci\.yml: only a job that never runs PR code uses it/],
  ['a literal label with no if:', { 'deploy.yml': () => 'name: deploy\non:\n  push:\njobs:\n  d:\n    runs-on: [self-hosted, example-exec]\n    steps:\n      - run: echo\n' }, /deploy\.yml: a literal example-exec job/],
  ['CodeQL on our runners', { 'codeql.yml': (y) => y.replace('    runs-on: ubuntu-latest', "    runs-on: ${{ (github.repository != 'askalf/example' || github.event.pull_request && (github.event.pull_request.head.repo.full_name != github.repository || github.event.pull_request.user.login == 'dependabot[bot]')) && 'ubuntu-latest' || fromJSON('[\"self-hosted\",\"example-exec\"]') }}") }, /CodeQL runs on GitHub's runners/],
  ['a self-test with a push trigger', { 'fleet-status-self-test.yml': (y) => y.replace('on:\n', 'on:\n  push:\n') }, /self-test runs on pull_request, and a dispatch, alone/],
  ['a self-test with a write token', { 'fleet-status-self-test.yml': (y) => y.replace('      contents: read\n', '      contents: write\n') }, /self-test token reads contents alone/],
  ['a self-test without the check action', { 'fleet-status-self-test.yml': (y) => y.replace(/\n      - uses: askalf\/ci\/actions\/fleet-status-check@.*/, '') }, /self-test runs askalf\/ci\/actions\/fleet-status-check/],
  ['a backfill that runs on a schedule too', { 'fleet-status-backfill.yml': (y) => y.replace('  workflow_dispatch:\n', '  workflow_dispatch:\n  schedule:\n    - cron: \'0 * * * *\'\n') }, /backfill runs on a dispatch alone/],
  ['a backfill without all-open', { 'fleet-status-backfill.yml': (y) => y.replace("all-open: 'true'", "all-open: 'false'") }, /over every open PR/],
  ['a relay with a token', { 'fleet-review-relay.yml': (y) => y.replace('permissions: {}', 'permissions:\n  contents: read') }, /relay has no token/],
  ['no relay', { 'fleet-review-relay.yml': null }, /relay is listed/],
];
for (const [name, edits, expect] of cases) {
  const names = caught(edits);
  check(`${name}: caught`, names.some((n) => expect.test(n)), names.join('\n') || '(nothing failed)');
}
check('too few own-code expressions for the floor', caught({}, { minOwn: 4 }).some((n) => /at least 4/.test(n)));
check('a repository-only expression on a listed file is allowed',
  failing(checkCaller(variant({ 'pulse.yml': () => "name: pulse\non:\n  schedule:\n    - cron: '0 * * * *'\njobs:\n  p:\n    runs-on: ${{ github.repository == 'askalf/example' && fromJSON('[\"self-hosted\",\"example-exec\"]') || 'ubuntu-latest' }}\n    steps:\n      - run: echo\n" }), { repoOnly: ['fleet-status.yml', 'fleet-status-backfill.yml', 'pulse.yml'] })).length === 0);
check('a missing fleet-status.yml is one failure, not a crash', caught({ [STATUS]: null }).join() === 'fleet-status.yml is here');

console.log('\n  the CLI');
{
  const cli = fileURLToPath(new URL('./check.mjs', import.meta.url));
  const run = (dir, env = {}) => spawnSync(process.execPath, [cli, dir], { env: { ...process.env, ...env }, encoding: 'utf8' });
  check('a passing caller exits 0', run(FIXTURE).status === 0);
  const broken = run(variant({ 'fleet-review-relay.yml': null }));
  check('a failing caller exits 1 and names the failure', broken.status === 1 && /FAIL the review relay is listed/.test(broken.stdout));
  check('FS_MIN_OWN is read', run(FIXTURE, { FS_MIN_OWN: '9' }).status === 1);
  check('a bad FS_MIN_OWN is a usage error', run(FIXTURE, { FS_MIN_OWN: 'many' }).status === 2);
  check('a missing directory is a usage error', run(join(FIXTURE, 'nope')).status === 2);
}

for (const d of scratch) rmSync(d, { recursive: true, force: true });
console.log(`\n  ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
