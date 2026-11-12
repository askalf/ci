// Tests for scripts/tree-tested/check.mjs. Run: node scripts/tree-tested/check.test.mjs
// GitHub is stubbed through io.fetch; nothing leaves the machine.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factsOf, notEligible, mergedAs, runAtHead, jobsProblem, contains, thisJob, checkoutMerge, decide, main } from './check.mjs';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}`); fail++; }
}

const REPO = 'askalf/demo';
const SHA = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const BASE = 'e'.repeat(40);
const RELEASE = 'f'.repeat(40);
const RUN_ID = '555';
const env = (o = {}) => ({
  GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: SHA,
  GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/ci.yml@refs/heads/main`, DEFAULT_BRANCH: 'main', GITHUB_TOKEN: 't',
  GITHUB_RUN_ID: RUN_ID, RUNNER_NAME: 'pool-e3', SAME_ON_PULL_REQUEST: 'true', ...o,
});
const pr = (o = {}) => ({ number: 7, merged_at: '2026-11-12T00:00:00Z', merge_commit_sha: SHA, base: { repo: { full_name: REPO } }, head: { sha: HEAD }, ...o });
const run = (o = {}) => ({ id: 900, event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: HEAD, created_at: '2026-11-11T23:00:00Z', html_url: 'https://x/run/900', pull_requests: [], ...o });
const step = (name, conclusion = 'success') => ({ name, conclusion, status: 'completed' });
let jobIds = 1000;
const job = (name, conclusion = 'success', steps = [step('Set up job'), step('Test'), step('Complete job')]) => ({ id: jobIds++, name, conclusion, status: 'completed', steps });
const mine = (name, runner = 'pool-e3') => ({ id: 1, name, status: 'in_progress', runner_name: runner });
// A job log as GitHub writes it: each step opens with "##[group]Run <step>".
const T = '2026-11-12T02:58:14.1195074Z ';
const checkoutStep = (head = HEAD, base = BASE) => [`${T}##[group]Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1`, `${T}with:`, `${T}##[endgroup]`,
  `${T}##[group]Checking out the ref`, `${T}HEAD is now at 25a09da Merge ${head} into ${base}`, `${T}##[endgroup]`];
const testStep = (out = 'tests pass') => [`${T}##[group]Run npm test`, `${T}npm test`, `${T}##[endgroup]`, `${T}${out}`];
const checkoutLog = (head = HEAD, base = BASE) => [`${T}##[group]Run askalf/ci/actions/checkout-with-retry@${'1'.repeat(40)}`, `${T}##[endgroup]`, ...checkoutStep(head, base), ...testStep()].join('\n') + '\n';

/** A fake GitHub. routes: path (no query) -> body, an HTTP status, text, or a function of the url. */
function world(over = {}) {
  const prJobs = [job('unit'), job('e2e')];
  const routes = {
    [`/repos/${REPO}/commits/${SHA}/pulls`]: [pr()],
    [`/repos/${REPO}/git/commits/${SHA}`]: { tree: { sha: TREE } },
    [`/repos/${REPO}/git/commits/${HEAD}`]: { tree: { sha: TREE } },
    [`/repos/${REPO}/actions/workflows/ci.yml/runs`]: { workflow_runs: [run()] },
    [`/repos/${REPO}/actions/runs/900/jobs`]: { total_count: 2, jobs: prJobs },
    [`/repos/${REPO}/actions/runs/${RUN_ID}/jobs`]: { total_count: 2, jobs: [mine('unit'), { id: 2, name: 'e2e', status: 'queued' }] },
    [`/repos/${REPO}/compare/${BASE}...${HEAD}`]: { status: 'ahead' },
    ...over,
  };
  if (!('LOG' in routes)) routes.LOG = { text: checkoutLog() };
  const calls = [];
  const fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    let body = routes[u.pathname];
    if (body === undefined && /\/actions\/jobs\/\d+\/logs$/.test(u.pathname)) body = routes.LOG;
    if (typeof body === 'function') body = body(u);
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    if (typeof body === 'number') return { ok: body < 300, status: body, json: async () => ({}), text: async () => '' };
    if (body && typeof body.text === 'string') return { ok: true, status: 200, json: async () => ({}), text: async () => body.text };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls, prJobs };
}

