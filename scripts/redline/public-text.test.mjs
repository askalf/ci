// Tests for scripts/redline/public-text.mjs. Run: node scripts/redline/public-text.test.mjs
import { addedByContent, addedLines, check as checkPr, creditHits, dashHits, fromFork, needsContent, overused, ownDescription } from './public-text.mjs';

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

console.log('overused');
{
  check('four dashed lines are normal text, however short the PR', !overused(4, 4));
  check('five dashed lines in a short PR are overuse', overused(5, 5) && overused(5, 40));
  check('five dashed lines in a long PR are normal text', !overused(5, 1000));
  check('exactly one line in twenty is under the limit', !overused(50, 1000));
  check('more than one line in twenty is overuse', overused(51, 1000));
  check('nothing read is not overuse', !overused(0, 0));
}

console.log('fromFork');
{
  check('a branch of this repository is not a fork', !fromFork({ head: { repo: { full_name: 'askalf/x' } } }, 'askalf/x'));
  check('another repository is a fork', fromFork({ head: { repo: { full_name: 'someone/x' } } }, 'askalf/x'));
  check('a deleted fork is a fork', fromFork({ head: { repo: null } }, 'askalf/x'));
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
  check('total counts the lines read and leaves blank ones out', dashHits({ title: 'a', body: 'b\n\nc', commits: [], files: [] }).total === 3);
}

