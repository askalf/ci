// Tests for the bump step of .github/workflows/redline-pin-bump.yml, run as the workflow runs it.
// Run: node scripts/redline/pin-bump.test.mjs
// gh is a fake on PATH that records every call and fails any path it does not serve; nothing
// leaves the machine. pin.mjs is the real one, copied into a scratch checkout.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { actionPins, bumpActionPins, CHECKOUT_RETRY_ACTION, countActionPins, DRIFT_REPORT_ACTION, missingGrants, permissionsOf } from './pin.mjs';

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

console.log('\n  --action moves every askalf/ci action pin, each on its own path');
{
  const both = `jobs:\n  w:\n    steps:\n      - uses: ${CHECKOUT_RETRY_ACTION}@${OLDSHA} # main 2026-10-01\n        with:\n          persist-credentials: false\n      - uses: actions/setup-node@${OLDSHA} # v7\n      - name: report\n        uses: ${DRIFT_REPORT_ACTION}@${OLDSHA}\n`;
  const moved = bumpActionPins(both, NEWSHA, 'main 2026-10-20');
  check('a checkout-with-retry pin and a drift-report pin are both pins, in file order; another action at a sha is not',
    actionPins(both).join() === `${OLDSHA},${OLDSHA}` && countActionPins(both) === 2);
  check('each pin moves to the commit on its own path, with the note',
    moved.includes(`      - uses: ${CHECKOUT_RETRY_ACTION}@${NEWSHA} # main 2026-10-20\n`) && moved.includes(`        uses: ${DRIFT_REPORT_ACTION}@${NEWSHA} # main 2026-10-20\n`), moved);
  check('the other action and every other line are unchanged',
    moved.includes(`actions/setup-node@${OLDSHA} # v7\n`) && moved.replace(new RegExp(NEWSHA, 'g'), OLDSHA).replace(/ # main 2026-10-20/g, '') === both.replace(/ # main 2026-10-01/g, ''), moved);
  check('a workflow with a plain actions/checkout and no askalf/ci action is not a caller and comes back unchanged',
    countActionPins(`steps:\n  - uses: actions/checkout@${OLDSHA}\n`) === 0 && bumpActionPins(`steps:\n  - uses: actions/checkout@${OLDSHA}\n`, NEWSHA) === `steps:\n  - uses: actions/checkout@${OLDSHA}\n`);
}

console.log('\n  a caller must grant what the called workflow asks for');
{
  const called = 'on:\n  workflow_call:\npermissions:\n  actions: read # the gate check\n  contents: read\njobs:\n  r:\n    runs-on: x\n    permissions:\n      pull-requests: write\n    steps:\n      - run: true\n';
  const at = (perms) => `${perms}jobs:\n  review:\n    uses: askalf/ci/.github/workflows/redline-review.yml@${NEWSHA} # main\n    with:\n      redline-ref: ${NEWSHA}\n`;
  check('the called workflow\'s asks are its top-level block and every job\'s',
    JSON.stringify(permissionsOf(called)) === JSON.stringify({ top: { actions: 'read', contents: 'read' }, jobs: { r: { 'pull-requests': 'write' } }, uses: {} }), JSON.stringify(permissionsOf(called)));
  check('a caller granting less is told each scope it lacks, at the level asked',
    missingGrants(at('permissions:\n  contents: read\n  pull-requests: read\n'), called).join() === 'actions: read,pull-requests: write');
  check('a caller granting all of it, or more, lacks nothing',
    missingGrants(at('permissions:\n  actions: write\n  contents: read\n  pull-requests: write\n'), called).length === 0);
  check('the calling job\'s own block is the grant when it has one',
    missingGrants(`permissions: {}\njobs:\n  review:\n    permissions:\n      actions: read\n      contents: read\n      pull-requests: write\n    uses: askalf/ci/.github/workflows/redline-review.yml@${NEWSHA}\n`, called).length === 0);
  check('read-all grants every read and no write, {} grants nothing',
    missingGrants(at('permissions: read-all\n'), called).join() === 'pull-requests: write'
      && missingGrants(at('permissions: {}\n'), called).length === 3);
  check('an inline map grants its entries: a sufficient one lacks nothing, a short one is told what it lacks',
    missingGrants(at('permissions: {actions: read, contents: read, pull-requests: write}\n'), called).length === 0
      && missingGrants(at('permissions: {contents: read}\n'), called).join() === 'actions: read,pull-requests: write');
  const inlineCalled = 'on:\n  workflow_call:\npermissions: {actions: read}\njobs:\n  r:\n    runs-on: x\n    steps:\n      - run: true\n';
  check('an inline map in the called workflow is an ask: a caller granting nothing is told it lacks it',
    missingGrants(at('permissions: {}\n'), inlineCalled).join() === 'actions: read');
  const throws = (f) => { try { f(); return false; } catch { return true; } };
  const quotedCalled = 'on:\n  workflow_call:\npermissions:\n  actions: "read"\n  contents: \'read\'\njobs:\n  r:\n    runs-on: x\n    steps:\n      - run: true\n';
  check('quoted levels are read: an empty caller is told it lacks both, quoted grants cover them',
    missingGrants(at('permissions: {}\n'), quotedCalled).join() === 'actions: read,contents: read'
      && missingGrants(at('permissions:\n  actions: \'read\'\n  contents: "read"\n'), quotedCalled).length === 0
      && missingGrants(at('permissions: {actions: "read", contents: \'read\'}\n'), quotedCalled).length === 0);
  const fullTop = 'permissions: {actions: read, contents: read, pull-requests: write}\n';
  check('a quoted or escaped key anywhere throws instead of being read as some other key',
    throws(() => missingGrants(`${fullTop}jobs:\n  "review":\n    "permissions": {}\n    uses: askalf/ci/.github/workflows/redline-review.yml@${NEWSHA}\n`, called))
      && throws(() => missingGrants(at('"permissions": {}\n'), called))
      && throws(() => missingGrants(at('\'permissions\':\n  contents: read\n'), called))
      && throws(() => missingGrants(at('"permiss\\u0069ons": {}\n'), called))
      && throws(() => missingGrants(at('permissions: {}\n'), 'on:\n  workflow_call:\n"permiss\\u0069ons": {actions: read}\njobs:\n  r:\n    runs-on: x\n')));
  check('a quoted uses value still finds the calling job and its override',
    missingGrants(`${fullTop}jobs:\n  review:\n    permissions: {}\n    uses: "askalf/ci/.github/workflows/redline-review.yml@${NEWSHA}"\n`, called).length === 3);
  check('a call spelled out in block scalar text never stands in for the calling job',
    missingGrants(`${fullTop}env:\n  NOTE: |\n    uses: "askalf/ci/.github/workflows/redline-review.yml@${NEWSHA}"\njobs:\n  review:\n    permissions: {}\n    uses: askalf/ci/.github/workflows/redline-review.yml@${NEWSHA}\n`, called).length === 3
      && missingGrants(`${fullTop}jobs:\n  notes:\n    runs-on: x\n    steps:\n      - run: |\n          uses: askalf/ci/.github/workflows/redline-review.yml@${NEWSHA}\n  review:\n    permissions: {}\n    uses: askalf/ci/.github/workflows/redline-review.yml@${NEWSHA}\n`, called).length === 3);
  check('two jobs calling it, or none, throws instead of picking one',
    throws(() => missingGrants(`${fullTop}jobs:\n  a:\n    uses: askalf/ci/.github/workflows/redline-review.yml@${NEWSHA}\n  b:\n    permissions: {}\n    uses: askalf/ci/.github/workflows/redline-review.yml@${NEWSHA}\n`, called))
      && throws(() => missingGrants(`${fullTop}jobs:\n  a:\n    runs-on: x\n`, called)));
  check('a caller whose calling job cannot be found throws instead of falling back to the top level',
    throws(() => missingGrants(`${fullTop}jobs:\n  review: {permissions: {}, uses: askalf/ci/.github/workflows/redline-review.yml@${NEWSHA}}\n`, called)));
  check('a called workflow whose job is written inline throws instead of asking for nothing',
    throws(() => missingGrants(at('permissions: {}\n'), 'on:\n  workflow_call:\njobs:\n  r: {runs-on: ubuntu-latest, permissions: {actions: read}, steps: [{run: echo ok}]}\n'))
      && throws(() => missingGrants(at('permissions: {}\n'), 'on:\n  workflow_call:\njobs: {r: {permissions: {actions: read}}}\n'))
      && throws(() => missingGrants(at('permissions: {}\n'), 'on:\n  workflow_call:\njobs:\n  r: *shared\n')));
  check('a merge key at the top, job or job-key level throws instead of hiding a block',
    throws(() => missingGrants(at('permissions: {}\n'), '<<: *base\njobs:\n  r:\n    runs-on: x\n'))
      && throws(() => missingGrants(at('permissions: {}\n'), 'jobs:\n  <<: *jobs\n  r:\n    runs-on: x\n'))
      && throws(() => missingGrants(at('permissions: {}\n'), 'jobs:\n  r:\n    <<: *job\n    runs-on: x\n')));
  check('an indented root, a document marker, a tag, an anchor or a complex key throws',
    throws(() => missingGrants(at('permissions: {}\n'), '  on:\n    workflow_call:\n  permissions: {actions: read}\n  jobs:\n    r:\n      runs-on: x\n'))
      && throws(() => missingGrants(at('permissions: {}\n'), '---\npermissions: {actions: read}\n'))
      && throws(() => missingGrants(at('permissions: {}\n'), 'permissions: !!map {actions: read}\n'))
      && throws(() => missingGrants(at('permissions: {}\n'), 'permissions: &p {actions: read}\n'))
      && throws(() => missingGrants(at('permissions: {}\n'), '? permissions\n: {actions: read}\n')));
  check('a value that runs onto the next line throws instead of hiding what follows',
    throws(() => missingGrants(at('permissions: {}\n'), 'permissions: {actions: read,\n  contents: read}\n'))
      && throws(() => missingGrants(at('permissions: {}\n'), 'name: "two\n  lines"\npermissions: {actions: read}\n'))
      && throws(() => missingGrants(at('permissions: {}\n'), 'name: plain\n  continued\npermissions: {actions: read}\n')));
  check('block scalar text is skipped, whatever it holds',
    missingGrants(at('permissions: {}\n'), 'jobs:\n  r:\n    runs-on: x\n    steps:\n      - run: |\n          "permissions": {}\n          ---\n        shell: bash\n    permissions:\n      actions: read\n').join() === 'actions: read');
  check('a block entry it cannot read throws instead of counting as nothing',
    (() => { try { missingGrants(at('permissions:\n  actions: maybe\n'), called); return false; } catch { return true; } })()
      && (() => { try { missingGrants(at('permissions: {}\n'), 'permissions:\n  actions: ${{ x }}\njobs:\n  r:\n    runs-on: x\n'); return false; } catch { return true; } })());
  check('a permissions form it cannot read throws instead of passing for an empty grant',
    (() => { try { missingGrants(at('permissions: ${{ fromJSON(x) }}\n'), called); return false; } catch { return true; } })()
      && (() => { try { missingGrants(at('permissions: {actions: maybe}\n'), called); return false; } catch { return true; } })());
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
    put.startsWith('api -X PUT repos/askalf/x/contents/.github/workflows/npm%20drift.yml ') && put.includes('message=ci: bump action pins to askalf/ci@bbbbbbb in npm drift.yml'), put);
  check('what is written moves the watcher\'s pin to the commit', actionPins(written).join() === NEWSHA, written);
  // Read once as the caller; the listing's redline.yml is the caller path, so it is not read again as a watcher.
  const callerReads = calls.split('\n').filter((l) => l.includes('contents/.github/workflows/redline.yml?ref=tip0000')).length;
  check('the caller already at the commit is read once and not rewritten',
    callerReads === 1 && !/-X PUT [^\n]*redline\.yml/.test(calls) && out.includes('.github/workflows/redline.yml already at bbbbbbb'), out + calls);
}

console.log('\n  a watcher-only caller: no redline.yml, one drift-report pin');
if (spawnSync('bash', ['-c', 'true']).status !== 0 || process.platform === 'win32') {
  console.log('  skip the bump step run: no POSIX bash here');
} else {
  // askalf/w has no redline.yml and one watcher at the old commit: bumped for the watcher alone.
  // askalf/n has no redline.yml and no pin anywhere: reported, not bumped.
  // askalf/f lists a redline.yml that cannot be read (the fake gh fails the read) beside a readable
  // watcher at the old commit: that is a failed read, not an absent caller, so nothing is bumped there.
  const d = mkdtempSync(join(tmpdir(), 'pin-bump-watcher-only-'));
  writeFileSync(join(d, 'gh'), `#!/usr/bin/env bash
echo "$*" >> "${d}/calls"
case "$*" in
  *"commits/${NEWSHA}/pulls"*) ;;
  "api repos/askalf/"*" --jq .default_branch") echo main ;;
  *"git/ref/heads/main --jq .object.sha") echo tip0000 ;;
  "api repos/askalf/w/contents/.github/workflows?ref=tip0000 --jq"*) printf '%s\\n' drift.yml ;;
  "api repos/askalf/n/contents/.github/workflows?ref=tip0000 --jq"*) printf '%s\\n' build.yml ;;
  "api repos/askalf/f/contents/.github/workflows?ref=tip0000 --jq"*) printf '%s\\n' redline.yml drift.yml ;;
  *"repos/askalf/f/contents/.github/workflows/drift.yml?ref=tip0000 --jq .content") echo "${b64(watcher)}" ;;
  *"repos/askalf/n/contents/.github/workflows/build.yml?ref=tip0000 --jq .content") echo "${b64('jobs:\n  b:\n    steps:\n      - run: true\n')}" ;;
  *"repos/askalf/w/contents/.github/workflows/drift.yml?ref=tip0000 --jq .content") echo "${b64(watcher)}" ;;
  *"repos/askalf/w/contents/.github/workflows/drift.yml?ref=bot/redline-pin --jq .content") echo "${b64(watcher)}" ;;
  *"repos/askalf/w/contents/.github/workflows/drift.yml?ref=bot/redline-pin --jq .sha") echo blob1 ;;
  "api -X POST repos/askalf/w/git/refs"*) ;;
  "api -X PUT repos/askalf/w/contents/.github/workflows/drift.yml "*) ;;
  "pr list"*) ;;
  "pr create"*) echo https://github.com/askalf/w/pull/1 ;;
  *) exit 1 ;;
esac
`);
  chmodSync(join(d, 'gh'), 0o755);
  mkdirSync(join(d, 'work', 'scripts', 'redline'), { recursive: true });
  writeFileSync(join(d, 'work', 'scripts', 'redline', 'pin.mjs'), readFileSync(fileURLToPath(new URL('./pin.mjs', import.meta.url))));
  calledWorkflows(join(d, 'work'));
  const r = spawnSync('bash', ['-c', script.join('\n')], { encoding: 'utf8', cwd: join(d, 'work'),
    env: { ...process.env, PATH: `${d}:${process.env.PATH}`, GH_TOKEN: 't', SHA: NEWSHA, SOURCE: 'askalf/ci', CALLERS: 'askalf/w askalf/n askalf/f',
      BRANCH: 'bot/redline-pin', CALLER_PATHS: '.github/workflows/redline.yml .github/workflows/redline-fix.yml' } });
  const calls = existsSync(join(d, 'calls')) ? readFileSync(join(d, 'calls'), 'utf8') : '';
  rmSync(d, { recursive: true, force: true });
  const out = r.stdout + r.stderr;
  const put = calls.split('\n').find((l) => l.startsWith('api -X PUT ')) ?? '';
  const written = Buffer.from(/ content=(\S+)/.exec(put)?.[1] ?? '', 'base64').toString();
  check('the watcher-only caller is bumped: its missing redline.yml is noted, not an error, and a PR opens',
    calls.includes('pr create --repo askalf/w') && out.includes('no .github/workflows/redline.yml') && !out.includes('::error::askalf/w'), out + calls);
  check('what is written moves the watcher\'s pin to the commit',
    put.startsWith('api -X PUT repos/askalf/w/contents/.github/workflows/drift.yml ') && actionPins(written).join() === NEWSHA, put);
  check('a repository with no redline.yml and no action pin is reported, opens nothing, and fails the run',
    r.status !== 0 && out.includes('::error::askalf/n: no .github/workflows/redline.yml and no action pin') && !calls.includes('pr create --repo askalf/n'), out + calls);
  check('a redline.yml that is listed but could not be read is a failed read, not an absent caller: nothing is bumped there',
    out.includes('::error::askalf/f: could not read .github/workflows/redline.yml at tip0000') && out.includes('::error::askalf/f: not every workflow could be read')
      && !out.includes('askalf/f: no .github/workflows/redline.yml') && !calls.includes('pr create --repo askalf/f') && !calls.includes('repos/askalf/f/git/refs'), out + calls);
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
    *"repos/askalf/a/contents/.github/workflows?ref=tip0000 --jq"*) printf '%s\\n' redline-fix.yml; exit 0 ;;
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

console.log('\n  the pick step skips a commit that only moves pins to this repository');
if (spawnSync('bash', ['-c', 'true']).status !== 0 || process.platform === 'win32' || spawnSync('git', ['--version']).status !== 0) {
  console.log('  skip the pick step run: no POSIX bash or git here');
} else {
  const pickAt = lines.findIndex((l) => l.includes('- name: Pick the commit to pin'));
  const pickRunAt = lines.findIndex((l, i) => i > pickAt && l.trim() === 'run: |');
  const pick = [];
  for (const l of lines.slice(pickRunAt + 1)) { if (l.trim() && !l.startsWith('          ')) break; pick.push(l.slice(10)); }
  // PIN_PATHS as the workflow sets it, read from the file so the test follows it.
  const pinPaths = bump.match(/PIN_PATHS: >-\n((?: {8}\S.*\n)+)/)[1].split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
  const d = mkdtempSync(join(tmpdir(), 'pin-pick-'));
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: d, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (files, msg) => {
    for (const [p, c] of Object.entries(files)) { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), c); }
    git('add', '-A'); git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  const SHA1 = '1'.repeat(40), SHA2 = '2'.repeat(40), SHA3 = '3'.repeat(40);
  const review = (pin, extra = '') => `on:\n  workflow_call:\njobs:\n  r:\n    steps:\n      - uses: ${CHECKOUT_RETRY_ACTION}@${pin} # main 2026-10-20, askalf/ci#1\n      - uses: actions/setup-node@${SHA1} # v7\n${extra}`;
  const callerFile = (pin) => `jobs:\n  review:\n    uses: askalf/ci/.github/workflows/redline-review.yml@${pin} # main\n    with:\n      redline-ref: ${pin}\n`;
  const pickRun = () => {
    const out = join(d, '.out'); writeFileSync(out, '');
    const r = spawnSync('bash', ['-c', pick.join('\n')], { cwd: d, encoding: 'utf8',
      env: { ...process.env, PIN_PATHS: pinPaths, GITHUB_REPOSITORY: 'askalf/ci', GITHUB_OUTPUT: out, EVENT: 'workflow_dispatch', WAIT_FOR_QUIET: 'false', QUIET_MINUTES: '60', WAVE_SIZE: '3' } });
    return { r, out: readFileSync(out, 'utf8') };
  };
  git('init', '-q', '-b', 'main');
  commit({ 'scripts/redline/review.mjs': 'export const v = 1;\n', '.github/workflows/redline-review.yml': review(SHA1) }, 'root');
  const real = commit({ 'scripts/redline/review.mjs': 'export const v = 2;\n' }, 'redline: a real change');
  // The bump PR in this repository: its own caller and the action pins move, nothing else.
  commit({ '.github/workflows/redline-review.yml': review(SHA2).replace('askalf/ci#1', 'askalf/ci#2'), '.github/workflows/redline.yml': callerFile(SHA2) }, 'ci: bump Redline to askalf/ci@2222222');
  commit({ 'README.md': 'not a path a caller runs\n' }, 'docs');
  const first = pickRun();
  check('the newest commit that changes more than pins is picked, past a bump that moves only this repository\'s pins',
    first.r.status === 0 && first.out.includes(`sha=${real}\n`) && first.r.stdout.includes('skipped ') && first.r.stdout.includes('it changes only pins to askalf/ci'),
    first.r.stdout + first.r.stderr + first.out);
  const mixed = commit({ '.github/workflows/redline-review.yml': review(SHA3, '      - run: echo new step\n') }, 'redline-review: a pin and a new step');
  const second = pickRun();
  check('a commit that moves a pin and changes another line is a change and is picked',
    second.r.status === 0 && second.out.includes(`sha=${mixed}\n`), second.r.stdout + second.r.stderr + second.out);
  const other = commit({ '.github/workflows/redline-review.yml': review(SHA3, '      - run: echo new step\n').replace(`actions/setup-node@${SHA1}`, `actions/setup-node@${SHA2}`) }, 'build(deps): bump actions/setup-node');
  const third = pickRun();
  check('a pin to another repository is a change: it alters what a caller runs',
    third.r.status === 0 && third.out.includes(`sha=${other}\n`), third.r.stdout + third.r.stderr + third.out);
  rmSync(d, { recursive: true, force: true });
}

console.log(`\n  ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
