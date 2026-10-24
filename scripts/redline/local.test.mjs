// Tests for scripts/redline/local.mjs. Run: node scripts/redline/local.test.mjs
// A throwaway git repository stands in for the workstation's branch; the model is stubbed through
// ctx.fetch, so nothing leaves the machine.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  git, repoFromUrl, changedFiles, branchCommits, baseRef, buildChange, packChange, checkChange, reviewLocal, parseArgs,
} from './local.mjs';
import { REVIEWER_LOGIN } from './review.mjs';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}`); fail++; }
}
async function throws(fn) { try { await fn(); return null; } catch (e) { return e; } }

console.log('\n  repoFromUrl and parseArgs');
check('https and ssh remotes name owner/repo', repoFromUrl('https://github.com/askalf/ci.git') === 'askalf/ci'
  && repoFromUrl('git@github.com:askalf/plumbline.git') === 'askalf/plumbline' && repoFromUrl('https://github.com/a/b') === 'a/b');
check('a remote off GitHub names nothing', repoFromUrl('https://example.com/a/b.git') === null && repoFromUrl('') === null);
check('flags take the next word; the rest is positional', JSON.stringify(parseArgs(['pack', '--pr', '7', '--base', 'origin/dev'])) === JSON.stringify({ _: ['pack'], pr: '7', base: 'origin/dev' }));
check('a flag with no value is an error', !!(await throws(() => parseArgs(['pack', '--pr']))) && !!(await throws(() => parseArgs(['--pr', '--base', 'x']))));

// A repository with a main branch and a feature branch that adds, changes, renames, removes and
// adds a binary file, in two commits.
const repo = mkdtempSync(join(tmpdir(), 'redline-local-'));
const g = (...args) => git(repo, args);
g('init', '-q', '-b', 'main');
g('config', 'user.name', 'tester');
g('config', 'user.email', 'tester@example.invalid');
g('config', 'core.autocrlf', 'false');
mkdirSync(join(repo, 'src'));
mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
writeFileSync(join(repo, 'src', 'keep.js'), 'const a = 1;\nconst b = 2;\n');
writeFileSync(join(repo, 'src', 'old.js'), Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');
writeFileSync(join(repo, 'gone.txt'), 'bye\n');
writeFileSync(join(repo, 'vendor.js'), 'captured\n');
writeFileSync(join(repo, '.gitattributes'), 'vendor.js redline-protected\n');
g('add', '-A');
g('commit', '-q', '-m', 'base');
const BASE = g('rev-parse', 'HEAD').trim();
g('checkout', '-q', '-b', 'feat/x');
writeFileSync(join(repo, 'src', 'keep.js'), 'const a = 1;\nconst b = process.env.TOKEN;\n');
writeFileSync(join(repo, 'src', 'new file.js'), 'export const added = true;\n');
g('add', '-A');
g('commit', '-q', '-m', 'feat: read the token\n\nSecond paragraph of the message.');
g('mv', 'src/old.js', 'src/renamed.js');
writeFileSync(join(repo, 'src', 'renamed.js'), readFileSync(join(repo, 'src', 'renamed.js'), 'utf8').replace('v3 = 3', 'v3 = 33'));
g('rm', '-q', 'gone.txt');
writeFileSync(join(repo, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0, 3]));
writeFileSync(join(repo, 'vendor.js'), 'captured again\n');
writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
g('add', '-A');
g('commit', '-q', '-m', 'chore: move and drop');
const HEAD = g('rev-parse', 'HEAD').trim();

console.log('\n  changedFiles');
{
  const files = changedFiles(repo, BASE, HEAD);
  const by = Object.fromEntries(files.map((f) => [f.filename, f]));
  check('every change is listed once', files.length === 7 && ['src/keep.js', 'src/new file.js', 'src/renamed.js', 'gone.txt', 'img.png', 'vendor.js', '.github/workflows/ci.yml'].every((n) => by[n]));
  check('statuses are GitHub\'s words', by['src/keep.js'].status === 'modified' && by['src/new file.js'].status === 'added' && by['gone.txt'].status === 'removed' && by['src/renamed.js'].status === 'renamed');
  check('a rename names the file it came from', by['src/renamed.js'].previous_filename === 'src/old.js');
  check('a patch starts at the first hunk, as GitHub sends it', by['src/keep.js'].patch.startsWith('@@ ') && by['src/keep.js'].patch.includes('+const b = process.env.TOKEN;') && !by['src/keep.js'].patch.includes('diff --git'));
  check('a renamed file\'s patch carries only its edit', /^@@/.test(by['src/renamed.js'].patch) && by['src/renamed.js'].patch.includes('+export const v3 = 33;') && !by['src/renamed.js'].patch.includes('+export const v0'));
  check('a binary file has no patch', by['img.png'].patch === undefined);
  check('counts per file, rename included', by['src/keep.js'].additions === 1 && by['src/keep.js'].deletions === 1 && by['src/keep.js'].changes === 2
    && by['src/renamed.js'].additions === 1 && by['src/renamed.js'].deletions === 1 && by['gone.txt'].deletions === 1);
  check('a path with a space survives', by['src/new file.js'].patch.includes('+export const added = true;'));
}

console.log('\n  branchCommits and baseRef');
{
  const commits = branchCommits(repo, BASE, HEAD);
  check('the branch\'s commits, oldest first, whole messages', commits.length === 2 && commits[0].commit.message === 'feat: read the token\n\nSecond paragraph of the message.'
    && commits[1].commit.message === 'chore: move and drop' && commits[1].sha === HEAD);
  check('--base wins; with no origin the base is origin/main', baseRef(repo, 'main') === 'main' && baseRef(repo) === 'origin/main');
}

console.log('\n  buildChange');
{
  const c = buildChange(repo, { base: 'main', repo: 'askalf/r' });
  check('the change names its repo, base and head', c.repo === 'askalf/r' && c.base.sha === BASE && c.base.ref === 'main' && c.head.sha === HEAD && c.head.ref === 'feat/x');
  check('with no PR the title is the last commit\'s subject and the number 0', c.title === 'chore: move and drop' && c.number === 0 && c.body === '' && c.reviews.length === 0);
  check('the base\'s .gitattributes travels with it', c.attributes === 'vendor.js redline-protected\n');
  const asked = [];
  const withPr = buildChange(repo, {
    base: 'main', repo: 'askalf/r', pr: 7,
    fetchPr: (r, n) => { asked.push(`${r}#${n}`); return { pr: { number: 7, title: 'feat: token', body: 'Reads it.', user: { login: 'askalf' } }, reviews: [{ user: { login: REVIEWER_LOGIN }, state: 'CHANGES_REQUESTED', commit_id: BASE, body: 'Earlier: the token is logged.', extra: 'dropped' }] }; },
  });
  check('--pr reads the PR\'s title, body, author and reviews', asked.join() === 'askalf/r#7' && withPr.title === 'feat: token' && withPr.body === 'Reads it.' && withPr.author === 'askalf' && withPr.number === 7
    && withPr.reviews.length === 1 && withPr.reviews[0].body === 'Earlier: the token is logged.' && !('extra' in withPr.reviews[0]));
  check('--title wins over the PR\'s', buildChange(repo, { base: 'main', pr: 7, title: 'mine', fetchPr: () => ({ pr: { number: 7, title: 'theirs' }, reviews: [] }) }).title === 'mine');
  check('a PR that cannot be read is an error, not a review without it', /could not read/.test((await throws(() => buildChange(repo, { base: 'main', pr: 7, fetchPr: () => ({ pr: null }) })))?.message ?? ''));
  check('HEAD on the base is an error', /nothing to review/.test((await throws(() => buildChange(repo, { base: 'HEAD' })))?.message ?? ''));
}

