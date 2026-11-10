// Unit tests for check.mjs, and its main() and the action's entry against a stubbed network.
// Run: node scripts/scorecard-publish/check.test.mjs

import { runOf, notChecked, isPublished, onUnpublished, readServed, main, API, READS, READ_WAIT_MS, SKEW_MS } from './check.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}`); fail++; }
}

const STARTED = '2026-11-09T10:25:21Z';
const event = (over = {}, repo = {}) => ({
  workflow_run: { id: 42, event: 'schedule', conclusion: 'success', head_branch: 'main', run_started_at: STARTED, path: '.github/workflows/scorecard.yml', ...over },
  repository: { default_branch: 'main', private: false, ...repo },
});

console.log('\n  which runs are checked');
{
  const run = runOf(event());
  check('a workflow_run event gives the facts', run.id === 42 && run.event === 'schedule' && run.headBranch === 'main' && run.workflowFile === 'scorecard.yml' && run.defaultBranch === 'main' && run.isPrivate === false);
  check('a successful run on the default branch of a public repository is checked', notChecked(run) === '');
  check('an event that is no workflow_run is not', notChecked(runOf({})) !== '' && notChecked(runOf(null)) !== '' && runOf({ workflow_run: 'x' }) === null);
  check('a failed or cancelled run is not: its own status says so', /ended failure/.test(notChecked(runOf(event({ conclusion: 'failure' })))) && notChecked(runOf(event({ conclusion: 'cancelled' }))) !== '');
  check('a run on another branch is not', /only main publishes/.test(notChecked(runOf(event({ head_branch: 'feature' })))));
  check('a private repository is not', /private/.test(notChecked(runOf(event({}, { private: true })))));
  check('a run with no default branch or no start time is not', notChecked(runOf(event({}, { default_branch: '' }))) !== '' && notChecked(runOf(event({ run_started_at: '', created_at: '' }))) !== '');
  check('the start time falls back to created_at', runOf(event({ run_started_at: undefined, created_at: STARTED })).startedAt === STARTED);
  check('the workflow file is a plain file name under .github/workflows, or none',
    runOf(event({ path: '.github/workflows/scorecard.yaml@refs/heads/main' })).workflowFile === 'scorecard.yaml'
    && ['.github/workflows/../../x.yml', 'scorecard.yml', '.github/workflows/a/b.yml', '.github/workflows/x.yml?ref=1', ''].every((p) => runOf(event({ path: p })).workflowFile === ''));
}

console.log('\n  published or not');
{
  const run = runOf(event());
  const at = (ms) => new Date(Date.parse(STARTED) + ms).toISOString();
  check('a result dated after the run started is this run\'s', isPublished(run, { status: 200, date: at(8_000) }));
  check('a result dated within the skew before the start still is', isPublished(run, { status: 200, date: at(-SKEW_MS) }) && SKEW_MS === 60_000);
  check('an older result is not', !isPublished(run, { status: 200, date: at(-SKEW_MS - 1) }) && !isPublished(run, { status: 200, date: '2026-11-03T17:18:37Z' }));
  check('a 404, a 500, no answer and a result with no date are not', [{ status: 404, date: '' }, { status: 500, date: at(8_000) }, { status: 0, date: '' }, { status: 200, date: '' }, { status: 200, date: 'soon' }, undefined].every((s) => !isPublished(run, s)));
  check('an unpublished scheduled or push run is retried; an unpublished dispatch fails', onUnpublished(runOf(event())) === 'retry' && onUnpublished(runOf(event({ event: 'push' }))) === 'retry' && onUnpublished(runOf(event({ event: 'workflow_dispatch' }))) === 'fail');
}

// A stubbed network: scorecard.dev answers from `served` in turn (the last one repeats), GitHub's
// dispatch answers `dispatchStatus`. Every request is recorded.
function world({ served, dispatchStatus = 204, ev = event(), env = {} }) {
  const calls = [];
  const lines = [];
  const sleeps = [];
  let n = 0;
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ?? '', auth: init.headers?.authorization ?? '' });
    if (url.startsWith(API)) {
      const s = served[Math.min(n++, served.length - 1)];
      if (s === 'throw') throw new Error('connect ETIMEDOUT');
      return { status: s.status, json: async () => (s.body ?? { date: s.date }) };
    }
    if (dispatchStatus === 'throw') throw new Error('socket hang up');
    return { status: dispatchStatus, json: async () => ({}) };
  };
  const go = () => main({ REPO: 'askalf/pitlane', GITHUB_TOKEN: 'job-token', ...env }, { fetch: fetchFn, sleep: async (ms) => { sleeps.push(ms); }, log: (l) => lines.push(l), event: ev });
  return { go, calls, lines, sleeps, dispatches: () => calls.filter((c) => c.method === 'POST') };
}
const FRESH = { status: 200, date: '2026-11-09T10:25:29Z' };
const OLD = { status: 200, date: '2026-11-09T07:05:40Z' };
const GONE = { status: 404 };

