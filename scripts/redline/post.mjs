// Redline's post: puts the verdict of a finished Redline run on its pull request as
// sprayberry-redline, from a workflow_run job that runs the default branch's workflow files.
//
// Why here. The review job runs on the redline runner from the workflow files a pull request
// brings with it, so it never holds the reviewer token: review.mjs leaves verdict.json with
// posted: false. A workflow_run job always runs the default branch's copy of its workflow file,
// never a pull request's, so it may hold the token as a repository secret: a pull request cannot
// change what this job runs, or where its secret goes, until that change has been reviewed and
// merged. It runs on a GitHub-hosted runner, a fresh machine no pull request's job has touched.
// Our ops automation applies the same rules and never posts to a repository that has the caller, so
// this job is the only poster there.
//
// Nothing in the artifact is taken on trust. Every fact a rule judges is read from the GitHub API
// with the workflow's read-only token, and the verdict is posted only when every rule holds.
//
// A pull_request run (the PR's own Redline run):
//   1. The run is .github/workflows/redline.yml in this repository, on pull_request, completed, with
//      its head in this repository and at the PR's current head. The PR is open.
//   2. The PR changes nothing under .github/workflows/ or .github/actions/ beyond a pin bump of
//      redline.yml (its review uses line and its redline-ref, naming one sha). A PR that does could
//      shape its own run; such a head is reviewed in dispatch mode instead.
//   3. The run called redline-review.yml from one tooling repository at one sha X on that
//      repository's main, and the redline.yml the run used pins the same repository and X in both
//      lines. When the PR changes that file it is read at the PR head. Otherwise the run used a copy
//      from the base branch, and neither the run nor the base's history by date says which (the base
//      may have moved since, and a commit's date is not when it was merged), so every copy among
//      the base branch's last BASE_CALLER_COMMITS commits to the file is read: those that name X in
//      the uses line, which the run's copy did, must number at least one and all set redline-ref X.
//   4. The run's redline-verdict artifact holds a verdict.json (version 1) for this repository, PR
//      and head, with posted: false, whose event agrees with the run's conclusion (APPROVE exactly
//      when the run succeeded).
//   5. sprayberry-redline has no review at the head yet.
// A dispatched run (a workflow_dispatch of redline.yml on the default branch by the dispatch account,
// askalf unless the caller passes dispatch-actor, for a head the
// pull_request run cannot vouch for):
//   1. The dispatch account dispatched .github/workflows/redline.yml in this repository on the default branch, the
//      run is completed, and its title names this repository, an open PR and the PR's current head.
//   2. The run's commit is on the default branch.
//   3. As above, with redline.yml read at the run's commit.
//   4. As above.
//   5. sprayberry-redline has no review at the head yet; for a re-read, none since the run was created.
//   There is no CI-change rule: the PR's own workflow files never ran in a dispatched run.
// Rule 5 is read again just before the post, then the PR: a PR whose state, head or base changed
// while this job read is a skip, since the facts it judged are no longer the PR's. The post itself
// is sent once, never retried: a retry after an answer that was lost on the way back would post the
// review twice. Two posts for one head never overlap: redline-post-verdict.yml runs one at a time.
//
// The outcome. A posted review, and a run that is not one to post (rules 1, 2 and 5), end with exit
// 0. A verdict refused under rule 3 or 4 also ends with exit 0, and with a warning: no later run of
// this job decides otherwise, and our ops automation, which applies the same rules, hands that head
// to a reviewer. A failed read or a failed post ends with exit 1, so the run shows failed and a re-run
// of it decides again.
//
// CLI (the post step of redline-post.yml):
//   REPO=owner/name RUN_ID=<the Redline run> GH_READ_TOKEN=... REDLINE_REVIEWER_TOKEN=... node post.mjs

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gh, verdictProblem, REVIEWER_LOGIN, DISPATCH_ACTOR, isDispatchActor } from './review.mjs';
export { DISPATCH_ACTOR };
import { CI_REPO } from './pin.mjs';
import { zipEntry, MAX_ARTIFACT_BYTES } from './zip.mjs';
export { zipEntry, MAX_ARTIFACT_BYTES };

export const CALLER_PATH = '.github/workflows/redline.yml';
/**
 * The repositories whose redline-review.yml a caller may run: ci-repo (pin.mjs CI_REPO), and for
 * askalf/ci also askalf/askalf, accepted while a caller still pins it. Every check is made against
 * the repository the run named, never a fixed one.
 */
