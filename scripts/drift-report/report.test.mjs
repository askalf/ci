// Tests for scripts/drift-report/report.mjs and the action pin in pin.mjs.
// Run: node scripts/drift-report/report.test.mjs
// gh and git are a fake `run` that records every call; nothing leaves the machine. A second
// section runs real git against a bare origin in a temp dir, with gh still faked.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readConfig, report, stamp, pickPr, pickIssues, pushEnv, prBody, parseEntries, parseLines, gitPath, BODY_LIMIT, BODY_RESERVE } from './report.mjs';
import { bumpActionPins, countActionPins, DRIFT_REPORT_ACTION } from '../redline/pin.mjs';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}`); fail++; }
}
async function throws(fn) { try { await fn(); return null; } catch (e) { return e; } }

const root = mkdtempSync(join(tmpdir(), 'drift-report-'));
mkdirSync(join(root, 'test', 'fixtures'), { recursive: true });
const SNAP = 'test/fixtures/snap.json';
writeFileSync(join(root, SNAP), '{"models":["b"]}\n');
writeFileSync(join(root, 'issue-body.md'), 'The list moved.\n');
writeFileSync(join(root, 'pr-body.md'), '## Snapshot\n\nIt moved.\n');
const outFile = join(root, 'out.txt');

const SHA = '47536435fb5c9540d8cb36fd26d81e101955b364';
const NOW = new Date(Date.UTC(2026, 9, 9, 22, 41, 7));
const RUN = 'https://github.com/askalf/x/actions/runs/1';

const base = (extra = {}) => ({
  DR_REPO: 'askalf/x', DR_LABEL: 'codex-drift', DR_ISSUE_TOKEN: 'jobtok', DR_PR_TOKEN: 'pat-secret',
  GITHUB_WORKSPACE: root, GITHUB_WORKFLOW: 'Codex drift watch', DR_RUN_URL: RUN, GITHUB_OUTPUT: outFile, ...extra,
});
const issueEnv = (extra = {}) => base({ DR_ISSUE: 'true', DR_ISSUE_TITLE: 'Codex drift detected', DR_ISSUE_BODY_FILE: join(root, 'issue-body.md'), ...extra });
const prEnv = (extra = {}) => base({ DR_PR: 'true', DR_PR_BRANCH_PREFIX: 'bot/codex-models-', DR_PR_FILES: SNAP, DR_PR_TITLE: 'test(codex): snapshot follows the list', DR_PR_BODY_FILE: join(root, 'pr-body.md'), ...extra });

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const bad = (stderr = 'boom') => ({ status: 1, stdout: '', stderr });
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const COMMIT = 'c'.repeat(40);

/**
 * A fake gh and git. `onBranch` maps path -> content, or -> { content, mode }, on the open PR
 * branch; a path not in it is absent there. The fake index is the real file under `root`, with
 * `indexModes` for anything that is not 100644. `staged: false` makes write-tree answer the
 * parent's tree, as it does when the files match it.
 */
function world({ issues = [], prs = [], onBranch = null, indexModes = {}, defaultBranch = 'master', failPrCreate = false, failPrComment = false, failIssueComment = false, staged = true, labelExists = false, labelFails = false, bigDiff = false } = {}) {
  const calls = [];
  const lines = (arr) => arr.map((p) => JSON.stringify(p)).join('\n') + '\n';
  const run = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, env: opts.env ?? {}, cwd: opts.cwd });
    if (cmd === 'gh') {
      const [a, b] = args;
      // gh label create refuses an existing label unless --force, which would rewrite it.
      if (a === 'label') return labelFails ? bad('HTTP 403: Resource not accessible') : labelExists ? bad(`X label with name "codex-drift" already exists; use \`--force\` to update its color and description`) : ok();
      if (a === 'issue' && b === 'create') return ok('https://github.com/askalf/x/issues/12\n');
      if (a === 'issue' && b === 'comment') return failIssueComment ? bad('HTTP 403: Resource not accessible') : ok();
      if (a === 'issue' && b === 'close') return ok();
      // gh api has no -R; the paginated queries answer one object per line, as --jq does.
      if (a === 'api') {
        if (args.includes('-R')) return bad('unknown shorthand flag: R in -R');
        if (args[2].includes('/pulls?')) return ok(lines(prs));
        if (args[2].includes('/issues?')) return ok(lines(issues));
        return bad(`unexpected api ${args[2]}`);
      }
      if (a === 'pr' && b === 'create') return failPrCreate ? bad('422 no commits') : ok('https://github.com/askalf/x/pull/77\n');
      if (a === 'pr' && b === 'comment') return failPrComment ? bad('HTTP 502') : ok();
      // gh repo view takes the repository as an argument and refuses -R, as the real gh does.
      if (a === 'repo' && b === 'view') return args.includes('-R') ? bad('unknown shorthand flag: R in -R') : ok(JSON.stringify({ defaultBranchRef: { name: defaultBranch } }));
    }
    if (cmd === 'git') {
      const paths = args.slice(args.indexOf('--') + 1);
      if (args[0] === 'ls-files') return ok(paths.map((p) => `${indexModes[p] ?? '100644'} ${sha1(readFileSync(join(root, p)))} 0\t${p}\x00`).join(''));
      if (args[0] === 'ls-tree') {
        return ok(paths.filter((p) => onBranch && p in onBranch).map((p) => {
          const e = typeof onBranch[p] === 'string' ? { content: onBranch[p], mode: '100644' } : onBranch[p];
          return `${e.mode} blob ${sha1(e.content)}\t${p}\x00`;
        }).join(''));
      }
      if (args[0] === 'diff') return ok(bigDiff ? `diff --git a/x b/x\n${'+'.padEnd(99, 'x')}\n`.repeat(900) : 'diff --git a/x b/x\n-"b"\n+"c"\n');
      // The temporary index: write-tree answers the parent's tree when nothing changed for the files.
      if (args[0] === 'rev-parse') return ok(`${'a'.repeat(40)}\n`);
      if (args[0] === 'write-tree') return ok(`${(staged ? 'b' : 'a').repeat(40)}\n`);
      if (args.includes('commit-tree')) return ok(`${COMMIT}\n`);
      return ok();
    }
    return bad(`unexpected ${cmd} ${args.join(' ')}`);
  };
  const find = (cmd, ...head) => calls.filter((c) => c.cmd === cmd && head.every((h, i) => c.args[i] === h));
  return { run, calls, find };
}
const deps = (w) => ({ run: w.run, now: () => NOW, log: () => {}, env: { PATH: '/bin' } });
const bodyOf = (call) => readFileSync(call.args[call.args.indexOf('--body-file') + 1], 'utf8');
const openPr = (number, branch) => ({ number, headRefName: branch, url: `https://github.com/askalf/x/pull/${number}`, isCrossRepository: false });
const issueApi = (w) => w.find('gh', 'api').filter((c) => c.args[2].includes('/issues?'));