console.log('\n  checkChange');
{
  const ok = { repo: 'a/b', head: { sha: HEAD }, base: { sha: BASE }, files: [{ filename: 'x' }], commits: [] };
  check('a whole change passes', !checkChange(ok).error);
  check('short shas, no files or no repo fail', !!checkChange({ ...ok, head: { sha: 'abc' } }).error && !!checkChange({ ...ok, files: [] }).error
    && !!checkChange({ ...ok, repo: '' }).error && !!checkChange(null).error);
}

console.log('\n  packChange and reviewLocal');
const unpacked = mkdtempSync(join(tmpdir(), 'redline-local-in-'));
{
  const change = buildChange(repo, { base: 'main', repo: 'askalf/r', pr: 7, fetchPr: () => ({
    pr: { number: 7, title: 'feat: token', body: 'Reads it.', user: { login: 'askalf' } },
    reviews: [{ user: { login: REVIEWER_LOGIN }, state: 'CHANGES_REQUESTED', commit_id: BASE, body: 'Earlier: the token is logged.' }],
  }) });
  const tar = packChange(repo, change, 'pipe');
  // tar runs in the target directory: GNU tar reads a C:\ path as a remote host on Windows.
  const x = spawnSync('tar', ['-x', '-f', '-'], { cwd: unpacked, input: tar });
  check('the pack unpacks with tar', x.status === 0);
  check('change.json at the top, the head\'s files under tree/', existsSync(join(unpacked, 'change.json')) && readFileSync(join(unpacked, 'tree', 'src', 'keep.js'), 'utf8').includes('process.env.TOKEN')
    && existsSync(join(unpacked, 'tree', 'src', 'renamed.js')) && !existsSync(join(unpacked, 'tree', 'gone.txt')) && !existsSync(join(unpacked, 'tree', '.git')));
  check('change.json reads back whole', JSON.parse(readFileSync(join(unpacked, 'change.json'), 'utf8')).files.length === 7);
}
{
  const calls = { model: [] };
  const json = (body, status = 200) => ({ ok: status < 300, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
  const turns = [
    [{ type: 'tool_use', id: 'r1', name: 'redline_read', input: { path: 'src/keep.js' } }],
    [{ type: 'tool_use', id: 's1', name: 'redline_submit', input: { verdict: 'REQUEST_CHANGES', summary: 'One issue.', findings: [
      { severity: 'blocking', file: 'src/keep.js', line: 2, quote: '+const b = process.env.TOKEN;', problem: 'Keeps the token in a module constant.' }] } }],
  ];
  const fetch = async (url, init = {}) => {
    if (!String(url).endsWith('/v1/messages')) return json({ message: `unexpected ${url}` }, 404);
    calls.model.push(JSON.parse(init.body));
    return json({ content: turns[Math.min(calls.model.length - 1, turns.length - 1)] });
  };
  let t = 0;
  const logs = [];
  const ctx = { darioUrl: 'http://dario/', darioKey: 'k', model: 'routine', deepModel: 'deep', pinModel: '', fallbackModel: '', system: 'sys', context: '',
    fetch, sleep: async () => {}, now: () => (t += 1000), log: (l) => logs.push(l) };
  const r = await reviewLocal(ctx, unpacked);
  const first = calls.model[0].messages[0].content;
  check('the verdict and the posted body\'s text come back', r.verdict === 'REQUEST_CHANGES' && r.body.includes('Keeps the token in a module constant.'));
  check('the brief is the PR as review.mjs builds it', first.includes('Repository: askalf/r') && first.includes('PR #7: feat: token') && first.includes('Reads it.')
    && first.includes('+const b = process.env.TOKEN;') && first.includes('chore: move and drop'));
  check('Redline\'s earlier request reaches the model', first.includes('Earlier: the token is logged.'));
  check('the read tools read the packed tree', JSON.stringify(calls.model[1].messages.at(-1)).includes('process.env.TOKEN'));
  check('a change under .github/ routes to the deep model, as on a PR', r.model === 'deep' && calls.model[0].model === 'deep' && logs.some((l) => /read on deep/.test(l)));
  check('captured data is marked from the base\'s .gitattributes', /redline-protected[^\n]*vendor\.js/.test(first));
  writeFileSync(join(unpacked, 'change.json'), JSON.stringify({ repo: 'a/b' }));
  check('a broken change.json stops before any model call', /full head and base/.test((await throws(() => reviewLocal(ctx, unpacked)))?.message ?? '') && calls.model.length === 2);
}

// A second repository whose names are pathspec magic and whose .gitattributes asks archives to drop
// and rewrite files.
console.log('\n  literal paths and archive attributes');
const odd = mkdtempSync(join(tmpdir(), 'redline-local-odd-'));
const oddOut = mkdtempSync(join(tmpdir(), 'redline-local-odd-in-'));
{
  const o = (...args) => git(odd, args);
  o('init', '-q', '-b', 'main');
  o('config', 'user.name', 'tester');
  o('config', 'user.email', 'tester@example.invalid');
  o('config', 'core.autocrlf', 'false');
  mkdirSync(join(odd, 'src'));
  writeFileSync(join(odd, 'src', 'a[1].js'), 'export const bracket = 0;\n');
  writeFileSync(join(odd, 'src', 'a1.js'), 'export const plain = 0;\n');
  writeFileSync(join(odd, '.gitattributes'), 'src/ export-ignore\nstamp.txt export-subst\n');
  writeFileSync(join(odd, 'stamp.txt'), 'built from $Format:%H$\n');
  o('add', '-A');
  o('commit', '-q', '-m', 'base');
  const oddBase = o('rev-parse', 'HEAD').trim();
  o('checkout', '-q', '-b', 'feat/odd');
  writeFileSync(join(odd, 'src', 'a[1].js'), 'export const bracket = 1;\n');
  writeFileSync(join(odd, 'src', 'a1.js'), 'export const plain = 1;\n');
  o('add', '-A');
  o('commit', '-q', '-m', 'feat: both');
  const files = changedFiles(odd, oddBase, o('rev-parse', 'HEAD').trim());
  const by = Object.fromEntries(files.map((f) => [f.filename, f]));
  check('a name with pathspec magic gets only its own patch', by['src/a[1].js'].patch.includes('+export const bracket = 1;') && !by['src/a[1].js'].patch.includes('plain')
    && by['src/a1.js'].patch.includes('+export const plain = 1;') && !by['src/a1.js'].patch.includes('bracket'));
  const tar = packChange(odd, buildChange(odd, { base: 'main', repo: 'askalf/odd' }), 'pipe');
  const x = spawnSync('tar', ['-x', '-f', '-'], { cwd: oddOut, input: tar });
  check('export-ignore does not drop committed files from tree/', x.status === 0
    && readFileSync(join(oddOut, 'tree', 'src', 'a[1].js'), 'utf8') === 'export const bracket = 1;\n' && readFileSync(join(oddOut, 'tree', 'src', 'a1.js'), 'utf8') === 'export const plain = 1;\n');
  check('export-subst does not rewrite committed bytes in tree/', existsSync(join(oddOut, 'tree', 'stamp.txt')) && readFileSync(join(oddOut, 'tree', 'stamp.txt'), 'utf8') === 'built from $Format:%H$\n');
}

rmSync(repo, { recursive: true, force: true });
rmSync(unpacked, { recursive: true, force: true });
rmSync(odd, { recursive: true, force: true });
rmSync(oddOut, { recursive: true, force: true });
console.log(`\n  ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