export const TOOLING_REPOS = CI_REPO === 'askalf/ci' ? ['askalf/ci', 'askalf/askalf'] : [CI_REPO];
export const REVIEW_WORKFLOW_FILE = '.github/workflows/redline-review.yml';
export const VERDICT_ARTIFACT = 'redline-verdict';
export const VERDICT_FILE = 'verdict.json';
// DISPATCH_ACTOR, the identity that dispatches a review, is review.mjs's: both readers of a run hold the one rule.
/**
 * How many of the base branch's commits to redline.yml rule 3 reads. The run's copy is among them
 * unless that many changes to the file merged between the run and its post.
 */
export const BASE_CALLER_COMMITS = 20;

const SHA = /^[0-9a-f]{40}$/;
const CI_DIRS = ['.github/workflows/', '.github/actions/'];
const TOOLING_ALT = TOOLING_REPOS.map((r) => r.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
/** Group 1 the tooling repository, group 2 the sha. */
const USES_LINE = new RegExp(`^\\s*uses:\\s*(${TOOLING_ALT})\\/\\.github\\/workflows\\/redline-review\\.yml@([0-9a-f]{40})\\s*(?:#.*)?$`);
const REF_LINE = /^\s*redline-ref:\s*([0-9a-f]{40})\s*$/;
/** Group 1 the tooling repository, group 2 whatever follows the @. */
const ANY_USES = new RegExp(`^\\s*(?:-\\s+)?uses:\\s*(${TOOLING_ALT})\\/\\.github\\/workflows\\/redline-review\\.yml@(\\S*)`);
const ANY_REF = /^\s*redline-ref:\s*(\S*)/;
/** redline.yml's run-name on a dispatch: `Redline review <owner>/<name>#<pr> @ <head>[ (re-read)]`. */
const DISPATCH_TITLE = /^Redline review ([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#([1-9]\d*) @ ([0-9a-f]{40})( \(re-read\))?$/;

// ---------- facts ----------

/** The run, as the rules read it. */
export function runFromApi(raw) {
  return {
    id: Number(raw?.id ?? 0),
    runAttempt: Number(raw?.run_attempt ?? 1),
    title: String(raw?.display_title ?? ''),
    path: String(raw?.path ?? ''),
    event: String(raw?.event ?? ''),
    status: String(raw?.status ?? ''),
    conclusion: raw?.conclusion == null ? null : String(raw.conclusion),
    actor: String(raw?.actor?.login ?? ''),
    triggeringActor: String(raw?.triggering_actor?.login ?? ''),
    headSha: String(raw?.head_sha ?? ''),
    headBranch: String(raw?.head_branch ?? ''),
    headRepo: String(raw?.head_repository?.full_name ?? ''),
    repo: String(raw?.repository?.full_name ?? ''),
    createdAt: String(raw?.created_at ?? ''),
    referencedWorkflows: (Array.isArray(raw?.referenced_workflows) ? raw.referenced_workflows : [])
      .map((w) => ({ path: String(w?.path ?? ''), sha: String(w?.sha ?? '') })),
  };
}

/** The PR a dispatched run's title names, or null. Pure. */
export function parseDispatchTitle(title) {
  const m = DISPATCH_TITLE.exec(String(title ?? ''));
  return m ? { repo: m[1], pr: Number(m[2]), head: m[3], reread: m[4] !== undefined } : null;
}

// ---------- the rules (pure) ----------
// Each returns null when it holds, else a decision: skip (not a run to post), refuse (this run's
// verdict will never be posted), or retry (a read failed, so this run cannot decide yet).

const skip = (reason) => ({ action: 'skip', reason });
const refuse = (reason) => ({ action: 'refuse', reason });
const retry = (reason) => ({ action: 'retry', reason });
const short = (sha) => String(sha ?? '').slice(0, 7);

/** Rule 5. `reviewsSinceRun` counts only for a re-read, which replaces the verdict at the head. */
export function ruleNotYetReviewed({ prHead, reviewsAtHead, reviewsSinceRun = 0, reread = false }) {
  const n = reread ? reviewsSinceRun : reviewsAtHead;
  return n > 0 ? skip(`${REVIEWER_LOGIN} already reviewed ${short(prHead)}${reread ? ' since this re-read was dispatched' : ''}`) : null;
}

/** Rule 1, pull_request. */
export function rulePrRun({ repo, prState, prHead, prHeadRepo, run }) {
  if (prState !== 'open') return skip(`the PR is ${prState || 'unreadable'}`);
  if (run.path !== CALLER_PATH) return skip(`run ${run.id} is ${run.path}, not ${CALLER_PATH}`);
  if (run.event !== 'pull_request') return skip(`run ${run.id} ran on ${run.event}, not pull_request`);
  if (run.status !== 'completed') return skip(`run ${run.id} is ${run.status}`);
  if (run.repo !== repo) return skip(`run ${run.id} belongs to ${run.repo}`);
  if (run.headRepo !== repo || prHeadRepo !== repo) return skip('the head is not in the base repository');
  if (!SHA.test(prHead) || run.headSha !== prHead) return skip(`run ${run.id} is at ${short(run.headSha)}, the PR head is ${short(prHead)}`);
  return null;
}

/** Rule 1, dispatch. */
export function ruleDispatchRun({ repo, pr, prState, prHead, prHeadRepo, defaultBranch, run }) {
  if (run.repo !== repo || run.path !== CALLER_PATH || run.event !== 'workflow_dispatch'
    || !isDispatchActor(run.actor) || !isDispatchActor(run.triggeringActor) || !defaultBranch || run.headBranch !== defaultBranch) {
    return skip(`run ${run.id} is not ${DISPATCH_ACTOR}'s dispatch of ${CALLER_PATH} on ${defaultBranch || 'the default branch'} (${run.event || 'no event'} of ${run.path || 'no path'} on ${run.headBranch || 'no branch'} by ${run.actor || '?'})`);
  }
  const t = parseDispatchTitle(run.title);
  if (!t) return skip(`run ${run.id} is titled ${JSON.stringify(run.title).slice(0, 100)}, which names no review`);
  if (t.repo !== repo || t.pr !== pr) return skip(`run ${run.id} is for ${t.repo}#${t.pr}`);
  if (run.status !== 'completed') return skip(`run ${run.id} is ${run.status}`);
  if (prState !== 'open') return skip(`the PR is ${prState || 'unreadable'}`);
  // A fork head is reviewed on a dispatch like any other: the run executed the default branch's
  // files, not the PR's. Only a head whose repository could not be read is left alone.
  if (!prHeadRepo) return skip('the head repository is unknown');
  if (!SHA.test(prHead) || t.head !== prHead) return skip(`run ${run.id} reviewed ${short(t.head)}, the PR is at ${short(prHead)}`);
  return null;
}

const underCiDir = (p) => !!p && CI_DIRS.some((d) => p.startsWith(d));

/**
 * The sha a redline.yml patch pins, when every changed line is a pin line (the review's uses line,
 * from any tooling repository, or the redline-ref input) and the added ones name one sha; else
 * null. At most one uses line and one redline-ref line may be added. Pure.
 */
export function pinOnlyPatchSha(patch) {
  if (!patch) return null;
  const added = new Set();
  let addedUses = 0;
  let addedRefs = 0;
  let changed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('\\') || line === '') continue;
    const mark = line[0];
    if (mark === ' ') continue;
    if (mark !== '+' && mark !== '-') return null;
    changed++;
    const body = line.slice(1);
    const u = USES_LINE.exec(body);
    const r = u ? null : REF_LINE.exec(body);
    if (!u && !r) return null;
    if (mark === '+') {
      added.add(u ? u[2] : r[1]);
      if (u) addedUses++; else addedRefs++;
    }
  }
  if (changed === 0 || added.size !== 1 || addedUses > 1 || addedRefs > 1) return null;
  return [...added][0];
}

/** Rule 2, pull_request. `files` is null when the list could not be read in full. */
export function ruleNoCiChanges({ files }) {
  if (files === null) return retry('the PR\'s changed files could not be read in full');
  const other = [];
  for (const f of files) {
    if (!underCiDir(f.filename) && !underCiDir(f.previousFilename)) continue;
    const pinBump = f.filename === CALLER_PATH && f.status === 'modified'
      && (f.previousFilename === undefined || f.previousFilename === CALLER_PATH)
      && pinOnlyPatchSha(f.patch) !== null;
    if (!pinBump) other.push(f.filename);
  }
  if (other.length === 0) return null;
  return skip(`the PR changes CI definitions (${other.slice(0, 5).join(', ')}${other.length > 5 ? `, ${other.length - 5} more` : ''}); it is reviewed in dispatch mode`);
}

/** Rule 2, dispatch. `runOnDefault` is the compare status of <default>...<run's commit>. */
export function ruleDispatchOnDefault({ run, defaultBranch, runOnDefault }) {
  if (runOnDefault === null) return retry(`could not compare ${short(run.headSha)} with ${defaultBranch}`);
  if (runOnDefault !== 'identical' && runOnDefault !== 'behind') return refuse(`run ${run.id} ran at ${short(run.headSha)}, which is not on ${defaultBranch} (${runOnDefault})`);
  return null;
}

/** The pin of a redline.yml: the review's tooling repository and sha, and the redline-ref, each exactly once. Pure. */
export function callerPin(yaml) {
  if (!yaml) return null;
  const uses = [];
  const refs = [];
  for (const line of yaml.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const u = ANY_USES.exec(line);
    if (u) uses.push({ repo: u[1], sha: u[2].replace(/#.*$/, '').trim() });
    const r = ANY_REF.exec(line);
    if (r) refs.push(r[1].trim());
  }
  if (uses.length !== 1 || refs.length !== 1) return null;
  return { repo: uses[0].repo, uses: uses[0].sha, ref: refs[0] };
}

/**
 * The tooling repository and sha the run called redline-review.yml at, from its referenced_workflows:
 * exactly one entry, `<repo>/<file>@<sha>`, with the repository ours and a full sha the entry's own
 * sha agrees with. Null otherwise. Pure.
 */
export function referencedPin(run) {
  const list = run.referencedWorkflows ?? [];
  if (list.length !== 1) return null;
  const [path, at, ...rest] = String(list[0].path ?? '').split('@');
  const sha = String(list[0].sha ?? '');
  if (rest.length || !SHA.test(sha) || at !== sha) return null;
  const repo = TOOLING_REPOS.find((r) => path === `${r}/${REVIEW_WORKFLOW_FILE}`);
  return repo ? { repo, sha } : null;
}

/**
 * The copy of redline.yml rule 3 judges for a pull_request run that does not change the file, from
 * the base branch's copies (`copies`, newest first, each { sha, text }). The run's copy named X in
 * its uses line, so: the first copy that names X but does not pin X in both lines, else the newest
 * copy that names X, else, when none does, the newest copy. Pure.
 */
export function baseCallerChoice(copies, x) {
  if (!x) return copies[0];
  const names = (text) => String(text ?? '').split(/\r?\n/).some((line) => {
    if (line.trimStart().startsWith('#')) return false;
    const u = ANY_USES.exec(line);
    return u !== null && u[1] === x.repo && u[2].replace(/#.*$/, '').trim() === x.sha;
  });
  const named = copies.filter((c) => names(c.text));
  const bad = named.find((c) => {
    const pin = callerPin(c.text);
    return !pin || pin.repo !== x.repo || pin.uses !== x.sha || pin.ref !== x.sha;
  });
  return bad ?? named[0] ?? copies[0];
}

/**
 * Rule 3. `caller` is the redline.yml the run used and `where` says where it was read; `patch` is
 * the PR's own change to redline.yml (pull_request only), whose pin must name the same sha.
 * `pinCompare` is the compare status of <tooling repo> main...X.
 */
export function rulePinnedOnMain({ run, caller, where, patch, pinCompare }) {
  const x = referencedPin(run);
  if (!x) return refuse(`run ${run.id} did not call ${REVIEW_WORKFLOW_FILE} from ${TOOLING_REPOS.join(' or ')} at exactly one full sha`);
  // The file the run used exists (the run ran it), so an absent text is a read that failed.
  if (caller === null) return retry(`could not read ${CALLER_PATH} at ${where}`);
  const pin = callerPin(caller);
  if (!pin) return refuse(`${CALLER_PATH} at ${where} does not pin the review exactly once with one redline-ref`);
  if (pin.repo !== x.repo || pin.uses !== x.sha || pin.ref !== x.sha) {
    return refuse(`${CALLER_PATH} at ${where} pins ${pin.repo}@${short(pin.uses)} with redline-ref ${short(pin.ref)}; the run called ${x.repo}@${short(x.sha)}`);
  }
  if (patch !== undefined) {
    const patchSha = pinOnlyPatchSha(patch);
    if (patchSha !== x.sha) return refuse(`the PR's pin change names ${short(patchSha)}, the run called ${short(x.sha)}`);
  }
  if (pinCompare === null) return retry(`could not compare ${short(x.sha)} with ${x.repo} main`);
  if (pinCompare !== 'identical' && pinCompare !== 'behind') return refuse(`${short(x.sha)} is not on ${x.repo} main (${pinCompare})`);
  return null;
}

/** Rule 4. On success, the review to post. */
export function ruleVerdictMatches({ repo, pr, prHead, run, artifact, verdictText }) {
  if (!artifact) return refuse(`run ${run.id} has no ${VERDICT_ARTIFACT} artifact`);
  if (artifact.runId !== run.id || artifact.headSha !== run.headSha) return refuse(`the ${VERDICT_ARTIFACT} artifact is not from run ${run.id} at ${short(run.headSha)}`);
  if (artifact.expired) return refuse(`the ${VERDICT_ARTIFACT} artifact of run ${run.id} has expired`);
  if (artifact.sizeInBytes > MAX_ARTIFACT_BYTES) return refuse(`the ${VERDICT_ARTIFACT} artifact of run ${run.id} is ${artifact.sizeInBytes} bytes, over the ${MAX_ARTIFACT_BYTES} byte cap`);
  if (verdictText === null) return refuse(`the ${VERDICT_ARTIFACT} artifact holds no ${VERDICT_FILE}`);
  let v;
  try { v = JSON.parse(verdictText); } catch { return refuse(`${VERDICT_FILE} is not JSON`); }
  const bad = verdictProblem(v);
  if (bad) return refuse(`${VERDICT_FILE}: ${bad}`);
  if (v.repo !== repo || v.pr !== pr) return refuse(`${VERDICT_FILE} names ${v.repo}#${v.pr}`);
  // The PR's head, not the run's: a dispatched run is at the default branch's commit and reviews
  // the head its title names. A pull_request run is at the PR head already (rule 1).
  if (v.head_sha !== prHead) return refuse(`${VERDICT_FILE} is for ${short(v.head_sha)}`);
  if (v.posted !== false) return refuse('the review job posted this verdict itself');
  const conclusion = String(run.conclusion ?? '');
  if (conclusion !== 'success' && conclusion !== 'failure') return refuse(`run ${run.id} concluded ${conclusion || 'nothing'}`);
  if ((v.event === 'APPROVE') !== (conclusion === 'success')) return refuse(`${VERDICT_FILE} says ${v.event} but run ${run.id} concluded ${conclusion}`);
  return {
    action: 'post',
    review: {
      commit_id: v.head_sha,
      event: v.event,
      body: v.body,
      ...(v.comments.length ? { comments: v.comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })) } : {}),
    },
  };
}

// ---------- the artifact: zipEntry, in zip.mjs, shared with the review ----------

// ---------- I/O ----------

/** A GitHub read as the workflow's token, or null when it failed after review.mjs's retries. */
const read = (ctx, path) => gh(ctx, path).catch(() => null);

/** Every row of a list, or null when a page failed or there are more than `maxPages` pages. */
export async function readAll(ctx, path, maxPages) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const rows = await read(ctx, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(rows)) return null;
    out.push(...rows);
    if (rows.length < 100) return out;
  }
  return null;
}