console.log('\n  readConfig');
{
  check('nothing requested needs no label', (await throws(() => readConfig(base({ DR_LABEL: '' })))) === null);
  check('a label with a space is refused', /plain GitHub label/.test((await throws(() => readConfig(issueEnv({ DR_LABEL: 'two words' }))))?.message));
  check('issue and close together are refused', /both set/.test((await throws(() => readConfig(issueEnv({ DR_CLOSE: 'true' }))))?.message));
  check('issue needs a title', /issue-title/.test((await throws(() => readConfig(issueEnv({ DR_ISSUE_TITLE: '' }))))?.message));
  check('issue needs a body', /issue-body/.test((await throws(() => readConfig(issueEnv({ DR_ISSUE_BODY_FILE: '' }))))?.message));
  check('an unreadable body file names itself', /cannot read .*nope\.md/.test((await throws(() => readConfig(issueEnv({ DR_ISSUE_BODY_FILE: join(root, 'nope.md') }))))?.message));
  writeFileSync(join(root, 'huge.md'), 'x'.repeat(BODY_LIMIT - BODY_RESERVE + 1));
  check('a body file GitHub would refuse is refused here, before anything happens', /issue-body-file is \d+ characters; GitHub takes 65536/.test((await throws(() => readConfig(issueEnv({ DR_ISSUE_BODY_FILE: join(root, 'huge.md') }))))?.message) && /pr-body-file is \d+ characters/.test((await throws(() => readConfig(prEnv({ DR_PR_BODY_FILE: join(root, 'huge.md') }))))?.message) && /issue-body is \d+ characters/.test((await throws(() => readConfig(issueEnv({ DR_ISSUE_BODY_FILE: '', DR_ISSUE_BODY: 'y'.repeat(BODY_LIMIT) }))))?.message));
  check('issue-match must be label or title', /issue-match/.test((await throws(() => readConfig(issueEnv({ DR_ISSUE_MATCH: 'body' }))))?.message));
  check('a pr prefix outside bot/ is refused', /bot\/<name>-/.test((await throws(() => readConfig(prEnv({ DR_PR_BRANCH_PREFIX: 'codex-models-' }))))?.message));
  check('a pr prefix without its trailing dash is refused', /bot\/<name>-/.test((await throws(() => readConfig(prEnv({ DR_PR_BRANCH_PREFIX: 'bot/codex-models' }))))?.message));
  check('pr needs files', /pr-files is required/.test((await throws(() => readConfig(prEnv({ DR_PR_FILES: '' }))))?.message));
  check('a missing file is refused', /not a file/.test((await throws(() => readConfig(prEnv({ DR_PR_FILES: 'test/fixtures/none.json' }))))?.message));
  check('a path that climbs out is refused', /relative path inside/.test((await throws(() => readConfig(prEnv({ DR_PR_FILES: '../etc/passwd' }))))?.message));
  check('an absolute path is refused', /relative path inside/.test((await throws(() => readConfig(prEnv({ DR_PR_FILES: join(root, SNAP) }))))?.message));
  // The checkout has the relative counterpart, so the refusal is for the spelling, not for a missing file.
  check('a root-anchored path is refused even when its relative counterpart exists', /relative path inside/.test((await throws(() => readConfig(prEnv({ DR_PR_FILES: `/${SNAP}` }))))?.message) && /relative path inside/.test((await throws(() => readConfig(prEnv({ DR_PR_FILES: `\\${SNAP}` }))))?.message) && /relative path inside/.test((await throws(() => readConfig(prEnv({ DR_PR_FILES: `C:/${SNAP}` }))))?.message));
  check('pr needs a title', /pr-title/.test((await throws(() => readConfig(prEnv({ DR_PR_TITLE: '' }))))?.message));
  check('pr needs its token', /token is required/.test((await throws(() => readConfig(prEnv({ DR_PR_TOKEN: '' }))))?.message));
  check('the commit subject defaults to the pr title', readConfig(prEnv()).prCommitMessage === 'test(codex): snapshot follows the list');
  check('close by title needs a title', /close-title/.test((await throws(() => readConfig(base({ DR_CLOSE: 'true', DR_CLOSE_MATCH: 'title' }))))?.message));
  check('files split on spaces and commas, and one file named twice is one file', readConfig(prEnv({ DR_PR_FILES: `${SNAP}, ./${SNAP}` })).prFiles.join() === SNAP);
  check('files are named as git names them, so they match ls-files and ls-tree', gitPath('./tools//run.sh') === 'tools/run.sh' && gitPath('test\\fixtures\\snap.json') === 'test/fixtures/snap.json' && gitPath('tools/') === 'tools' && readConfig(prEnv({ DR_PR_FILES: `./${SNAP}` })).prFiles[0] === SNAP);
  check('a path that names no file is refused', /must name files/.test((await throws(() => readConfig(prEnv({ DR_PR_FILES: './' }))))?.message));
  check('pr-diff and issue-pointer default on', readConfig(prEnv()).prDiff === true && readConfig(prEnv()).issuePointer === true);
}

