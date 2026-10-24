// Unit tests for fleet-status.mjs, and its CLI against a stubbed GitHub.
// Run: node scripts/fleet-status/fleet-status.test.mjs
// The checks on a caller's workflows are check.mjs, tested by check.test.mjs.

import {
  laneStatuses,
  isCodePath,
  isBotPr,
  latestByContext,
  statusesToPost,
  verifiedAtHead,
  CONTEXTS,
  requiredCiState,
  REDLINE_LOGIN,
  VERIFIER_LOGIN,
  collectPages,
  prsFromHead,
} from './fleet-status.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}`); fail++; }
}

const HEAD = '47536435fb5c9540d8cb36fd26d81e101955b364';
const OLD = '34b7875f46525f7899a4e6601fbca4be75443903';
const base = (over = {}) => ({
  head: HEAD, headRef: 'feat/opus-alias-5-5', author: 'askalf',
  files: ['src/proxy.ts', 'test/opus-alias-fallback.mjs', 'CHANGELOG.md'],
  labels: [], reviews: [], comments: [], ...over,
});
const verification = (sha, login = VERIFIER_LOGIN) => ({ login, body: `## Verification at ${sha}\n\nbody` });
const review = (login, state, commitId, body = '') => ({ login, state, commitId, body });
const by = (rows) => Object.fromEntries(rows.map((s) => [s.context, s]));

console.log('\n  isCodePath / isBotPr');
check('src is code', isCodePath('src/proxy.ts'));
check('markdown and images are not', !isCodePath('README.md') && !isCodePath('docs/art/x.PNG') && !isCodePath('docs/notes.txt'));
check('.github config is not', !isCodePath('.github/workflows/ci.yml') && !isCodePath('.github/labeler.yml'));
check('.github scripts are', isCodePath('.github/scripts/a.sh') && isCodePath('.github/workflows/helper.mjs'));
check('.gitattributes is not', !isCodePath('.gitattributes'));
check('askalf on bot/ is a bot PR', isBotPr('askalf', 'bot/cc-drift-v2.1.281'));
check('askalf on a feature branch is not', !isBotPr('askalf', 'feat/opus-alias-5-5'));
check('a person on bot/ is not', !isBotPr('someone', 'bot/cc-drift-v2.1.281'));
check('dependabot always is', isBotPr('dependabot[bot]', 'dependabot/npm/x'));

console.log('\n  verifiedAtHead');
check('label + comment at head', verifiedAtHead(base({ labels: ['verified'], comments: [verification(HEAD)] })));
check('a 7-char prefix counts', verifiedAtHead(base({ labels: ['verified'], comments: [verification(HEAD.slice(0, 7))] })));
check('the label alone does not', !verifiedAtHead(base({ labels: ['verified'] })));
check('a comment at an older head does not', !verifiedAtHead(base({ labels: ['verified'], comments: [verification(OLD)] })));
check('the latest comment wins', !verifiedAtHead(base({ labels: ['verified'], comments: [verification(HEAD), verification(OLD)] })));
check('another login does not count', !verifiedAtHead(base({ labels: ['verified'], comments: [verification(HEAD, 'someone')] })));
check('findings heading does not count', !verifiedAtHead(base({ labels: ['verified'], comments: [{ login: VERIFIER_LOGIN, body: `## Verification findings at ${HEAD}` }] })));

console.log('\n  code PR, not verified: everything waits on the Breaker');
{
  const s = by(laneStatuses(base({ reviews: [review(REDLINE_LOGIN, 'APPROVED', HEAD)] })));
  check('verify pending', s[CONTEXTS.verify].state === 'pending' && s[CONTEXTS.verify].description.includes('4753643'));
  check('review pending even with an approval at head', s[CONTEXTS.review].state === 'pending');
}

console.log('\n  verdicts on an older head');
{
  const s = by(laneStatuses(base({
    labels: ['verified'], comments: [verification(HEAD)],
    reviews: [
      review(REDLINE_LOGIN, 'CHANGES_REQUESTED', OLD),
    ],
  })));
  check('verify green', s[CONTEXTS.verify].state === 'success');
  check('an old CHANGES_REQUESTED is not a red at this head', s[CONTEXTS.review].state === 'pending' && s[CONTEXTS.review].description.includes('34b7875'));
}

console.log('\n  verdicts at the head');
{
  const s = by(laneStatuses(base({
    labels: ['verified'], comments: [verification(HEAD)],
    reviews: [
      review(REDLINE_LOGIN, 'CHANGES_REQUESTED', OLD),
      review(REDLINE_LOGIN, 'APPROVED', HEAD),
    ],
  })));
  check('Redline approved', s[CONTEXTS.review].state === 'success');
}
{
  const s = by(laneStatuses(base({
    labels: ['verified'], comments: [verification(HEAD)],
    reviews: [
      review(REDLINE_LOGIN, 'CHANGES_REQUESTED', HEAD),
    ],
  })));
  check('Redline changes requested is red', s[CONTEXTS.review].state === 'failure');
}

