#!/usr/bin/env node
// Checks that a finished OpenSSF Scorecard run reached scorecard.dev, and runs Scorecard once more
// when it did not. The scorecard-publish-check action runs it on workflow_run of a repository's
// Scorecard workflow.
//
// Why. scorecard-action reports a failed publish as a warning and the run stays green. On
// 2026-11-09 a publish from askalf/pitlane was answered 500 three times; scorecard.dev then
// served "not found" for the repository from its cache for fifteen hours, the README badge read
// "invalid repo path", and nothing was red anywhere. One clean publish cleared it.
//
// A step in the Scorecard job itself cannot do this: scorecard.dev accepts results only from a
// job whose steps are on its short allow list, so the check is a workflow of its own.
//
// What it does, for a Scorecard run that succeeded on the default branch of a public repository:
//   - reads https://api.scorecard.dev/projects/github.com/<owner>/<name>, the address the badge
//     reads, a few times some seconds apart;
//   - published: the result there carries a time, and it is no earlier than the run started
//     (less a minute for clock skew). Exit 0. A result this action's publish wrote is dated to
//     the second ("2026-11-09T10:25:29Z", read from the API on 2026-11-09 and 10); a date with
//     no time is OpenSSF's own weekly scan of the repository, never a run's publish, so it is
//     not taken for one whatever its day.
//   - not published, and the run was not a dispatch: dispatches the Scorecard workflow on the
//     default branch, once. Exit 0; that run is checked in turn.
//   - not published, and the run was a dispatch (the retry above, or one a person sent): exit 1,
//     so the failure is a red run and not a stale badge. A dispatch is never answered with
//     another, so one failed publish costs at most one extra run.
// Any other run (failed, cancelled, on another branch, in a private repository) is not one that
// publishes, and exits 0 untouched.
//
// The run's facts come in as the action's inputs, which default to the workflow_run event's own
// fields, never from the event file: nothing read from a file goes into a request.
//
// CLI: REPO=owner/name GITHUB_TOKEN=... EVENT_NAME=workflow_run RUN_ID=<id> RUN_EVENT=schedule \
//   RUN_CONCLUSION=success RUN_BRANCH=main RUN_STARTED_AT=<iso> RUN_PATH=.github/workflows/scorecard.yml \
//   DEFAULT_BRANCH=main PRIVATE=false [DRY_RUN=true] node check.mjs

import { pathToFileURL } from 'node:url';

export const API = 'https://api.scorecard.dev/projects/github.com';
/** How far before the run's start a result may be dated and still be this run's. */
export const SKEW_MS = 60_000;
/** Reads of scorecard.dev before a run is called unpublished, and the wait between them. */
export const READS = 4;
export const READ_WAIT_MS = 15_000;

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const WORKFLOW_RE = /^\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)$/;

/**
 * The facts the decision reads, from the environment the action hands over; null when the event
 * is not a workflow_run. The default branch is kept as GitHub gives it: a branch may carry a +
 * or letters outside ASCII, and it goes into the dispatch as a JSON string, nowhere else.
 */
export function runOf(env) {
  if ((env?.EVENT_NAME ?? '') !== 'workflow_run') return null;
  const text = (k) => String(env[k] ?? '').trim();
  return {
    id: text('RUN_ID'),
    event: text('RUN_EVENT'),
    conclusion: text('RUN_CONCLUSION'),
    headBranch: text('RUN_BRANCH'),
    startedAt: text('RUN_STARTED_AT'),
    workflowFile: WORKFLOW_RE.exec(text('RUN_PATH').split('@')[0])?.[1] ?? '',
    defaultBranch: text('DEFAULT_BRANCH'),
    isPrivate: text('PRIVATE') === 'true',
  };
}

/** Why this run is not one whose publish is checked, or '' when it is. Pure. */
export function notChecked(run) {
  if (!run) return 'not a workflow_run event';
  if (run.isPrivate) return 'a private repository does not publish to scorecard.dev';
  if (run.conclusion !== 'success') return `the Scorecard run ended ${run.conclusion || 'without a conclusion'}; its own status says so`;
  if (!run.defaultBranch || run.headBranch !== run.defaultBranch) return `the run was on ${run.headBranch || 'no branch'}, and only ${run.defaultBranch || 'the default branch'} publishes`;
  if (!Number.isFinite(Date.parse(run.startedAt))) return 'the run has no start time to compare with';
  return '';
}