console.log('\n  helpers');
{
  check('stamp is UTC to the second', stamp(NOW) === '20261009-224107');
  const prs = [
    { number: 3, headRefName: 'bot/codex-models-1', url: 'u3', isCrossRepository: true },
    { number: 9, headRefName: 'bot/codex-models-2', url: 'u9', isCrossRepository: false },
    { number: 5, headRefName: 'bot/codex-models-3', url: 'u5', isCrossRepository: false },
    { number: 4, headRefName: 'bot/template-rebake-1', url: 'u4', isCrossRepository: false },
  ];
  check('pickPr takes the oldest same-repo PR under the prefix and never a fork branch', pickPr(prs, 'bot/codex-models-')?.number === 5);
  check('pickPr finds nothing under another prefix', pickPr(prs, 'bot/npm-') === null);
  const issues = [{ number: 8, title: 'Wire drift detected: CC v2', url: 'a' }, { number: 2, title: 'CC drift detected: v2', url: 'b' }];
  check('pickIssues by label keeps all, oldest first', pickIssues(issues, 'label').map((i) => i.number).join() === '2,8');
  check('pickIssues by title keeps the exact title', pickIssues(issues, 'title', 'Wire drift detected: CC v2').map((i) => i.number).join() === '8');
  const e = pushEnv({ PATH: '/bin' }, 'tok');
  check('pushEnv clears the persisted header then adds ours, in env not argv', e.GIT_CONFIG_COUNT === '2' && e.GIT_CONFIG_VALUE_0 === '' && e.GIT_CONFIG_KEY_1 === 'http.https://github.com/.extraheader' && e.GIT_CONFIG_VALUE_1 === `AUTHORIZATION: basic ${Buffer.from('x-access-token:tok').toString('base64')}` && e.PATH === '/bin');
  const body = prBody('Text.\n', 'diff --git a b\n', { prDiff: true, runUrl: RUN, workflow: 'W', label: 'codex-drift' });
  check('prBody carries the text, the fenced diff and the run', body.startsWith('Text.\n\n### What changes\n\n```diff\ndiff --git a b\n```') && body.includes(`[a run](${RUN}) of W`) && body.includes('`codex-drift` issue closes'));
  check('prBody without the diff has no fence', !prBody('Text.', 'd', { prDiff: false, runUrl: '', workflow: 'W', label: 'l' }).includes('```'));
  const huge = Array.from({ length: 2000 }, (_, i) => `+line ${i} ${'x'.repeat(40)}`).join('\n');
  const cut = prBody('Text.\n', huge, { prDiff: true, runUrl: RUN, workflow: 'W', label: 'codex-drift' });
  check('a diff that does not fit is cut to GitHub\'s body limit, on a line, with the fence closed and the footer kept', huge.length > BODY_LIMIT && cut.length <= BODY_LIMIT && /```diff\n\+line 0 x/.test(cut) && /x\n```\n\nThe diff is cut at \d+ of \d+ characters; the Files changed tab has the whole of it\.\n\nOpened by/.test(cut) && cut.startsWith('Text.\n\n### What changes'));
  check('a diff that fits is not cut', !prBody('Text.', 'diff --git a b\n', { prDiff: true, runUrl: RUN, workflow: 'W', label: 'l' }).includes('is cut at'));
  const h = sha1('x');
  check('parseEntries reads ls-files -s and ls-tree records alike', JSON.stringify(parseEntries(`100755 ${h} 0\tbin/run.sh\x00100644 blob ${h}\tnew/dir/f.json\x00`)) === JSON.stringify({ 'bin/run.sh': { mode: '100755', sha: h }, 'new/dir/f.json': { mode: '100644', sha: h } }));
  check('parseLines reads one object per line and skips blanks', parseLines('{"n":1}\n\n{"n":2}\n').map((o) => o.n).join() === '1,2');
}

console.log('\n  issue');
{
  const w = world();
  const out = await report(readConfig(issueEnv()), deps(w));
  const list = issueApi(w)[0];
  check('open issues are read through the paginated API under the label, pull requests excluded, without -R', list && list.args.includes('--paginate') && list.args[2] === 'repos/askalf/x/issues?state=open&labels=codex-drift&per_page=100' && list.args[list.args.indexOf('--jq') + 1].includes('select(.pull_request == null)') && !list.args.includes('-R') && list.env.GH_TOKEN === 'jobtok');
  const create = w.find('gh', 'issue', 'create')[0];
  check('no open issue: the label is ensured and the issue created with title, body file and label', w.find('gh', 'label', 'create').length === 1 && create && create.args.includes('Codex drift detected') && create.args.includes('--label') && create.args.includes('codex-drift') && bodyOf(create) === 'The list moved.\n');
  check('the label is created without --force, so an existing label is never rewritten', !w.find('gh', 'label', 'create')[0].args.includes('--force'));
  const w1 = world({ labelExists: true });
  const out1 = await report(readConfig(issueEnv()), deps(w1));
  check('an existing label is left as the repository keeps it and the issue still opens', out1['issue-action'] === 'created' && w1.find('gh', 'label', 'create').length === 1 && w1.find('gh', 'issue', 'create').length === 1);
  const w1b = world({ labelFails: true });
  check('any other label failure stops the run and names the label', /gh label create codex-drift failed/.test((await throws(() => report(readConfig(issueEnv()), deps(w1b))))?.message));
  check('issue calls use the issue token, with the repo', create.env.GH_TOKEN === 'jobtok' && create.args.at(-2) === '-R' && create.args.at(-1) === 'askalf/x');
  check('outputs name the created issue', out['issue-action'] === 'created' && out['issue-number'] === '12' && out['issue-url'] === 'https://github.com/askalf/x/issues/12');
}
{
  const w = world({ issues: [{ number: 30, title: 'other', url: 'u30' }, { number: 20, title: 'Codex drift detected', url: 'u20' }] });
  const out = await report(readConfig(issueEnv()), deps(w));
  const comment = w.find('gh', 'issue', 'comment')[0];
  check('an open issue under the label is refreshed with the body, not duplicated', w.find('gh', 'issue', 'create').length === 0 && comment && comment.args[2] === '20' && bodyOf(comment) === 'The list moved.\n');
  check('outputs name the refreshed issue', out['issue-action'] === 'refreshed' && out['issue-number'] === '20' && out['issue-url'] === 'u20');
  const wn = world({ issues: [{ number: 20, title: 'Codex drift detected', url: 'u20' }] });
  const outn = await report(readConfig(issueEnv({ DR_ISSUE_REFRESH: 'none' })), deps(wn));
  check('issue-refresh none: an open issue is left as it is, no comment, no create', wn.find('gh', 'issue', 'comment').length === 0 && wn.find('gh', 'issue', 'create').length === 0 && outn['issue-action'] === 'unchanged' && outn['issue-number'] === '20');
  const wn2 = world();
  check('issue-refresh none still opens the first issue', (await report(readConfig(issueEnv({ DR_ISSUE_REFRESH: 'none' })), deps(wn2)))['issue-action'] === 'created');
  check('issue-refresh takes comment or none', /issue-refresh must be comment or none/.test((await throws(() => readConfig(issueEnv({ DR_ISSUE_REFRESH: 'daily' }))))?.message));
}
{
  const w = world({ issues: [{ number: 30, title: 'Wire drift detected: CC v2', url: 'u30' }] });
  await report(readConfig(issueEnv({ DR_ISSUE_MATCH: 'title' })), deps(w));
  check('match by title: a different title under the label is not this issue, so a new one opens', w.find('gh', 'issue', 'create').length === 1);
  const w2 = world({ issues: [{ number: 30, title: 'Codex drift detected', url: 'u30' }] });
  await report(readConfig(issueEnv({ DR_ISSUE_MATCH: 'title' })), deps(w2));
  check('match by title: the same title is refreshed', w2.find('gh', 'issue', 'comment').length === 1 && w2.find('gh', 'issue', 'create').length === 0);
  // The matching issue far down a long list: every page is read, so it is refreshed, not duplicated.
  const many = Array.from({ length: 150 }, (_, i) => ({ number: 200 + i, title: `Wire drift detected: CC v${i}`, url: `u${200 + i}` }));
  many.push({ number: 7, title: 'Codex drift detected', url: 'u7' });
  const w3 = world({ issues: many });
  const out3 = await report(readConfig(issueEnv({ DR_ISSUE_MATCH: 'title' })), deps(w3));
  check('match by title finds the issue past the first hundred', out3['issue-action'] === 'refreshed' && out3['issue-number'] === '7' && w3.find('gh', 'issue', 'create').length === 0);
  const w4 = world();
  await report(readConfig(issueEnv({ DR_ISSUE_BODY_FILE: '', DR_ISSUE_BODY: 'inline body' })), deps(w4));
  check('an inline body is written to a file for gh', bodyOf(w4.find('gh', 'issue', 'create')[0]) === 'inline body');
}

