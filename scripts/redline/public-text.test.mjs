// Tests for scripts/redline/public-text.mjs. Run: node scripts/redline/public-text.test.mjs
import { addedByContent, addedLines, check as checkPr, dashHits, needsContent } from './public-text.mjs';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}`); fail++; }
}

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

console.log('addedLines');
{
  const patch = [
    '@@ -10,4 +10,5 @@ export function f() {',
    ' kept',
    '-gone',
    '+new one',
    '+new two',
    ' kept',
    '\\ No newline at end of file',
    '@@ -40,2 +41,3 @@',
    ' x',
    '+later',
  ].join('\n');
  const a = addedLines(patch);
  check('numbers added lines in the new file', JSON.stringify(a) === JSON.stringify([
    { line: 11, text: 'new one' }, { line: 12, text: 'new two' }, { line: 42, text: 'later' },
  ]));
  check('a patch with no hunk adds nothing', addedLines('+not a hunk').length === 0);
  check('no patch adds nothing', addedLines(undefined).length === 0);
}

console.log('dashHits');
{
  const files = [
    // The dash sits on a context line and a removed line: neither is added, so neither counts.
    { filename: 'CHANGELOG.md', status: 'modified', changes: 2, patch: `@@ -1,3 +1,3 @@\n # Changelog\n-old ${EM} line\n+new, line\n ## 1.0 ${EM} older` },
    { filename: 'src/a.js', status: 'modified', changes: 1, patch: `@@ -5,1 +5,2 @@\n x\n+// waits ${EM} then retries` },
    { filename: 'docs/range.md', status: 'added', changes: 1, patch: `@@ -0,0 +1,1 @@\n+pages 10${EN}20` },
    { filename: 'fixtures/captured.json', status: 'added', changes: 1, patch: `@@ -0,0 +1,1 @@\n+{"t": "a ${EM} b"}` },
    { filename: 'big.json', status: 'modified', changes: 9000 },
    { filename: 'logo.png', status: 'added', changes: 0 },
    { filename: 'old.md', status: 'removed', changes: 3 },
  ];
  const { hits, unread } = dashHits({
    title: `fix: retry ${EM} once`,
    body: `First line.\r\nSecond ${EN} line.`,
    commits: [{ sha: 'abcdef1234567890', commit: { message: `subject\n\nbody ${EM} here` } }, { sha: '1234567aaaa', commit: { message: 'clean' } }],
    files,
    protectedPaths: new Set(['fixtures/captured.json']),
  });
  const where = hits.map((h) => `${h.where}:${h.line}`);
  check('the title, a description line and a commit message line', where.includes('PR title:1') && where.includes('PR description:2') && where.includes('commit abcdef1 message:3'));
  check('an added code line, by its new line number', where.includes('src/a.js:6') && hits.find((h) => h.where === 'src/a.js').file === true);
  check('an en dash counts too', where.includes('docs/range.md:1'));
  check('context and removed lines do not count', !where.some((w) => w.startsWith('CHANGELOG.md')));
  check('captured data is skipped', !where.some((w) => w.startsWith('fixtures/')));
  check('exactly the five added dashes', hits.length === 5);
  check('PR text hits are not file hits', !hits.find((h) => h.where === 'PR title').file);
  check('a changed file with no patch is reported unread, an image with no change is not', JSON.stringify(unread) === '["big.json"]');
  check('a clean PR has no hits', dashHits({ title: 'fix: retry once', body: null, commits: [], files: [] }).hits.length === 0);
}

