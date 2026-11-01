// Tests for scripts/redline/post.mjs. Run: node scripts/redline/post.test.mjs
// GitHub is stubbed through ctx.fetch; nothing leaves the machine.

import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseDispatchTitle, pinOnlyPatchSha, callerPin, referencedPin, runFromApi, zipEntry, exitCode, postRun,
  ruleNotYetReviewed, rulePrRun, ruleDispatchRun, ruleNoCiChanges, ruleDispatchOnDefault, rulePinnedOnMain, ruleVerdictMatches,
  CALLER_PATH,
} from './post.mjs';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}`); fail++; }
}

const REPO = 'askalf/demo';
const HEAD = '47536435fb5c9540d8cb36fd26d81e101955b364';
const MAIN = '1111111111111111111111111111111111111111';
/** The base branch's newest commit to redline.yml from before the run. */
const BASE_AT_RUN = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const X = '5305beec29bdd65ff79d5b431d8c3a25fe945bb1';
const Y = '34b7875f46525f7899a4e6601fbca4be75443903';
const RUN_ID = 900;
const ART_ID = 77;

const caller = (sha = X, ref = sha, repo = 'askalf/ci') => [
  'name: Redline',
  'jobs:',
  '  review:',
  `    uses: ${repo}/.github/workflows/redline-review.yml@${sha} # main`,
  '    with:',
  `      redline-ref: ${ref}`,
  '      runner-label: redline',
  '',
].join('\n');
const pinPatch = (from, to) => [
  '@@ -1,4 +1,4 @@',
  `-    uses: askalf/ci/.github/workflows/redline-review.yml@${from} # main`,
  `+    uses: askalf/ci/.github/workflows/redline-review.yml@${to} # main`,
  '     with:',
  `-      redline-ref: ${from}`,
  `+      redline-ref: ${to}`,
].join('\n');

/** A zip of one entry; deflated or stored. */
function makeZip(name, text, deflate = true) {
  const data = Buffer.from(text, 'utf8');
  const body = deflate ? deflateRawSync(data) : data;
  const n = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(deflate ? 8 : 0, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(deflate ? 8 : 0, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + n.length + body.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + n.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, n, body, central, n, eocd]);
}

const verdict = (over = {}) => ({
  version: 1, repo: REPO, pr: 5, head_sha: HEAD, event: 'APPROVE', body: 'Looks right.',
  comments: [], posted: false, ...over,
});

const prRunRaw = (over = {}) => ({
  id: RUN_ID, run_attempt: 1, display_title: 'Add a thing', path: CALLER_PATH, event: 'pull_request',
  status: 'completed', conclusion: 'success', actor: { login: 'someone' }, triggering_actor: { login: 'someone' },
  head_sha: HEAD, head_branch: 'feature', head_repository: { full_name: REPO }, repository: { full_name: REPO },
  created_at: '2026-11-01T10:00:00Z', pull_requests: [{ number: 5 }],
  referenced_workflows: [{ path: `askalf/ci/.github/workflows/redline-review.yml@${X}`, sha: X }],
  ...over,
});
const dispatchRunRaw = (over = {}) => prRunRaw({
  display_title: `Redline review ${REPO}#5 @ ${HEAD}`, event: 'workflow_dispatch', actor: { login: 'askalf' },
  triggering_actor: { login: 'askalf' }, head_sha: MAIN, head_branch: 'main', pull_requests: [], ...over,
});

const json = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body, text: async () => JSON.stringify(body),
  arrayBuffer: async () => new ArrayBuffer(0),
});
const bytes = (buf) => ({
  status: 200, ok: true, headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(buf.length) : null) },
  json: async () => ({}), text: async () => '', arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
});

/**
 * A stub GitHub for one PR. `o` overrides any fact; `o.reviews` may be a list of review lists, one
 * per read, the last repeating, and `o.prs` a list of PR states, one per read, the last repeating.
 * `o.baseCommits` answers the base branch's history of redline.yml.
 */