console.log('\n  pr, none open');
{
  const w = world({ issues: [{ number: 20, title: 'Codex drift detected', url: 'u20' }] });
  const out = await report(readConfig(prEnv()), deps(w));
  const branch = 'bot/codex-models-20261009-224107';
  const api = w.find('gh', 'api').find((c) => c.args[2].includes('/pulls?'));
  check('open PRs are read through the paginated API, every page, without -R', api && api.args.includes('--paginate') && api.args[2] === 'repos/askalf/x/pulls?state=open&per_page=100' && !api.args.includes('-R') && api.env.GH_TOKEN === 'pat-secret');
  check('pr-files are staged in the caller\'s index and nothing is checked out', w.find('git', 'add')[0]?.args.join(' ') === `add -- ${SNAP}` && !w.find('git', 'add')[0].env.GIT_INDEX_FILE && w.find('git', 'checkout').length === 0);
  const temp = w.calls.filter((c) => c.cmd === 'git' && c.env.GIT_INDEX_FILE);
  check('the tree is built in a temporary index from HEAD plus pr-files alone, so other staged files stay out', temp.map((c) => c.args[0]).join() === 'read-tree,update-index,write-tree' && temp[0].args[1] === 'HEAD' && new Set(temp.map((c) => c.env.GIT_INDEX_FILE)).size === 1);
  check('each file enters that index as the blob and mode the caller\'s index recorded', temp[1].args.join(' ') === `update-index --add --cacheinfo 100644,${sha1('{"models":["b"]}\n')},${SNAP}`);
  const commit = w.find('git', '-c')[0];
  check('the commit carries the author through -c, the subject and HEAD as its parent', commit && commit.args.includes('user.name=drift-report[bot]') && commit.args.includes('user.email=actions@github.com') && commit.args.includes('commit-tree') && commit.args[commit.args.indexOf('-m') + 1] === 'test(codex): snapshot follows the list' && commit.args[commit.args.indexOf('-p') + 1] === 'HEAD');
  const view = w.find('gh', 'repo', 'view')[0];
  check('the default branch is read with the repository as an argument, before anything is pushed', view && view.args.slice(0, 5).join(' ') === 'repo view askalf/x --json defaultBranchRef' && !view.args.includes('-R') && w.calls.indexOf(view) < w.calls.indexOf(w.find('git', 'push')[0]));
  const push = w.find('git', 'push')[0];
  check('the commit is pushed by its sha to the new branch as the PR token, through the environment, and HEAD does not move', push && push.args.at(-1) === `${COMMIT}:refs/heads/${branch}` && push.env.GIT_CONFIG_VALUE_1 === `AUTHORIZATION: basic ${Buffer.from('x-access-token:pat-secret').toString('base64')}` && push.env.GIT_CONFIG_VALUE_0 === '' && w.find('git', 'update-ref').length === 0 && w.find('git', 'reset').length === 0);
  check('no token is ever an argument', w.calls.every((c) => c.args.every((a) => !a.includes('pat-secret') && !a.includes('jobtok'))));
  check('every git call takes pr-files as names, not patterns', w.find('git').length > 0 && w.find('git').every((c) => c.env.GIT_LITERAL_PATHSPECS === '1'));
  const create = w.find('gh', 'pr', 'create')[0];
  check('the PR is opened as the PR token, on the default branch read from the repo, with the label', create && create.env.GH_TOKEN === 'pat-secret' && create.args.includes('--base') && create.args[create.args.indexOf('--base') + 1] === 'master' && create.args.includes('codex-drift') && w.find('gh', 'repo', 'view').length === 1);
  check('the label is ensured for the PR without --force', w.find('gh', 'label', 'create').length === 1 && !w.find('gh', 'label', 'create')[0].args.includes('--force'));
  const wl = world({ labelExists: true });
  check('an existing label survives a new PR and the PR still opens', (await report(readConfig(prEnv({ DR_ISSUE_POINTER: 'false' })), deps(wl)))['pr-action'] === 'created');
  const body = bodyOf(create);
  check('its body is the file, the staged diff and the run', body.startsWith('## Snapshot\n\nIt moved.') && body.includes('```diff\ndiff --git a/x b/x') && body.includes(RUN));
  const pointer = w.find('gh', 'issue', 'comment')[0];
  check('the open issue is pointed at the PR once, as the issue token', w.find('gh', 'issue', 'comment').length === 1 && pointer.args[2] === '20' && pointer.env.GH_TOKEN === 'jobtok' && pointer.args.at(-3).includes('https://github.com/askalf/x/pull/77'));
  check('outputs name the created PR', out['pr-action'] === 'created' && out['pr-number'] === '77' && out['pr-url'] === 'https://github.com/askalf/x/pull/77' && out['pr-branch'] === branch);
  const lines = readFileSync(outFile, 'utf8').trim().split('\n');
  check('GITHUB_OUTPUT has every output as key=value', lines.includes('pr-action=created') && lines.includes(`pr-branch=${branch}`) && lines.includes('closed=0') && lines.includes('issue-action=none'));
}
{
  const w = world();
  await report(readConfig(prEnv({ DR_PR_BASE: 'main', DR_ISSUE_POINTER: 'false', DR_PR_DIFF: 'false' })), deps(w));
  const create = w.find('gh', 'pr', 'create')[0];
  check('a given base is used and the repo is not asked', create.args[create.args.indexOf('--base') + 1] === 'main' && w.find('gh', 'repo', 'view').length === 0);
  check('issue-pointer false lists no issues and comments on none', issueApi(w).length === 0 && w.find('gh', 'issue').length === 0);
  check('pr-diff false leaves the diff out', !bodyOf(create).includes('```'));
}
{
  const w = world({ failPrCreate: true });
  const e = await throws(() => report(readConfig(prEnv()), deps(w)));
  check('a pushed branch whose PR did not open is named in the error', /bot\/codex-models-20261009-224107 is pushed, but the pull request was not opened/.test(e?.message));
  check('the label is ensured before the push', w.calls.indexOf(w.find('gh', 'label', 'create')[0]) < w.calls.indexOf(w.find('git', 'push')[0]));
}
{
  const w = world({ labelFails: true });
  const e = await throws(() => report(readConfig(prEnv()), deps(w)));
  check('a label that cannot be made stops a new PR with nothing pushed', /gh label create codex-drift failed/.test(e?.message) && w.find('git', 'push').length === 0 && w.find('gh', 'pr', 'create').length === 0);
}
{
  const w = world({ issues: [{ number: 20, title: 'Codex drift detected', url: 'u20' }], failIssueComment: true });
  const e = await throws(() => report(readConfig(prEnv()), deps(w)));
  check('an issue that could not be pointed at the opened PR names the PR and the branch', /https:\/\/github\.com\/askalf\/x\/pull\/77 is open from bot\/codex-models-20261009-224107, but the open issue was not pointed at it/.test(e?.message));
}
{
  const w = world({ bigDiff: true });
  await report(readConfig(prEnv({ DR_ISSUE_POINTER: 'false' })), deps(w));
  const body = bodyOf(w.find('gh', 'pr', 'create')[0]);
  check('a PR whose diff is larger than the body limit still opens, with the diff cut and the body within the limit', body.length <= BODY_LIMIT && body.includes('is cut at') && body.includes(RUN));
  check('the body is built before the push', w.calls.findIndex((c) => c.cmd === 'git' && c.args[0] === 'diff') < w.calls.findIndex((c) => c.cmd === 'git' && c.args[0] === 'push'));
}
{
  const w = world({ staged: false });
  const out = await report(readConfig(prEnv()), deps(w));
  check('files that match the base commit nothing and open nothing', out['pr-action'] === 'none' && w.find('git', 'push').length === 0 && w.find('gh', 'pr', 'create').length === 0);
}

