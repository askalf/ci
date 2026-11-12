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
//   4. Main as it was just before the merge (the pushed commit's first parent) is an ancestor of
//      that head, by GitHub's compare. A pull_request run tests its head merged with the base main
//      had then, an older main than that parent; when the parent is inside the head, so is every
//      base the run could have used, and the merge it tested is the head's own tree. Without this,
//      the tree a run tested is not known: main could have gained a change and reverted it between
//      the run and the merge, leaving the head's tree on main but a different tree tested.
//   5. The newest completed pull_request run of this workflow file at that head concluded success,
//      on its latest attempt, and every job in it, and every step of every job, concluded success,
//      all pages of them. A job or a step that was skipped did not test anything (a step that runs
//      only on push, a job a change did not need), so a run with one is not taken.
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
  };
}

/** Why this run is not one to look up at all, or '' when it is. Pure. */
export function notEligible(f) {
  if (!REPO_RE.test(f.repo)) return `GITHUB_REPOSITORY is not owner/name (${JSON.stringify(f.repo)})`;
  if (f.event !== 'push') return `a ${f.event || 'run with no event'} is tested in full`;
  if (!f.defaultBranch || f.ref !== `refs/heads/${f.defaultBranch}`) return `a push to ${f.ref || 'no ref'} is tested in full; only a push to the default branch repeats a pull request's run`;
  if (!SHA_RE.test(f.sha)) return 'the pushed commit is not a full sha';
  if (!f.workflowFile) return 'the workflow file could not be read from GITHUB_WORKFLOW_REF';
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
    const parent = String(pushed?.parents?.[0]?.sha ?? '');
    if (!SHA_RE.test(parent)) return { tested: false, why: `${f.sha.slice(0, 7)} names no parent to compare` };
    const cmp = await get(io, env, `/repos/${f.repo}/compare/${parent}...${head}`);
    if (!contains(cmp)) {
      return { tested: false, why: `main before the merge (${parent.slice(0, 7)}) is not inside #${pr.number}'s head ${head.slice(0, 7)} (${cmp?.status ?? 'no status'}), so the tree its run tested is not known` };
    }
    const listed = await get(io, env, `/repos/${f.repo}/actions/workflows/${f.workflowFile}/runs?head_sha=${head}&event=pull_request&per_page=50`);
    const run = runAtHead(listed?.workflow_runs, { head, number: pr.number });
    if (!run) return { tested: false, why: `${f.workflowFile} has no finished pull_request run at #${pr.number}'s head ${head.slice(0, 7)}` };
    if (run.conclusion !== 'success') return { tested: false, why: `${f.workflowFile} ended ${run.conclusion} at #${pr.number}'s head (${run.html_url ?? run.id})` };
    const jobs = [];
    for (let page = 1; ; page++) {
      if (page > MAX_JOB_PAGES) return { tested: false, why: `the run has more than ${MAX_JOB_PAGES * 100} jobs; not read` };
      const got = await get(io, env, `/repos/${f.repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`);
      const batch = Array.isArray(got?.jobs) ? got.jobs : [];
      jobs.push(...batch);
      const total = Number(got?.total_count);
      if (batch.length < 100 || (Number.isFinite(total) && jobs.length >= total)) {
        if (Number.isFinite(total) && jobs.length !== total) return { tested: false, why: `read ${jobs.length} of the run's ${total} jobs` };
        break;
      }
    }
    const bad = jobsProblem(jobs);
    if (bad) return { tested: false, why: `${bad} in ${run.html_url ?? run.id}` };
    return { tested: true, why: `#${pr.number}'s head ${head.slice(0, 7)} has this tree and holds main as it was before the merge, and ${f.workflowFile} passed there with every job and every step`, run: run.html_url ?? String(run.id) };
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
