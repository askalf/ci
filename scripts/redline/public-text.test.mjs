// Tests for scripts/redline/public-text.mjs. Run: node scripts/redline/public-text.test.mjs
import { addedLines, dashHits } from './public-text.mjs';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