console.log('\n  pr, one open');
{
  const OPEN = 'bot/codex-models-20261002-000000';
  const prs = [
    { number: 3, headRefName: 'bot/codex-models-20261001-000000', url: 'fork', isCrossRepository: true },
    openPr(5, OPEN),
  ];
  const w = world({ prs, onBranch: { [SNAP]: '{"models":["b"]}\n' } });
  const out = await report(readConfig(prEnv()), deps(w));
  check('the same blob and mode on the open branch: nothing is written', out['pr-action'] === 'unchanged' && out['pr-number'] === '5' && w.find('git', 'write-tree').length === 0 && w.find('git', 'push').length === 0);
  check('the branch was fetched shallow and read with ls-tree', w.find('git', 'fetch')[0]?.args.join(' ') === `fetch -q --depth 1 origin ${OPEN}` && w.find('git', 'ls-tree')[0]?.args.slice(0, 3).join(' ') === 'ls-tree -z FETCH_HEAD');
  const w2 = world({ prs, onBranch: { [SNAP]: '{"models":["a"]}\n' } });
  const out2 = await report(readConfig(prEnv()), deps(w2));
  const temp = w2.calls.filter((c) => c.cmd === 'git' && c.env.GIT_INDEX_FILE);
  check('different content: the commit is built on FETCH_HEAD in a temporary index, with no checkout', temp[0]?.args.join(' ') === 'read-tree FETCH_HEAD' && w2.find('git', '-c')[0].args[w2.find('git', '-c')[0].args.indexOf('-p') + 1] === 'FETCH_HEAD' && w2.find('git', 'checkout').length === 0 && readFileSync(join(root, SNAP), 'utf8') === '{"models":["b"]}\n');
  check('then pushed by its sha to the open branch as the PR token and the PR told', w2.find('git', 'push')[0]?.args.at(-1) === `${COMMIT}:refs/heads/${OPEN}` && w2.find('git', 'push')[0].env.GIT_CONFIG_COUNT === '2' && w2.find('gh', 'pr', 'comment')[0]?.args[2] === '5' && out2['pr-action'] === 'refreshed');
  check('the blob and mode the watcher had are recorded for the file', w2.find('git', 'update-index')[0]?.args.join(' ') === `update-index --add --cacheinfo 100644,${sha1('{"models":["b"]}\n')},${SNAP}` && w2.find('git', 'update-index')[0].env.GIT_INDEX_FILE);
  check('no new PR, no pointer comment', w2.find('gh', 'pr', 'create').length === 0 && w2.find('gh', 'issue', 'comment').length === 0);
  const w3 = world({ prs, onBranch: {} });
  check('a file absent on the open branch counts as different', (await report(readConfig(prEnv()), deps(w3)))['pr-action'] === 'refreshed');
  const w4 = world({ prs, onBranch: { [SNAP]: { content: '{"models":["b"]}\n', mode: '100755' } } });
  check('the same blob with another mode counts as different', (await report(readConfig(prEnv()), deps(w4)))['pr-action'] === 'refreshed');
  const w5 = world({ prs, onBranch: { [SNAP]: '{"models":["b"]}\n' }, indexModes: { [SNAP]: '100755' } });
  const out5 = await report(readConfig(prEnv()), deps(w5));
  check('an executable in the index is recorded as one', out5['pr-action'] === 'refreshed' && w5.find('git', 'update-index')[0]?.args.join(' ') === `update-index --add --cacheinfo 100755,${sha1('{"models":["b"]}\n')},${SNAP}`);
  // The drift PR far down a long list: every page is read, so it is found and no second PR opens.
  const many = Array.from({ length: 230 }, (_, i) => openPr(100 + i, `feature/${i}`));
  many.push(openPr(9, 'bot/codex-models-20260901-000000'));
  const w6 = world({ prs: many, onBranch: { [SNAP]: '{"models":["b"]}\n' } });
  const out6 = await report(readConfig(prEnv()), deps(w6));
  check('the open drift PR is found past the first hundred PRs', out6['pr-action'] === 'unchanged' && out6['pr-number'] === '9' && w6.find('gh', 'pr', 'create').length === 0);
  const w7 = world({ prs, onBranch: { [SNAP]: '{"models":["a"]}\n' }, failPrComment: true });
  const e7 = await throws(() => report(readConfig(prEnv()), deps(w7)));
  check('a refresh whose comment fails names the pushed branch and the PR', /bot\/codex-models-20261002-000000 is pushed with the new files, but https:\/\/github\.com\/askalf\/x\/pull\/5 was not told/.test(e7?.message));
}