console.log('\n  main');
{
  const ok = world({ served: [FRESH] });
  check('a published run: one read, no dispatch, exit 0', await ok.go() === 0 && ok.calls.length === 1 && ok.calls[0].url === `${API}/askalf/pitlane` && ok.sleeps.length === 0 && /^published: /.test(ok.lines.at(-1)));

  const late = world({ served: [GONE, GONE, FRESH] });
  check('a result that arrives on a later read is published: no dispatch', await late.go() === 0 && late.calls.length === 3 && late.dispatches().length === 0 && late.sleeps.join() === `${READ_WAIT_MS},${READ_WAIT_MS}`);

  // 2026-11-09: the run succeeded, the publish was answered 500, and scorecard.dev served 404.
  const stale = world({ served: [GONE] });
  const staleExit = await stale.go();
  const sent = stale.dispatches();
  check(`an unpublished scheduled run is read ${READS} times, then Scorecard is dispatched once on the default branch`,
    staleExit === 0 && stale.calls.filter((c) => c.method === 'GET').length === READS && READS === 4 && stale.sleeps.length === READS - 1 && sent.length === 1
    && sent[0].url === 'https://api.github.com/repos/askalf/pitlane/actions/workflows/scorecard.yml/dispatches' && sent[0].body === '{"ref":"main"}' && sent[0].auth === 'Bearer job-token');
  check('the dispatch is a warning on the run, naming what scorecard.dev served', /^::warning::Scorecard run 42 did not reach scorecard\.dev \(HTTP 404\); dispatched scorecard\.yml on main once more$/.test(stale.lines.at(-1)));

  const older = world({ served: [OLD] });
  check('an older result still served is unpublished too', await older.go() === 0 && older.dispatches().length === 1 && older.lines.some((l) => l.includes('a result dated 2026-11-09T07:05:40Z')));

  const down = world({ served: ['throw'] });
  check('scorecard.dev not answering is unpublished, not a crash', await down.go() === 0 && down.dispatches().length === 1 && down.lines.some((l) => l.includes('no answer')));

  const again = world({ served: [GONE], ev: event({ event: 'workflow_dispatch' }) });
  check('an unpublished dispatch fails the job and dispatches nothing: no loop', await again.go() === 1 && again.dispatches().length === 0 && /^::error::Scorecard run 42 was a dispatch/.test(again.lines.at(-1)));

  const retried = world({ served: [FRESH], ev: event({ event: 'workflow_dispatch' }) });
  check('a published dispatch passes', await retried.go() === 0 && retried.dispatches().length === 0);

  const dry = world({ served: [GONE], env: { DRY_RUN: 'true' } });
  check('a dry run says what it would dispatch and sends nothing', await dry.go() === 0 && dry.dispatches().length === 0 && dry.lines.at(-1) === 'dry run: would dispatch scorecard.yml on main');

  const denied = world({ served: [GONE], dispatchStatus: 403 });
  check('a refused dispatch fails the job and names the permission', await denied.go() === 1 && /HTTP 403 \(the job needs actions: write\)/.test(denied.lines.at(-1)));
  const dropped = world({ served: [GONE], dispatchStatus: 'throw' });
  check('a dispatch that cannot be sent fails the job', await dropped.go() === 1 && /could not dispatch scorecard\.yml: socket hang up/.test(dropped.lines.at(-1)));

  const noFile = world({ served: [GONE], ev: event({ path: 'dynamic/scorecard' }) });
  check('an unpublished run with no workflow file fails without a request to GitHub', await noFile.go() === 1 && noFile.dispatches().length === 0);

  for (const [name, ev] of [['a failed run', event({ conclusion: 'failure' })], ['a run on another branch', event({ head_branch: 'x' })], ['a private repository', event({}, { private: true })], ['an event with no run', {}]]) {
    const w = world({ served: [GONE], ev });
    check(`${name}: nothing is read or dispatched, exit 0`, await w.go() === 0 && w.calls.length === 0 && /^not checked: /.test(w.lines.at(-1)));
  }

  const bad = world({ served: [FRESH], env: { REPO: 'askalf/pitlane/../x' } });
  check('a REPO that is not owner/name is refused before any request', await bad.go() === 1 && bad.calls.length === 0);

  const served = await readServed(async () => ({ status: 200, json: async () => { throw new Error('not json'); } }), 'a/b');
  check('a 200 that is not JSON reads as no answer', served.status === 0);
}

console.log('\n  the action');
{
  const dir = mkdtempSync(join(tmpdir(), 'scorecard-publish-'));
  const eventPath = join(dir, 'event.json');
  const entry = fileURLToPath(new URL('../../actions/scorecard-publish-check/main.mjs', import.meta.url));
  const runEntry = (ev, env = {}) => {
    writeFileSync(eventPath, JSON.stringify(ev));
    return spawnSync(process.execPath, [entry], { encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_REPOSITORY: 'askalf/pitlane', GITHUB_EVENT_PATH: eventPath, INPUT_TOKEN: 't', 'INPUT_DRY-RUN': 'false', ...env } });
  };
  // Runs that are not checked end before any request, so the entry is run for real, with no network.
  const skipped = runEntry(event({ conclusion: 'failure' }));
  check('the entry runs on the event file and the repository the runner names', skipped.status === 0 && /not checked: the Scorecard run ended failure/.test(skipped.stdout));
  const noEvent = runEntry({}, { GITHUB_EVENT_PATH: join(dir, 'missing.json') });
  check('an event file that cannot be read fails the step', noEvent.status === 1 && /cannot read the event/.test(noEvent.stdout));
  const yml = readFileSync(fileURLToPath(new URL('../../actions/scorecard-publish-check/action.yml', import.meta.url)), 'utf8');
  check('the action runs main.mjs on the runner\'s Node, with the job token by default', /\nruns:\n  using: node24\n  main: main\.mjs\n/.test(yml) && yml.includes('    default: ${{ github.token }}\n') && yml.includes("  dry-run:\n") && !/uses:\s+\S+@/.test(yml.replace(/^#.*$/gm, '')));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