console.log('\n  the facts and who is looked up');
{
  const f = factsOf(env());
  check('the workflow file, run id, runner and the caller\'s word are read from the environment', f.workflowFile === 'ci.yml' && f.sha === SHA && f.runId === RUN_ID && f.runnerName === 'pool-e3' && f.declared === 'true');
  check('without the caller\'s word that the job is the same on push, nothing is skipped',
    ['', 'false', 'yes', 'TRUE'].every((v) => /has not declared this job the same/.test(notEligible(factsOf(env({ SAME_ON_PULL_REQUEST: v }))))));
  check('a push to the default branch is eligible', notEligible(f) === '');
  check('a pull request run is tested in full', /tested in full/.test(notEligible(factsOf(env({ GITHUB_EVENT_NAME: 'pull_request' })))));
  check('a push to another branch is tested in full', /only a push to the default branch/.test(notEligible(factsOf(env({ GITHUB_REF: 'refs/heads/feature' })))));
  check('a schedule, a dispatch and a missing event are tested in full',
    ['schedule', 'workflow_dispatch', ''].every((e) => notEligible(factsOf(env({ GITHUB_EVENT_NAME: e }))) !== ''));
  check('no default branch, a short sha, a bad repository, no workflow ref, no run id or no runner is tested in full',
    [{ DEFAULT_BRANCH: '' }, { GITHUB_SHA: 'abc' }, { GITHUB_REPOSITORY: 'nope' }, { GITHUB_WORKFLOW_REF: 'x' }, { GITHUB_RUN_ID: 'x' }, { RUNNER_NAME: '' }]
      .every((o) => notEligible(factsOf(env(o))) !== ''));
}

console.log('\n  the pure rules');
{
  check('the pull request merged as this commit is found', mergedAs([pr({ number: 3, merge_commit_sha: OTHER }), pr()], REPO, SHA)?.number === 7);
  check('an open, unmerged or other repository\'s pull request is not',
    mergedAs([pr({ merged_at: null }), pr({ base: { repo: { full_name: 'x/y' } } }), pr({ head: { sha: 'short' } })], REPO, SHA) === null && mergedAs(null, REPO, SHA) === null);
  const older = run({ id: 1, created_at: '2026-11-11T20:00:00Z', conclusion: 'failure' });
  check('the newest finished pull_request run at the head is the one read', runAtHead([older, run()], { head: HEAD, number: 7 })?.id === 900);
  check('a push run, a run in progress, another head and another pull request\'s run are not',
    runAtHead([run({ event: 'push' }), run({ status: 'in_progress' }), run({ head_sha: OTHER }), run({ pull_requests: [{ number: 8 }] })], { head: HEAD, number: 7 }) === null);
  check('every job and every step passed reads as tested', jobsProblem([job('a'), job('b')]) === '');
  check('a green job with a skipped step does not: a step that runs only on push did not run there',
    /integration skipped/.test(jobsProblem([job('a', 'success', [step('Set up job'), step('integration', 'skipped'), step('Complete job')])])));
  check('a green job with no steps listed does not', /lists no steps/.test(jobsProblem([{ name: 'a', conclusion: 'success' }])) && /lists no steps/.test(jobsProblem([job('a', 'success', [])])));
  check('a skipped, failed or cancelled job, or no job at all, does not',
    /e2e: skipped/.test(jobsProblem([job('a'), job('e2e', 'skipped')])) && jobsProblem([job('a', 'failure')]) !== '' && jobsProblem([job('a', 'cancelled')]) !== '' && jobsProblem([]) !== '');
  check('a base is inside the head when the head is ahead of it or the same',
    contains({ status: 'ahead' }) && contains({ status: 'identical' }) && !contains({ status: 'behind' }) && !contains({ status: 'diverged' }) && !contains(null));
  check('this job is the one in progress on this runner, and only when there is one',
    thisJob([mine('a', 'other'), mine('b'), { name: 'c', status: 'queued', runner_name: 'pool-e3' }], 'pool-e3')?.name === 'b'
      && thisJob([mine('a'), mine('b')], 'pool-e3') === null && thisJob([], 'pool-e3') === null);
  check('the merge the one checkout made is read from its step', JSON.stringify(checkoutMerge(checkoutLog())) === JSON.stringify({ head: HEAD, base: BASE }));
  const lines = (...parts) => parts.flat().join('\n');
  // A merge checkout, then a step that checks out an older ordinary commit before the tests.
  check('a later checkout of another commit, even by hand, is caught: two "HEAD is now at" lines',
    /2 "HEAD is now at" lines/.test(checkoutMerge(lines(checkoutStep(), [`${T}##[group]Run git checkout ${OTHER}`, `${T}##[endgroup]`, `${T}HEAD is now at ddddddd an older commit`], testStep())).why));
  check('a second actions/checkout step is not taken', /2 actions\/checkout steps/.test(checkoutMerge(lines(checkoutStep(), checkoutStep(), testStep())).why));
  check('a merge line printed by a test, outside the checkout, is not taken',
    /not in the checkout step/.test(checkoutMerge(lines([`${T}##[group]Run actions/checkout@${'2'.repeat(40)}`, `${T}##[endgroup]`], testStep(`HEAD is now at 25a09da Merge ${HEAD} into ${BASE}`))).why));
  check('a checkout of the head itself, not a merge, is not taken',
    /did not check out a pull request merge/.test(checkoutMerge(lines([`${T}##[group]Run actions/checkout@${'2'.repeat(40)}`, `${T}HEAD is now at bbbbbbb the head commit`], testStep())).why));
  check('no checkout at all is not taken', /0 actions\/checkout steps/.test(checkoutMerge(lines(testStep())).why) && /0 actions\/checkout steps/.test(checkoutMerge('').why));
}