console.log('\n  close');
{
  const issues = [{ number: 8, title: 'Wire drift detected: CC v2', url: 'a' }, { number: 2, title: 'Codex drift detected', url: 'b' }];
  const w = world({ issues });
  const out = await report(readConfig(base({ DR_CLOSE: 'true' })), deps(w));
  const closes = w.find('gh', 'issue', 'close');
  check('every open issue under the label is closed, oldest first, as the issue token', closes.map((c) => c.args[2]).join() === '2,8' && closes.every((c) => c.env.GH_TOKEN === 'jobtok') && out.closed === '2');
  check('the default comment names the workflow and the run', closes[0].args[closes[0].args.indexOf('--comment') + 1] === `Closed by Codex drift watch: [a run](${RUN}) found no drift.`);
  const w2 = world({ issues });
  const out2 = await report(readConfig(base({ DR_CLOSE: 'true', DR_CLOSE_MATCH: 'title', DR_CLOSE_TITLE: 'Wire drift detected: CC v2', DR_CLOSE_COMMENT: 'clean' })), deps(w2));
  check('close by title closes that title only, with the given comment', w2.find('gh', 'issue', 'close').map((c) => c.args[2]).join() === '8' && out2.closed === '1' && w2.find('gh', 'issue', 'close')[0].args.at(-3) === 'clean');
  const w3 = world();
  check('nothing open closes nothing', (await report(readConfig(base({ DR_CLOSE: 'true' })), deps(w3))).closed === '0' && w3.find('gh', 'issue', 'close').length === 0);
  // 101 open issues: the one past the first page is closed too.
  const many = Array.from({ length: 101 }, (_, i) => ({ number: 300 + i, title: `t${i}`, url: `u${i}` }));
  const w4 = world({ issues: many });
  const out4 = await report(readConfig(base({ DR_CLOSE: 'true' })), deps(w4));
  check('a clean run closes every open issue, past the first hundred', out4.closed === '101' && w4.find('gh', 'issue', 'close').length === 101 && w4.find('gh', 'issue', 'close').some((c) => c.args[2] === '400'));
}

