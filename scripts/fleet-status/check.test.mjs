// Tests for check.mjs: the expression evaluator, the refresh-list rule, and the whole check over
// test-fixtures/caller (a caller that passes), then over copies of it with one thing broken each.
// Run: node scripts/fleet-status/check.test.mjs

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCaller, condOf, evalExpr, evalIf, homeOf, jobsOf, misfits, Other, uncomment, UNKNOWN, workflowRunList, yamlGaps } from './check.mjs';

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
{
  const repo = new Other(['askalf/example'], { repo: true });
  const login = new Other(['dependabot[bot]']);
  const ctx = { r: repo, s: repo, l: login };
  check('a value known by what it is not settles only against itself and what it excludes',
    evalExpr("r == 'ASKALF/example'", ctx) === false && evalExpr("r == 'someone/example'", ctx) === UNKNOWN
    && evalExpr('r == s', ctx) === true && evalExpr('r == null', ctx) === false
    && evalExpr("l != 'dependabot[bot]'", ctx) === true && evalExpr("l == 'contributor'", ctx) === UNKNOWN
    && evalExpr('l == 0', ctx) === UNKNOWN && evalExpr("startsWith(l, 'a')", ctx) === UNKNOWN && evalExpr('l.x', ctx) === UNKNOWN);
}
{
  const inside = 'name: x # c\non:\n  push:\n    branches:\n    - main\n  workflow_run:\n    workflows: [a, \'b c\',\n                "d"]\njobs:\n  a:\n    name: --help smoke\n    if: >-\n      a ==\n      b\n    runs-on: [self-hosted, x-exec]\n    steps:\n      -\n        run: |\n          echo a: b\n\n          echo # c\n      - with: { a: 1 }\n';
  check('a workflow in the YAML subset has no gaps', yamlGaps(inside).length === 0);
  const gap = (s) => String(yamlGaps(s)[0]);
  check('each shape outside the YAML subset is a gap, from its first line',
    gap("'on':\n  push:\n") === '1' && gap('a: b\n  c\n') === '2' && gap("a: 'b\n  c'\n") === '1'
    && gap('a: &x b\n') === '1' && gap('a: *x\n') === '1' && gap('a: !t b\n') === '1' && gap('---\na: b\n') === '1'
    && gap('a:\n\tb: c\n') === '2' && gap('a: b: c\n') === '1' && gap('a: [b,\n  {c: d}]\n') === '1'
    && gap('a: [b,\nc]\n') === '1' && gap('? a\n: b\n') === '1' && gap('- a\n  b\n') === '2');
}
check('&& and || return operands, as Actions does', evalIf("(x && 'ubuntu-latest' || 'ours') == 'ours'", { x: false }));
check('mixed types compare as numbers, as Actions does',
  evalIf("null == ''", {}) && evalIf('false == 0', {}) && evalIf("'1' == 1", {}) && evalIf("true == '1'", {})
  && !evalIf("'a' == 0", {}) && !evalIf("'a' == null", {}) && evalIf("'' == false", {}) && evalIf('null == null', {}));
check('an array equals only itself', !evalIf("fromJSON('[]') == fromJSON('[]')", {}));
check('startsWith compares case-insensitively', evalIf("startsWith(x, '## verification')", { x: '## Verification at abc' }));
let threw = false;
try { evalIf("unknownFn(x)", {}); } catch { threw = true; }
check('an unknown function throws instead of reading as false', threw);

console.log('\n  fields a fork chooses are unknown');
{
  const fork = { github: { repository: 'askalf/example', event_name: 'pull_request', event: { pull_request: { title: 'safe', draft: false, head: { repo: { full_name: 'x/example' } }, user: { login: 'x' } } } } };
  check('a fork\'s title is unknown, not its value', condOf("contains(github.event.pull_request.title, 'safe')", fork) === UNKNOWN);
  check('false && unknown is false', condOf("github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.draft == false", fork) === false);
  check('true || unknown is true', condOf("github.event.pull_request.user.login == 'x' || github.event.pull_request.title == 'y'", fork) === true);
  check('!unknown is unknown, and so is a function of it', condOf('!github.event.pull_request.draft', fork) === UNKNOWN && condOf("startsWith(github.event.pull_request.head.ref, 'a')", fork) === UNKNOWN);
  check('vars and inputs are unknown', condOf("vars.TRUSTED == 'yes'", fork) === UNKNOWN && condOf('inputs.go', fork) === UNKNOWN);
  check('the head repository and the author are read', condOf("github.event.pull_request.head.repo.full_name == 'x/example' && github.event.pull_request.user.login == 'x'", fork) === true);
  check('the evaluator without trusted paths reads every value', evalExpr('github.event.pull_request.title', fork) === 'safe');
}

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

