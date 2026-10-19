// Tests for the bump step of .github/workflows/redline-pin-bump.yml, run as the workflow runs it.
// Run: node scripts/redline/pin-bump.test.mjs
// gh is a fake on PATH that records every call and fails any path it does not serve; nothing
// leaves the machine. pin.mjs is the real one, copied into a scratch checkout.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { actionPins, DRIFT_REPORT_ACTION, missingGrants, permissionsOf } from './pin.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? `\n${detail}` : ''}`); fail++; }
}

const bump = readFileSync(fileURLToPath(new URL('../../.github/workflows/redline-pin-bump.yml', import.meta.url)), 'utf8');
const lines = bump.split('\n');
const at = lines.findIndex((l) => l.includes('- name: Open or update a bump PR in each caller'));
const runAt = lines.findIndex((l, i) => i > at && l.trim() === 'run: |');
const script = [];
for (const l of lines.slice(runAt + 1)) { if (l.trim() && !l.startsWith('          ')) break; script.push(l.slice(10)); }

const NEWSHA = 'b'.repeat(40), OLDSHA = 'a'.repeat(40);
const b64 = (x) => Buffer.from(x).toString('base64');
const caller = `jobs:\n  review:\n    uses: askalf/ci/.github/workflows/redline-review.yml@${NEWSHA} # main\n    with:\n      redline-ref: ${NEWSHA}\n`;
const watcher = `jobs:\n  w:\n    steps:\n      - uses: ${DRIFT_REPORT_ACTION}@${OLDSHA} # main\n`;

// The bump step reads the called workflows from its checkout, as the sparse checkout leaves them.
function calledWorkflows(work) {
  mkdirSync(join(work, '.github', 'workflows'), { recursive: true });
  for (const f of ['redline-review.yml', 'redline-fix-run.yml']) {
    writeFileSync(join(work, '.github', 'workflows', f), readFileSync(fileURLToPath(new URL(`../../.github/workflows/${f}`, import.meta.url))));
  }
}

console.log('\n  a caller must grant what the called workflow asks for');
{
  const called = 'on:\n  workflow_call:\npermissions:\n  actions: read # the gate check\n  contents: read\njobs:\n  r:\n    runs-on: x\n    permissions:\n      pull-requests: write\n    steps:\n      - run: true\n';
  const at = (perms) => `${perms}jobs:\n  review:\n    uses: askalf/ci/.github/workflows/redline-review.yml@${NEWSHA} # main\n    with:\n      redline-ref: ${NEWSHA}\n`;
  check('the called workflow\'s asks are its top-level block and every job\'s',
    JSON.stringify(permissionsOf(called)) === JSON.stringify({ top: { actions: 'read', contents: 'read' }, jobs: { r: { 'pull-requests': 'write' } } }), JSON.stringify(permissionsOf(called)));
  check('a caller granting less is told each scope it lacks, at the level asked',
    missingGrants(at('permissions:\n  contents: read\n  pull-requests: read\n'), called).join() === 'actions: read,pull-requests: write');
  check('a caller granting all of it, or more, lacks nothing',
    missingGrants(at('permissions:\n  actions: write\n  contents: read\n  pull-requests: write\n'), called).length === 0);
  check('the calling job\'s own block is the grant when it has one',
    missingGrants(`permissions: {}\njobs:\n  review:\n    permissions:\n      actions: read\n      contents: read\n      pull-requests: write\n    uses: askalf/ci/.github/workflows/redline-review.yml@${NEWSHA}\n`, called).length === 0);
  check('read-all grants every read and no write, {} grants nothing',
    missingGrants(at('permissions: read-all\n'), called).join() === 'pull-requests: write'
      && missingGrants(at('permissions: {}\n'), called).length === 3);
  check('a caller with no permissions block runs on the repository default, which a file cannot show: nothing is reported',
    missingGrants(at(''), called).length === 0);
  const real = (f) => readFileSync(fileURLToPath(new URL(`../../.github/workflows/${f}`, import.meta.url)), 'utf8');
  check('this repository\'s own callers grant what its called workflows ask for',
    missingGrants(real('redline.yml'), real('redline-review.yml')).length === 0
      && (!existsSync(fileURLToPath(new URL('../../.github/workflows/redline-fix.yml', import.meta.url))) || missingGrants(real('redline-fix.yml'), real('redline-fix-run.yml')).length === 0));
}