async function fileText(ctx, path, ref) {
  const res = await read(ctx, `/repos/${ctx.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
  if (res?.encoding !== 'base64' || typeof res?.content !== 'string') return null;
  return Buffer.from(res.content, 'base64').toString('utf8');
}

/**
 * The copies of redline.yml in the base branch's last BASE_CALLER_COMMITS commits to it, newest
 * first, each { sha, text }. Null unless the list and every copy were read.
 */
async function baseCallerCopies(ctx, baseRef) {
  if (!baseRef) return null;
  const q = new URLSearchParams({ sha: baseRef, path: CALLER_PATH, per_page: String(BASE_CALLER_COMMITS) });
  const rows = await read(ctx, `/repos/${ctx.repo}/commits?${q}`);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const copies = [];
  for (const row of rows.slice(0, BASE_CALLER_COMMITS)) {
    const sha = String(row?.sha ?? '');
    const text = SHA.test(sha) ? await fileText(ctx, CALLER_PATH, sha) : null;
    if (text === null) return null;
    copies.push({ sha, text });
  }
  return copies;
}

async function compareStatus(ctx, path) {
  const res = await read(ctx, path);
  return typeof res?.status === 'string' ? res.status : null;
}

/** sprayberry-redline's reviews at `head`, or null when they could not be read in full. */
async function reviewerReviews(ctx, pr, head) {
  const all = await readAll(ctx, `/repos/${ctx.repo}/pulls/${pr}/reviews`, 10);
  if (all === null) return null;
  return all.filter((r) => String(r?.user?.login ?? '').toLowerCase() === REVIEWER_LOGIN && String(r?.commit_id ?? '') === head);
}

/** The zip of an artifact, through GitHub's redirect to storage (fetched without the token), or null. */
async function downloadZip(ctx, artifactId) {
  try {
    const first = await ctx.fetch(`https://api.github.com/repos/${ctx.repo}/actions/artifacts/${artifactId}/zip`, {
      headers: { authorization: `Bearer ${ctx.readToken}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    const location = first.headers?.get?.('location');
    const res = first.status >= 300 && first.status < 400 && location
      ? await ctx.fetch(location, { signal: AbortSignal.timeout(30_000) })
      : first;
    if (res.status !== 200) return null;
    if (Number(res.headers?.get?.('content-length') ?? 0) > MAX_ARTIFACT_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length <= MAX_ARTIFACT_BYTES ? buf : null;
  } catch {
    return null;
  }
}

/** The run's newest redline-verdict artifact and its verdict.json, or a retry decision. */
async function readVerdict(ctx, run) {
  const listed = await read(ctx, `/repos/${ctx.repo}/actions/runs/${run.id}/artifacts?name=${VERDICT_ARTIFACT}&per_page=100`);
  if (!Array.isArray(listed?.artifacts)) return retry('could not list the run\'s artifacts');
  const art = listed.artifacts.filter((a) => a?.name === VERDICT_ARTIFACT).sort((a, b) => Number(b?.id ?? 0) - Number(a?.id ?? 0))[0];
  if (!art) return { artifact: null, verdictText: null };
  const artifact = {
    runId: Number(art.workflow_run?.id ?? 0),
    headSha: String(art.workflow_run?.head_sha ?? ''),
    expired: art.expired === true,
    sizeInBytes: Number(art.size_in_bytes ?? 0),
  };
  if (artifact.expired || artifact.sizeInBytes > MAX_ARTIFACT_BYTES) return { artifact, verdictText: null };
  const zip = await downloadZip(ctx, Number(art.id));
  if (!zip) return retry(`could not download the ${VERDICT_ARTIFACT} artifact`);
  const entry = zipEntry(zip, VERDICT_FILE);
  return { artifact, verdictText: entry ? entry.toString('utf8') : null };
}

/** The files a PR changes, or null unless every one was read. */
async function prFiles(ctx, pr) {
  const rows = await readAll(ctx, `/repos/${ctx.repo}/pulls/${pr.number}/files`, 30);
  if (rows === null || !Number.isInteger(pr.changed_files) || rows.length !== pr.changed_files) return null;
  return rows.map((f) => ({
    filename: String(f?.filename ?? ''),
    ...(f?.previous_filename ? { previousFilename: String(f.previous_filename) } : {}),
    status: String(f?.status ?? ''),
    patch: typeof f?.patch === 'string' ? f.patch : null,
  }));
}

/** Post the review once, as sprayberry-redline. Never retried; see the header. */
async function postReview(ctx, prNumber, review) {
  try {
    const res = await ctx.fetch(`https://api.github.com/repos/${ctx.repo}/pulls/${prNumber}/reviews`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.reviewToken}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
      body: JSON.stringify(review),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status < 200 || res.status >= 300) return { ok: false, why: `HTTP ${res.status} ${String(data?.message ?? '').slice(0, 200)}` };
    return { ok: true, url: String(data?.html_url ?? '') };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

/**
 * Decide one PR for one run, and post when every rule holds. `reread` is a dispatched re-read.
 * Returns { outcome: posted | skipped | refused | failed, pr, reason, url? }.
 */
async function decideAndPost(ctx, run, number, mode, defaultBranch, reread) {
  const at = (o, reason, extra = {}) => ({ outcome: o, pr: number, reason, ...extra });
  const end = (d) => at({ skip: 'skipped', refuse: 'refused', retry: 'failed' }[d.action], d.reason);
  const pr = await read(ctx, `/repos/${ctx.repo}/pulls/${number}`);
  if (!pr) return at('failed', `could not read #${number}`);
  const facts = {
    repo: ctx.repo, pr: number,
    prState: String(pr.state ?? ''), prHead: String(pr.head?.sha ?? ''), prHeadRepo: String(pr.head?.repo?.full_name ?? ''),
    defaultBranch, run,
  };
  let d;
  const reviewsNow = async () => {
    const mine = await reviewerReviews(ctx, number, facts.prHead);
    if (mine === null) return retry('could not read the reviews');
    const created = Date.parse(run.createdAt);
    return ruleNotYetReviewed({
      prHead: facts.prHead, reread,
      reviewsAtHead: mine.length,
      reviewsSinceRun: mine.filter((r) => !(Date.parse(String(r?.submitted_at ?? '')) < created)).length,
    });
  };

  if (mode === 'pull_request') {
    if ((d = await reviewsNow()) || (d = rulePrRun(facts))) return end(d);
    const files = await prFiles(ctx, pr);
    if ((d = ruleNoCiChanges({ files }))) return end(d);
    const own = files.find((f) => f.filename === CALLER_PATH);
    const x = referencedPin(run);
    let caller;
    let where = 'the PR head';
    if (own) {
      caller = await fileText(ctx, CALLER_PATH, facts.prHead);
    } else {
      const copies = await baseCallerCopies(ctx, String(pr.base?.ref ?? ''));
      const chosen = copies ? baseCallerChoice(copies, x) : null;
      caller = chosen ? chosen.text : null;
      where = chosen ? `the base branch at ${short(chosen.sha)}` : 'the base branch';
    }
    const pinCompare = x ? await compareStatus(ctx, `/repos/${x.repo}/compare/main...${x.sha}`) : null;
    d = rulePinnedOnMain({ run, caller, where, ...(own ? { patch: own.patch } : {}), pinCompare });
    if (d) return end(d);
  } else {
    if ((d = ruleDispatchRun(facts)) || (d = await reviewsNow())) return end(d);
    const runOnDefault = await compareStatus(ctx, `/repos/${ctx.repo}/compare/${encodeURIComponent(defaultBranch)}...${run.headSha}`);
    if ((d = ruleDispatchOnDefault({ run, defaultBranch, runOnDefault }))) return end(d);
    const caller = await fileText(ctx, CALLER_PATH, run.headSha);
    const x = referencedPin(run);
    const pinCompare = x ? await compareStatus(ctx, `/repos/${x.repo}/compare/main...${x.sha}`) : null;
    if ((d = rulePinnedOnMain({ run, caller, where: short(run.headSha), pinCompare }))) return end(d);
  }

  const verdict = await readVerdict(ctx, run);
  if (verdict.action) return end(verdict);
  d = ruleVerdictMatches({ repo: ctx.repo, pr: number, prHead: facts.prHead, run, ...verdict });
  if (d.action !== 'post') return end(d);
  // Read again at the last moment: another post may have landed, or the PR moved, while this one read.
  const again = await reviewsNow();
  if (again) return end(again);
  const now = await read(ctx, `/repos/${ctx.repo}/pulls/${number}`);
  if (!now) return at('failed', `could not read #${number} again before the post`);
  const moved = [
    ['state', pr.state, now.state], ['head', pr.head?.sha, now.head?.sha], ['base', pr.base?.ref, now.base?.ref],
  ].find(([, was, is]) => String(was ?? '') !== String(is ?? ''));
  if (moved) return at('skipped', `#${number}'s ${moved[0]} changed while this run read (${String(moved[1] ?? '')} to ${String(moved[2] ?? '')})`);
  const res = await postReview(ctx, number, d.review);
  if (!res.ok) return at('failed', `the post failed: ${res.why}`);
  return at('posted', `posted ${d.review.event} at ${short(facts.prHead)}`, { url: res.url });
}

/**
 * The PRs a pull_request run may be for: those GitHub lists on the run, and the open PRs whose head
 * is the run's commit. Each is then held to every rule. Null when neither list could be read.
 */
async function prsOfRun(ctx, raw, run) {
  const numbers = new Set((Array.isArray(raw?.pull_requests) ? raw.pull_requests : []).map((p) => Number(p?.number)).filter((n) => Number.isInteger(n) && n > 0));
  const byCommit = await read(ctx, `/repos/${ctx.repo}/commits/${run.headSha}/pulls?per_page=100`);
  if (!Array.isArray(byCommit) && numbers.size === 0) return null;
  for (const p of Array.isArray(byCommit) ? byCommit : []) {
    if (p?.state === 'open' && p?.head?.sha === run.headSha && Number.isInteger(p?.number)) numbers.add(p.number);
  }
  return [...numbers].sort((a, b) => a - b);
}

/**
 * Post the verdict of one finished Redline run. ctx: { repo, runId, readToken, reviewToken, fetch,
 * sleep, now, log }. Returns one result per PR the run was for ({ outcome, pr, reason, url? }), or a
 * single result with pr 0 when the run names none.
 */
export async function postRun(ctx) {
  const none = (outcome, reason) => [{ outcome, pr: 0, reason }];
  if (!/^[\w.-]+\/[\w.-]+$/.test(ctx.repo ?? '')) return none('failed', 'REPO must be owner/name');
  if (!/^[1-9]\d*$/.test(String(ctx.runId ?? ''))) return none('failed', 'RUN_ID must be a run id');
  if (!ctx.reviewToken) return none('failed', 'no reviewer token: the caller passes the REDLINE_REVIEWER_TOKEN secret as reviewer-token');
  const raw = await read(ctx, `/repos/${ctx.repo}/actions/runs/${ctx.runId}`);
  if (!raw) return none('failed', `could not read run ${ctx.runId}`);
  const run = runFromApi(raw);
  if (run.path !== CALLER_PATH) return none('skipped', `run ${run.id} is ${run.path || 'no workflow'}, not ${CALLER_PATH}`);
  if (run.conclusion !== 'success' && run.conclusion !== 'failure') return none('skipped', `run ${run.id} concluded ${run.conclusion ?? 'nothing yet'}`);

  if (run.event === 'pull_request') {
    const prs = await prsOfRun(ctx, raw, run);
    if (prs === null) return none('failed', `could not list the PRs at ${short(run.headSha)}`);
    if (prs.length === 0) return none('skipped', `no open PR is at ${short(run.headSha)}`);
    const out = [];
    for (const n of prs) out.push(await decideAndPost(ctx, run, n, 'pull_request', '', false));
    return out;
  }
  if (run.event === 'workflow_dispatch') {
    const t = parseDispatchTitle(run.title);
    if (!t) return none('skipped', `run ${run.id} is titled ${JSON.stringify(run.title).slice(0, 100)}, which names no review`);
    const repo = await read(ctx, `/repos/${ctx.repo}`);
    const defaultBranch = String(repo?.default_branch ?? '');
    if (!defaultBranch) return none('failed', 'could not read the default branch');
    return [await decideAndPost(ctx, run, t.pr, 'dispatch', defaultBranch, t.reread)];
  }
  return none('skipped', `run ${run.id} ran on ${run.event}`);
}

/** The exit code for a set of results: 1 when any read or post failed, else 0. */
export function exitCode(results) {
  return results.some((r) => r.outcome === 'failed') ? 1 : 0;
}

async function main() {
  const env = process.env;
  const ctx = {
    repo: env.REPO,
    runId: env.RUN_ID,
    readToken: env.GH_READ_TOKEN,
    reviewToken: env.REDLINE_REVIEWER_TOKEN,
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    log: (line) => console.log(line),
  };
  const results = await postRun(ctx);
  for (const r of results) {
    const ref = r.pr ? `${ctx.repo}#${r.pr}` : `${ctx.repo} run ${ctx.runId}`;
    const line = `${ref}: ${r.outcome}: ${r.reason}${r.url ? ` ${r.url}` : ''}`;
    if (r.outcome === 'failed') console.log(`::error::${line}`);
    else if (r.outcome === 'refused') console.log(`::warning::${line}`);
    else console.log(line);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  }
  process.exit(exitCode(results));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error(`::error::Redline post failed: ${e.message}`); process.exit(1); });
}