function world(o = {}) {
  const s = {
    run: prRunRaw(), pr: { number: 5, state: 'open', head: { sha: HEAD, repo: { full_name: REPO } }, base: { ref: 'main' }, changed_files: 1 },
    files: [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }],
    callerAt: { main: caller(), [HEAD]: caller(), [MAIN]: caller() },
    pinCompare: 'behind', defaultCompare: 'identical', reviews: [[]], verdict: verdict(),
    artifact: { id: ART_ID, name: 'redline-verdict', expired: false, size_in_bytes: 500, workflow_run: { id: RUN_ID, head_sha: (o.run ?? prRunRaw()).head_sha } },
    postStatus: 200, commitPulls: null, failRead: null, prs: null,
    baseCommits: [{ sha: BASE_AT_RUN }],
    ...o,
  };
  s.callerAt = { [BASE_AT_RUN]: s.callerAt.main, ...s.callerAt };
  const calls = [];
  let reviewReads = 0;
  let prReads = 0;
  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, init });
    if (url === 'https://storage.example/zip') return bytes(s.zip ?? makeZip('verdict.json', JSON.stringify(s.verdict)));
    const path = url.replace('https://api.github.com', '');
    if (s.failRead && s.failRead.test(path)) return json(404, { message: 'Not Found' });
    const [p, q = ''] = path.split('?');
    const params = new URLSearchParams(q);
    if (p === `/repos/${REPO}/actions/runs/${RUN_ID}`) return json(200, s.run);
    if (p === `/repos/${REPO}`) return json(200, { default_branch: 'main' });
    if (p === `/repos/${REPO}/pulls/5`) return json(200, s.prs ? s.prs[Math.min(prReads++, s.prs.length - 1)] : s.pr);
    if (p === `/repos/${REPO}/commits` && params.get('path') === CALLER_PATH) {
      return Date.parse(params.get('until')) === Date.parse(s.run.created_at) && params.get('sha') === s.pr.base.ref ? json(200, s.baseCommits) : json(200, []);
    }
    if (p === `/repos/${REPO}/pulls/5/files`) return json(200, params.get('page') === '1' ? s.files : []);
    if (p === `/repos/${REPO}/commits/${s.run.head_sha}/pulls`) return json(200, s.commitPulls ?? []);
    if (p === `/repos/${REPO}/contents/${CALLER_PATH}`) {
      const text = s.callerAt[params.get('ref')];
      return text === undefined ? json(404, {}) : json(200, { encoding: 'base64', content: Buffer.from(text).toString('base64') });
    }
    if (p.startsWith('/repos/askalf/ci/compare/main...')) return json(200, { status: s.pinCompare });
    if (p.startsWith(`/repos/${REPO}/compare/main...`)) return json(200, { status: s.defaultCompare });
    if (p === `/repos/${REPO}/actions/runs/${RUN_ID}/artifacts`) return json(200, { artifacts: s.artifact ? [s.artifact] : [] });
    if (p === `/repos/${REPO}/actions/artifacts/${ART_ID}/zip`) return json(302, {}, { location: 'https://storage.example/zip' });
    if (p === `/repos/${REPO}/pulls/5/reviews` && method === 'GET') {
      if (params.get('page') !== '1') return json(200, []);
      const list = s.reviews[Math.min(reviewReads, s.reviews.length - 1)];
      reviewReads++;
      return json(200, list);
    }
    if (p === `/repos/${REPO}/pulls/5/reviews` && method === 'POST') {
      return json(s.postStatus, s.postStatus === 200 ? { html_url: 'https://github.com/askalf/demo/pull/5#review' } : { message: 'nope' });
    }
    return json(404, { message: `no stub for ${method} ${p}` });
  };
  const ctx = { repo: REPO, runId: String(RUN_ID), readToken: 'read', reviewToken: 'review', fetch, sleep: async () => {}, now: () => 0, log: () => {} };
  return { s, ctx, calls, posts: () => calls.filter((c) => c.method === 'POST') };
}