console.log('\n  deterministic approvals');
{
  const det = review(REDLINE_LOGIN, 'APPROVED', HEAD, '**Deterministic approval** low-risk');
  const code = by(laneStatuses(base({ labels: ['verified'], comments: [verification(HEAD)], reviews: [det] })));
  check('on code it is not Redline\'s verdict', code[CONTEXTS.review].state === 'pending');
  const docs = by(laneStatuses(base({ files: ['README.md'], reviews: [det] })));
  check('on docs it is', docs[CONTEXTS.review].state === 'success');
}

console.log('\n  exempt PRs');
{
  const docs = by(laneStatuses(base({ files: ['README.md', 'docs/routing.md'] })));
  check('docs: verify not required', docs[CONTEXTS.verify].state === 'success' && docs[CONTEXTS.verify].description.startsWith('Not required'));
  check('docs: review still waits on Redline', docs[CONTEXTS.review].state === 'pending');
  const bot = by(laneStatuses(base({ headRef: 'bot/cc-drift-v2.1.281', reviews: [review(REDLINE_LOGIN, 'APPROVED', HEAD)] })));
  check('bot branch: verify not required, approval counts', bot[CONTEXTS.verify].state === 'success' && bot[CONTEXTS.review].state === 'success');
  const many = Array.from({ length: 101 }, (_, i) => `docs/p${i}.md`);
  check('more than 100 files is code whatever they are', by(laneStatuses(base({ files: many })))[CONTEXTS.verify].state === 'pending');
  const hundred = Array.from({ length: 100 }, (_, i) => `docs/p${i}.md`);
  check('exactly 100 docs files is not code', by(laneStatuses(base({ files: hundred })))[CONTEXTS.verify].state === 'success');
  check('more than 100 docs files still verifies once required CI passes',
    by(laneStatuses(base({ files: many, requiredCi: 'passed' })))[CONTEXTS.verify].state === 'success');
}

console.log('\n  descriptions');
check('capped at 140 characters', laneStatuses(base()).every((r) => r.description.length <= 140));

console.log('\n  verifiedAtHead: the label and the comment are each required');
check('a comment at head without the label does not count', !verifiedAtHead(base({ comments: [verification(HEAD)] })));
check('an older comment followed by one at head counts', verifiedAtHead(base({ labels: ['verified'], comments: [verification(OLD), verification(HEAD)] })));
check('a blocked heading does not count', !verifiedAtHead(base({ labels: ['verified'], comments: [{ login: VERIFIER_LOGIN, body: `## Verification blocked at ${HEAD}` }] })));

console.log('\n  Redline reviews that are not verdicts, and verdicts in order');
{
  const s = by(laneStatuses(base({
    labels: ['verified'], comments: [verification(HEAD)],
    reviews: [review(REDLINE_LOGIN, 'APPROVED', OLD), review(REDLINE_LOGIN, 'DISMISSED', HEAD), review(REDLINE_LOGIN, 'COMMENTED', HEAD, 'notes')],
  })));
  check('a dismissal and a comment at head leave the older approval as the last verdict', s[CONTEXTS.review].state === 'pending' && s[CONTEXTS.review].description.includes('34b7875'));
}
{
  const s = by(laneStatuses(base({
    labels: ['verified'], comments: [verification(HEAD)],
    reviews: [review(REDLINE_LOGIN, 'APPROVED', HEAD), review(REDLINE_LOGIN, 'CHANGES_REQUESTED', HEAD)],
  })));
  check('changes requested after an approval at the same head is red', s[CONTEXTS.review].state === 'failure');
}
{
  const s = by(laneStatuses(base({ reviews: [review(REDLINE_LOGIN, 'CHANGES_REQUESTED', HEAD)] })));
  check('changes requested at an unverified head still waits on the Breaker', s[CONTEXTS.verify].state === 'pending' && s[CONTEXTS.review].state === 'pending');
}

console.log('\n  what counts as code');
check('.github actions are', isCodePath('.github/actions/retry/action.yml'));
check('a .txt outside docs is', isCodePath('notes.txt') && isCodePath('src/fixtures/a.txt'));
check('a .github script keeps its case', isCodePath('.github/workflows/helper.MJS'));

console.log('\n  bot PRs');
check('github-actions on bot/ is', isBotPr('github-actions[bot]', 'bot/x') && isBotPr('app/github-actions', 'bot/x'));
check('askalf on a release, receipts or dependabot branch is',
  isBotPr('askalf', 'release-v6.12.0') && isBotPr('askalf', 'release/6.12') && isBotPr('askalf', 'chore/release-v6.12.0') && isBotPr('askalf', 'receipts-2026-09-24') && isBotPr('askalf', 'dependabot/npm/x'));
{
  const docs = (n) => Array.from({ length: n }, (_, i) => `docs/p${i}.md`);
  // The bot rule is read before the file count: a bot PR over 100 files is still exempt, a person's is code.
  check('a bot PR with more than 100 files is still not code', by(laneStatuses(base({ headRef: 'bot/cc-drift-v2.1.281', files: docs(101) })))[CONTEXTS.verify].state === 'success');
  check('a person with more than 100 docs files is code', by(laneStatuses(base({ files: docs(101) })))[CONTEXTS.verify].state === 'pending');
  check('99 docs files are not code', by(laneStatuses(base({ files: docs(99) })))[CONTEXTS.verify].state === 'success');
}

