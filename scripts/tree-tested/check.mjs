#!/usr/bin/env node
// Says whether the tree a push to the default branch carries was already tested green by this same
// workflow, on the pull request that merged it. The tree-tested action runs it as the first step of
// a job; the steps that build and test then take `if: steps.<id>.outputs.tested != 'true'`.
//
// Why. A pull request runs its workflow, merges, and the push to main runs the same workflow again
// on, most often, exactly the same files: a squash or merge of a branch that already had main in it
// leaves main with the branch head's tree. On the askalf runner host on 2026-11-11 that second run
// was about 300 of a day's CPU-heavy runner minutes (restore-desk, claude-re, platform, dario), on a
// host whose runner slice was waiting on CPU a quarter of the time.
//
// The rule, all of it read from the GitHub API with the job's own token:
//   1. The event is a push to the default branch. Anything else is tested=false.
//   2. A pull request of this repository was merged as this commit (its merge_commit_sha is the
//      pushed sha). A direct push has none, and is tested=false.
//   3. The pull request's head commit has the same tree as the pushed commit: the same files, byte
//      for byte, git's own hash of them.
//   4. The newest completed pull_request run of this workflow file at that head concluded success,
//      on its latest attempt, and every job in it, and every step of every job, concluded success,
//      all pages of them. A job or a step that was skipped did not test anything (a step that runs
//      only on push, a job a change did not need), so a run with one is not taken.
//   5. This job, the one asking (found in this run by its runner's name), has the name of a job in
//      that run. A job the push runs and the pull request did not, such as a matrix entry only a
//      push expands, is never in that run, so it runs in full. Steps that run only on push are a
//      skipped step there, which rule 4 does not take.
//   6. That job's log shows what it checked out: GitHub's merge of the head into the base, written
//      by the checkout as "Merge <head> into <base>". The head there is the pull request's head,
//      and that base is inside the head by GitHub's compare. A merge of a base the head already
//      holds is the head's own tree, so the job tested exactly the pushed tree, whatever branch
//      the pull request pointed at then and whatever main did after. With no such line, or more
//      than one, what was tested is not known.
// Every read that fails, and every rule that does not hold, is tested=false: the job runs in full.
// Nothing here can turn a red run green; at worst it runs a test it could have skipped.
//
// CLI: GITHUB_REPOSITORY=owner/name GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main GITHUB_SHA=<sha> \
//   GITHUB_WORKFLOW_REF=owner/name/.github/workflows/ci.yml@refs/heads/main DEFAULT_BRANCH=main \
//   GITHUB_TOKEN=... [GITHUB_OUTPUT=file] node check.mjs

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
/** owner/name/.github/workflows/<file>@<ref>: the file this run's workflow came from. */
const WORKFLOW_REF_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)@/;

/** The facts the decision starts from, from the runner's environment. Pure. */
export function factsOf(env) {
  const text = (k) => String(env?.[k] ?? '').trim();
  return {
    repo: text('GITHUB_REPOSITORY'),
    event: text('GITHUB_EVENT_NAME'),
    ref: text('GITHUB_REF'),
    sha: text('GITHUB_SHA'),
    workflowFile: WORKFLOW_REF_RE.exec(text('GITHUB_WORKFLOW_REF'))?.[1] ?? '',
    defaultBranch: text('DEFAULT_BRANCH'),
    runId: text('GITHUB_RUN_ID'),
    runnerName: text('RUNNER_NAME'),
  };
}

/** Why this run is not one to look up at all, or '' when it is. Pure. */
export function notEligible(f) {
  if (!REPO_RE.test(f.repo)) return `GITHUB_REPOSITORY is not owner/name (${JSON.stringify(f.repo)})`;
  if (f.event !== 'push') return `a ${f.event || 'run with no event'} is tested in full`;
  if (!f.defaultBranch || f.ref !== `refs/heads/${f.defaultBranch}`) return `a push to ${f.ref || 'no ref'} is tested in full; only a push to the default branch repeats a pull request's run`;
  if (!SHA_RE.test(f.sha)) return 'the pushed commit is not a full sha';
  if (!f.workflowFile) return 'the workflow file could not be read from GITHUB_WORKFLOW_REF';
  if (!/^[1-9][0-9]*$/.test(f.runId)) return 'GITHUB_RUN_ID is not a run id';
  if (!f.runnerName) return 'RUNNER_NAME is not set, so this job cannot be found in its run';
  return '';
}