console.log('\n  parseDispatchTitle');
{
  const t = parseDispatchTitle(`Redline review askalf/ci#12 @ ${HEAD} (re-read)`);
  check('owner/name, PR, head and re-read', t.repo === 'askalf/ci' && t.pr === 12 && t.head === HEAD && t.reread === true);
  check('not a re-read', parseDispatchTitle(`Redline review askalf/ci#12 @ ${HEAD}`).reread === false);
  check('a short sha is no title', parseDispatchTitle('Redline review askalf/ci#12 @ 4753643') === null);
  check('a PR title is no title', parseDispatchTitle('Fix the thing') === null);
}

console.log('\n  pinOnlyPatchSha');
{
  check('a bump of both lines names the new sha', pinOnlyPatchSha(pinPatch(Y, X)) === X);
  check('a bump to two shas is not a pin bump', pinOnlyPatchSha(pinPatch(Y, X).replace(`redline-ref: ${X}`, `redline-ref: ${Y}`)) === null);
  check('any other changed line is not a pin bump', pinOnlyPatchSha(`${pinPatch(Y, X)}\n+    secrets: inherit`) === null);
  check('no patch is not a pin bump', pinOnlyPatchSha(null) === null);
}

console.log('\n  callerPin and referencedPin');
{
  check('a caller pins one repo and sha', JSON.stringify(callerPin(caller())) === JSON.stringify({ repo: 'askalf/ci', uses: X, ref: X }));
  check('two uses lines are no pin', callerPin(caller() + caller()) === null);
  check('a commented uses line is ignored', callerPin(`# uses: askalf/ci/.github/workflows/redline-review.yml@${Y}\n${caller()}`)?.uses === X);
  check('the run\'s one referenced workflow', referencedPin(runFromApi(prRunRaw()))?.sha === X);
  check('a referenced workflow at a branch is no pin', referencedPin(runFromApi(prRunRaw({ referenced_workflows: [{ path: 'askalf/ci/.github/workflows/redline-review.yml@main', sha: X }] }))) === null);
  check('a referenced workflow from another repo is no pin', referencedPin(runFromApi(prRunRaw({ referenced_workflows: [{ path: `evil/ci/.github/workflows/redline-review.yml@${X}`, sha: X }] }))) === null);
  check('two referenced workflows are no pin', referencedPin(runFromApi(prRunRaw({ referenced_workflows: [prRunRaw().referenced_workflows[0], prRunRaw().referenced_workflows[0]] }))) === null);
}

