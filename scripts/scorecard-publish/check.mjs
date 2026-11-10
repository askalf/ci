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
//   - published: the result there is dated no earlier than the run started (less a minute for
//     clock skew). Exit 0.
//   - not published, and the run was not a dispatch: dispatches the Scorecard workflow on the
//     default branch, once. Exit 0; that run is checked in turn.
//   - not published, and the run was a dispatch (the retry above, or one a person sent): exit 1,
//     so the failure is a red run and not a stale badge. A dispatch is never answered with
//     another, so one failed publish costs at most one extra run.
// Any other run (failed, cancelled, on another branch, in a private repository) is not one that
// publishes, and exits 0 untouched.
//
// CLI: REPO=owner/name GITHUB_TOKEN=... GITHUB_EVENT_PATH=<workflow_run event> [DRY_RUN=true] node check.mjs

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const API = 'https://api.scorecard.dev/projects/github.com';
/** How far before the run's start a result may be dated and still be this run's. */
export const SKEW_MS = 60_000;
/** Reads of scorecard.dev before a run is called unpublished, and the wait between them. */
export const READS = 4;
export const READ_WAIT_MS = 15_000;

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const WORKFLOW_RE = /^\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)$/;

/** The facts the decision reads, from a workflow_run event; null when the event is not one. */
export function runOf(event) {
  const r = event?.workflow_run;
  if (!r || typeof r !== 'object') return null;
  return {
    id: r.id,
    event: String(r.event ?? ''),
    conclusion: String(r.conclusion ?? ''),
    headBranch: String(r.head_branch ?? ''),
    startedAt: String(r.run_started_at ?? r.created_at ?? ''),
    workflowFile: WORKFLOW_RE.exec(String(r.path ?? '').split('@')[0])?.[1] ?? '',
    defaultBranch: String(event.repository?.default_branch ?? ''),
    isPrivate: event.repository?.private === true,
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

/** Whether what scorecard.dev serves ({ status, date }) is this run's result or a later one. Pure. */
export function isPublished(run, served) {
  if (served?.status !== 200) return false;
  const date = Date.parse(String(served.date ?? ''));
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
 * @param {Record<string,string|undefined>} env REPO, GITHUB_TOKEN, GITHUB_EVENT_PATH, DRY_RUN, GITHUB_API_URL
 * @param {{ fetch?: typeof fetch, sleep?: (ms:number)=>Promise<void>, log?: (l:string)=>void, event?: object }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function main(env, io = {}) {
  const fetchFn = io.fetch ?? globalThis.fetch;
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = io.log ?? ((l) => console.log(l));
  const repo = env.REPO ?? '';
  if (!REPO_RE.test(repo)) { log(`::error::REPO must be owner/name; got ${JSON.stringify(repo)}`); return 1; }
  let event = io.event;
  if (event === undefined) {
    try { event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? '', 'utf8')); } catch (e) {
      log(`::error::cannot read the event at GITHUB_EVENT_PATH (${e.code ?? e.message})`); return 1;
    }
  }
  const run = runOf(event);
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