console.log('creditHits');
{
  const robot = String.fromCodePoint(0x1f916);
  const found = creditHits({
    title: 'feat: retry once',
    body: `Retries once.\n\n${robot} Generated with [Claude Code](https://claude.com/claude-code)\n\nhttps://claude.ai/code/session_01ABC`,
    commits: [
      { sha: 'abcdef1234567890', commit: { message: 'fix: x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' } },
      { sha: '1234567aaaa', commit: { message: 'fix: y\n\nco-authored-by: GitHub Copilot <copilot@github.com>\nClaude-Session: https://example.test/s' } },
      { sha: '7777777bbbb', commit: { message: 'fix: z\n\nCo-authored-by: Dana Reyes <dana@example.test>' } },
    ],
  });
  const where = found.map((h) => `${h.where}:${h.line}`);
  check('a generated-with footer and a session link in the description', where.includes('PR description:3') && where.includes('PR description:5'));
  check('co-author trailers for a model or a tool, in any case', where.includes('commit abcdef1 message:3') && where.includes('commit 1234567 message:3'));
  check('a session trailer', where.includes('commit 1234567 message:4'));
  check('a person as co-author is not a credit', !where.some((w) => w.startsWith('commit 7777777')));
  check('exactly those five', found.length === 5);
  check('naming a tool is not crediting it', creditHits({ title: 'fix: the Claude Code adapter drops the Copilot header', body: 'Codex and Gemini requests keep their model name.', commits: [] }).length === 0);
  const coAuthor = (trailer) => creditHits({ commits: [{ sha: 'abcdef1', commit: { message: `fix: x\n\n${trailer}` } }] }).length;
  check('a person named Claude as co-author is not a credit', coAuthor('Co-Authored-By: Claude Martin <claude.martin@example.org>') === 0);
  check('a person at a model vendor as co-author is not a credit',
    coAuthor('Co-authored-by: Dana Reyes <dana@anthropic.com>') === 0 && coAuthor('Co-authored-by: Sam Lee <sam@openai.com>') === 0);
  check('GPT and its versioned names as co-author are credits',
    coAuthor('Co-Authored-By: GPT <noreply@example.org>') === 1 && coAuthor('Co-authored-by: GPT-4o <x@example.org>') === 1
      && coAuthor('Co-authored-by: OpenAI GPT-5.5 <x@example.org>') === 1 && coAuthor('Co-authored-by: ChatGPT <x@example.org>') === 1);
  check('a tool address under a person-like name is a credit', coAuthor('Co-authored-by: Helper <noreply@anthropic.com>') === 1);
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
  const PR = { title: 'docs: grow the table', body: 'More rows.', base: { sha: 'b'.repeat(40) }, head: { sha: 'h'.repeat(40), repo: { full_name: 'askalf/x' } } };
  // The merge base of the PR's base and head: the base branch has moved on from it.
  const MB = 'a'.repeat(40);
  const big = { filename: 'docs/table.md', status: 'modified', changes: 9000 };
  const world = (raw, pr = PR, mergeBase = MB) => ({
    repo: 'askalf/x', readToken: 't', sleep: async () => {}, now: () => 0,
    fetch: async (url) => {
      const u = new URL(url);
      const json = (v) => ({ ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) });
      if (u.pathname === '/repos/askalf/x/pulls/5') return json(pr);
      if (u.pathname === '/repos/askalf/x/pulls/5/files') return json(u.searchParams.get('page') === '1' ? [big] : []);
      if (u.pathname === '/repos/askalf/x/pulls/5/commits') return json(u.searchParams.get('page') === '1' ? [{ sha: 'c'.repeat(40), commit: { message: 'docs: rows' } }] : []);
      if (u.pathname === `/repos/askalf/x/compare/${PR.base.sha}...${PR.head.sha}`) {
        return mergeBase ? json({ merge_base_commit: { sha: mergeBase } }) : { ok: false, status: 404, json: async () => ({}), text: async () => 'Not Found' };
      }
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
  const rows = (n) => Array.from({ length: n }, (_, i) => `row ${EM} ${i}\n`).join('');
  const dashed = await checkPr(world((ref) => text(ref === MB ? 'row\n' : `row\n${rows(5)}`)), 5);
  check('read whole, five added dashes fail the check (1), each at its line',
    dashed.code === 1 && dashed.summary.includes('docs/table.md:2') && dashed.summary.includes('docs/table.md:6') && /5 of 8 added lines/.test(dashed.summary));
  const normal = await checkPr(world((ref) => text(ref === MB ? 'row\n' : `row\n${rows(1)}`)), 5);
  check('one dash in normal text passes (0), with nothing flagged', normal.code === 0 && normal.annotations.length === 0 && /within the limit/.test(normal.summary));
  const under = await checkPr(world((ref) => text(ref === MB ? 'row\n' : `row\n${rows(4)}`)), 5);
  check('four dashes pass (0)', under.code === 0);
  const clean = await checkPr(world((ref) => text(ref === MB ? `row ${EM} one\n` : `row ${EM} one\nrow two\n`)), 5);
  check('read whole with only an old dash, it passes (0)', clean.code === 0 && /within the limit/.test(clean.summary));
  // The merge base holds a dashed line the PR keeps; the base branch deleted it after the PR branched.
  const diverged = (ref) => text(ref === MB ? `row ${EM} one\nrow\n` : ref === PR.base.sha ? 'row\n' : `row ${EM} one\nrow\nrow two\n`);
  const kept = await checkPr(world(diverged), 5);
  check('read whole against the merge base, not the moved base tip: a kept dashed line is not added (0)',
    kept.code === 0 && /within the limit/.test(kept.summary));
  // Both branches added the same dashed line after the PR branched: the base tip has it, the merge base does not.
  const bothAdded = (ref) => text(ref === MB ? 'row\n' : `row\n${rows(5)}`);
  const twice = await checkPr(world(bothAdded), 5);
  check('read whole against the merge base: a dashed line the base branch also added still counts for the PR (1)',
    twice.code === 1 && twice.summary.includes('docs/table.md:2'));
  const noBase = await checkPr(world(diverged, PR, null), 5);
  check('no merge base to read from: the file is unread (2), never a pass',
    noBase.code === 2 && /Not every added line could be read: docs\/table\.md/.test(noBase.summary));
  const cleanRead = (ref) => text(ref === MB ? 'row\n' : 'row\nrow two\n');
  const listed = await checkPr(world(cleanRead, { ...PR, changed_files: 1, commits: 1 }), 5);
  check('every changed file and commit listed: it passes (0)', listed.code === 0);
  const capped = await checkPr(world(cleanRead, { ...PR, changed_files: 3500 }), 5);
  check('more changed files than the files API lists: incomplete (2), never a pass',
    capped.code === 2 && capped.summary.includes('3499 changed file(s) the files API did not list') && capped.annotations.some((a) => a.includes('listed 1, so 3499 were not checked')));
  const manyCommits = await checkPr(world(cleanRead, { ...PR, commits: 300 }), 5);
  check('more commits than the commits API lists: incomplete (2), never a pass',
    manyCommits.code === 2 && manyCommits.summary.includes('299 commit message(s) the commits API did not list') && manyCommits.annotations.some((a) => a.includes('listed 1, so 299 commit message(s) were not checked')));
  const credited = await checkPr(world(cleanRead, { ...PR, changed_files: 1, commits: 1, body: 'More rows.\n\nCo-Authored-By: Claude <noreply@anthropic.com>' }), 5);
  check('a credit in the description fails the check (1), named in the summary and an annotation',
    credited.code === 1 && /1 line\(s\) credit a model or an AI tool/.test(credited.summary) && credited.summary.includes('PR description, line 3') && credited.annotations.some((a) => a.includes('PR description, line 3 credits')));
  const gpt = await checkPr(world(cleanRead, { ...PR, changed_files: 1, commits: 1, body: 'More rows.\n\nCo-Authored-By: GPT <noreply@example.org>' }), 5);
  check('a GPT co-author trailer fails the check (1)', gpt.code === 1 && gpt.summary.includes('PR description, line 3'));
  const person = await checkPr(world(cleanRead, { ...PR, changed_files: 1, commits: 1, body: 'More rows.\n\nCo-Authored-By: Claude Martin <claude.martin@example.org>' }), 5);
  check('a person named Claude as co-author passes the check (0)', person.code === 0);
  const both = await checkPr(world(() => down, { ...PR, title: 'docs: Generated with Claude Code' }), 5);
  check('a credit with an unread file still fails as a finding (1), and the summary names both',
    both.code === 1 && /credit a model/.test(both.summary) && /Not every added line could be read/.test(both.summary));
  const bump = { ...PR, changed_files: 1, commits: 1, user: { login: 'dependabot[bot]', type: 'Bot' }, body: `Release notes\n<li>fix: keys ${EM} values</li>\nGenerated with Claude Code` };
  const quoted = await checkPr(world(cleanRead, bump), 5);
  check('a Dependabot description quoting upstream dashes and credits passes (0)', quoted.code === 0);
  const bumpTitle = await checkPr(world((ref) => text(ref === MB ? 'row\n' : `row\n${rows(4)}`), { ...bump, title: `chore(deps): bump x ${EM} y` }), 5);
  check('a Dependabot title is still checked (1)', bumpTitle.code === 1 && bumpTitle.summary.includes('PR title, line 1'));
  const lookalike = await checkPr(world(cleanRead, { ...bump, user: { login: 'dependabot[bot]', type: 'User' } }), 5);
  check('an account named like Dependabot but not a bot is checked (1)', lookalike.code === 1);
  check('ownDescription: a person keeps the description', ownDescription({ user: { login: 'askalf', type: 'User' }, body: 'x' }) === 'x');
  const fork = { ...PR, head: { sha: PR.head.sha, repo: { full_name: 'someone/x' } }, changed_files: 1, commits: 1 };
  const forked = await checkPr(world((ref) => text(ref === MB ? 'row\n' : `row\n${rows(30)}`), { ...fork, title: `fix: x ${EM} y`, body: `a ${EM} b\nc ${EM} d` }), 5);
  check('a fork full of dashes passes (0), and the summary says they were not read', forked.code === 0 && /not read on a fork/.test(forked.summary));
  const forkDown = await checkPr(world(() => down, { ...fork, changed_files: 3500 }), 5);
  check('a fork\'s files are not read, so one too large to patch or past the list is no failure (0)', forkDown.code === 0);
  const forkCredit = await checkPr(world(cleanRead, { ...fork, body: 'Generated with Claude Code' }), 5);
  check('a credit on a fork still fails (1)', forkCredit.code === 1 && /credit a model/.test(forkCredit.summary));
  const forkCommits = await checkPr(world(cleanRead, { ...fork, commits: 300 }), 5);
  check('a fork\'s commit messages past the list are still incomplete (2), since credits are read there', forkCommits.code === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