console.log('\n  jobs are read one at a time');
/** One job, appended under a workflow's jobs:. `head` is its if: and runs-on lines. */
const job = (id, head) => `\n  ${id}:\n${head}    steps:\n      - run: echo ${id}\n`;
{
  const y = `name: x\non:\n  pull_request:\njobs:\n  a:\n    if: >-\n      startsWith(github.event.comment.body, '## Verification at') &&\n      github.repository == 'askalf/example'\n    runs-on: [self-hosted, 'example-exec'] # ours\n    steps:\n      - run: echo\n  b:\n    if: github.event_name == 'push' # a comment\n    runs-on:\n      - self-hosted\n      - "example-build"\n  c:\n    uses: ./.github/workflows/called.yml\n  d:\n    runs-on: \${{ matrix.os }}\n`;
  const [a, b, c, d] = jobsOf(y);
  check('a folded if: keeps its # and joins its lines', a.cond === "startsWith(github.event.comment.body, '## Verification at') && github.repository == 'askalf/example'");
  check('a flow list drops quotes and the comment', a.labels.join() === 'self-hosted,example-exec' && a.expr === null);
  check('a plain if: drops its comment; a block list is read', b.cond === "github.event_name == 'push'" && b.labels.join() === 'self-hosted,example-build');
  check('a reusable-workflow job has no runs-on', !c.hasRunsOn);
  check('an expression is kept as one', d.expr === 'matrix.os' && d.labels.length === 0);
  check('a # inside quotes is not a comment', uncomment("x == '## a' # b") === "x == '## a'");
}
{
  const ok = (head) => failing(checkCaller(variant({ 'ci.yml': (y) => `${y}${job('extra', head)}` })));
  check('a literal job on pull requests that keeps fork PRs and Dependabot out passes',
    ok("    if: github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.login != 'dependabot[bot]' && github.repository == 'askalf/example'\n    runs-on: [self-hosted, example-exec]\n").length === 0);
  check('a literal job that reads failure() beside a guard that keeps forks out passes',
    ok("    needs: test\n    if: failure() && github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.login != 'dependabot[bot]' && github.repository == 'askalf/example'\n    runs-on: [self-hosted, example-exec]\n").length === 0);
  check('a literal job on pull requests that reads the draft flag beside the head repository passes',
    ok("    if: >-\n      github.event_name == 'workflow_dispatch' ||\n      (github.event.pull_request.draft == false &&\n       github.event.pull_request.head.repo.full_name == github.repository &&\n       github.event.pull_request.user.login != 'dependabot[bot]')\n    runs-on: [self-hosted, example-exec]\n").length === 0);
  check('an include that adds a Windows entry to the own-code expression passes', failing(checkCaller(variant({ 'ci.yml': (y) => `${y}\n  extra:\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n        node: [20, 22]\n        include:\n          - os: windows-latest\n            node: 22\n    runs-on: \${{ matrix.os != 'ubuntu-latest' && matrix.os || ((github.repository != 'askalf/example' || github.event.pull_request && (github.event.pull_request.head.repo.full_name != github.repository || github.event.pull_request.user.login == 'dependabot[bot]')) && 'ubuntu-latest' || fromJSON('[\"self-hosted\",\"example-exec\"]')) }}\n    steps:\n      - run: echo\n` }))).length === 0);
  check('a workflow at four-space indentation, guarded, passes', failing(checkCaller(variant({ 'wide.yml': () => "name: wide\non:\n  schedule:\n    - cron: '0 3 * * *'\njobs: # nightly\n    w:\n        if: github.repository == 'askalf/example'\n        runs-on: [self-hosted, example-exec]\n        steps:\n            - run: echo\n" }))).length === 0);
  check('a matrix of GitHub\'s runners read through an expression passes', failing(checkCaller(variant({ 'ci.yml': (y) => `${y}\n  extra:\n    strategy:\n      matrix:\n        runner:\n          - ubuntu-latest\n          - windows-latest\n    runs-on: \${{ matrix.runner }}\n    steps:\n      - run: echo\n` }))).length === 0);
  check('this repository\'s other label (example-build) is its own', failing(checkCaller(variant({ 'nightly.yml': () => `name: nightly\non:\n  schedule:\n    - cron: '0 3 * * *'\njobs:\n${job('n', "    if: github.repository == 'askalf/example'\n    runs-on: [self-hosted, example-build]\n")}` }))).length === 0);
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
  ['another repository\'s runner label', { 'ci.yml': (y) => y.replace('fromJSON(\'["self-hosted","example-exec"]\') }}\n    steps:\n      - run: echo test', 'fromJSON(\'["self-hosted","other-exec"]\') }}\n    steps:\n      - run: echo test') }, /this repository's own \(not: ci\.yml test: other-exec\)/],
  ['another repository\'s label in a quoted flow list', { 'ci.yml': (y) => `${y}${job('extra', "    runs-on: ['self-hosted', 'other-exec']\n")}` }, /this repository's own \(not: ci\.yml extra: other-exec\)/],
  ['another repository\'s label in a block list', { 'ci.yml': (y) => `${y}${job('extra', '    runs-on:\n      - self-hosted\n      - other-exec\n')}` }, /this repository's own \(not: ci\.yml extra: other-exec\)/],
  ['another repository\'s label under labels:', { 'ci.yml': (y) => `${y}${job('extra', '    runs-on:\n      group: ours\n      labels: [self-hosted, other-exec]\n')}` }, /this repository's own \(not: ci\.yml extra: other-exec\)/],
  ['a fork repository sent to our runners', { 'ci.yml': (y) => y.replace("(github.repository != 'askalf/example' || github.event.pull_request", '(github.event.pull_request') }, /ci\.yml test: in a fork repository every event runs on GitHub's|not: ci\.yml test: <unreadable>/],
  ['Dependabot sent to our runners', { 'ci.yml': (y) => y.replace(" || github.event.pull_request.user.login == 'dependabot[bot]')) && 'ubuntu-latest' || fromJSON('[\"self-hosted\",\"example-exec\"]') }}\n    steps:\n      - run: echo test", ")) && 'ubuntu-latest' || fromJSON('[\"self-hosted\",\"example-exec\"]') }}\n    steps:\n      - run: echo test") }, /ci\.yml test: a Dependabot PR runs on GitHub's/],
  ['the repository-only expression on a PR job', { 'ci.yml': (y) => y.replace(/runs-on: \$\{\{ \(github\.repository != 'askalf\/example' .*\n    steps:\n      - run: echo test/, "runs-on: ${{ github.repository == 'askalf/example' && fromJSON('[\"self-hosted\",\"example-exec\"]') || 'ubuntu-latest' }}\n    steps:\n      - run: echo test") }, /ci\.yml test: only a job that never runs PR code uses it/],
  ['a literal label with no if:', { 'deploy.yml': () => `name: deploy\non:\n  push:\njobs:\n${job('d', '    runs-on: [self-hosted, example-exec]\n')}` }, /deploy\.yml d: a literal self-hosted job's if: keeps forks off/],
  ['a literal job unguarded while another job in the file is guarded', { 'ci.yml': (y) => `${y}${job('guarded', '    if: github.repository == \'askalf/example\'\n    runs-on: ubuntu-latest\n')}${job('open', '    runs-on: [self-hosted, example-exec]\n')}` }, /ci\.yml open: a literal self-hosted job's if: keeps forks, fork PRs and Dependabot PRs off/],
  ['a literal job on pull requests guarded by the repository alone', { 'ci.yml': (y) => `${y}${job('pr', "    if: github.repository == 'askalf/example'\n    runs-on: [self-hosted, example-exec]\n")}` }, /ci\.yml pr: a literal self-hosted job's if: keeps forks, fork PRs and Dependabot PRs off/],
  ['a literal job that keeps fork PRs out but lets Dependabot in', { 'ci.yml': (y) => `${y}${job('pr', '    if: github.event.pull_request.head.repo.full_name == github.repository\n    runs-on: [self-hosted, example-exec]\n')}` }, /ci\.yml pr: a literal self-hosted job's if:/],
  ['a bare self-hosted label with no if:', { 'deploy.yml': () => `name: deploy\non:\n  schedule:\n    - cron: '0 * * * *'\njobs:\n${job('d', '    runs-on: self-hosted\n')}` }, /deploy\.yml d: a literal self-hosted job's if:/],
  ['a comment on jobs: hiding an unguarded foreign runner', { 'ci.yml': (y) => `${y.replace(/^jobs:$/m, 'jobs: # build jobs')}${job('extra', '    runs-on: [self-hosted, other-exec]\n')}` }, /not: ci\.yml extra: other-exec/],
  ['four-space jobs hiding an unguarded foreign runner', { 'wide.yml': () => 'name: wide\non:\n  pull_request:\njobs:\n    w:\n        runs-on: [self-hosted, other-exec]\n        steps:\n            - run: echo\n' }, /not: wide\.yml w: other-exec/],
  ['four-space jobs hiding an unguarded literal of ours', { 'wide.yml': () => 'name: wide\non:\n  pull_request:\njobs:\n    w:\n        runs-on: [self-hosted, example-exec]\n        steps:\n            - run: echo\n' }, /wide\.yml w: a literal self-hosted job's if:/],
  ['a job written as a flow mapping', { 'ci.yml': (y) => `${y}\n  odd: { runs-on: [self-hosted, example-exec], steps: [{ run: echo }] }\n` }, /ci\.yml: every runs-on is in a job this check reads/],
  ['an expression giving the bare self-hosted label', { 'ci.yml': (y) => `${y}${job('extra', "    runs-on: ${{ 'self-hosted' }}\n")}` }, /ci\.yml extra: only a job that never runs PR code uses it/],
  ['an expression reading a context this check cannot see', { 'ci.yml': (y) => `${y}${job('extra', '    runs-on: ${{ vars.RUNNER }}\n')}` }, /not: ci\.yml extra: <unreadable>/],
  ['an expression reading a matrix key the job does not define', { 'ci.yml': (y) => `${y}${job('extra', '    runs-on: ${{ matrix.runner }}\n')}` }, /not: ci\.yml extra: <unreadable>/],
  ['a matrix value that is itself an expression', { 'ci.yml': (y) => `${y}\n  extra:\n    strategy:\n      matrix:\n        runner: \${{ fromJSON(vars.RUNNERS) }}\n    runs-on: \${{ matrix.runner }}\n    steps:\n      - run: echo\n` }, /not: ci\.yml extra: <unreadable>/],
  ['a matrix that lists a self-hosted runner', { 'ci.yml': (y) => `${y}\n  extra:\n    strategy:\n      matrix:\n        runner: [ubuntu-latest, other-exec]\n    runs-on: \${{ matrix.runner }}\n    steps:\n      - run: echo\n` }, /not: ci\.yml extra: other-exec/],
  ['a runner group with no labels', { 'ci.yml': (y) => `${y}${job('extra', '    runs-on:\n      group: big\n')}` }, /not: ci\.yml extra: <unreadable>/],
  ['a literal job guarded by a field the fork chooses', { 'ci.yml': (y) => `${y}${job('pr', "    if: github.event.pull_request.head.repo.full_name == github.repository || contains(github.event.pull_request.title, '[safe]')\n    runs-on: [self-hosted, example-exec]\n")}` }, /ci\.yml pr: a literal self-hosted job's if:/],
  ['a literal job guarded by a variable', { 'ci.yml': (y) => `${y}${job('pr', "    if: vars.SELF_HOSTED == 'on'\n    runs-on: [self-hosted, example-exec]\n")}` }, /ci\.yml pr: a literal self-hosted job's if:/],
  ['a runner expression that a fork\'s title steers', { 'ci.yml': (y) => `${y}${job('extra', "    runs-on: \${{ contains(github.event.pull_request.title, '[hosted]') && 'ubuntu-latest' || fromJSON('[\"self-hosted\",\"example-exec\"]') }}\n")}` }, /not: ci\.yml extra: <unreadable>/],
  ['a matrix include that adds a self-hosted runner', { 'ci.yml': (y) => `${y}\n  extra:\n    strategy:\n      matrix:\n        runner: [ubuntu-latest]\n        include:\n          - runner: self-hosted\n    runs-on: \${{ matrix.runner }}\n    steps:\n      - run: echo\n` }, /ci\.yml extra: only a job that never runs PR code uses it/],
  ['a matrix include written as a flow mapping', { 'ci.yml': (y) => `${y}\n  extra:\n    strategy:\n      matrix:\n        runner: [ubuntu-latest]\n        include:\n          - { runner: other-exec }\n    runs-on: \${{ matrix.runner }}\n    steps:\n      - run: echo\n` }, /not: ci\.yml extra: <unreadable>/],
  ['a non-os matrix key that sends one combination to our runners', { 'ci.yml': (y) => y.replace("    runs-on: ${{ (github.repository != 'askalf/example'", "    strategy:\n      matrix:\n        variant: [safe, unsafe]\n    runs-on: ${{ matrix.variant == 'unsafe' && fromJSON('[\"self-hosted\",\"example-exec\"]') || (github.repository != 'askalf/example'") }, /ci\.yml test: only a job that never runs PR code uses it/],
  ['a literal guard that loose comparison makes true', { 'ci.yml': (y) => `${y}${job('pr', "    if: github.repository == 'askalf/example' && null == ''\n    runs-on: [self-hosted, example-exec]\n")}` }, /ci\.yml pr: a literal self-hosted job's if:/],
  ['a boolean matrix value that sends a fork PR to our runners', { 'ci.yml': (y) => `${y}\n  extra:\n    strategy:\n      matrix:\n        flag: [false]\n    runs-on: \${{ matrix.flag && 'ubuntu-latest' || fromJSON('["self-hosted","example-exec"]') }}\n    steps:\n      - run: echo\n` }, /ci\.yml extra: only a job that never runs PR code uses it/],
  ['a block-list boolean matrix value that sends a fork PR to our runners', { 'ci.yml': (y) => `${y}\n  extra:\n    strategy:\n      matrix:\n        flag:\n          - false\n    runs-on: \${{ matrix.flag && 'ubuntu-latest' || fromJSON('["self-hosted","example-exec"]') }}\n    steps:\n      - run: echo\n` }, /ci\.yml extra: only a job that never runs PR code uses it/],
  ['two include entries that together send a fork PR to our runners', { 'ci.yml': (y) => `${y}\n  extra:\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n        include:\n          - a: 'yes'\n          - b: 'yes'\n    runs-on: \${{ matrix.a == 'yes' && matrix.b == 'yes' && fromJSON('["self-hosted","example-exec"]') || 'ubuntu-latest' }}\n    steps:\n      - run: echo\n` }, /ci\.yml extra: only a job that never runs PR code uses it/],
  ['a matrix value YAML versions read differently', { 'ci.yml': (y) => `${y}\n  extra:\n    strategy:\n      matrix:\n        flag: [no]\n    runs-on: \${{ matrix.flag && 'ubuntu-latest' || fromJSON('["self-hosted","example-exec"]') }}\n    steps:\n      - run: echo\n` }, /not: ci\.yml extra: <unreadable>/],
  ['an include entry with a nested value', { 'ci.yml': (y) => `${y}\n  extra:\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n        include:\n          - os: ubuntu-latest\n            cfg:\n              runner: other-exec\n    runs-on: \${{ matrix.os }}\n    steps:\n      - run: echo\n` }, /not: ci\.yml extra: <unreadable>/],
  ['a quoted on: key hiding a PR trigger', { 'pr.yml': () => `name: pr\n'on':\n  pull_request:\njobs:\n${job('p', "    if: github.repository == 'askalf/example'\n    runs-on: [self-hosted, example-exec]\n")}` }, /pr\.yml: is in the YAML subset this check reads \(not line 2\)/],
  ['an if: whose next line continues it', { 'ci.yml': (y) => `${y}${job('pr', "    if: github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.login != 'dependabot[bot]' && github.repository == 'askalf/example'\n      || github.event_name == 'pull_request'\n    runs-on: [self-hosted, example-exec]\n")}` }, /ci\.yml: is in the YAML subset this check reads/],
  ['an if: in a quoted string over two lines', { 'ci.yml': (y) => `${y}${job('pr', "    if: \"github.repository == 'askalf/example'\n      || true\"\n    runs-on: [self-hosted, example-exec]\n")}` }, /ci\.yml: is in the YAML subset this check reads/],
  ['a literal guard that lets one outside author in', { 'ci.yml': (y) => `${y}${job('pr', "    if: github.repository == 'askalf/example' && github.event.pull_request.user.login == 'contributor'\n    runs-on: [self-hosted, example-exec]\n")}` }, /ci\.yml pr: a literal self-hosted job's if: keeps forks, fork PRs and Dependabot PRs off/],
  ['a literal guard that lets one fork repository in', { 'ci.yml': (y) => `${y}${job('pr', "    if: github.repository == 'askalf/example' && (github.event.pull_request.head.repo.full_name == github.repository || github.event.pull_request.head.repo.full_name == 'someone/example') && github.event.pull_request.user.login != 'dependabot[bot]'\n    runs-on: [self-hosted, example-exec]\n")}` }, /ci\.yml pr: a literal self-hosted job's if: keeps forks, fork PRs and Dependabot PRs off/],
  ['a runner expression that sends one outside author to our runners', { 'ci.yml': (y) => y.replace("    runs-on: ${{ (github.repository != 'askalf/example'", "    runs-on: ${{ github.event.pull_request.user.login == 'contributor' && fromJSON('[\"self-hosted\",\"example-exec\"]') || (github.repository != 'askalf/example'") }, /not: ci\.yml test: <unreadable>/],
  ['a literal guard on a github field the scenarios do not supply', { 'ci.yml': (y) => `${y}${job('pr', "    if: github.repository == 'askalf/example' && github.actor == 'contributor'\n    runs-on: [self-hosted, example-exec]\n")}` }, /ci\.yml pr: a literal self-hosted job's if:/],
  ['a literal job guarded only by failure() after another job', { 'ci.yml': (y) => `${y}${job('after', '    needs: test\n    if: failure()\n    runs-on: [self-hosted, example-exec]\n')}` }, /ci\.yml after: a literal self-hosted job's if:/],
  ['a literal job guarded only by cancelled()', { 'ci.yml': (y) => `${y}${job('after', '    needs: test\n    if: cancelled() && github.repository == \'askalf/example\'\n    runs-on: [self-hosted, example-exec]\n')}` }, /ci\.yml after: a literal self-hosted job's if:/],
  ['a called workflow guarded by the repository alone', { 'called.yml': () => `name: called\non:\n  workflow_call:\njobs:\n${job('c', "    if: github.repository == 'askalf/example'\n    runs-on: [self-hosted, example-exec]\n")}` }, /called\.yml c: a literal self-hosted job's if: keeps forks, fork PRs and Dependabot PRs off/],
  ['a runs-on alias', { 'ci.yml': (y) => `${y}${job('extra', '    runs-on: *ours\n')}` }, /not: ci\.yml extra: <unreadable>/],
  ['the status action without the PR number', { [STATUS]: (y) => y.replace(/\n {10}pr: .*/, '') }, /gets the PR number/],
  ['the status action with the comment path dropped from the PR number', { [STATUS]: (y) => y.replace(' || github.event.issue.number', '') }, /gets the PR number/],
  ['the status action as a dry run', { [STATUS]: (y) => y.replace('          head-branch:', "          dry-run: 'true'\n          head-branch:") }, /no dry-run/],
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
