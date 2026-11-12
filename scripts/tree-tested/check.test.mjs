// Tests for scripts/tree-tested/check.mjs. Run: node scripts/tree-tested/check.test.mjs
// GitHub is stubbed through io.fetch; nothing leaves the machine.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factsOf, notEligible, mergedAs, runAtHead, jobsProblem, contains, decide, main } from './check.mjs';

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
const PARENT = 'e'.repeat(40);
const env = (o = {}) => ({
  GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: SHA,
  GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/ci.yml@refs/heads/main`, DEFAULT_BRANCH: 'main', GITHUB_TOKEN: 't', ...o,
});
const pr = (o = {}) => ({ number: 7, merged_at: '2026-11-12T00:00:00Z', merge_commit_sha: SHA, base: { repo: { full_name: REPO } }, head: { sha: HEAD }, ...o });
const run = (o = {}) => ({ id: 900, event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: HEAD, created_at: '2026-11-11T23:00:00Z', html_url: 'https://x/run/900', pull_requests: [{ number: 7 }], ...o });
const step = (name, conclusion = 'success') => ({ name, conclusion, status: 'completed' });
const job = (name, conclusion = 'success', steps = [step('Set up job'), step('Test'), step('Complete job')]) => ({ name, conclusion, status: 'completed', steps });

/** A fake GitHub. routes: path (no query) -> body, an HTTP status, or a function of the url. */
function world(over = {}) {
  const routes = {
    [`/repos/${REPO}/commits/${SHA}/pulls`]: [pr()],
    [`/repos/${REPO}/git/commits/${SHA}`]: { tree: { sha: TREE }, parents: [{ sha: PARENT }] },
    [`/repos/${REPO}/compare/${PARENT}...${HEAD}`]: { status: 'ahead' },
    [`/repos/${REPO}/git/commits/${HEAD}`]: { tree: { sha: TREE } },
    [`/repos/${REPO}/actions/workflows/ci.yml/runs`]: { workflow_runs: [run()] },
    [`/repos/${REPO}/actions/runs/900/jobs`]: { total_count: 2, jobs: [job('unit'), job('e2e')] },
    ...over,
  };
  const calls = [];
  const fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    let body = routes[u.pathname];
    if (typeof body === 'function') body = body(u);
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (typeof body === 'number') return { ok: body < 300, status: body, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetch, calls };
}

console.log('\n  the facts and who is looked up');
{
  const f = factsOf(env());
  check('the workflow file is read from GITHUB_WORKFLOW_REF', f.workflowFile === 'ci.yml' && f.sha === SHA);
  check('a push to the default branch is eligible', notEligible(f) === '');
  check('a pull request run is tested in full', /tested in full/.test(notEligible(factsOf(env({ GITHUB_EVENT_NAME: 'pull_request' })))));
  check('a push to another branch is tested in full', /only a push to the default branch/.test(notEligible(factsOf(env({ GITHUB_REF: 'refs/heads/feature' })))));
  check('a schedule, a dispatch and a missing event are tested in full',
    ['schedule', 'workflow_dispatch', ''].every((e) => notEligible(factsOf(env({ GITHUB_EVENT_NAME: e }))) !== ''));
  check('no default branch, a short sha, a bad repository or no workflow ref is tested in full',
    [{ DEFAULT_BRANCH: '' }, { GITHUB_SHA: 'abc' }, { GITHUB_REPOSITORY: 'nope' }, { GITHUB_WORKFLOW_REF: 'x' }].every((o) => notEligible(factsOf(env(o))) !== ''));
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
  check('main before the merge is inside the head when the head is ahead of it or the same',
    contains({ status: 'ahead' }) && contains({ status: 'identical' }) && !contains({ status: 'behind' }) && !contains({ status: 'diverged' }) && !contains(null));
  check('a skipped, failed or cancelled job, or no job at all, does not',
    /e2e: skipped/.test(jobsProblem([job('a'), job('e2e', 'skipped')])) && jobsProblem([job('a', 'failure')]) !== '' && jobsProblem([job('a', 'cancelled')]) !== '' && jobsProblem([]) !== '');
}

console.log('\n  the decision against a stubbed GitHub');
{
  const w = world();
  const d = await decide(env(), w);
  check('same tree, a green run with every job green: tested', d.tested === true && d.run === 'https://x/run/900');
  check('it asks for the runs at the head, of pull_request, of this workflow file',
    w.calls.some((c) => c.startsWith(`/repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${HEAD}&event=pull_request`)));
  check('and for the latest attempt\'s jobs', w.calls.some((c) => c === `/repos/${REPO}/actions/runs/900/jobs?filter=latest&per_page=100&page=1`));
  check('it compares main before the merge with the head', w.calls.includes(`/repos/${REPO}/compare/${PARENT}...${HEAD}`));
}
for (const [name, over, re] of [
  ['a direct push (no merged pull request)', { [`/repos/${REPO}/commits/${SHA}/pulls`]: [] }, /direct push/],
  ['main had moved: another tree', { [`/repos/${REPO}/git/commits/${HEAD}`]: { tree: { sha: OTHER } } }, /another tree/],
  ['no run at the head', { [`/repos/${REPO}/actions/workflows/ci.yml/runs`]: { workflow_runs: [] } }, /no finished pull_request run/],
  ['the run at the head failed', { [`/repos/${REPO}/actions/workflows/ci.yml/runs`]: { workflow_runs: [run({ conclusion: 'failure' })] } }, /ended failure/],
  ['a job there was skipped', { [`/repos/${REPO}/actions/runs/900/jobs`]: { total_count: 2, jobs: [job('unit'), job('e2e ui', 'skipped')] } }, /e2e ui: skipped/],
  ['a step there was skipped in a green job', { [`/repos/${REPO}/actions/runs/900/jobs`]: { total_count: 1, jobs: [job('unit', 'success', [step('Set up job'), step('Integration tests', 'skipped')])] } }, /Integration tests skipped/],
  // Main gained a change and reverted it between the run and the merge: the head's tree is on main,
  // but the head never held main as it was, so the run tested the head merged with that change.
  ['main changed and reverted after the run (the head does not hold main)', { [`/repos/${REPO}/compare/${PARENT}...${HEAD}`]: { status: 'diverged' } }, /is not inside #7's head .*diverged.*not known/],
  ['the head is behind main before the merge', { [`/repos/${REPO}/compare/${PARENT}...${HEAD}`]: { status: 'behind' } }, /not inside/],
  ['the compare cannot be read', { [`/repos/${REPO}/compare/${PARENT}...${HEAD}`]: 500 }, /HTTP 500/],
  ['the pushed commit names no parent', { [`/repos/${REPO}/git/commits/${SHA}`]: { tree: { sha: TREE }, parents: [] } }, /names no parent/],
  ['fewer jobs read than the run counts', { [`/repos/${REPO}/actions/runs/900/jobs`]: { total_count: 3, jobs: [job('unit'), job('e2e')] } }, /read 2 of the run's 3 jobs/],
  ['the pull request list cannot be read', { [`/repos/${REPO}/commits/${SHA}/pulls`]: 500 }, /HTTP 500; tested in full/],
  ['a commit cannot be read', { [`/repos/${REPO}/git/commits/${HEAD}`]: 502 }, /HTTP 502/],
  ['the jobs cannot be read', { [`/repos/${REPO}/actions/runs/900/jobs`]: 403 }, /HTTP 403/],
  ['a commit with no tree', { [`/repos/${REPO}/git/commits/${SHA}`]: {} }, /another tree/],
]) {
  const d = await decide(env(), world(over));
  check(`${name}: tested in full`, d.tested === false && re.test(d.why));
}
{
  const w = world();
  const d = await decide(env({ GITHUB_EVENT_NAME: 'pull_request' }), w);
  check('a pull request run makes no request at all', d.tested === false && w.calls.length === 0);
  const thrown = await decide(env(), { fetch: async () => { throw new Error('network down'); } });
  check('a fetch that throws is tested in full', thrown.tested === false && /network down; tested in full/.test(thrown.why));
}

console.log('\n  every page of jobs is read');
{
  const page1 = Array.from({ length: 100 }, (_, i) => job(`shard ${i}`));
  const jobsRoute = (rest) => (u) => (u.searchParams.get('page') === '1' ? { total_count: 100 + rest.length, jobs: page1 } : { total_count: 100 + rest.length, jobs: rest });
  const skipped = await decide(env(), world({ [`/repos/${REPO}/actions/runs/900/jobs`]: jobsRoute([job('last', 'skipped')]) }));
  check('a skipped job past the first hundred is found: tested in full', skipped.tested === false && /last: skipped/.test(skipped.why));
  const w = world({ [`/repos/${REPO}/actions/runs/900/jobs`]: jobsRoute([job('last')]) });
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