// Real git, fake gh: a bare origin, a clone of it, and the branch and commit the report makes,
// read back from origin. Skipped where git is missing.
console.log('\n  pr, real git');
const haveGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
if (!haveGit) {
  console.log('  skip: no git on PATH');
} else {
  const sandbox = mkdtempSync(join(tmpdir(), 'drift-report-git-'));
  const originDir = join(sandbox, 'origin.git');
  const work = join(sandbox, 'work');
  const GIT_ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
  // An empty global config, so the machine's hooks, signing and autocrlf stay out of the test.
  const gitconfig = join(sandbox, 'gitconfig');
  writeFileSync(gitconfig, '');
  const gitEnv = (extra = {}) => ({ ...process.env, ...extra, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' });
  const sh = (args, cwd = work) => {
    const r = spawnSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8', env: gitEnv() });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  sh(['init', '-q', '--bare', '-b', 'master', originDir], sandbox);
  sh(['clone', '-q', originDir, work], sandbox);
  mkdirSync(join(work, 'test', 'fixtures'), { recursive: true });
  writeFileSync(join(work, SNAP), 'A\n');
  writeFileSync(join(work, 'other.txt'), 'other 1\n');
  writeFileSync(join(work, 'third.txt'), 'third 1\n');
  sh(['add', '-A']); sh(['commit', '-q', '-m', 'base']); sh(['push', '-q', 'origin', 'master']);
  // An older bot branch, cut before the directories the later tests need existed.
  sh(['branch', 'bot/snap-20261001-000000']);
  mkdirSync(join(work, 'new', 'dir'), { recursive: true });
  writeFileSync(join(work, 'new', 'dir', 'file.json'), 'X\n');
  mkdirSync(join(work, 'tools'), { recursive: true });
  writeFileSync(join(work, 'tools', 'run.sh'), '#!/bin/sh\necho one\n');
  sh(['add', '-A']); sh(['update-index', '--chmod=+x', 'tools/run.sh']);
  sh(['commit', '-q', '-m', 'adds new/dir and an executable']); sh(['push', '-q', 'origin', 'master', 'bot/snap-20261001-000000']);

  /** gh is faked; git is real and runs in the clone. */
  const hybrid = (prs = []) => {
    const w = world({ prs });
    const fakeGh = w.run;
    const run = (cmd, args, opts = {}) => {
      if (cmd === 'git') {
        w.calls.push({ cmd, args, env: opts.env ?? {}, cwd: opts.cwd });
        const r = spawnSync('git', args, { cwd: opts.cwd, env: gitEnv(opts.env ?? {}), encoding: 'utf8' });
        return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      }
      return fakeGh(cmd, args, opts);
    };
    return { ...w, run };
  };
  const realDeps = (w) => ({ run: w.run, now: () => NOW, log: () => {}, env: process.env });
  const envHere = (extra) => prEnv({ GITHUB_WORKSPACE: work, DR_PR_BODY_FILE: join(root, 'pr-body.md'), DR_PR_BASE: 'master', DR_ISSUE_POINTER: 'false', ...extra });
  const onOrigin = (ref, path) => spawnSync('git', ['show', `${ref}:${path}`], { cwd: originDir, encoding: 'utf8' });
  const modeOnOrigin = (ref, path) => (spawnSync('git', ['ls-tree', ref, '--', path], { cwd: originDir, encoding: 'utf8' }).stdout.split(' ')[0]);
  const OLD = 'bot/snap-20261001-000000';
  const oldPr = [openPr(5, OLD)];
  const status = () => sh(['status', '--porcelain']);
  const onMaster = () => sh(['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'master';
  // The watcher made a file executable: in the index, and on a filesystem that has the bit.
  const execHere = (path) => { sh(['update-index', '--chmod=+x', '--', path]); try { chmodSync(join(work, path), 0o755); } catch { /* no modes here */ } };
  // What a watcher may leave beside pr-files: a staged change, an unstaged change, a staged new file.
  const leaveUnrelated = () => {
    writeFileSync(join(work, 'other.txt'), 'other 2\n'); sh(['add', 'other.txt']);
    writeFileSync(join(work, 'third.txt'), 'third 2\n');
    writeFileSync(join(work, 'unrelated.txt'), 'staged by accident\n'); sh(['add', 'unrelated.txt']);
  };
  const unrelatedSurvive = () => /^M  other\.txt/m.test(status()) && /^ M third\.txt/m.test(status()) && /^A  unrelated\.txt/m.test(status()) && readFileSync(join(work, 'third.txt'), 'utf8') === 'third 2\n';
  const clean = () => { sh(['reset', '-q', '--hard']); rmSync(join(work, 'unrelated.txt'), { force: true }); sh(['checkout', '-q', '-f', 'master']); };

  {
    // A new PR: the unrelated changes stay off the branch and survive in the checkout.
    leaveUnrelated();
    writeFileSync(join(work, SNAP), 'B\n');
    const w = hybrid();
    const out = await report(readConfig(envHere()), realDeps(w));
    const branch = 'bot/codex-models-20261009-224107';
    check('the branch reached origin with the snapshot as the watcher left it', out['pr-action'] === 'created' && onOrigin(branch, SNAP).stdout === 'B\n');
    check('nothing unrelated is on the branch', onOrigin(branch, 'unrelated.txt').status !== 0 && onOrigin(branch, 'other.txt').stdout === 'other 1\n' && onOrigin(branch, 'third.txt').stdout === 'third 1\n');
    check('the unrelated staged, unstaged and new changes all survive, and the checkout is still on master', unrelatedSurvive() && onMaster());
    check('the branch exists only on origin, one commit on master', sh(['rev-list', '--count', `master..${branch}`], originDir).trim() === '1' && spawnSync('git', ['rev-parse', '--verify', '-q', branch], { cwd: work, encoding: 'utf8' }).status !== 0);
    clean();
  }
  {
    // A file whose name is also a glob: data[1].json names that file, never data1.json beside it.
    writeFileSync(join(work, 'data[1].json'), 'bracket 1\n');
    writeFileSync(join(work, 'data1.json'), 'plain 1\n');
    sh(['add', '-A']); sh(['commit', '-q', '-m', 'two data files']); sh(['push', '-q', 'origin', 'master']);
    writeFileSync(join(work, 'data[1].json'), 'bracket 2\n');
    writeFileSync(join(work, 'data1.json'), 'plain 2\n'); sh(['add', 'data1.json']);
    const w = hybrid();
    const out = await report(readConfig(envHere({ DR_PR_BRANCH_PREFIX: 'bot/glob-', DR_PR_FILES: 'data[1].json' })), realDeps(w));
    const branch = 'bot/glob-20261009-224107';
    check('the named file reaches the branch and the file its name would match as a pattern does not', out['pr-action'] === 'created' && onOrigin(branch, 'data[1].json').stdout === 'bracket 2\n' && onOrigin(branch, 'data1.json').stdout === 'plain 1\n');
    check('the unrelated staged change to the look-alike survives in the checkout', /^M  data1\.json/m.test(status()));
    clean();
  }
  {
    // Refreshing a bot branch that predates new/dir, with unrelated changes left in the checkout:
    // the branch gets the file, the checkout keeps everything.
    leaveUnrelated();
    writeFileSync(join(work, 'new', 'dir', 'file.json'), 'Y\n');
    const tipBefore = sh(['rev-parse', OLD], originDir).trim();
    const w = hybrid(oldPr);
    const out = await report(readConfig(envHere({ DR_PR_BRANCH_PREFIX: 'bot/snap-', DR_PR_FILES: 'new/dir/file.json' })), realDeps(w));
    check('the older branch is refreshed with the file and its directory', out['pr-action'] === 'refreshed' && onOrigin(OLD, 'new/dir/file.json').stdout === 'Y\n' && modeOnOrigin(OLD, 'new/dir/file.json') === '100644');
    check('nothing unrelated reached the branch', onOrigin(OLD, 'unrelated.txt').status !== 0 && onOrigin(OLD, 'other.txt').stdout === 'other 1\n');
    check('the unrelated changes survive the refresh, the checkout stays on master, and the PR was told', unrelatedSurvive() && onMaster() && existsSync(join(work, 'tools', 'run.sh')) && w.find('gh', 'pr', 'comment')[0]?.args[2] === '5');
    check('the refresh is one commit on the old branch tip', sh(['rev-parse', `${OLD}^`], originDir).trim() === tipBefore);
    clean();
  }
  {
    // The same content again is a no-op against the real branch.
    writeFileSync(join(work, 'new', 'dir', 'file.json'), 'Y\n');
    const w = hybrid(oldPr);
    const out = await report(readConfig(envHere({ DR_PR_BRANCH_PREFIX: 'bot/snap-', DR_PR_FILES: 'new/dir/file.json' })), realDeps(w));
    check('content already on the branch: unchanged, no push', out['pr-action'] === 'unchanged' && w.find('git', 'push').length === 0);
    clean();
  }
  {
    // An executable the old branch never had: its directory is created and its mode kept.
    writeFileSync(join(work, 'tools', 'run.sh'), '#!/bin/sh\necho two\n');
    const w = hybrid(oldPr);
    const out = await report(readConfig(envHere({ DR_PR_BRANCH_PREFIX: 'bot/snap-', DR_PR_FILES: 'tools/run.sh' })), realDeps(w));
    check('the executable reaches the older branch as 100755 with the new content', out['pr-action'] === 'refreshed' && onOrigin(OLD, 'tools/run.sh').stdout === '#!/bin/sh\necho two\n' && modeOnOrigin(OLD, 'tools/run.sh') === '100755');
    clean();
  }
  {
    // A tracked file an ignore rule matches, absent from the old branch: it is carried from the
    // caller's index, where a second add against the old branch would refuse it as ignored.
    writeFileSync(join(work, '.gitignore'), '*.lock\n');
    writeFileSync(join(work, 'pinned.lock'), 'lock 1\n');
    sh(['add', '.gitignore']); sh(['add', '-f', 'pinned.lock']); sh(['commit', '-q', '-m', 'a tracked, ignored file']); sh(['push', '-q', 'origin', 'master']);
    writeFileSync(join(work, 'pinned.lock'), 'lock 2\n');
    const w = hybrid(oldPr);
    const out = await report(readConfig(envHere({ DR_PR_BRANCH_PREFIX: 'bot/snap-', DR_PR_FILES: 'pinned.lock' })), realDeps(w));
    check('a tracked file that matches .gitignore reaches the older branch', out['pr-action'] === 'refreshed' && onOrigin(OLD, 'pinned.lock').stdout === 'lock 2\n');
    clean();
  }
  {
    // The same executable named as ./tools/run.sh: the mode still travels, and the next run with the
    // same spelling finds the branch unchanged.
    writeFileSync(join(work, 'tools', 'run.sh'), '#!/bin/sh\necho three\n');
    const w = hybrid(oldPr);
    const out = await report(readConfig(envHere({ DR_PR_BRANCH_PREFIX: 'bot/snap-', DR_PR_FILES: './tools/run.sh' })), realDeps(w));
    check('a ./ path keeps the executable mode on the branch', out['pr-action'] === 'refreshed' && onOrigin(OLD, 'tools/run.sh').stdout === '#!/bin/sh\necho three\n' && modeOnOrigin(OLD, 'tools/run.sh') === '100755');
    clean();
    writeFileSync(join(work, 'tools', 'run.sh'), '#!/bin/sh\necho three\n');
    const w2 = hybrid(oldPr);
    const out2 = await report(readConfig(envHere({ DR_PR_BRANCH_PREFIX: 'bot/snap-', DR_PR_FILES: './tools/run.sh' })), realDeps(w2));
    check('and the next run with the same spelling is unchanged', out2['pr-action'] === 'unchanged' && w2.find('git', 'push').length === 0);
    clean();
  }
  {
    // A mode-only change: the same bytes, now executable, is a refresh, and origin records it.
    writeFileSync(join(work, 'new', 'dir', 'file.json'), 'Y\n');
    execHere('new/dir/file.json');
    const w = hybrid(oldPr);
    const out = await report(readConfig(envHere({ DR_PR_BRANCH_PREFIX: 'bot/snap-', DR_PR_FILES: 'new/dir/file.json' })), realDeps(w));
    check('a permission-only change is carried', out['pr-action'] === 'refreshed' && modeOnOrigin(OLD, 'new/dir/file.json') === '100755' && onOrigin(OLD, 'new/dir/file.json').stdout === 'Y\n');
    clean();
  }
  rmSync(sandbox, { recursive: true, force: true });
}

console.log('\n  action pin');
{
  const yaml = [
    'jobs:', '  w:', '    steps:',
    `      - uses: askalf/ci/actions/drift-report@${'0'.repeat(40)} # main 2026-09-01`,
    '      - uses: actions/checkout@abc',
    `      - uses: ${DRIFT_REPORT_ACTION}@${'1'.repeat(40)}`,
    '  review:', `    uses: askalf/ci/.github/workflows/redline-review.yml@${'2'.repeat(40)}`,
  ].join('\n');
  check('countActionPins counts the drift-report pins only', countActionPins(yaml) === 2);
  const bumped = bumpActionPins(yaml, SHA, 'main 2026-10-09, askalf/ci#37');
  const lines = bumped.split('\n');
  check('both pins move to the sha with the note', lines[3] === `      - uses: askalf/ci/actions/drift-report@${SHA} # main 2026-10-09, askalf/ci#37` && lines[5] === `      - uses: askalf/ci/actions/drift-report@${SHA} # main 2026-10-09, askalf/ci#37`);
  check('other uses lines are untouched', lines[4] === '      - uses: actions/checkout@abc' && lines[7].endsWith(`@${'2'.repeat(40)}`));
  check('a short sha is refused', /not a full commit sha/.test((await throws(() => bumpActionPins(yaml, 'abc')))?.message));
  check('a file without the pin comes back unchanged', bumpActionPins('on: push\n', SHA) === 'on: push\n' && countActionPins('on: push\n') === 0);
  const trailing = `      - uses: ${DRIFT_REPORT_ACTION}@${'3'.repeat(40)}   \n`;
  check('an uncommented pin with trailing spaces is a pin, and the bump drops the spaces', countActionPins(trailing) === 1 && bumpActionPins(trailing, SHA) === `      - uses: ${DRIFT_REPORT_ACTION}@${SHA}\n`);
  const crlf = `steps:\r\n  - uses: ${DRIFT_REPORT_ACTION}@${'4'.repeat(40)}\r\n  - uses: ${DRIFT_REPORT_ACTION}@${'5'.repeat(40)} # old\r\n  - uses: actions/checkout@abc\r\n`;
  const crlfBumped = bumpActionPins(crlf, SHA, 'new');
  check('pins in a CRLF file are found, bumped and keep their line endings', countActionPins(crlf) === 2 && crlfBumped === `steps:\r\n  - uses: ${DRIFT_REPORT_ACTION}@${SHA} # new\r\n  - uses: ${DRIFT_REPORT_ACTION}@${SHA} # new\r\n  - uses: actions/checkout@abc\r\n`);
  check('a bump without a note leaves no comment and no stray space', bumpActionPins(`uses: ${DRIFT_REPORT_ACTION}@${'6'.repeat(40)} # gone\n`, SHA) === `uses: ${DRIFT_REPORT_ACTION}@${SHA}\n`);
  check('the action path is what action.yml documents', DRIFT_REPORT_ACTION === 'askalf/ci/actions/drift-report' && existsSync(new URL('../../actions/drift-report/action.yml', import.meta.url)));
}

rmSync(root, { recursive: true, force: true });
console.log(`\n  ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