console.log('\n  docs PRs still show Redline\'s verdict');
{
  const s = by(laneStatuses(base({ files: ['README.md'], reviews: [review(REDLINE_LOGIN, 'CHANGES_REQUESTED', HEAD)] })));
  check('changes requested on docs is red', s[CONTEXTS.review].state === 'failure');
  const old = by(laneStatuses(base({ files: ['README.md'], reviews: [review(REDLINE_LOGIN, 'CHANGES_REQUESTED', OLD)] })));
  check('changes requested on an older docs head is pending and says where', old[CONTEXTS.review].state === 'pending' && old[CONTEXTS.review].description.endsWith('(its last verdict was on 34b7875)'));
}

console.log('\n  required CI is the verification where the base branch requires checks');
{
  const REQ = ['test', 'build (22)', 'live-test'];
  const ok = (name) => ({ name, state: 'success' });
  check('no required checks -> none', requiredCiState([], [ok('test')]) === 'none');
  check('all required passed -> passed', requiredCiState(REQ, REQ.map(ok)) === 'passed');
  check('a required check not reported yet -> pending', requiredCiState(REQ, [ok('test'), ok('build (22)')]) === 'pending');
  check('a required check still running -> pending', requiredCiState(REQ, [ok('test'), ok('build (22)'), { name: 'live-test', state: 'in_progress' }]) === 'pending');
  check('a required check failed -> failed, even with another pending',
    requiredCiState(REQ, [{ name: 'test', state: 'failure' }, ok('build (22)')]) === 'failed');
  check('the last result per check counts (a rerun that passed)',
    requiredCiState(['test'], [{ name: 'test', state: 'failure' }, ok('test')]) === 'passed');
  check('a check run and a status of one name are both held to passing',
    requiredCiState(['test'], [ok('test')], [{ name: 'test', state: 'failure' }]) === 'failed'
    && requiredCiState(['test'], [{ name: 'test', state: 'failure' }], [ok('test')]) === 'failed'
    && requiredCiState(['test'], [ok('test')], [{ name: 'test', state: 'pending' }]) === 'pending'
    && requiredCiState(['test'], [ok('test')], [ok('test')]) === 'passed'
    && requiredCiState(['test'], [], [ok('test')]) === 'passed');
  check('a required check that names its app counts only that app\'s check runs',
    requiredCiState([{ name: 'test', app: 5 }], [{ ...ok('test'), app: 6 }]) === 'pending'
    && requiredCiState([{ name: 'test', app: 5 }], [{ ...ok('test'), app: 5 }]) === 'passed'
    && requiredCiState([{ name: 'test', app: 5 }], [{ name: 'test', state: 'failure', app: 5 }, { ...ok('test'), app: 6 }]) === 'failed'
    && requiredCiState([{ name: 'test', app: 5 }], [], [ok('test')]) === 'pending'
    && requiredCiState([{ name: 'test', app: null }], [{ ...ok('test'), app: 6 }]) === 'passed');
  check('skipped and neutral pass', requiredCiState(['a', 'b'], [{ name: 'a', state: 'skipped' }, { name: 'b', state: 'neutral' }]) === 'passed');
  check('checks nobody requires do not hold it', requiredCiState(['test'], [ok('test'), { name: 'fleet/verify', state: 'pending' }]) === 'passed');

  const lanes = (over) => by(laneStatuses(base(over)));
  const passed = lanes({ requiredCi: 'passed' });
  check('CI passed: fleet/verify green with no label or comment', passed[CONTEXTS.verify].state === 'success'
    && passed[CONTEXTS.verify].description === 'Required CI passed at 4753643');
  check('CI passed: Redline is waited on, not held for a Breaker',
    passed[CONTEXTS.review].description === 'Waiting on Redline at 4753643');
  check('CI pending: fleet/verify waits on CI, not the Breaker', lanes({ requiredCi: 'pending' })[CONTEXTS.verify].description === 'Waiting on required CI at 4753643');
  check('CI failed: fleet/verify red', lanes({ requiredCi: 'failed' })[CONTEXTS.verify].state === 'failure');
  check('CI pending: an old Breaker label and comment do not count',
    lanes({ requiredCi: 'pending', labels: ['verified'], comments: [verification(HEAD)] })[CONTEXTS.verify].state === 'pending');
  check('no required checks: the label and comment still verify',
    lanes({ requiredCi: 'none', labels: ['verified'], comments: [verification(HEAD)] })[CONTEXTS.verify].description === 'Verified at 4753643');
}

{
  // The dispatcher exempts a bot-shaped branch only when one of our identities opened it.
  check('a person on a bot-shaped branch is not a bot PR', !isBotPr('contributor', 'bot/maintenance'));
  check('a person on release/1.2 is not a bot PR', !isBotPr('someone', 'release/1.2'));
  check('askalf on bot/drift is a bot PR', isBotPr('askalf', 'bot/drift'));
  check('github-actions on receipts-2026 is a bot PR', isBotPr('github-actions[bot]', 'receipts-2026'));
  check('dependabot on any branch is a bot PR', isBotPr('dependabot[bot]', 'feature/x'));
}