/** A result date with a time of day, as a publish from the action carries: 2026-11-09T10:25:29Z. */
const TIMED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Whether what scorecard.dev serves ({ status, date }) is this run's result or a later one. A
 * date with no time of day is the weekly scan's and is never a run's publish. Pure.
 */
export function isPublished(run, served) {
  if (served?.status !== 200) return false;
  const text = String(served.date ?? '');
  if (!TIMED_RE.test(text)) return false;
  const date = Date.parse(text);
  return Number.isFinite(date) && date >= Date.parse(run.startedAt) - SKEW_MS;
}

/** What to do about an unpublished run: retry by one dispatch, or fail when it was a dispatch. Pure. */
export function onUnpublished(run) {
  return run.event === 'workflow_dispatch' ? 'fail' : 'retry';
}

/** One read of scorecard.dev: { status, date }. A failed request is status 0. */
export async function readServed(fetchFn, repo) {
  try {
    const res = await fetchFn(`${API}/${repo}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (res.status !== 200) return { status: res.status, date: '' };
    const body = await res.json();
    return { status: 200, date: String(body?.date ?? '') };
  } catch {
    return { status: 0, date: '' };
  }
}

const describe = (served) => (served.status === 200 ? `a result dated ${served.date || 'nothing'}` : served.status === 0 ? 'no answer' : `HTTP ${served.status}`);

/**
 * @param {Record<string,string|undefined>} env REPO, GITHUB_TOKEN, EVENT_NAME, the RUN_* facts, DEFAULT_BRANCH, PRIVATE, DRY_RUN, GITHUB_API_URL
 * @param {{ fetch?: typeof fetch, sleep?: (ms:number)=>Promise<void>, log?: (l:string)=>void }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function main(env, io = {}) {
  const fetchFn = io.fetch ?? globalThis.fetch;
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = io.log ?? ((l) => console.log(l));
  const repo = env.REPO ?? '';
  if (!REPO_RE.test(repo)) { log(`::error::REPO must be owner/name; got ${JSON.stringify(repo)}`); return 1; }
  const run = runOf(env);
  // A workflow_run event always names its run. No id here means the action's inputs did not
  // carry the event's fields, and passing would be a check that never checks.
  if (run && !/^[1-9][0-9]*$/.test(run.id)) {
    log('::error::the event is a workflow_run but the action got no run id: pass the run inputs (run-id, run-event, run-conclusion, run-branch, run-started-at, run-path, default-branch, private) from github.event in the caller');
    return 1;
  }
  const why = notChecked(run);
  if (why) { log(`not checked: ${why}`); return 0; }

  let served = { status: 0, date: '' };
  for (let read = 1; read <= READS; read++) {
    served = await readServed(fetchFn, repo);
    if (isPublished(run, served)) {
      log(`published: scorecard.dev serves ${describe(served)} for ${repo}; run ${run.id} started ${run.startedAt}`);
      return 0;
    }
    log(`read ${read} of ${READS}: scorecard.dev serves ${describe(served)}, not a result of run ${run.id} (started ${run.startedAt})`);
    if (read < READS) await sleep(READ_WAIT_MS);
  }

  if (onUnpublished(run) === 'fail') {
    log(`::error::Scorecard run ${run.id} was a dispatch and its result still did not reach scorecard.dev (${describe(served)}). The badge for ${repo} may be stale; see the run's "Run analysis" log for the publish error.`);
    return 1;
  }
  if (!run.workflowFile) { log(`::error::run ${run.id} names no workflow file to dispatch`); return 1; }
  if ((env.DRY_RUN ?? '') === 'true') { log(`dry run: would dispatch ${run.workflowFile} on ${run.defaultBranch}`); return 0; }
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  let res;
  try {
    res = await fetchFn(`${api}/repos/${repo}/actions/workflows/${run.workflowFile}/dispatches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.GITHUB_TOKEN ?? ''}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
      body: JSON.stringify({ ref: run.defaultBranch }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    log(`::error::could not dispatch ${run.workflowFile}: ${e.message}`); return 1;
  }
  if (res.status !== 204 && res.status !== 200) {
    log(`::error::could not dispatch ${run.workflowFile}: HTTP ${res.status} (the job needs actions: write)`); return 1;
  }
  log(`::warning::Scorecard run ${run.id} did not reach scorecard.dev (${describe(served)}); dispatched ${run.workflowFile} on ${run.defaultBranch} once more`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.env);
}