console.log('\n  a watcher whose file name has a space');
if (spawnSync('bash', ['-c', 'true']).status !== 0 || process.platform === 'win32') {
  console.log('  skip the bump step run: no POSIX bash here');
} else {
  const d = mkdtempSync(join(tmpdir(), 'pin-bump-'));
  // The listing names the caller and one watcher, "npm drift.yml". The watcher is served only at
  // its whole, encoded path: a split name asks for a path this gh does not have, and fails.
  writeFileSync(join(d, 'gh'), `#!/usr/bin/env bash
echo "$*" >> "${d}/calls"
case "$*" in
  *"commits/${NEWSHA}/pulls"*) ;;
  "api repos/askalf/x --jq .default_branch") echo main ;;
  *"git/ref/heads/main --jq .object.sha") echo tip0000 ;;
  *"contents/.github/workflows/redline.yml?ref=tip0000 --jq .content") echo "${b64(caller)}" ;;
  *"contents/.github/workflows?ref=tip0000 --jq"*) printf '%s\\n' redline.yml 'npm drift.yml' ;;
  *"contents/.github/workflows/npm%20drift.yml?ref=tip0000 --jq .content") echo "${b64(watcher)}" ;;
  *"contents/.github/workflows/npm%20drift.yml?ref=bot/redline-pin --jq .content") echo "${b64(watcher)}" ;;
  *"contents/.github/workflows/npm%20drift.yml?ref=bot/redline-pin --jq .sha") echo blob1 ;;
  "api -X POST repos/askalf/x/git/refs"*) ;;
  "api -X PUT repos/askalf/x/contents/.github/workflows/npm%20drift.yml "*) ;;
  "pr list"*) ;;
  "pr create"*) echo https://github.com/askalf/x/pull/1 ;;
  *) exit 1 ;;
esac
`);
  chmodSync(join(d, 'gh'), 0o755);
  // The step runs pin.mjs from the checkout and writes caller.yml in its working directory.
  mkdirSync(join(d, 'work', 'scripts', 'redline'), { recursive: true });
  writeFileSync(join(d, 'work', 'scripts', 'redline', 'pin.mjs'), readFileSync(fileURLToPath(new URL('./pin.mjs', import.meta.url))));
  calledWorkflows(join(d, 'work'));
  const r = spawnSync('bash', ['-c', script.join('\n')], { encoding: 'utf8', cwd: join(d, 'work'),
    env: { ...process.env, PATH: `${d}:${process.env.PATH}`, GH_TOKEN: 't', SHA: NEWSHA, SOURCE: 'askalf/ci', CALLERS: 'askalf/x',
      BRANCH: 'bot/redline-pin', CALLER_PATHS: '.github/workflows/redline.yml' } });
  const calls = existsSync(join(d, 'calls')) ? readFileSync(join(d, 'calls'), 'utf8') : '';
  rmSync(d, { recursive: true, force: true });
  const out = r.stdout + r.stderr;
  const put = calls.split('\n').find((l) => l.startsWith('api -X PUT ')) ?? '';
  const written = Buffer.from(/ content=(\S+)/.exec(put)?.[1] ?? '', 'base64').toString();
  check('the bump completes and opens a PR', r.status === 0 && calls.includes('pr create'), out + calls);
  check('the watcher is read at its whole path, encoded for the Contents API',
    calls.includes('contents/.github/workflows/npm%20drift.yml?ref=tip0000 --jq .content'), calls);
  check('no read asks for a piece of the split name',
    !/contents\/\.github\/workflows\/(npm|drift\.yml)\?/.test(calls) && !calls.includes('workflows/npm drift'), calls);
  check('the watcher is written at its whole path, with the commit named after the whole file',
    put.startsWith('api -X PUT repos/askalf/x/contents/.github/workflows/npm%20drift.yml ') && put.includes('message=ci: bump drift-report to askalf/ci@bbbbbbb in npm drift.yml'), put);
  check('what is written moves the watcher\'s pin to the commit', actionPins(written).join() === NEWSHA, written);
  // Read once as the caller; the listing's redline.yml is the caller path, so it is not read again as a watcher.
  const callerReads = calls.split('\n').filter((l) => l.includes('contents/.github/workflows/redline.yml?ref=tip0000')).length;
  check('the caller already at the commit is read once and not rewritten',
    callerReads === 1 && !/-X PUT [^\n]*redline\.yml/.test(calls) && out.includes('.github/workflows/redline.yml already at bbbbbbb'), out + calls);
}