{
  // With the fleet/* lanes listed as required checks, they must not wait on themselves.
  const ci = ['test', 'analyze'];
  const own = [CONTEXTS.verify, CONTEXTS.review];
  const green = ci.map((name) => ({ name, state: 'SUCCESS' }));
  check('own lanes required, CI green: passed', requiredCiState([...ci, ...own], green) === 'passed');
  check('own lanes required and pending, CI green: still passed',
    requiredCiState([...ci, ...own], [...green, ...own.map((name) => ({ name, state: 'PENDING' }))]) === 'passed');
  check('only own lanes required: none (the Breaker rule applies)', requiredCiState(own, []) === 'none');
  check('own lanes required, a real check running: pending',
    requiredCiState([...ci, ...own], [{ name: 'test', state: 'SUCCESS' }, { name: 'analyze', state: 'IN_PROGRESS' }]) === 'pending');
  let posted = [];
  let states = [];
  for (let round = 0; round < 3; round++) {
    const requiredCi = requiredCiState([...ci, ...own], [...green, ...posted]);
    const out = laneStatuses(base({ requiredCi, reviews: [
      review(REDLINE_LOGIN, 'APPROVED', HEAD),
    ] }));
    posted = out.map((x) => ({ name: x.context, state: x.state.toUpperCase() }));
    states = out.map((x) => x.state);
  }
  check('own lanes required, three rounds: both green', states.join() === 'success,success');
}

{
  // Post-then-verify ordering: what differs from the head's newest status per context is posted.
  const have = latestByContext([
    { context: 'fleet/review', state: 'success', description: 'Redline approved abc1234' },
    { context: 'fleet/review', state: 'pending', description: 'older' },
    { context: 'fleet/verify', state: 'success', description: 'Required CI passed at abc1234' },
  ]);
  check('latestByContext keeps the newest per context', have.get('fleet/review').state === 'success' && have.size === 2);
  const want = [
    { context: 'fleet/verify', state: 'success', description: 'Required CI passed at abc1234' },
    { context: 'fleet/review', state: 'pending', description: 'Waiting on Redline at abc1234' },
  ];
  const todo = statusesToPost(want, have).map((s) => s.context);
  check('an identical status is not posted again', !todo.includes('fleet/verify'));
  check('a differing state is posted', todo.includes('fleet/review'));
  check('a missing context is posted', statusesToPost([{ context: 'fleet/new', state: 'pending', description: 'x' }], have).length === 1);
  check('same state, new description is posted',
    statusesToPost([{ context: 'fleet/verify', state: 'success', description: 'Verified at abc1234' }], have).length === 1);
  // A stale run posted after a fresh one: the fresh run's verify pass sees the difference and corrects it.
  const stale = latestByContext([{ context: 'fleet/review', state: 'pending', description: 'Waiting on Redline at abc1234' }]);
  const fresh = [{ context: 'fleet/review', state: 'success', description: 'Redline approved abc1234' }];
  check('a stale overwrite is corrected on the next pass', statusesToPost(fresh, stale).length === 1);
  check('and then left alone', statusesToPost(fresh, latestByContext(fresh)).length === 0);
}

{
  // Paging reads to the first short page, so a required check on page 2 still counts.
  const pager = (sizes) => async (n) => Array.from({ length: sizes[n - 1] ?? 0 }, (_, i) => ({ name: `check-${n}-${i}`, state: 'SUCCESS' }));
  const two = await collectPages(pager([100, 1]));
  check('101 rows over two pages are all read', two.length === 101);
  check('a full last page reads one more, empty, page', (await collectPages(pager([100, 100]))).length === 200);
  check('a short first page is the only page', (await collectPages(pager([5]))).length === 5);
  check('a required check on page 2 counts', requiredCiState(['check-2-0'], two) === 'passed');
}