console.log('\n  the rules');
{
  const run = runFromApi(prRunRaw());
  const facts = { repo: REPO, pr: 5, prState: 'open', prHead: HEAD, prHeadRepo: REPO, defaultBranch: 'main', run };
  check('rule 1 holds for the PR\'s own run', rulePrRun(facts) === null);
  check('rule 1 skips a run at an older head', rulePrRun({ ...facts, prHead: Y })?.action === 'skip');
  check('rule 1 skips a fork head', rulePrRun({ ...facts, prHeadRepo: 'fork/demo' })?.action === 'skip');
  check('rule 1 skips a closed PR', rulePrRun({ ...facts, prState: 'closed' })?.action === 'skip');
  const drun = runFromApi(dispatchRunRaw());
  check('dispatch rule 1 holds for askalf\'s dispatch', ruleDispatchRun({ ...facts, run: drun }) === null);
  check('dispatch rule 1 skips anyone else\'s dispatch', ruleDispatchRun({ ...facts, run: { ...drun, triggeringActor: 'mallory' } })?.action === 'skip');
  check('dispatch rule 1 skips a dispatch on another branch', ruleDispatchRun({ ...facts, run: { ...drun, headBranch: 'feature' } })?.action === 'skip');
  check('dispatch rule 1 skips a title for another repo', ruleDispatchRun({ ...facts, run: { ...drun, title: `Redline review askalf/other#5 @ ${HEAD}` } })?.action === 'skip');
  check('dispatch rule 1 allows a fork head', ruleDispatchRun({ ...facts, prHeadRepo: 'fork/demo', run: drun }) === null);
  check('rule 5 skips a reviewed head', ruleNotYetReviewed({ prHead: HEAD, reviewsAtHead: 1 })?.action === 'skip');
  check('rule 5 lets a re-read past an older review', ruleNotYetReviewed({ prHead: HEAD, reviewsAtHead: 1, reviewsSinceRun: 0, reread: true }) === null);
  check('rule 2 holds for code only', ruleNoCiChanges({ files: [{ filename: 'src/a.js', status: 'modified' }] }) === null);
  check('rule 2 holds for a pin bump', ruleNoCiChanges({ files: [{ filename: CALLER_PATH, status: 'modified', patch: pinPatch(Y, X) }] }) === null);
  check('rule 2 skips a workflow change', ruleNoCiChanges({ files: [{ filename: '.github/workflows/ci.yml', status: 'modified', patch: '' }] })?.action === 'skip');
  check('rule 2 skips a file renamed out of .github/actions', ruleNoCiChanges({ files: [{ filename: 'x.yml', previousFilename: '.github/actions/a/action.yml', status: 'renamed' }] })?.action === 'skip');
  check('rule 2 waits on an unread file list', ruleNoCiChanges({ files: null })?.action === 'retry');
  check('dispatch rule 2 refuses a commit off the default branch', ruleDispatchOnDefault({ run: drun, defaultBranch: 'main', runOnDefault: 'diverged' })?.action === 'refuse');
  check('dispatch rule 2 holds on the default branch', ruleDispatchOnDefault({ run: drun, defaultBranch: 'main', runOnDefault: 'behind' }) === null);
  const r3 = (o) => rulePinnedOnMain({ run, caller: caller(), where: 'the base branch', pinCompare: 'behind', ...o });
  check('rule 3 holds', r3({}) === null);
  check('rule 3 refuses a caller pinned elsewhere', r3({ caller: caller(Y) })?.action === 'refuse');
  check('rule 3 refuses a split pin', r3({ caller: caller(X, Y) })?.action === 'refuse');
  check('rule 3 refuses a sha off main', r3({ pinCompare: 'diverged' })?.action === 'refuse');
  check('rule 3 refuses a pin patch to another sha', r3({ patch: pinPatch(X, Y) })?.action === 'refuse');
  check('rule 3 waits on an unread caller', r3({ caller: null })?.action === 'retry');
  const r4 = (o = {}, v = verdict()) => ruleVerdictMatches({
    repo: REPO, pr: 5, prHead: HEAD, run,
    artifact: { runId: RUN_ID, headSha: HEAD, expired: false, sizeInBytes: 500 }, verdictText: JSON.stringify(v), ...o,
  });
  check('rule 4 posts the verdict at the head', r4().action === 'post' && r4().review.commit_id === HEAD && r4().review.event === 'APPROVE');
  check('rule 4 refuses REQUEST_CHANGES on a successful run', r4({}, verdict({ event: 'REQUEST_CHANGES', comments: [{ path: 'a', line: 1, side: 'RIGHT', body: 'b', extra: 1 }] })).action === 'refuse');
  {
    const failed = ruleVerdictMatches({ repo: REPO, pr: 5, prHead: HEAD, run: { ...run, conclusion: 'failure' },
      artifact: { runId: RUN_ID, headSha: HEAD, expired: false, sizeInBytes: 500 },
      verdictText: JSON.stringify(verdict({ event: 'REQUEST_CHANGES', comments: [{ path: 'a', line: 1, side: 'RIGHT', body: 'b', extra: 1 }] })) });
    check('rule 4 posts REQUEST_CHANGES on a failed run', failed.action === 'post' && failed.review.event === 'REQUEST_CHANGES' && !('extra' in failed.review.comments[0]));
  }
  check('rule 4 refuses an APPROVE on a failed run', r4({ run: { ...run, conclusion: 'failure' } }).action === 'refuse');
  check('rule 4 refuses a verdict for another head', r4({}, verdict({ head_sha: Y })).action === 'refuse');
  check('rule 4 refuses a verdict for another PR', r4({}, verdict({ pr: 6 })).action === 'refuse');
  check('rule 4 refuses a verdict already posted', r4({}, verdict({ posted: true })).action === 'refuse');
  check('rule 4 refuses an artifact of another run', r4({ artifact: { runId: 1, headSha: HEAD, expired: false, sizeInBytes: 500 } }).action === 'refuse');
  check('rule 4 refuses a missing artifact', r4({ artifact: null }).action === 'refuse');
  check('rule 4 refuses text that is not JSON', r4({ verdictText: '{' }).action === 'refuse');
}