console.log('\n  a capped run opens at most CAP bump PRs, in caller order');
if (spawnSync('bash', ['-c', 'true']).status !== 0 || process.platform === 'win32') {
  console.log('  skip the bump step run: no POSIX bash here');
} else {
  const d = mkdtempSync(join(tmpdir(), 'pin-bump-cap-'));
  // Every repository has a caller at the old commit and no watcher; each bump opens a PR.
  const old = caller.replaceAll(NEWSHA, OLDSHA);
  writeFileSync(join(d, 'gh'), `#!/usr/bin/env bash
echo "$*" >> "${d}/calls"
# A_MODE shapes askalf/a: nopin fails it before any PR, partial opens a PR for its fix caller and
# still fails it, since its review caller is missing, ungranted gives it a caller that grants too
# little for the called review, granted one that grants enough.
if [ "$A_MODE" = ungranted ] && [[ "$*" == *"repos/askalf/a/contents/.github/workflows/redline.yml?ref="*" --jq .content" ]]; then echo "${b64('permissions:\n  contents: read\n  pull-requests: read\n' + old)}"; exit 0; fi
if [ "$A_MODE" = granted ] && [[ "$*" == *"repos/askalf/a/contents/.github/workflows/redline.yml?ref="*" --jq .content" ]]; then echo "${b64('permissions:\n  actions: read\n  contents: read\n  pull-requests: read\n' + old)}"; exit 0; fi
if [ "$A_MODE" = nopin ] && [[ "$*" == *"repos/askalf/a/contents/.github/workflows/redline.yml?ref=tip0000 --jq .content" ]]; then echo "${b64('name: x'+String.fromCharCode(10))}"; exit 0; fi
if [ "$A_MODE" = partial ]; then
  case "$*" in
    *"repos/askalf/a/contents/.github/workflows/redline.yml?ref="*) exit 1 ;;
    *"repos/askalf/a/contents/.github/workflows/redline-fix.yml?ref="*" --jq .content") echo "${b64(old)}"; exit 0 ;;
    *"repos/askalf/a/contents/.github/workflows/redline-fix.yml?ref=bot/redline-pin --jq .sha") echo blob1; exit 0 ;;
  esac
fi
case "$*" in
  *"commits/${NEWSHA}/pulls"*) ;;
  "api repos/askalf/"*" --jq .default_branch") echo main ;;
  *"git/ref/heads/main --jq .object.sha") echo tip0000 ;;
  *"git/ref/heads/bot/redline-pin") exit 1 ;;
  *"contents/.github/workflows/redline.yml?ref="*" --jq .content") echo "${b64(old)}" ;;
  *"contents/.github/workflows/redline.yml?ref=bot/redline-pin --jq .sha") echo blob1 ;;
  *"contents/.github/workflows?ref=tip0000 --jq"*) printf '%s\\n' redline.yml ;;
  "api -X POST repos/askalf/"*"/git/refs"*) ;;
  "api -X PUT repos/askalf/"*) ;;
  "pr list"*) ;;
  "pr create --repo "*) echo "https://github.com/$4/pull/1" ;;
  *) exit 1 ;;
esac
`);
  chmodSync(join(d, 'gh'), 0o755);
  mkdirSync(join(d, 'work', 'scripts', 'redline'), { recursive: true });
  writeFileSync(join(d, 'work', 'scripts', 'redline', 'pin.mjs'), readFileSync(fileURLToPath(new URL('./pin.mjs', import.meta.url))));
  calledWorkflows(join(d, 'work'));
  const run = (cap, env = {}) => {
    rmSync(join(d, 'calls'), { force: true });
    const r = spawnSync('bash', ['-c', script.join('\n')], { encoding: 'utf8', cwd: join(d, 'work'),
      env: { ...process.env, PATH: `${d}:${process.env.PATH}`, GH_TOKEN: 't', SHA: NEWSHA, SOURCE: 'askalf/ci', CALLERS: 'askalf/a askalf/b askalf/c askalf/d',
        BRANCH: 'bot/redline-pin', CALLER_PATHS: '.github/workflows/redline.yml', CAP: String(cap), A_MODE: '', ...env } });
    const calls = existsSync(join(d, 'calls')) ? readFileSync(join(d, 'calls'), 'utf8') : '';
    return { r, calls, created: calls.split('\n').filter((l) => l.startsWith('pr create')).map((l) => / --repo (\S+)/.exec(l)[1]) };
  };
  const capped = run(2);
  check('a cap of 2 opens PRs in the first two callers only, and the run is green',
    capped.r.status === 0 && capped.created.join() === 'askalf/a,askalf/b', capped.r.stdout + capped.r.stderr + capped.calls);
  check('the callers past the cap are named as left for the next run and never read',
    capped.r.stdout.includes('== askalf/c: left for the next run') && !/repos\/askalf\/c(\/|\s|$)/m.test(capped.calls), capped.r.stdout);
  const all = run(0);
  check('no cap bumps every caller', all.r.status === 0 && all.created.join() === 'askalf/a,askalf/b,askalf/c,askalf/d', all.r.stdout + all.r.stderr);
  const early = run(1, { A_MODE: 'nopin' });
  check('a caller that fails before opening a PR is reported and does not count: the next caller gets the slot',
    early.r.status !== 0 && early.r.stdout.includes('::error::askalf/a: the bump did not complete') && early.created.join() === 'askalf/b'
      && early.r.stdout.includes('== askalf/c: left for the next run'), early.r.stdout + early.r.stderr);
  const partial = run(1, { A_MODE: 'partial', CALLER_PATHS: '.github/workflows/redline.yml .github/workflows/redline-fix.yml' });
  check('a caller that opened a PR and then fails is reported and counts, since its PR loads the runners like any other',
    partial.r.status !== 0 && partial.r.stdout.includes('::error::askalf/a: no .github/workflows/redline.yml') && partial.r.stdout.includes('::error::askalf/a: the bump did not complete')
      && partial.created.join() === 'askalf/a' && partial.r.stdout.includes('== askalf/b: left for the next run'), partial.r.stdout + partial.r.stderr);
  const ungranted = run(0, { A_MODE: 'ungranted' });
  check('a caller that does not grant what the called review asks for is named, not bumped, and the others still are',
    ungranted.r.status !== 0 && ungranted.r.stdout.includes('::error::askalf/a: .github/workflows/redline.yml does not grant actions: read, which redline-review.yml at bbbbbbb asks for')
      && ungranted.created.join() === 'askalf/b,askalf/c,askalf/d' && !/-X PUT repos\/askalf\/a\//.test(ungranted.calls), ungranted.r.stdout + ungranted.r.stderr);
  const granted = run(0, { A_MODE: 'granted' });
  check('a caller that grants it is bumped like any other',
    granted.r.status === 0 && granted.created.join() === 'askalf/a,askalf/b,askalf/c,askalf/d', granted.r.stdout + granted.r.stderr);
  rmSync(d, { recursive: true, force: true });
}

console.log(`\n  ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