{
  // The CLI, end to end, against a stubbed GitHub: the rules read fails closed, check runs page,
  // and a run posts only what differs, then re-reads and corrects a stale overwrite.
  const script = fileURLToPath(new URL('./fleet-status.mjs', import.meta.url));
  const stub = `
    const fx = JSON.parse(process.env.FLEET_STATUS_FIXTURE);
    const posted = [];
    const pageOf = (u) => Number(new URL(u).searchParams.get('page') ?? 1);
    const slice = (rows, u) => rows.slice((pageOf(u) - 1) * 100, pageOf(u) * 100);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    globalThis.fetch = async (url, init = {}) => {
      const p = new URL(url).pathname;
      if (init.method === 'POST') { posted.push({ path: p, ...JSON.parse(init.body) }); return json({}, 201); }
      if (p.endsWith('/files')) return json(slice(fx.files, url));
      if (p.endsWith('/reviews')) return json(slice(fx.reviews, url));
      if (p.endsWith('/comments')) return json(slice(fx.comments, url));
      if (p.includes('/rules/branches/')) return fx.rules === null ? json({ message: 'no' }, 500) : json(fx.rules);
      if (/[/]branches[/][^/]+$/.test(p)) return json(fx.branch ?? { protected: false });
      if (p.endsWith('/statuses')) return json(slice(fx.statuses.length > 1 ? fx.statuses.shift() : fx.statuses[0], url));
      if (p.endsWith('/check-runs')) return json({ check_runs: slice(fx.checkRuns, url) });
      if (/[/]pulls[/][0-9]+$/.test(p)) return json(fx.pr);
      return json({ message: 'unexpected ' + p }, 404);
    };
    process.on('exit', () => process.stdout.write('POSTED ' + JSON.stringify(posted) + '\\n'));
  `;
  const run = (fixture, ...args) => {
    const r = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(stub)}`, script, ...args], {
      env: { ...process.env, GITHUB_TOKEN: 't', REPO: 'o/r', PR: '7', FLEET_STATUS_FIXTURE: JSON.stringify(fixture) },
      encoding: 'utf8',
    });
    const posted = JSON.parse(/^POSTED (.*)$/m.exec(r.stdout)?.[1] ?? '[]');
    return { status: r.status, out: r.stdout + r.stderr, posted, lane: (c) => new RegExp(`^${c}\\s+(\\S+)\\s+(.*)$`, 'm').exec(r.stdout)?.slice(1) ?? [] };
  };
  const pr = (over = {}) => ({
    state: 'open', number: 7, html_url: 'https://x/pull/7',
    head: { sha: HEAD, ref: 'feat/x', repo: { full_name: 'o/r' } }, base: { ref: 'main' },
    user: { login: 'askalf' }, labels: [{ name: 'verified' }], ...over,
  });
  const fixture = (over = {}) => ({
    pr: pr(), files: [{ filename: 'src/a.ts' }], reviews: [], rules: [],
    comments: [{ user: { login: VERIFIER_LOGIN }, body: `## Verification at ${HEAD}` }],
    statuses: [[]], checkRuns: [], ...over,
  });
  const requireTest = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }] } }];
  const filler = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `lint-${i}`, status: 'completed', conclusion: 'success' }));

  const unreadable = run(fixture({ rules: null }), '--dry-run');
  check('rules that cannot be read leave verify pending, label and comment notwithstanding',
    unreadable.status === 0 && unreadable.lane(CONTEXTS.verify).join(' ') === `pending Waiting on required CI at ${HEAD.slice(0, 7)}`);
  const paged = run(fixture({ rules: requireTest, checkRuns: [...filler, { id: 101, name: 'test', status: 'completed', conclusion: 'success' }] }), '--dry-run');
  check('a required check run on the second page is read', paged.status === 0 && paged.lane(CONTEXTS.verify)[0] === 'success');
  const running = run(fixture({ rules: requireTest, checkRuns: [{ id: 1, name: 'test', status: 'in_progress', conclusion: null }] }), '--dry-run');
  check('a required check still running is pending, not failed', running.lane(CONTEXTS.verify).join(' ') === `pending Waiting on required CI at ${HEAD.slice(0, 7)}`);
  check('a dry run posts nothing', unreadable.posted.length === 0 && paged.posted.length === 0);
  const passingRun = [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }];
  const classic = (enforcement_level = 'non_admins') => ({ protected: true, protection: { enabled: true, required_status_checks: { enforcement_level, contexts: ['test'], checks: [{ context: 'test', app_id: null }] } } });
  const classicFailing = run(fixture({ branch: classic(), checkRuns: [{ ...passingRun[0], conclusion: 'failure' }] }), '--dry-run');
  check('a check classic branch protection requires, failing, fails verify though the label and comment are there',
    classicFailing.status === 0 && classicFailing.lane(CONTEXTS.verify).join(' ') === `failure A required check failed at ${HEAD.slice(0, 7)}`);
  const classicPassing = run(fixture({ branch: classic(), checkRuns: passingRun, pr: pr({ head: { sha: HEAD, ref: 'feat/x', repo: { full_name: 'else/r' } } }) }), '--dry-run');
  check('a fork PR whose classic required check passed is verified',
    classicPassing.status === 0 && classicPassing.lane(CONTEXTS.verify).join(' ') === `success Required CI passed at ${HEAD.slice(0, 7)}`);
  const classicOff = run(fixture({ branch: classic('off'), checkRuns: [{ ...passingRun[0], conclusion: 'failure' }] }), '--dry-run');
  check('classic protection that enforces nothing requires nothing',
    classicOff.status === 0 && classicOff.lane(CONTEXTS.verify)[0] === 'success');
  // A required check that names its app: only that app's check run counts.
  const APP = 15368;
  const byApp = (app, conclusion) => ({ id: app, name: 'test', status: 'completed', conclusion, app: { id: app } });
  const rulesFrom = (app) => [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test', integration_id: app }] } }];
  const classicFrom = (app) => ({ protected: true, protection: { enabled: true, required_status_checks: { enforcement_level: 'everyone', contexts: ['test'], checks: [{ context: 'test', app_id: app }] } } });
  const forkPr = pr({ head: { sha: HEAD, ref: 'feat/x', repo: { full_name: 'else/r' } } });
  for (const [how, req] of [['a ruleset', { rules: rulesFrom(APP) }], ['classic protection', { branch: classicFrom(APP) }]]) {
    const wrongApp = run(fixture({ ...req, pr: forkPr, checkRuns: [byApp(999, 'success')] }), '--dry-run');
    check(`${how}: a passing check of the required name from another app, the required app absent, is pending`,
      wrongApp.lane(CONTEXTS.verify).join(' ') === `pending Waiting on required CI at ${HEAD.slice(0, 7)}`);
    const appFailing = run(fixture({ ...req, pr: forkPr, checkRuns: [byApp(APP, 'failure'), byApp(999, 'success')] }), '--dry-run');
    check(`${how}: the required app failing fails verify, whatever another app reports`,
      appFailing.lane(CONTEXTS.verify).join(' ') === `failure A required check failed at ${HEAD.slice(0, 7)}`);
    const appPassing = run(fixture({ ...req, pr: forkPr, checkRuns: [byApp(APP, 'success')] }), '--dry-run');
    check(`${how}: the required app passing verifies a fork PR`,
      appPassing.lane(CONTEXTS.verify).join(' ') === `success Required CI passed at ${HEAD.slice(0, 7)}`);
    const statusOnly = run(fixture({ ...req, pr: forkPr, statuses: [[{ context: 'test', state: 'success' }]] }), '--dry-run');
    check(`${how}: a commit status cannot stand in for a check the required app must report`,
      statusOnly.lane(CONTEXTS.verify).join(' ') === `pending Waiting on required CI at ${HEAD.slice(0, 7)}`);
  }
  const anyApp = run(fixture({ branch: classicFrom(-1), pr: forkPr, checkRuns: [byApp(999, 'success')] }), '--dry-run');
  check('classic protection with app_id -1 takes any app', anyApp.lane(CONTEXTS.verify)[0] === 'success');
  const hidden = run(fixture({ branch: { protected: true } }), '--dry-run');
  check('a protected branch that shows no protection leaves verify pending',
    hidden.status === 0 && hidden.lane(CONTEXTS.verify).join(' ') === `pending Waiting on required CI at ${HEAD.slice(0, 7)}`);
  const failingStatus = run(fixture({ rules: requireTest, statuses: [[{ context: 'test', state: 'failure' }]], checkRuns: passingRun }), '--dry-run');
  check('a failing status beside a passing check run of the same required name fails verify',
    failingStatus.status === 0 && failingStatus.lane(CONTEXTS.verify).join(' ') === `failure A required check failed at ${HEAD.slice(0, 7)}`);
  const failingRun = run(fixture({ rules: requireTest, statuses: [[{ context: 'test', state: 'success' }]], checkRuns: [{ ...passingRun[0], conclusion: 'failure' }] }), '--dry-run');
  check('a failing check run beside a passing status of the same required name fails verify',
    failingRun.status === 0 && failingRun.lane(CONTEXTS.verify).join(' ') === `failure A required check failed at ${HEAD.slice(0, 7)}`);

  const want = (context, state, description) => ({ context, state, description });
  const settled = [
    want(CONTEXTS.verify, 'success', `Verified at ${HEAD.slice(0, 7)}`),
    want(CONTEXTS.review, 'pending', `Waiting on Redline at ${HEAD.slice(0, 7)}`),
  ];
  const stale = [want(CONTEXTS.review, 'pending', 'older'), ...settled];
  const posting = run(fixture({ statuses: [[], stale, settled] }));
  check('the first pass posts both lanes on the head',
    posting.status === 0 && posting.posted.slice(0, 2).every((s) => s.path === `/repos/o/r/statuses/${HEAD}` && s.target_url === 'https://x/pull/7'));
  check('the second pass re-posts only the lane a stale run overwrote',
    posting.posted.length === 3 && posting.posted[2].context === CONTEXTS.review && /^pass 2: correcting fleet\/review$/m.test(posting.out));
  const quiet = run(fixture({ statuses: [settled] }));
  check('a head already showing the right statuses gets no post', quiet.status === 0 && quiet.posted.length === 0);
  const closed = run(fixture({ pr: pr({ state: 'closed' }) }));
  check('a closed PR gets no post', closed.status === 0 && closed.posted.length === 0 && /nothing to report/.test(closed.out));
  const fork = run(fixture({ pr: pr({ head: { sha: HEAD, ref: 'feat/x', repo: { full_name: 'else/r' } } }) }));
  check('a fork PR is computed: with no required checks its label and comment do not verify it',
    fork.status === 0 && fork.lane(CONTEXTS.verify).join(' ') === "pending an outside contributor's PR: the operator verifies and merges");
}

