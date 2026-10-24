// Tests for scripts/redline/local.mjs. Run: node scripts/redline/local.test.mjs
// A throwaway git repository stands in for the workstation's branch; the model is stubbed through
// ctx.fetch, so nothing leaves the machine.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  git, repoFromUrl, changedFiles, fileRecords, gitQuoted, patchOf, branchCommits, baseRef, buildChange, packChange, tarOf, checkChange, reviewLocal, parseArgs,
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
// A third commit of paths and attributes that bend a pack: export-ignore and export-subst marks, a
// name that is a glob of another changed name, a symlink, a path past 100 bytes, a name that is not
// ASCII, and a text file that eol conversion would rewrite.
const LONG = `d/${'x'.repeat(110)}.txt`;
writeFileSync(join(repo, '.gitattributes'), 'vendor.js redline-protected\nsrc/keep.js export-ignore\nsrc/subst.txt export-subst\n');
writeFileSync(join(repo, 'src', 'subst.txt'), 'id $Format:%H$\n');
writeFileSync(join(repo, 'src', '[id].js'), 'export const bracket = 1;\n');
writeFileSync(join(repo, 'src', 'i.js'), 'export const eye = 1;\n');
mkdirSync(join(repo, 'd'));
writeFileSync(join(repo, LONG), 'long path\n');
writeFileSync(join(repo, 'src', 'naïve.js'), 'export const naive = 1;\n');
writeFileSync(join(repo, 'crlf.txt'), 'one\ntwo\n');
g('add', '-A');
const linkBlob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'src/keep.js', encoding: 'utf8' }).stdout.trim();
g('update-index', '--add', '--cacheinfo', `120000,${linkBlob},link`);
g('commit', '-q', '-m', 'test: edge paths');
const TIP = g('rev-parse', 'HEAD').trim();

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
{
  const by = Object.fromEntries(changedFiles(repo, HEAD, TIP).map((f) => [f.filename, f]));
  check('a name that is a glob of another gets only its own patch', by['src/[id].js'].patch.includes('bracket') && !by['src/[id].js'].patch.includes('eye')
    && by['src/i.js'].patch.includes('eye') && !by['src/i.js'].patch.includes('bracket'));
  check('a long path and a name that is not ASCII are listed with their patches', by[LONG]?.patch.includes('+long path') && by['src/naïve.js']?.patch.includes('+export const naive = 1;'));
}
{
  // A rename's diff names two paths; a new file at the old path is a second record in that output.
  const out = [
    'diff --git a/a.js b/a.js', 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', '+++ b/a.js', '@@ -0,0 +1 @@', '+const replacement = 1;',
    'diff --git a/a.js b/b.js', 'similarity index 100%', 'rename from a.js', 'rename to b.js', '',
  ].join('\n');
  const renamed = { filename: 'b.js', previous_filename: 'a.js', status: 'renamed' };
  const patch = (o, f) => fileRecords(o, f).map(patchOf).filter((p) => p !== undefined).join('\n') || undefined;
  check('an unchanged rename takes no hunk from a new file at its old path', patch(out, renamed) === undefined);
  check('the new file at the old path takes only its own hunk', patch(out, { filename: 'a.js', status: 'added' }) === '@@ -0,0 +1 @@\n+const replacement = 1;');
  const edited = `${out.replace(/\n$/, '')}\nindex 2222222..3333333 100644\n--- a/a.js\n+++ b/b.js\n@@ -1 +1 @@\n-old\n+new\n`;
  const p = patch(edited, renamed);
  check('an edited rename takes only its own hunks', p === '@@ -1 +1 @@\n-old\n+new');
  check('a rename whose record is missing gets no patch, not another file\'s', patch(out.split('diff --git a/a.js b/b.js')[0], renamed) === undefined);
  check('a copy is matched by its header', fileRecords('diff --git a/x b/y\ncopy from x\ncopy to y\n@@ -1 +1 @@\n', { filename: 'y', previous_filename: 'x', status: 'copied' }).length === 1);
  check('a name with a tab or a quote is matched as git quotes it', gitQuoted('a/x\ty"z') === '"a/x\\ty\\"z"' && gitQuoted('a/naïve b.js') === 'a/naïve b.js'
    && fileRecords('diff --git "a/x\\ty" "b/x\\ty"\n@@ -1 +1 @@\n-a\n+b\n', { filename: 'x\ty', status: 'modified' }).length === 1);
}
{
  // The same move in a repository: git reports moved.js modified and kept.js added, and neither
  // path may carry the other's lines.
  const r2 = mkdtempSync(join(tmpdir(), 'redline-local-mv-'));
  const g2 = (...args) => git(r2, args);
  g2('init', '-q', '-b', 'main'); g2('config', 'user.name', 't'); g2('config', 'user.email', 't@example.invalid'); g2('config', 'core.autocrlf', 'false');
  writeFileSync(join(r2, 'moved.js'), Array.from({ length: 30 }, (_, i) => `export const m${i} = ${i};`).join('\n') + '\n');
  g2('add', '-A'); g2('commit', '-q', '-m', 'base');
  const b2 = g2('rev-parse', 'HEAD').trim();
  g2('mv', 'moved.js', 'kept.js');
  writeFileSync(join(r2, 'moved.js'), 'export const replacement = true;\n');
  g2('add', '-A'); g2('commit', '-q', '-m', 'move and replace');
  const by = Object.fromEntries(changedFiles(r2, b2, 'HEAD').map((f) => [f.filename, f]));
  check('a file moved away and replaced: each path carries only its own change',
    !(by['kept.js']?.patch ?? '').includes('replacement') && (by['moved.js']?.patch ?? '').includes('+export const replacement = true;'));
  // Local diff config: a textconv driver that drops a line, and wider context. The patch is still
  // the committed text with three lines of context, as GitHub sends it.
  writeFileSync(join(r2, '.git', 'info', 'attributes'), '*.conv diff=strip\n');
  g2('config', 'diff.strip.textconv', 'sed /DROP/d');
  g2('config', 'diff.context', '10');
  writeFileSync(join(r2, 'a.conv'), Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n');
  g2('add', '-A'); g2('commit', '-q', '-m', 'conv base');
  const b3 = g2('rev-parse', 'HEAD').trim();
  writeFileSync(join(r2, 'a.conv'), Array.from({ length: 20 }, (_, i) => (i === 10 ? 'DROP me\n' : '') + `line ${i}`).join('\n') + '\n');
  g2('commit', '-qam', 'conv change');
  const conv = changedFiles(r2, b3, 'HEAD').find((f) => f.filename === 'a.conv');
  check('a textconv driver does not change the patch', conv?.patch?.includes('+DROP me') && conv.additions === 1);
  check('the patch has three lines of context whatever diff.context says', conv?.patch?.startsWith('@@ -8,6 +8,7 @@'));
  // More local settings that reshape a patch: hunks merged across a gap, a blank context line
  // written empty.
  g2('config', 'diff.interHunkContext', '10');
  g2('config', 'diff.suppressBlankEmpty', 'true');
  const lines = Array.from({ length: 20 }, (_, i) => (i % 4 === 3 ? '' : `row ${i}`));
  writeFileSync(join(r2, 'gaps.txt'), lines.join('\n') + '\n');
  g2('add', '-A'); g2('commit', '-q', '-m', 'gaps base');
  const b5 = g2('rev-parse', 'HEAD').trim();
  writeFileSync(join(r2, 'gaps.txt'), lines.map((l, i) => (i === 1 || i === 17 ? `${l} changed` : l)).join('\n') + '\n');
  g2('commit', '-qam', 'gaps change');
  const gaps = changedFiles(r2, b5, 'HEAD').find((f) => f.filename === 'gaps.txt')?.patch ?? '';
  check('two hunks stay two and a blank context line is one space, whatever diff.* says',
    (gaps.match(/^@@/gm) ?? []).length === 2 && gaps.split('\n').includes(' ') && !gaps.split('\n').includes(''));
  // A file replaced by a directory: the removed path is a prefix of the added one.
  g2('config', 'diff.noprefix', 'true');
  writeFileSync(join(r2, 'item'), 'the file\n');
  g2('add', '-A'); g2('commit', '-q', '-m', 'item base');
  const b4 = g2('rev-parse', 'HEAD').trim();
  g2('rm', '-q', 'item'); mkdirSync(join(r2, 'item')); writeFileSync(join(r2, 'item', 'child.js'), 'export const child = 1;\n');
  g2('add', '-A'); g2('commit', '-q', '-m', 'item becomes a directory');
  const byItem = Object.fromEntries(changedFiles(r2, b4, 'HEAD').map((f) => [f.filename, f]));
  check('a file replaced by a directory: each path carries only its own change',
    byItem.item?.patch === '@@ -1 +0,0 @@\n-the file' && byItem['item/child.js']?.patch === '@@ -0,0 +1 @@\n+export const child = 1;');
  // A name with a tab, committed through the index (no file system needs to allow it; Git for
  // Windows refuses it unless core.protectNTFS is off).
  g2('config', 'core.protectNTFS', 'false');
  const TAB = 'src/a\tb.js';
  const blob = (text) => spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: r2, input: text, encoding: 'utf8' }).stdout.trim();
  g2('update-index', '--add', '--cacheinfo', `100644,${blob('one\n')},${TAB}`); g2('commit', '-q', '-m', 'tab base');
  const b6 = g2('rev-parse', 'HEAD').trim();
  g2('update-index', '--cacheinfo', `100644,${blob('one\ntwo\nthree\nfour\n')},${TAB}`); g2('commit', '-q', '-m', 'tab change');
  const tabbed = changedFiles(r2, b6, 'HEAD').find((f) => f.filename === TAB);
  check('a name with a tab keeps its counts and its patch', tabbed?.additions === 3 && tabbed.deletions === 0 && tabbed.changes === 3 && tabbed.patch?.includes('+four'));
  rmSync(r2, { recursive: true, force: true });
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
  check('the change names its repo, base and head', c.repo === 'askalf/r' && c.base.sha === BASE && c.base.ref === 'main' && c.head.sha === TIP && c.head.ref === 'feat/x');
  check('with no PR the title is the last commit\'s subject and the number 0', c.title === 'test: edge paths' && c.number === 0 && c.body === '' && c.reviews.length === 0);
  check('the base\'s .gitattributes travels with it', c.attributes === 'vendor.js redline-protected\n');
  const nested = buildChange(join(repo, 'src'), { base: 'main', repo: 'askalf/r' });
  check('packed from a subdirectory, the change is the same as from the root', JSON.stringify(nested) === JSON.stringify(c)
    && c.files.find((f) => f.filename === 'src/keep.js')?.patch?.includes('process.env.TOKEN'));
  check('and so is the packed tree', packChange(join(repo, 'src'), nested).equals(packChange(repo, c)));
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
  check('a PR read whose reviews fail is an error, not an empty history',
    /could not read the reviews/.test((await throws(() => buildChange(repo, { base: 'main', pr: 7, fetchPr: () => ({ pr: { number: 7, title: 't' }, reviews: null }) })))?.message ?? ''));
}
{
  // The base branch changes .gitattributes after the branch left it: the tip's protected paths count.
  const r4 = mkdtempSync(join(tmpdir(), 'redline-local-attr-'));
  const g4 = (...args) => git(r4, args);
  g4('init', '-q', '-b', 'main'); g4('config', 'user.name', 't'); g4('config', 'user.email', 't@example.invalid');
  writeFileSync(join(r4, '.gitattributes'), 'old.js redline-protected\n');
  g4('add', '-A'); g4('commit', '-q', '-m', 'base');
  g4('checkout', '-q', '-b', 'feat'); writeFileSync(join(r4, 'new.js'), 'x\n'); g4('add', '-A'); g4('commit', '-q', '-m', 'feat');
  g4('checkout', '-q', 'main'); writeFileSync(join(r4, '.gitattributes'), 'new.js redline-protected\n'); g4('commit', '-qam', 'protect new.js');
  g4('checkout', '-q', 'feat');
  check('the protected paths are the base branch tip\'s, not the merge base\'s', buildChange(r4, { base: 'main', repo: 'askalf/attr' }).attributes === 'new.js redline-protected\n');
  rmSync(r4, { recursive: true, force: true });
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
  // eol conversion on, as on a Windows checkout: the pack must still carry the committed bytes.
  g('config', 'core.autocrlf', 'true');
  const tar = packChange(repo, change);
  // tar runs in the target directory: GNU tar reads a C:\ path as a remote host on Windows.
  const x = spawnSync('tar', ['-x', '-f', '-'], { cwd: unpacked, input: tar });
  const read = (p) => readFileSync(join(unpacked, 'tree', p), 'utf8');
  check('the pack unpacks with tar', x.status === 0);
  check('change.json at the top, the head\'s files under tree/', existsSync(join(unpacked, 'change.json')) && read('src/renamed.js').includes('v3 = 33')
    && !existsSync(join(unpacked, 'tree', 'gone.txt')) && !existsSync(join(unpacked, 'tree', '.git')));
  check('change.json reads back whole', JSON.parse(readFileSync(join(unpacked, 'change.json'), 'utf8')).files.length === 15);
  check('a file marked export-ignore is still in the tree', read('src/keep.js').includes('process.env.TOKEN'));
  check('a file marked export-subst keeps its committed bytes', read('src/subst.txt') === 'id $Format:%H$\n');
  check('eol conversion does not touch the packed bytes', read('crlf.txt') === 'one\ntwo\n');
  check('a symlink is a file holding its target', read('link') === 'src/keep.js');
  check('a long path and a name that is not ASCII unpack whole', read(LONG) === 'long path\n' && read('src/na\u00efve.js') === 'export const naive = 1;\n');
}
{
  const t = tarOf([{ path: 'a.txt', data: Buffer.from('hi'), executable: false }]);
  const sum = [...t.subarray(0, 512)].reduce((s, b, i) => s + (i >= 148 && i < 156 ? 32 : b), 0);
  check('a tar entry is one header, the data padded to 512, then two empty blocks', t.length === 512 * 4 && t.toString('utf8', 512, 514) === 'hi'
    && parseInt(t.toString('ascii', 148, 154), 8) === sum && t.toString('ascii', 257, 262) === 'ustar');
}
{
  // A branch that removes every tracked file: the head tree is empty, and the change is still reviewable.
  const r3 = mkdtempSync(join(tmpdir(), 'redline-local-empty-'));
  const out3 = mkdtempSync(join(tmpdir(), 'redline-local-empty-in-'));
  const g3 = (...args) => git(r3, args);
  g3('init', '-q', '-b', 'main'); g3('config', 'user.name', 't'); g3('config', 'user.email', 't@example.invalid');
  writeFileSync(join(r3, 'only.txt'), 'the last file\n');
  g3('add', '-A'); g3('commit', '-q', '-m', 'base');
  g3('checkout', '-q', '-b', 'drop'); g3('rm', '-q', 'only.txt'); g3('commit', '-q', '-m', 'chore: drop the last file');
  const x = spawnSync('tar', ['-x', '-f', '-'], { cwd: out3, input: packChange(r3, buildChange(r3, { base: 'main', repo: 'askalf/empty' })) });
  check('a head with no files still unpacks a tree/', x.status === 0 && existsSync(join(out3, 'tree')) && readdirSync(join(out3, 'tree')).length === 0);
  const submit = [{ type: 'tool_use', id: 's1', name: 'redline_submit', input: { verdict: 'APPROVE', summary: 'Removes the last file.', findings: [] } }];
  const fetch = async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ content: submit }), text: async () => '' });
  let t = 0;
  const ctx = { darioUrl: 'http://dario/', darioKey: 'k', model: 'routine', deepModel: 'deep', pinModel: '', fallbackModel: '', system: 'sys', context: '',
    fetch, sleep: async () => {}, now: () => (t += 1000), log: () => {} };
  check('a change that removes every file is reviewed, not refused', (await reviewLocal(ctx, out3)).verdict === 'APPROVE');
  rmSync(r3, { recursive: true, force: true });
  rmSync(out3, { recursive: true, force: true });
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

rmSync(repo, { recursive: true, force: true });
rmSync(unpacked, { recursive: true, force: true });
console.log(`\n  ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