console.log('\n  zipEntry');
{
  check('a deflated entry', zipEntry(makeZip('verdict.json', '{"a":1}'), 'verdict.json')?.toString() === '{"a":1}');
  check('a stored entry', zipEntry(makeZip('verdict.json', '{"a":1}', false), 'verdict.json')?.toString() === '{"a":1}');
  check('an absent entry', zipEntry(makeZip('other.json', '{}'), 'verdict.json') === null);
  check('an entry over the cap', zipEntry(makeZip('verdict.json', 'x'.repeat(100)), 'verdict.json', 50) === null);
  check('not a zip', zipEntry(Buffer.from('nope'), 'verdict.json') === null);
}

console.log('\n  postRun, pull_request');
{
  const w = world();
  const out = await postRun(w.ctx);
  check('posts the verdict', out.length === 1 && out[0].outcome === 'posted' && w.posts().length === 1);
  const post = w.posts()[0];
  check('as the reviewer token', post.init.headers.authorization === 'Bearer review');
  check('at the head', JSON.parse(post.init.body).commit_id === HEAD && JSON.parse(post.init.body).event === 'APPROVE');
  check('reads with the read token only', w.calls.filter((c) => c.method === 'GET' && c.url.startsWith('https://api.github.com')).every((c) => c.init.headers.authorization === 'Bearer read'));
  check('the storage download carries no token', !w.calls.find((c) => c.url === 'https://storage.example/zip').init.headers);
  check('exit 0', exitCode(out) === 0);
}
{
  const w = world({ reviews: [[{ user: { login: 'sprayberry-redline' }, commit_id: HEAD, submitted_at: '2026-11-01T10:05:00Z' }]] });
  const out = await postRun(w.ctx);
  check('a reviewed head is skipped, nothing posted', out[0].outcome === 'skipped' && w.posts().length === 0);
}
{
  const w = world({ reviews: [[], [{ user: { login: 'sprayberry-redline' }, commit_id: HEAD, submitted_at: '2026-11-01T10:05:00Z' }]] });
  const out = await postRun(w.ctx);
  check('a review that lands while this one reads stops the post', out[0].outcome === 'skipped' && w.posts().length === 0);
}
{
  const w = world({ run: prRunRaw({ conclusion: 'failure' }) });
  const out = await postRun(w.ctx);
  check('an APPROVE from a failed run is refused, nothing posted', out[0].outcome === 'refused' && w.posts().length === 0 && exitCode(out) === 0);
}
{
  const w = world({ files: [{ filename: '.github/workflows/ci.yml', status: 'modified', patch: '+x' }] });
  const out = await postRun(w.ctx);
  check('a PR that changes CI is skipped for dispatch mode', out[0].outcome === 'skipped' && w.posts().length === 0);
}
{
  const w = world({
    files: [{ filename: CALLER_PATH, status: 'modified', patch: pinPatch(Y, X) }],
    callerAt: { main: caller(Y), [HEAD]: caller(X) },
  });
  const out = await postRun(w.ctx);
  check('a pin bump is judged by the caller at the head', out[0].outcome === 'posted');
}
{
  const w = world({ callerAt: { main: caller(Y) } });
  const out = await postRun(w.ctx);
  check('a run whose pin the base caller does not name is refused', out[0].outcome === 'refused' && w.posts().length === 0);
}
{
  // The run used X; a bump to Y merged on the base branch before this job read the caller.
  const w = world({ callerAt: { main: caller(Y), [BASE_AT_RUN]: caller(X) } });
  const out = await postRun(w.ctx);
  check('a pin bump merged after the run does not refuse its verdict', out[0].outcome === 'posted' && w.posts().length === 1);
  check('the caller is read at the base commit from before the run, never the base tip',
    w.calls.some((c) => c.url.includes(`/contents/${CALLER_PATH}?ref=${BASE_AT_RUN}`)) && !w.calls.some((c) => c.url.includes(`/contents/${CALLER_PATH}?ref=main`)));
}
{
  const w = world({ callerAt: { main: caller(X), [BASE_AT_RUN]: caller(Y) } });
  const out = await postRun(w.ctx);
  check('a base tip that pins the run\'s sha does not stand in for the copy the run used', out[0].outcome === 'refused' && w.posts().length === 0);
}
{
  const w = world({ baseCommits: [] });
  const out = await postRun(w.ctx);
  check('no base commit to redline.yml before the run fails the run, nothing posted', out[0].outcome === 'failed' && w.posts().length === 0);
}
{
  const w = world({ failRead: /\/commits\?/ });
  const out = await postRun(w.ctx);
  check('an unread base history fails the run, nothing posted', out[0].outcome === 'failed' && w.posts().length === 0);
}
{
  const pr = { number: 5, state: 'open', head: { sha: HEAD, repo: { full_name: REPO } }, base: { ref: 'main' }, changed_files: 1 };
  const w = world({ prs: [pr, { ...pr, head: { sha: Y, repo: { full_name: REPO } } }] });
  const out = await postRun(w.ctx);
  check('a push while the artifact was read stops the post', out[0].outcome === 'skipped' && /head changed/.test(out[0].reason) && w.posts().length === 0);
  const w2 = world({ prs: [pr, { ...pr, base: { ref: 'release' } }] });
  const out2 = await postRun(w2.ctx);
  check('a base changed while this one read stops the post', out2[0].outcome === 'skipped' && /base changed/.test(out2[0].reason) && w2.posts().length === 0);
  const w3 = world({ prs: [pr, { ...pr, state: 'closed' }] });
  const out3 = await postRun(w3.ctx);
  check('a PR closed while this one read stops the post', out3[0].outcome === 'skipped' && /state changed/.test(out3[0].reason) && w3.posts().length === 0);
  const w4 = world({ failRead: null });
  const order = (await postRun(w4.ctx), w4.calls.map((c) => `${c.method} ${c.url.replace('https://api.github.com', '').split('?')[0]}`));
  const lastPrRead = order.lastIndexOf(`GET /repos/${REPO}/pulls/5`);
  check('the PR is read again after the artifact, just before the post',
    lastPrRead > order.findIndex((c) => c.includes('/artifacts/')) && order[lastPrRead + 1] === `POST /repos/${REPO}/pulls/5/reviews`);
}
{
  const w = world({ pinCompare: 'ahead' });
  const out = await postRun(w.ctx);
  check('a pin off askalf/ci main is refused', out[0].outcome === 'refused' && w.posts().length === 0);
}
{
  const w = world({ postStatus: 422 });
  const out = await postRun(w.ctx);
  check('a failed post fails the run, sent once', out[0].outcome === 'failed' && w.posts().length === 1 && exitCode(out) === 1);
}
{
  const w = world({ failRead: /\/contents\// });
  const out = await postRun(w.ctx);
  check('an unread caller fails the run, nothing posted', out[0].outcome === 'failed' && w.posts().length === 0 && exitCode(out) === 1);
}
{
  const w = world({ artifact: null });
  const out = await postRun(w.ctx);
  check('a run with no artifact is refused', out[0].outcome === 'refused' && w.posts().length === 0);
}
{
  const w = world({ run: prRunRaw({ pull_requests: [] }), commitPulls: [{ number: 5, state: 'open', head: { sha: HEAD } }] });
  const out = await postRun(w.ctx);
  check('the PR is found by its commit when the run lists none', out[0].outcome === 'posted' && out[0].pr === 5);
}
{
  const w = world({ run: prRunRaw({ pull_requests: [] }) });
  const out = await postRun(w.ctx);
  check('no open PR at the commit is a skip', out[0].outcome === 'skipped' && out[0].pr === 0);
}
{
  const w = world({ run: prRunRaw({ conclusion: 'cancelled' }) });
  const out = await postRun(w.ctx);
  check('a cancelled run is a skip', out[0].outcome === 'skipped' && w.calls.length === 1);
}
{
  const w = world({ run: prRunRaw({ path: '.github/workflows/other.yml' }) });
  const out = await postRun(w.ctx);
  check('another workflow\'s run is a skip', out[0].outcome === 'skipped');
}
{
  const w = world();
  const out = await postRun({ ...w.ctx, reviewToken: '' });
  check('no reviewer token fails before any read', out[0].outcome === 'failed' && w.calls.length === 0);
}

console.log('\n  postRun, dispatch');
{
  const w = world({ run: dispatchRunRaw() });
  const out = await postRun(w.ctx);
  check('posts askalf\'s dispatched verdict', out[0].outcome === 'posted' && out[0].pr === 5 && w.posts().length === 1);
  check('reads redline.yml at the run\'s commit', w.calls.some((c) => c.url.includes(`/contents/${CALLER_PATH}?ref=${MAIN}`)));
}
{
  const w = world({ run: dispatchRunRaw({ actor: { login: 'mallory' }, triggering_actor: { login: 'mallory' } }) });
  const out = await postRun(w.ctx);
  check('anyone else\'s dispatch is a skip', out[0].outcome === 'skipped' && w.posts().length === 0);
}
{
  const w = world({ run: dispatchRunRaw(), defaultCompare: 'ahead' });
  const out = await postRun(w.ctx);
  check('a dispatch at a commit off the default branch is refused', out[0].outcome === 'refused' && w.posts().length === 0);
}
{
  const w = world({ run: dispatchRunRaw({ display_title: `Redline review ${REPO}#5 @ ${HEAD} (re-read)` }),
    reviews: [[{ user: { login: 'sprayberry-redline' }, commit_id: HEAD, submitted_at: '2026-11-01T09:00:00Z' }]] });
  const out = await postRun(w.ctx);
  check('a re-read posts past a review from before it', out[0].outcome === 'posted');
}
{
  const w = world({ run: dispatchRunRaw({ display_title: `Redline review ${REPO}#5 @ ${HEAD} (re-read)` }),
    reviews: [[{ user: { login: 'sprayberry-redline' }, commit_id: HEAD, submitted_at: '2026-11-01T10:30:00Z' }]] });
  const out = await postRun(w.ctx);
  check('a re-read already answered is a skip', out[0].outcome === 'skipped' && w.posts().length === 0);
}
{
  const w = world({ run: dispatchRunRaw({ display_title: `Redline review ${REPO}#5 @ ${Y}` }) });
  const out = await postRun(w.ctx);
  check('a dispatch for an older head is a skip', out[0].outcome === 'skipped' && w.posts().length === 0);
}
{
  const pr = { number: 5, state: 'open', head: { sha: HEAD, repo: { full_name: REPO } }, base: { ref: 'main' }, changed_files: 1 };
  const w = world({ run: dispatchRunRaw(), prs: [pr, { ...pr, head: { sha: Y, repo: { full_name: REPO } } }] });
  const out = await postRun(w.ctx);
  check('a push while a dispatched verdict was read stops the post', out[0].outcome === 'skipped' && w.posts().length === 0);
}

console.log('\n  redline-post-verdict.yml');
{
  // Two runs for one head finish together: their post jobs must not both pass rule 5 and both post.
  const yml = readFileSync(fileURLToPath(new URL('../../.github/workflows/redline-post-verdict.yml', import.meta.url)), 'utf8');
  const job = yml.slice(yml.indexOf('\n  post:\n'));
  const group = /\n    concurrency:\n      group: (.+)\n      cancel-in-progress: (.+)\n/.exec(job);
  check('the post job has a concurrency group', group !== null);
  check('a running post is never cancelled', group?.[2].trim() === 'false');
  check('the group is per repository', group?.[1].includes('${{ github.repository }}'));
  check('two pull_request runs at one head share a group', group?.[1].includes('github.event.workflow_run.head_sha'));
  check('a dispatch shares a group with every dispatch for its PR and head', group?.[1].includes('github.event.workflow_run.display_title'));
  check('the group is not keyed by the run id', !group?.[1].includes('workflow_run.id'));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