{
  // requiredCi drives the verify lane ahead of the label and comment.
  const at = (requiredCi) => by(laneStatuses(base({ requiredCi, labels: ['verified'], comments: [verification(HEAD)] })));
  check('a failed required check is red even at a verified head',
    at('failed')[CONTEXTS.verify].state === 'failure' && at('failed')[CONTEXTS.verify].description === 'A required check failed at 4753643');
  check('pending required CI holds every lane', Object.values(at('pending')).every((s) => s.state === 'pending'));
}

console.log('\n  fork PRs: an outside contributor\'s PR');
{
  const FORK = "an outside contributor's PR: the operator verifies and merges";
  const fork = (over = {}) => by(laneStatuses(base({ fork: true, author: 'contributor', headRef: 'fix/typo', ...over })));
  const green = fork({ requiredCi: 'passed', reviews: [review(REDLINE_LOGIN, 'APPROVED', HEAD)] });
  check('fork, Redline approved at head, required CI green: verify green',
    green[CONTEXTS.verify].state === 'success' && green[CONTEXTS.verify].description === 'Required CI passed at 4753643');
  check('fork, Redline approved at head, required CI green: review green',
    green[CONTEXTS.review].state === 'success' && green[CONTEXTS.review].description === 'Redline approved 4753643');
  const red = fork({ requiredCi: 'passed', reviews: [review(REDLINE_LOGIN, 'CHANGES_REQUESTED', HEAD)] });
  check('fork, Redline requested changes at head: review red', red[CONTEXTS.review].state === 'failure');
  check('fork, changes requested while required CI still runs: review red, not held',
    fork({ requiredCi: 'pending', reviews: [review(REDLINE_LOGIN, 'CHANGES_REQUESTED', HEAD)] })[CONTEXTS.review].state === 'failure');
  const none = fork({ requiredCi: 'none', reviews: [review(REDLINE_LOGIN, 'APPROVED', HEAD)] });
  check('fork, no required checks: verify pending for the operator',
    none[CONTEXTS.verify].state === 'pending' && none[CONTEXTS.verify].description === FORK);
  check('fork, no required checks: Redline\'s approval still shows', none[CONTEXTS.review].state === 'success');
  check('fork, no required checks: a label and verification comment do not verify it',
    fork({ requiredCi: 'none', labels: ['verified'], comments: [verification(HEAD)] })[CONTEXTS.verify].description === FORK);
  check('fork, no verdict: review waits on Redline at the head',
    fork({ requiredCi: 'passed' })[CONTEXTS.review].description === 'Waiting on Redline at 4753643');
  check('fork, approval on an older head: review pending',
    fork({ requiredCi: 'passed', reviews: [review(REDLINE_LOGIN, 'APPROVED', OLD)] })[CONTEXTS.review].state === 'pending');
  check('fork, required CI failed: verify red', fork({ requiredCi: 'failed' })[CONTEXTS.verify].state === 'failure');
  check('fork, required CI running: verify waits on it', fork({ requiredCi: 'pending' })[CONTEXTS.verify].description === 'Waiting on required CI at 4753643');
  check('fork, docs only: verify not required', fork({ files: ['README.md'] })[CONTEXTS.verify].description.startsWith('Not required'));
  check('fork, deterministic approval on code is not a verdict',
    fork({ requiredCi: 'passed', reviews: [review(REDLINE_LOGIN, 'APPROVED', HEAD, '**Deterministic approval** low-risk')] })[CONTEXTS.review].state === 'pending');
  check('fork, another login\'s approval is not Redline\'s',
    fork({ requiredCi: 'passed', reviews: [review('someone', 'APPROVED', HEAD)] })[CONTEXTS.review].state === 'pending');
  const same = by(laneStatuses(base({ fork: false, requiredCi: 'none', reviews: [review(REDLINE_LOGIN, 'APPROVED', HEAD)] })));
  check('same-repo, unchanged: waits on the Breaker, review held',
    same[CONTEXTS.verify].description === 'Waiting on the Breaker to verify 4753643' && same[CONTEXTS.review].state === 'pending');

  const pull = (number, repo, state = 'open') => ({ number, state, head: { repo: repo === null ? null : { full_name: repo } } });
  check('a fork head resolves to its open PRs from that repository',
    prsFromHead([pull(7, 'someone/r'), pull(8, 'someone/other'), pull(9, 'someone/r', 'closed'), pull(10, null)], 'someone/r').join() === '7');
  check('no open PR from the fork head resolves to none', prsFromHead([], 'someone/r').length === 0);
}