/** The pull request merged as this commit, from the commit's pull request list, or null. Pure. */
export function mergedAs(pulls, repo, sha) {
  return (Array.isArray(pulls) ? pulls : []).find((p) => p?.merged_at && p?.merge_commit_sha === sha
    && p?.base?.repo?.full_name === repo && SHA_RE.test(String(p?.head?.sha ?? ''))) ?? null;
}

/**
 * The run that tested the head, from the workflow's runs at that head sha: the newest completed
 * pull_request run for this pull request. Null when there is none. Pure.
 */
export function runAtHead(runs, { head, number }) {
  return (Array.isArray(runs) ? runs : [])
    .filter((r) => r?.event === 'pull_request' && r?.status === 'completed' && r?.head_sha === head
      && (!Array.isArray(r?.pull_requests) || r.pull_requests.length === 0 || r.pull_requests.some((p) => p?.number === number)))
    .sort((a, b) => Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0))[0] ?? null;
}

/**
 * Why the run's jobs do not show this tree tested, or '' when every job, and every step of every job,
 * concluded success. A job with no steps listed is not taken either: nothing shows what it ran. Pure.
 */
export function jobsProblem(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (list.length === 0) return 'the run lists no jobs';
  const off = list.filter((j) => j?.conclusion !== 'success');
  if (off.length) return `not every job passed there (${off.slice(0, 4).map((j) => `${j?.name ?? '?'}: ${j?.conclusion ?? j?.status ?? '?'}`).join(', ')})`;
  const bare = list.find((j) => !Array.isArray(j?.steps) || j.steps.length === 0);
  if (bare) return `the job ${bare?.name ?? '?'} lists no steps`;
  for (const j of list) {
    const step = j.steps.find((st) => st?.conclusion !== 'success');
    if (step) return `not every step ran and passed there (${j?.name ?? '?'}: ${step?.name ?? '?'} ${step?.conclusion ?? step?.status ?? '?'})`;
  }
  return '';
}

/** Whether a compare of base...head says base is inside head (head is ahead of it, or the same). Pure. */
export const contains = (compare) => compare?.status === 'ahead' || compare?.status === 'identical';

/** How many pages of jobs (100 a page) a run may have before it is not read at all. */
export const MAX_JOB_PAGES = 5;
/** The largest job log read for its checkout line. */
export const MAX_LOG_BYTES = 32 * 1024 * 1024;

/** This job in its own run: the one in progress on this runner. Null when there is not exactly one. Pure. */
export function thisJob(jobs, runnerName) {
  const mine = (Array.isArray(jobs) ? jobs : []).filter((j) => j?.status === 'in_progress' && j?.runner_name === runnerName);
  return mine.length === 1 ? mine[0] : null;
}

const MERGE_LINE = /HEAD is now at [0-9a-f]{7,40} Merge ([0-9a-f]{40}) into ([0-9a-f]{40})/g;
/** The merges a job's log says it checked out, as { head, base }, once each. Pure. */
export function mergesIn(log) {
  const seen = new Map();
  for (const m of String(log ?? '').matchAll(MERGE_LINE)) seen.set(`${m[1]} ${m[2]}`, { head: m[1], base: m[2] });
  return [...seen.values()];
}

/** GET from the API as the token. Throws on a status that is not 2xx. */
async function get(io, env, path) {
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  const res = await io.fetch(`${api}${path}`, {
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN ?? ''}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GET ${path.split('?')[0]}: HTTP ${res.status}`);
  return res.json();
}

/** A job's log as text; the API answers with a redirect to storage, which fetch follows. */
async function getLog(io, env, repo, jobId) {
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  const res = await io.fetch(`${api}/repos/${repo}/actions/jobs/${jobId}/logs`, {
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN ?? ''}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`GET the log of job ${jobId}: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_LOG_BYTES) throw new Error(`the log of job ${jobId} is over ${MAX_LOG_BYTES} bytes`);
  return text;
}

/** Every job of a run's latest attempt, all pages, or { why } when they cannot all be read. */
async function allJobs(io, env, repo, runId) {
  const jobs = [];
  for (let page = 1; ; page++) {
    if (page > MAX_JOB_PAGES) return { why: `run ${runId} has more than ${MAX_JOB_PAGES * 100} jobs; not read` };
    const got = await get(io, env, `/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`);
    const batch = Array.isArray(got?.jobs) ? got.jobs : [];
    jobs.push(...batch);
    const total = Number(got?.total_count);
    if (batch.length < 100 || (Number.isFinite(total) && jobs.length >= total)) {
      if (Number.isFinite(total) && jobs.length !== total) return { why: `read ${jobs.length} of run ${runId}'s ${total} jobs` };
      return { jobs };
    }
  }
}

