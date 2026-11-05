// Fuzz what the verdict post reads before it posts a review as the reviewer account: the Redline
// run's artifact (a zip archive built by the PR's own job), the verdict.json inside it, the run
// record and dispatch title the API returns, the PR's patch to its caller workflow and the caller
// workflow's text. The post runs with the reviewer token, and none of this is taken on trust, so
// each reader must refuse what it cannot read and never throw past its caller or post on a guess.
// Contracts: zipEntry returns null or a buffer no longer than its cap and never throws; every
// rule returns null or a decision; ruleVerdictMatches posts only a verdict that verdictProblem
// accepts, for the PR head it was given, unposted, with an event that agrees with the run;
// parseDispatchTitle, callerPin, pinOnlyPatchSha and runFromApi return their documented shapes.
// The input is five fields: a caller workflow, a patch, a run title, a JSON text (a verdict, and a
// run record when it parses as one), each ended by a NUL byte, then the zip archive to the end.
import {
  MAX_ARTIFACT_BYTES,
  VERDICT_FILE,
  baseCallerChoice,
  callerPin,
  parseDispatchTitle,
  pinOnlyPatchSha,
  referencedPin,
  ruleDispatchRun,
  rulePinnedOnMain,
  rulePrRun,
  ruleVerdictMatches,
  runFromApi,
  zipEntry,
} from '../scripts/redline/post.mjs';
import { verdictProblem } from '../scripts/redline/review.mjs';
import { fail } from './violation.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const DECISIONS = ['skip', 'refuse', 'retry', 'post'];

function fields(data) {
  const out = [];
  let at = 0;
  for (let i = 0; i < 4; i++) {
    const nul = data.indexOf(0, at);
    if (nul < 0) { out.push(data.subarray(at).toString('utf8')); at = data.length; continue; }
    out.push(data.subarray(at, nul).toString('utf8'));
    at = nul + 1;
  }
  return { texts: out, zip: data.subarray(at) };
}

function decision(d) {
  if (d !== null && (typeof d !== 'object' || !DECISIONS.includes(d.action))) fail('a rule returned something that is not a decision');
  return d;
}

export function fuzz(data) {
  const { texts: [yaml, patch, title, json], zip } = fields(data);

  // The artifact. An entry is named by the post and by the archive; a hostile archive may hold
  // either name any number of times, or lie about its sizes.
  for (const [name, cap] of [[VERDICT_FILE, MAX_ARTIFACT_BYTES], ['a', 16], ['', 0]]) {
    const entry = zipEntry(zip, name, cap);
    if (entry !== null && (!Buffer.isBuffer(entry) || entry.length > cap)) fail(`zipEntry returned more than its ${cap} byte cap`);
  }
  const fromZip = zipEntry(zip, VERDICT_FILE);

  const t = parseDispatchTitle(title);
  if (t !== null && (!Number.isInteger(t.pr) || t.pr < 1 || !/^[0-9a-f]{40}$/.test(t.head) || typeof t.repo !== 'string' || typeof t.reread !== 'boolean')) fail('parseDispatchTitle returned a malformed title');

  const pin = callerPin(yaml);
  if (pin !== null && (typeof pin.repo !== 'string' || typeof pin.uses !== 'string' || typeof pin.ref !== 'string')) fail('callerPin returned a malformed pin');
  const patchSha = pinOnlyPatchSha(patch);
  if (patchSha !== null && !/^[0-9a-f]{40}$/.test(patchSha)) fail('pinOnlyPatchSha returned something that is not a full sha');
  const chosen = baseCallerChoice([{ sha: 'a', text: yaml }, { sha: 'b', text: patch }, { sha: 'c', text: null }], pin ? { repo: pin.repo, sha: pin.uses } : null);
  if (!chosen || typeof chosen !== 'object') fail('baseCallerChoice chose no copy');

  let parsed;
  try { parsed = JSON.parse(json); } catch { parsed = null; }
  const run = runFromApi(parsed);
  for (const key of ['title', 'path', 'event', 'status', 'actor', 'triggeringActor', 'headSha', 'headBranch', 'headRepo', 'repo', 'createdAt']) {
    if (typeof run[key] !== 'string') fail(`runFromApi gave a non-string ${key}`);
  }
  if (typeof run.id !== 'number' || typeof run.runAttempt !== 'number' || !Array.isArray(run.referencedWorkflows)) fail('runFromApi returned a malformed run');
  const x = referencedPin(run);
  if (x !== null && !/^[0-9a-f]{40}$/.test(x.sha)) fail('referencedPin accepted something that is not a full sha');

  // The rules over that run, with the PR facts a hostile run could try to line up with.
  decision(rulePrRun({ repo: run.repo, prState: 'open', prHead: run.headSha, prHeadRepo: run.headRepo, run }));
  decision(ruleDispatchRun({ repo: t?.repo ?? run.repo, pr: t?.pr ?? 1, prState: 'open', prHead: t?.head ?? SHA, prHeadRepo: 'o/r', defaultBranch: run.headBranch, run }));
  for (const pinCompare of ['identical', 'behind', 'ahead', null]) {
    decision(rulePinnedOnMain({ run, caller: yaml, where: 'x', patch, pinCompare }));
    decision(rulePinnedOnMain({ run, caller: null, where: 'x', patch: undefined, pinCompare }));
  }

  // The verdict: from the JSON field and from the archive, against the PR head the verdict names
  // (the one a post would need) and against a head it does not name.
  const fact = { repo: 'o/r', pr: 1, run: { id: 1, headSha: SHA, conclusion: 'success' } };
  const artifact = { runId: 1, headSha: SHA, expired: false, sizeInBytes: 10 };
  const candidates = [json, fromZip === null ? null : fromZip.toString('utf8')];
  let verdict = null;
  try { verdict = JSON.parse(json); } catch { /* not JSON: refused below */ }
  const named = verdict && typeof verdict === 'object' ? { repo: verdict.repo, pr: verdict.pr, prHead: verdict.head_sha } : null;
  for (const verdictText of candidates) {
    for (const facts of [{ repo: fact.repo, pr: fact.pr, prHead: SHA }, ...(named ? [named] : [])]) {
      for (const conclusion of ['success', 'failure', 'cancelled']) {
        const d = decision(ruleVerdictMatches({ ...facts, run: { ...fact.run, conclusion }, artifact, verdictText }));
        if (!d || d.action !== 'post') continue;
        const v = JSON.parse(verdictText);
        if (verdictProblem(v) !== null) fail('ruleVerdictMatches posted a verdict that verdictProblem refuses');
        if (v.posted !== false || v.head_sha !== facts.prHead || v.repo !== facts.repo || v.pr !== facts.pr) fail('ruleVerdictMatches posted a verdict for another PR or one already posted');
        if ((d.review.event === 'APPROVE') !== (conclusion === 'success')) fail('ruleVerdictMatches posted an event that disagrees with the run');
      }
    }
  }
}