console.log('\n  fork PRs through the CLI, against a stubbed GitHub');
{
  const script = fileURLToPath(new URL('./fleet-status.mjs', import.meta.url));
  const stub = `
    const fx = JSON.parse(process.env.FLEET_STATUS_FIXTURE);
    const posted = [];
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const p = u.pathname;
      if (init.method === 'POST') { posted.push({ path: p, ...JSON.parse(init.body) }); return json({}, 201); }
      if (Number(u.searchParams.get('page') ?? 1) > 1) return p.endsWith('/check-runs') ? json({ check_runs: [] }) : json([]);
      if (p.endsWith('/pulls')) { fx.asked = u.searchParams.get('head'); return json(fx.pulls); }
      if (p.endsWith('/files')) return json(fx.files);
      if (p.endsWith('/reviews')) return json(fx.reviews);
      if (p.endsWith('/comments')) return json([]);
      if (p.includes('/rules/branches/')) return json(fx.rules);
      if (/[/]branches[/][^/]+$/.test(p)) return json(fx.branch ?? { protected: false });
      if (p.endsWith('/statuses')) return json([...posted].reverse());
      if (p.endsWith('/check-runs')) return json({ check_runs: fx.checkRuns });
      if (/[/]pulls[/]7$/.test(p)) return json(fx.pr);
      return json({ message: 'unexpected ' + p }, 404);
    };
    process.on('exit', () => process.stdout.write('ASKED ' + JSON.stringify(fx.asked ?? null) + '\\nPOSTED ' + JSON.stringify(posted) + '\\n'));
  `;
  const run = (fixture, env, ...args) => {
    const r = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(stub)}`, script, ...args], {
      env: { ...process.env, GITHUB_TOKEN: 't', REPO: 'o/r', PR: '', HEAD_REPO: '', HEAD_BRANCH: '', FLEET_STATUS_FIXTURE: JSON.stringify(fixture), ...env },
      encoding: 'utf8',
    });
    return {
      status: r.status, out: r.stdout + r.stderr,
      asked: JSON.parse(/^ASKED (.*)$/m.exec(r.stdout)?.[1] ?? 'null'),
      posted: JSON.parse(/^POSTED (.*)$/m.exec(r.stdout)?.[1] ?? '[]'),
      lane: (c) => new RegExp(`^${c}\\s+(\\S+)\\s+(.*)$`, 'm').exec(r.stdout)?.slice(1) ?? [],
    };
  };
  const forkPr = { state: 'open', number: 7, html_url: 'https://x/pull/7', user: { login: 'contributor' }, labels: [],
    head: { sha: HEAD, ref: 'fix/typo', repo: { full_name: 'contributor/r' } }, base: { ref: 'main' } };
  const fixture = (over = {}) => ({
    pr: forkPr, pulls: [forkPr], files: [{ filename: 'src/a.ts' }],
    reviews: [{ user: { login: REDLINE_LOGIN }, state: 'APPROVED', commit_id: HEAD, body: 'ok' }],
    rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }, { context: CONTEXTS.verify }] } }],
    checkRuns: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }], ...over,
  });
  const approved = run(fixture(), { PR: '7' }, '--dry-run');
  check('CLI: a fork PR, approved at head with required CI green, reads both lanes green',
    approved.status === 0 && approved.lane(CONTEXTS.verify)[0] === 'success' && approved.lane(CONTEXTS.review)[0] === 'success');
  const posting = run(fixture(), { PR: '7' });
  check('CLI: and posts both on the fork head',
    posting.status === 0 && posting.posted.length === 2 && posting.posted.every((s) => s.path === `/repos/o/r/statuses/${HEAD}` && s.state === 'success'));
  const noChecks = run(fixture({ rules: [] }), { PR: '7' }, '--dry-run');
  check('CLI: a fork PR where no checks are required leaves verify to the operator',
    noChecks.lane(CONTEXTS.verify).join(' ') === "pending an outside contributor's PR: the operator verifies and merges");
  const viaHead = run(fixture(), { HEAD_REPO: 'contributor/r', HEAD_BRANCH: 'fix/typo' }, '--dry-run');
  check('CLI: a fork head with no PR number finds its PR by owner and branch',
    viaHead.status === 0 && viaHead.asked === 'contributor:fix/typo' && viaHead.lane(CONTEXTS.review)[0] === 'success');
  const elsewhere = run(fixture({ pulls: [{ ...forkPr, head: { ...forkPr.head, repo: { full_name: 'contributor/other' } } }] }),
    { HEAD_REPO: 'contributor/r', HEAD_BRANCH: 'fix/typo' });
  check('CLI: a same-named branch in another of the owner\'s repos is not the PR',
    elsewhere.status === 0 && elsewhere.posted.length === 0 && /nothing to report/.test(elsewhere.out));
  check('CLI: no PR number and no fork head is a usage error', run(fixture(), {}).status === 2);

  // The backfill: every open PR is read, and only the same-repo ones get lanes.
  const samePr = { ...forkPr, user: { login: 'askalf' }, head: { ...forkPr.head, ref: 'feat/x', repo: { full_name: 'o/r' } } };
  const both = fixture({ pr: samePr, pulls: [samePr, { ...forkPr, number: 8 }] });
  const backfill = run(both, { ALL_OPEN: 'true' });
  check('CLI: ALL_OPEN reads the open PRs without a head filter',
    backfill.status === 0 && backfill.asked === null);
  check('CLI: ALL_OPEN posts the lanes on the same-repo PR alone',
    backfill.posted.length === 2 && backfill.posted.every((s) => s.path === `/repos/o/r/statuses/${HEAD}`) && !/unexpected/.test(backfill.out));
  check('CLI: DRY_RUN=true posts nothing', run(both, { ALL_OPEN: 'true', DRY_RUN: 'true' }).posted.length === 0);
  const forksOnly = run(fixture({ pulls: [forkPr] }), { ALL_OPEN: 'true' });
  check('CLI: ALL_OPEN with only fork PRs open reports nothing',
    forksOnly.status === 0 && forksOnly.posted.length === 0 && /no open same-repo PR/.test(forksOnly.out));
}

console.log(`\n  ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