console.log('a text file with no patch');
{
  check('addedByContent: the lines a diff adds, by head line number',
    JSON.stringify(addedByContent('a\nb\nc\n', 'a\nnew\nb\nc\nb\n')) === JSON.stringify([{ line: 2, text: 'new' }, { line: 5, text: 'b' }]));
  check('addedByContent: an added file is all added', addedByContent('', 'x\ny').length === 2 && addedByContent('', 'x\ny')[0].line === 1);
  const moved = addedByContent(`## one\nkeep ${EM} me\nfiller\n## two\nmore\n`, `## one\nfiller\n## two\nkeep ${EM} me\nmore\n`);
  check('addedByContent: a dash line moved to another section is added where it lands',
    moved.some((a) => a.line === 4 && a.text === `keep ${EM} me`));
  const dup = addedByContent(`a\nsame ${EM} line\nb\n`, `new\nsame ${EM} line\na\nsame ${EM} line\nb\n`);
  check('addedByContent: a duplicate inserted before its original is added at its own line',
    dup.some((a) => a.line === 2 && a.text === `same ${EM} line`) && !dup.some((a) => a.line === 4));
  const big = { filename: 'data/big.md', status: 'modified', changes: 9000 };
  check('needsContent: a changed text file with no patch, not a binary or a removed one',
    JSON.stringify(needsContent([big, { filename: 'a.png', status: 'modified', changes: 0 }, { filename: 'gone.md', status: 'removed', changes: 4 }]).map((f) => f.filename)) === '["data/big.md"]');
  const read = dashHits({ files: [big], contents: new Map([['data/big.md', { base: `old ${EM} kept\nx`, head: `old ${EM} kept\nx\nnew ${EM} line` }]]) });
  check('its added lines are read from the base and head: the new dash counts, the kept one does not',
    read.hits.length === 1 && read.hits[0].line === 3 && read.unread.length === 0);
  check('a head with a NUL byte is binary and skipped', dashHits({ files: [big], contents: new Map([['data/big.md', { base: '', head: `\0${EM}` }]]) }).hits.length === 0);
  check('no contents for it: unread', JSON.stringify(dashHits({ files: [big] }).unread) === '["data/big.md"]');
}

console.log('check, against a stubbed GitHub');
{
  const PR = { title: 'docs: grow the table', body: 'More rows.', base: { sha: 'b'.repeat(40) }, head: { sha: 'h'.repeat(40) } };
  const big = { filename: 'docs/table.md', status: 'modified', changes: 9000 };
  const world = (raw, pr = PR) => ({
    repo: 'askalf/x', readToken: 't', sleep: async () => {}, now: () => 0,
    fetch: async (url) => {
      const u = new URL(url);
      const json = (v) => ({ ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) });
      if (u.pathname === '/repos/askalf/x/pulls/5') return json(pr);
      if (u.pathname === '/repos/askalf/x/pulls/5/files') return json(u.searchParams.get('page') === '1' ? [big] : []);
      if (u.pathname === '/repos/askalf/x/pulls/5/commits') return json(u.searchParams.get('page') === '1' ? [{ sha: 'c'.repeat(40), commit: { message: 'docs: rows' } }] : []);
      if (u.pathname === '/repos/askalf/x/contents/.gitattributes') return { ok: false, status: 404, json: async () => ({}), text: async () => 'Not Found' };
      if (u.pathname === '/repos/askalf/x/contents/docs/table.md') return raw(u.searchParams.get('ref'));
      return { ok: false, status: 418, json: async () => ({}), text: async () => `unexpected ${url}` };
    },
  });
  const text = (s) => ({ ok: true, status: 200, text: async () => s });
  const down = { ok: false, status: 500, text: async () => 'boom' };
  const unreadable = await checkPr(world(() => down), 5);
  check('a text file with no patch that cannot be read fails the check (2), never passes',
    unreadable.code === 2 && /Not every added line could be read: docs\/table\.md/.test(unreadable.summary) && unreadable.annotations.some((a) => a.includes('file=docs/table.md')));
  const dashed = await checkPr(world((ref) => text(ref === PR.base.sha ? 'row\n' : `row\nrow ${EM} two\n`)), 5);
  check('read whole, its added dash fails the check (1) at its line', dashed.code === 1 && dashed.summary.includes('docs/table.md:2'));
  const clean = await checkPr(world((ref) => text(ref === PR.base.sha ? `row ${EM} one\n` : `row ${EM} one\nrow two\n`)), 5);
  check('read whole with only an old dash, it passes (0)', clean.code === 0 && /No added line/.test(clean.summary));
  const cleanRead = (ref) => text(ref === PR.base.sha ? 'row\n' : 'row\nrow two\n');
  const listed = await checkPr(world(cleanRead, { ...PR, changed_files: 1 }), 5);
  check('every changed file listed: it passes (0)', listed.code === 0);
  const capped = await checkPr(world(cleanRead, { ...PR, changed_files: 3500 }), 5);
  check('more changed files than the files API lists: incomplete (2), never a pass',
    capped.code === 2 && capped.summary.includes('3499 changed file(s) the files API did not list') && capped.annotations.some((a) => a.includes('listed 1, so 3499 were not checked')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