/**
 * The decision: { tested, why, run? }. tested is true only when every rule in the header holds.
 * io: { fetch }.
 */
export async function decide(env, io = { fetch: globalThis.fetch }) {
  const f = factsOf(env);
  const skip = notEligible(f);
  if (skip) return { tested: false, why: skip };
  try {
    const pulls = await get(io, env, `/repos/${f.repo}/commits/${f.sha}/pulls`);
    const pr = mergedAs(pulls, f.repo, f.sha);
    if (!pr) return { tested: false, why: `no pull request of ${f.repo} was merged as ${f.sha.slice(0, 7)} (a direct push is tested in full)` };
    const head = pr.head.sha;
    const [pushed, headed] = await Promise.all([
      get(io, env, `/repos/${f.repo}/git/commits/${f.sha}`),
      get(io, env, `/repos/${f.repo}/git/commits/${head}`),
    ]);
    const tree = String(pushed?.tree?.sha ?? ''), headTree = String(headed?.tree?.sha ?? '');
    if (!SHA_RE.test(tree) || tree !== headTree) {
      return { tested: false, why: `#${pr.number}'s head ${head.slice(0, 7)} has another tree than ${f.sha.slice(0, 7)}: main had moved, so the merged files were never tested together` };
    }
    const listed = await get(io, env, `/repos/${f.repo}/actions/workflows/${f.workflowFile}/runs?head_sha=${head}&event=pull_request&per_page=50`);
    const run = runAtHead(listed?.workflow_runs, { head, number: pr.number });
    if (!run) return { tested: false, why: `${f.workflowFile} has no finished pull_request run at #${pr.number}'s head ${head.slice(0, 7)}` };
    if (run.conclusion !== 'success') return { tested: false, why: `${f.workflowFile} ended ${run.conclusion} at #${pr.number}'s head (${run.html_url ?? run.id})` };
    const theirs = await allJobs(io, env, f.repo, run.id);
    if (theirs.why) return { tested: false, why: theirs.why };
    const bad = jobsProblem(theirs.jobs);
    if (bad) return { tested: false, why: `${bad} in ${run.html_url ?? run.id}` };
    // This job, and the job of the same name there.
    const ours = await allJobs(io, env, f.repo, f.runId);
    if (ours.why) return { tested: false, why: ours.why };
    const me = thisJob(ours.jobs, f.runnerName);
    if (!me) return { tested: false, why: `this job was not found in run ${f.runId} by its runner ${f.runnerName}` };
    const twins = theirs.jobs.filter((j) => j?.name === me.name);
    if (twins.length !== 1) return { tested: false, why: `the job "${me.name}" is ${twins.length ? 'not one job' : 'not a job'} in ${run.html_url ?? run.id}: the pull request did not run it` };
    // What that job checked out.
    const merges = mergesIn(await getLog(io, env, f.repo, twins[0].id));
    if (merges.length !== 1) return { tested: false, why: `the log of "${me.name}" there shows ${merges.length ? 'more than one merge' : 'no merge'} checked out, so what it tested is not known` };
    const { head: tHead, base: tBase } = merges[0];
    if (tHead !== head) return { tested: false, why: `"${me.name}" there checked out a merge of ${tHead.slice(0, 7)}, not of #${pr.number}'s head ${head.slice(0, 7)}` };
    const cmp = await get(io, env, `/repos/${f.repo}/compare/${tBase}...${head}`);
    if (!contains(cmp)) {
      return { tested: false, why: `"${me.name}" there tested #${pr.number}'s head merged into ${tBase.slice(0, 7)}, which the head does not hold (${cmp?.status ?? 'no status'}), so it tested another tree` };
    }
    return { tested: true, why: `#${pr.number}'s head ${head.slice(0, 7)} has this tree, "${me.name}" tested it there (merged into ${tBase.slice(0, 7)}, which the head holds), and every job and step of that run passed`, run: run.html_url ?? String(run.id) };
  } catch (e) {
    return { tested: false, why: `${e.message}; tested in full` };
  }
}

export async function main(env, io = {}) {
  const log = io.log ?? ((l) => console.log(l));
  const d = await decide(env, { fetch: io.fetch ?? globalThis.fetch });
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `tested=${d.tested ? 'true' : 'false'}\nrun=${d.run ?? ''}\n`);
  log(d.tested ? `::notice::this tree already passed: ${d.why} (${d.run}). The steps that test it are skipped.` : `tested in full: ${d.why}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.env).then((code) => { process.exitCode = code; }, (e) => {
    // Even a failure of this script runs the job in full: it never fails the job.
    console.log(`tested in full: ${e.message}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'tested=false\nrun=\n');
  });
}