console.log('\n  the decision against a stubbed GitHub');
{
  const w = world();
  const d = await decide(env(), w);
  check('same tree, every job and step green, this job there, and its checkout a merge of the head into a base it holds: tested', d.tested === true && d.run === 'https://x/run/900');
  check('it asks for the runs at the head, of pull_request, of this workflow file',
    w.calls.some((c) => c.startsWith(`/repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${HEAD}&event=pull_request`)));
  check('it reads both runs\' jobs, every page, the latest attempt',
    w.calls.includes(`/repos/${REPO}/actions/runs/900/jobs?filter=latest&per_page=100&page=1`) && w.calls.includes(`/repos/${REPO}/actions/runs/${RUN_ID}/jobs?filter=latest&per_page=100&page=1`));
  check('it reads the log of the job of the same name there, and compares its base with the head',
    w.calls.includes(`/repos/${REPO}/actions/jobs/${w.prJobs[0].id}/logs`) && w.calls.includes(`/repos/${REPO}/compare/${BASE}...${HEAD}`));
}
for (const [name, over, re, envOver] of [
  ['a direct push (no merged pull request)', { [`/repos/${REPO}/commits/${SHA}/pulls`]: [] }, /direct push/],
  ['main had moved: another tree', { [`/repos/${REPO}/git/commits/${HEAD}`]: { tree: { sha: OTHER } } }, /another tree/],
  ['no run at the head', { [`/repos/${REPO}/actions/workflows/ci.yml/runs`]: { workflow_runs: [] } }, /no finished pull_request run/],
  ['the run at the head failed', { [`/repos/${REPO}/actions/workflows/ci.yml/runs`]: { workflow_runs: [run({ conclusion: 'failure' })] } }, /ended failure/],
  ['a job there was skipped', { [`/repos/${REPO}/actions/runs/900/jobs`]: { total_count: 2, jobs: [job('unit'), job('e2e ui', 'skipped')] } }, /e2e ui: skipped/],
  ['a step there was skipped in a green job', { [`/repos/${REPO}/actions/runs/900/jobs`]: { total_count: 1, jobs: [job('unit', 'success', [step('Set up job'), step('Integration tests', 'skipped')])] } }, /Integration tests skipped/],
  ['fewer jobs read than the run counts', { [`/repos/${REPO}/actions/runs/900/jobs`]: { total_count: 3, jobs: [job('unit'), job('e2e')] } }, /read 2 of run 900's 3 jobs/],
  // A matrix that a push expands wider than a pull request: this job never ran there.
  ['this job is a push-only matrix entry the pull request never ran',
    { [`/repos/${REPO}/actions/runs/${RUN_ID}/jobs`]: { total_count: 1, jobs: [mine('test (windows)')] } }, /"test \(windows\)" is not a job in .*did not run it/],
  ['this job is not found in its own run', { [`/repos/${REPO}/actions/runs/${RUN_ID}/jobs`]: { total_count: 1, jobs: [mine('unit', 'someone-else')] } }, /not found in run 555/],
  ['this run\'s jobs cannot be read', { [`/repos/${REPO}/actions/runs/${RUN_ID}/jobs`]: 500 }, /HTTP 500/],
  ['the log shows no checkout', { LOG: { text: 'no checkout line\n' } }, /0 actions\/checkout steps, not one; what it tested is not known/],
  ['the log shows a merge checkout and then another checkout', { LOG: { text: checkoutLog() + checkoutLog(HEAD, RELEASE) } }, /2 actions\/checkout steps/],
  // A matrix whose entries share one display name, wider on push: the job asking cannot be matched.
  ['two jobs of this run share the display name of the job asking (a wider push matrix under name: test)',
    { [`/repos/${REPO}/actions/runs/${RUN_ID}/jobs`]: { total_count: 2, jobs: [mine('unit'), { id: 3, name: 'unit', status: 'queued' }] } }, /2 jobs of this run are named "unit"/],
  ['the caller has not declared the job the same on push', {}, /has not declared/, { SAME_ON_PULL_REQUEST: '' }],
  ['the log shows a merge of another head', { LOG: { text: checkoutLog(OTHER, BASE) } }, /merge of ddddddd, not of #7's head/],
  // Tested against a release branch, then retargeted to main with no new run: the base it merged
  // is not in the head, so the job tested the head plus that branch, not the pushed tree.
  ['the run tested a merge into a base the head does not hold (a retarget after the run)',
    { LOG: { text: checkoutLog(HEAD, RELEASE) }, [`/repos/${REPO}/compare/${RELEASE}...${HEAD}`]: { status: 'diverged' } }, /merged into fffffff, which the head does not hold \(diverged\)/],
  // Main gained a change and reverted it between the run and the merge: the run merged the head
  // into main with that change, a base the head does not hold.
  ['main changed and reverted after the run', { [`/repos/${REPO}/compare/${BASE}...${HEAD}`]: { status: 'diverged' } }, /does not hold/],
  ['the log cannot be read', { LOG: 410 }, /HTTP 410/],
  ['the compare cannot be read', { [`/repos/${REPO}/compare/${BASE}...${HEAD}`]: 500 }, /HTTP 500/],
  ['the pull request list cannot be read', { [`/repos/${REPO}/commits/${SHA}/pulls`]: 500 }, /HTTP 500; tested in full/],
  ['a commit cannot be read', { [`/repos/${REPO}/git/commits/${HEAD}`]: 502 }, /HTTP 502/],
  ['a commit with no tree', { [`/repos/${REPO}/git/commits/${SHA}`]: {} }, /another tree/],
]) {
  const d = await decide(env(envOver ?? {}), world(over));
  check(`${name}: tested in full`, d.tested === false && re.test(d.why));
}
{
  const same = await decide(env(), world({ LOG: { text: checkoutLog(HEAD, HEAD) }, [`/repos/${REPO}/compare/${HEAD}...${HEAD}`]: { status: 'identical' } }));
  check('a base that is the head itself counts as held', same.tested === true);
  const w2 = world();
  const p = await decide(env({ GITHUB_EVENT_NAME: 'pull_request' }), w2);
  check('a pull request run makes no request at all', p.tested === false && w2.calls.length === 0);
  const thrown = await decide(env(), { fetch: async () => { throw new Error('network down'); } });
  check('a fetch that throws is tested in full', thrown.tested === false && /network down; tested in full/.test(thrown.why));
}

console.log('\n  every page of jobs is read');
{
  const page1 = Array.from({ length: 100 }, (_, i) => job(`shard ${i}`));
  const jobsRoute = (rest) => (u) => (u.searchParams.get('page') === '1' ? { total_count: 100 + rest.length, jobs: page1 } : { total_count: 100 + rest.length, jobs: rest });
  const skipped = await decide(env(), world({ [`/repos/${REPO}/actions/runs/900/jobs`]: jobsRoute([job('last', 'skipped')]) }));
  check('a skipped job past the first hundred is found: tested in full', skipped.tested === false && /last: skipped/.test(skipped.why));
  const w = world({
    [`/repos/${REPO}/actions/runs/900/jobs`]: jobsRoute([job('last')]),
    [`/repos/${REPO}/actions/runs/${RUN_ID}/jobs`]: { total_count: 1, jobs: [mine('shard 0')] },
    LOG: { text: checkoutLog() },
  });
  const green = await decide(env(), w);
  check('a hundred and one green jobs, read over two pages: tested', green.tested === true && w.calls.some((c) => c.endsWith('&page=2')));
  const endless = await decide(env(), world({ [`/repos/${REPO}/actions/runs/900/jobs`]: () => ({ jobs: page1 }) }));
  check('a run that never ends its pages is not read past the cap', endless.tested === false && /more than 500 jobs/.test(endless.why));
}

console.log('\n  main: the step output and the line it prints');
{
  const dir = mkdtempSync(join(tmpdir(), 'tree-tested-'));
  const out = join(dir, 'out');
  const lines = [];
  const code = await main({ ...env(), GITHUB_OUTPUT: out }, { fetch: world().fetch, log: (l) => lines.push(l) });
  check('tested: the output says so and names the run, and the step passes',
    code === 0 && readFileSync(out, 'utf8') === 'tested=true\nrun=https://x/run/900\n' && /^::notice::this tree already passed/.test(lines[0]));
  const out2 = join(dir, 'out2');
  const code2 = await main({ ...env({ GITHUB_EVENT_NAME: 'pull_request' }), GITHUB_OUTPUT: out2 }, { fetch: world().fetch, log: (l) => lines.push(l) });
  check('not tested: tested=false, an empty run, and the step still passes',
    code2 === 0 && readFileSync(out2, 'utf8') === 'tested=false\nrun=\n' && /^tested in full: a pull_request/.test(lines[1]));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
