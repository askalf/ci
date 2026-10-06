// Unit and end-to-end tests for scripts/redline/fix.mjs. Run: node scripts/redline/fix.test.mjs
// The model and GitHub are stubbed through ctx.fetch; git is real, on throwaway repositories under
// the temp directory. Nothing leaves the machine.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseReviewUrl, parseReviewBody, inlineItems, formatFinding, detectRunner, allowedCommands, allowedArgv, safeWritePath, stageable,
  protectedFromCheckAttr, protectedPaths, PROTECTED_ATTR, descriptionProblem,
  commitSubject, hasAttributionTrailer, neutraliseRefs, cleanNotes, summariseTests, renderNotes, fixRecord, fixProblem, saveFix,
  failingTests, FAILING_NAMES_MAX, runSecrets, leaksSecret, maskSecrets, berryInstall, runAccount, asRunAccount, proxyEnv,
  runAccountUidProblem, TOOLS, FINISH_REQUIRED, askForFinish, checkFinish, runLoop, buildBrief, childEnv, onlyOrigins, runFix,
  LIMITS, OUTCOMES, AUTHOR, FIX_VERSION, DEFAULT_MODEL, SUBJECT_BANNED,
} from './fix.mjs';
import { bumpCaller, fixCallerYaml, REVIEW_WORKFLOW, FIX_WORKFLOW, CALLERS } from './pin.mjs';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}`); fail++; }
}
async function throws(fn) { try { await fn(); return null; } catch (e) { return e; } }
const SHA = /^[0-9a-f]{40}$/;
const HEAD = '47536435fb5c9540d8cb36fd26d81e101955b364';
const OTHER = '34b7875f46525f7899a4e6601fbca4be75443903';
const REVIEW_URL = 'https://github.com/askalf/r/pull/7#pullrequestreview-99';
const gitOk = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const npmOk = spawnSync('npm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }).status === 0;
const bashOk = !spawnSync('bash', ['-c', 'exit 0'], { encoding: 'utf8' }).error;

console.log('\n  the review link');
{
  const r = parseReviewUrl(REVIEW_URL);
  check('owner/name, PR and review id are read', r.repo === 'askalf/r' && r.pr === 7 && r.id === 99);
  check('a PR link without the review fragment is not a review', parseReviewUrl('https://github.com/askalf/r/pull/7') === null);
  check('a comment link is not a review', parseReviewUrl('https://github.com/askalf/r/pull/7#issuecomment-1') === null);
  check('another host is not a review', parseReviewUrl('https://example.com/askalf/r/pull/7#pullrequestreview-99') === null);
  check('padding is tolerated, trailing text is not', parseReviewUrl(` ${REVIEW_URL} `)?.id === 99 && parseReviewUrl(`${REVIEW_URL}x`) === null);
}

console.log('\n  the review body');
const BODY = [
  '**Verdict: request changes.** Two problems in the token handling.',
  '',
  '### 1. Blocking: `src/b.js:1`',
  '',
  '> export const token = process.env.X;',
  '> const y = 2;',
  '',
  'Exports a secret from the environment.',
  '',
  'Suggested fix:',
  '',
  '```',
  'const token = read();',
  '```',
  '',
  '### 2. Blocking: `README.md`',
  '',
  '> Generated with love',
  '',
  'The line credits a tool that is not the committer.',
  '',
  'Minor:',
  '- `src/c.js:4`: unused import',
  '- `src/d.js`: dead branch',
  '',
  '_1 finding(s) dropped: their quotes are not in the diff._',
  '',
  'rule:secret-exposure',
  '',
  `<!-- redline:head=${HEAD} -->`,
].join('\n');
{
  const r = parseReviewBody(BODY);
  check('the summary is the sentence after the verdict', r.summary === 'Two problems in the token handling.');
  check('two blocking and two minor findings', r.findings.length === 4 && r.findings.filter((f) => f.severity === 'blocking').length === 2);
  const [a, b, c, d] = r.findings;
  check('finding 1: file, line, both quote lines, the problem and the fenced suggestion',
    a.n === 1 && a.file === 'src/b.js' && a.line === 1 && a.quote === 'export const token = process.env.X;\nconst y = 2;'
    && a.problem === 'Exports a secret from the environment.' && a.suggestion === 'const token = read();');
  check('finding 2: a place without a line, no suggestion, and the Minor list does not bleed in',
    b.file === 'README.md' && b.line === null && b.quote === 'Generated with love' && b.problem === 'The line credits a tool that is not the committer.' && b.suggestion === '');
  check('minor findings carry their place and text', c.severity === 'minor' && c.file === 'src/c.js' && c.line === 4 && c.problem === 'unused import' && d.file === 'src/d.js' && d.line === null);
  check('the rule slug is read', r.rule === 'secret-exposure');
  check('the note and the head marker are in no finding', !r.findings.some((f) => /dropped|redline:head/.test(f.problem)));
  const crlf = parseReviewBody(BODY.replace(/\n/g, '\r\n'));
  check('CRLF bodies parse the same', crlf.findings.length === 4 && crlf.findings[0].suggestion === 'const token = read();');
  const plain = parseReviewBody(`Please handle the empty page.\n\n<!-- redline:head=${HEAD} -->`);
  check('a body without the shape is one blocking finding with the text, marker dropped', plain.findings.length === 1 && plain.findings[0].severity === 'blocking' && plain.findings[0].problem === 'Please handle the empty page.' && plain.findings[0].file === null);
  check('an empty body has no findings', parseReviewBody('').findings.length === 0 && parseReviewBody(null).findings.length === 0);
  const items = inlineItems([{ path: 'src/b.js', line: 3, body: ' Read it from the config. ' }, { path: 'src/c.js', line: null, original_line: 9, body: 'x' }, { path: 'z', line: 1, body: '  ' }]);
  check('inline comments keep path, line (original_line as a fallback) and trimmed body; empty ones drop',
    items.length === 2 && items[0].body === 'Read it from the config.' && items[0].line === 3 && items[1].line === 9);
  check('inline comments from a non-array are none', inlineItems(null).length === 0);
  const f = formatFinding(a);
  check('a finding is formatted with its place, quoted lines, problem and suggestion', f.startsWith('[1] blocking `src/b.js:1`\n> export const token') && f.includes('\nSuggested fix:\nconst token = read();'));
}

console.log('\n  toolchain detection and the run allowlist');
const root = mkdtempSync(join(tmpdir(), 'redline-fix-'));
const outside = mkdtempSync(join(tmpdir(), 'redline-fix-out-'));
mkdirSync(join(root, 'src'));
mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1;\n');
writeFileSync(join(root, 'test.mjs'), 'process.exit(0);\n');
writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
writeFileSync(join(outside, 'secret.txt'), 'top secret');
let symlinked = true;
try { symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt')); } catch { symlinked = false; }
{
  const npm = detectRunner(['package.json', 'package-lock.json'], { scripts: { test: 'node --test', build: 'tsc', lint: '', release: 'x' } });
  check('npm with a lockfile: npm ci, and only the four scripts that exist and are not empty', npm.pm === 'npm' && npm.install.join(' ') === 'npm ci --no-audit --no-fund --ignore-scripts' && npm.scripts.join() === 'test,build');
  check('npm without a lockfile installs', detectRunner(['package.json'], { scripts: {} }).install.join(' ') === 'npm install --no-audit --no-fund --ignore-scripts');
  check('no install runs dependencies\' lifecycle scripts', [['pnpm-lock.yaml'], ['yarn.lock'], ['bun.lock']].every((f) => detectRunner(f, {}).install.includes('--ignore-scripts')));
  // Yarn 2 rejects --mode=skip-build and Yarn 3+ dropped --skip-builds; both read YARN_ENABLE_SCRIPTS.
  const berry = (files, pkg) => { const r = detectRunner(files, pkg); return r.install.join(' ') === 'yarn install --immutable' && r.installEnv.YARN_ENABLE_SCRIPTS === 'false'; };
  check('yarn 2+ installs immutable with scripts off by variable, by .yarnrc.yml or packageManager, any Berry version',
    berry(['yarn.lock', '.yarnrc.yml'], {}) && berry(['yarn.lock'], { packageManager: 'yarn@2.4.2' }) && berry(['yarn.lock'], { packageManager: 'yarn@4.5.0' })
      && detectRunner(['yarn.lock'], { packageManager: 'yarn@4.5.0' }).install.every((a) => !/skip-build/.test(a)));
  check('yarn 2+ is marked for a version check before the install, yarn 1 is not',
    detectRunner(['yarn.lock', '.yarnrc.yml'], {}).berry === true && detectRunner(['yarn.lock'], { packageManager: 'yarn@1.22.22' }).berry === false);
  // A dependenciesMeta `built: true` overrides YARN_ENABLE_SCRIPTS, so the flag that skips builds is
  // always passed: --skip-builds in yarn 2, --mode=skip-build from 3 (checked against 2.4.2 and 4.5.0).
  check('berryInstall: the build-skipping flag of each major, nothing for an unknown version',
    berryInstall('2.4.2\n').join(' ') === 'yarn install --immutable --skip-builds'
      && berryInstall('4.5.0').join(' ') === 'yarn install --immutable --mode=skip-build'
      && berryInstall('warning: something\n3.6.4\n').join(' ') === 'yarn install --immutable --mode=skip-build'
      && berryInstall('1.22.22') === null && berryInstall('') === null && berryInstall('command not found') === null);
  check('yarn 1 keeps its flags and sets no variable',
    detectRunner(['yarn.lock'], { packageManager: 'yarn@1.22.22' }).install.join(' ') === 'yarn install --frozen-lockfile --ignore-scripts'
      && Object.keys(detectRunner(['yarn.lock'], { packageManager: 'yarn@1.22.22' }).installEnv).length === 0);
  check('pnpm, yarn and bun are read from their lockfiles', detectRunner(['pnpm-lock.yaml'], {}).pm === 'pnpm' && detectRunner(['yarn.lock'], {}).pm === 'yarn' && detectRunner(['bun.lockb'], {}).pm === 'bun' && detectRunner(['bun.lock'], {}).pm === 'bun');
  check('packageManager wins over a lockfile', detectRunner(['package-lock.json'], { packageManager: 'pnpm@9.1.0' }).pm === 'pnpm');
  check('no package.json: nothing to install, no scripts', detectRunner(['README.md'], null).pm === null && detectRunner(['README.md'], null).install === null);
  const plan = { pm: 'npm', scripts: ['test', 'build'], install: ['npm', 'ci'] };
  check('the allowlist as shown to the model', allowedCommands(plan).join(', ') === 'npm test, npm run build, node <file>, node --test <file>');
  check('npm test is allowed', allowedArgv('npm test', plan, root).argv.join(' ') === 'npm test');
  check('npm run build is allowed', allowedArgv('npm run build', plan, root).argv.join(' ') === 'npm run build');
  check('npm run test is the test script too', allowedArgv('npm run test', plan, root).argv.join(' ') === 'npm run test');
  check('a script that is not in package.json is refused', /allowlist/.test(allowedArgv('npm run lint', plan, root).error));
  check('a script outside the four is refused even if it exists', /allowlist/.test(allowedArgv('npm run release', { ...plan, scripts: ['release'] }, root).error));
  check('npm install is refused', /allowlist/.test(allowedArgv('npm install left-pad', plan, root).error));
  check('another package manager is refused', /allowlist/.test(allowedArgv('pnpm test', plan, root).error));
  check('npx, sh, curl and git are refused', ['npx foo', 'sh -c ls', 'curl http://x', 'git push'].every((c) => /allowlist/.test(allowedArgv(c, plan, root).error)));
  check('shell characters are refused before anything is parsed', ['npm test; rm -rf /', 'npm test && curl x', 'node test.mjs | tee', 'node $(x)', 'node test.mjs > out', 'node "test.mjs"', 'node test.mjs #c']
    .every((c) => /without a shell/.test(allowedArgv(c, plan, root).error)));
  check('node <file> inside the checkout is allowed, path normalised', allowedArgv('node ./test.mjs', plan, root).argv.join(' ') === 'node test.mjs');
  check('node --test <file> is allowed', allowedArgv('node --test test.mjs', plan, root).argv.join(' ') === 'node --test test.mjs');
  check('node with another flag is refused', /one file/.test(allowedArgv('node -e 1', plan, root).error) && /one file/.test(allowedArgv('node --eval test.mjs', plan, root).error));
  check('node with two files is refused', /one file/.test(allowedArgv('node a.mjs test.mjs', plan, root).error));
  check('node on a file outside the checkout is refused', /outside/.test(allowedArgv('node ../x.mjs', plan, root).error));
  check('node on a missing file is refused', /no such file/.test(allowedArgv('node nope.mjs', plan, root).error));
  check('node on a directory is refused', /directory/.test(allowedArgv('node src', plan, root).error));
  if (symlinked) check('node on a symlink out of the checkout is refused', /outside the checkout/.test(allowedArgv('node leak.txt', plan, root).error));
  check('an empty command is refused', /empty/.test(allowedArgv('  ', plan, root).error));
  check('with no package manager only node is allowed', /allowlist/.test(allowedArgv('npm test', { pm: null, scripts: [], install: null }, root).error) && allowedCommands({ pm: null, scripts: [] }).join() === 'node <file>,node --test <file>');
}

console.log('\n  the write sandbox');
{
  const err = (p) => { try { safeWritePath(root, p); return ''; } catch (e) { return e.message; } };
  check('a path inside resolves', safeWritePath(root, 'src/new.js').endsWith('new.js'));
  check('a new file in a new directory resolves', safeWritePath(root, 'src/deep/er/new.js').endsWith('new.js'));
  check('.. is refused', /outside/.test(err('../x')) && /outside/.test(err('src/../../x')));
  check('an absolute path is relative to the checkout, not the host', safeWritePath(root, '/src/a.js').endsWith('a.js'));
  check('backslashes are normalised', safeWritePath(root, 'src\\a.js').endsWith('a.js'));
  check('.github is refused, at any depth', /\.github/.test(err('.github/workflows/ci.yml')) && /\.github/.test(err('.github/CODEOWNERS')) && /\.github/.test(err('.github')));
  check('.git and node_modules are refused', /\.git or node_modules/.test(err('.git/config')) && /\.git or node_modules/.test(err('node_modules/x/index.js')) && /\.git or node_modules/.test(err('a/node_modules/b')));
  check('a directory is refused', /directory/.test(err('src')));
  check('the checkout root itself is refused', /outside/.test(err('')) && /outside/.test(err('.')));
  if (symlinked) check('a symlink is refused', /symlink/.test(err('leak.txt')));
  check('a .gitattributes is refused, at any depth', /gitattributes/.test(err('.gitattributes')) && /gitattributes/.test(err('src/.gitattributes')));
  let dirLinked = true;
  try { mkdirSync(join(root, '.github', 'workflows'), { recursive: true }); symlinkSync(join(root, '.github'), join(root, 'ghalias'), 'dir'); } catch { dirLinked = false; }
  if (dirLinked) {
    check('.github reached through a directory symlink is refused', /\.github.*directory symlink/.test(err('ghalias/workflows/ci.yml')));
    check('a .gitattributes reached through a directory symlink is refused', /gitattributes/.test(err('ghalias/../.gitattributes')) || /gitattributes/.test(err('ghalias/.gitattributes')));
  }
}

console.log('\n  redline-protected files');
{
  const raw = ['src/cc-template-data.json', PROTECTED_ATTR, 'set', 'src/a.js', PROTECTED_ATTR, 'unspecified',
    'b.json', PROTECTED_ATTR, 'unset', 'c.json', PROTECTED_ATTR, 'captured', 'd.json', PROTECTED_ATTR, 'false', ''].join('\0');
  const got = protectedFromCheckAttr(raw);
  check('set and valued paths are protected', got.has('src/cc-template-data.json') && got.has('c.json'));
  check('unspecified, unset and false are not', !got.has('src/a.js') && !got.has('b.json') && !got.has('d.json') && got.size === 2);
  check('empty output protects nothing', protectedFromCheckAttr('').size === 0);
  if (gitOk) {
    const attrs = { '.gitattributes': `data/*.json ${PROTECTED_ATTR}\n`, 'lib/.gitattributes': `vendor.js ${PROTECTED_ATTR}=vendored\n` };
    const got2 = protectedPaths(attrs, ['data/payload.json', 'lib/vendor.js', 'src/a.js', 'vendor.js']);
    check('a snapshot of .gitattributes decides, nested ones included', got2.has('data/payload.json') && got2.has('lib/vendor.js') && got2.size === 2);
    check('no snapshot protects nothing', protectedPaths({}, ['data/payload.json']).size === 0);
    check('no paths asks git nothing', protectedPaths(attrs, []).size === 0);
  }
}

console.log('\n  a new PR description');
{
  check('a changed description passes', descriptionProblem('Adds the token, read from the config.', 'Adds it.') === null);
  check('empty or unchanged is refused', /empty/.test(descriptionProblem('  ', 'Adds it.')) && /current description/.test(descriptionProblem('Adds it.\n', 'Adds it.')));
  check('attribution is refused', /attribution/.test(descriptionProblem('Body.\n\nhttps://claude.ai/code/session_01abc', 'x'))
    && /attribution/.test(descriptionProblem('Body.\n\nCo-Authored-By: Claude <noreply@anthropic.com>', 'x')));
  check('an em or en dash is refused', /dash/.test(descriptionProblem('A \u2014 B', 'x')) && /dash/.test(descriptionProblem('1\u20132', 'x')));
  check('a description longer than the brief shows is never rewritten', /not rewritten whole/.test(descriptionProblem('short', 'x'.repeat(LIMITS.bodyChars + 1))));
  check('the limit is the raw length the brief cuts: leading whitespace counts',
    /not rewritten whole/.test(descriptionProblem('short', ' '.repeat(100) + 'x'.repeat(LIMITS.bodyChars - 50))));
  check('the limit is the raw length the brief cuts: CRLF counts',
    /not rewritten whole/.test(descriptionProblem('short', 'ab\r\n'.repeat(Math.floor(LIMITS.bodyChars / 4) + 1))));
  check('a body exactly at the limit can still be rewritten', descriptionProblem('short', 'x'.repeat(LIMITS.bodyChars)) === null);
  check('the new text has a ceiling', /longer than/.test(descriptionProblem('y'.repeat(LIMITS.descriptionChars + 1), 'x')));
}

console.log('\n  what gets staged');
{
  const big = (p) => (p === 'big.bin' ? LIMITS.fileBytes + 1 : 10);
  const r = stageable(['src/a.js', '.github/workflows/ci.yml', 'package-lock.json', 'big.bin', 'src/new.js'], { installDirty: ['package-lock.json', 'src/new.js'], written: new Set(['src/new.js']), sizeOf: big });
  check('files the fix changed are kept', r.keep.join() === 'src/a.js,src/new.js');
  check('.github, a file over 1 MB and what the install dirtied are left out, each with its reason',
    r.skipped.map((s) => s.path).join() === '.github/workflows/ci.yml,package-lock.json,big.bin'
    && /\.github/.test(r.skipped[0].why) && /install/.test(r.skipped[1].why) && /larger/.test(r.skipped[2].why));
  check('a path the install dirtied that the model then wrote is the fix', r.keep.includes('src/new.js'));
  const q = stageable(['src/a.js', 'src/data.json', '.gitattributes', 'lib/.gitattributes'], { protectedSet: new Set(['src/data.json']) });
  check('a protected path and any .gitattributes are left out, each with its reason',
    q.keep.join() === 'src/a.js' && q.skipped.map((x) => `${x.path}:${x.why}`).join('|') === `src/data.json:marked ${PROTECTED_ATTR}|.gitattributes:a .gitattributes|lib/.gitattributes:a .gitattributes`);
}

console.log('\n  the commit subject');
{
  check('the model line gets the fix: prefix', commitSubject('reset the cursor on an empty page') === 'fix: reset the cursor on an empty page');
  check('a prefix the model added is not doubled', commitSubject('fix: reset the cursor') === 'fix: reset the cursor' && commitSubject('fix(pager)!: reset the cursor') === 'fix: reset the cursor');
  check('em and en dashes become commas', commitSubject('reset the cursor \u2014 twice') === 'fix: reset the cursor, twice' && !/[\u2013\u2014]/.test(commitSubject('a\u2013b')));
  check('issue closers are removed', commitSubject('reset the cursor (fixes #12)') === 'fix: reset the cursor' && commitSubject('Resolves askalf/dario#5: keep the cursor') === 'fix: keep the cursor');
  check('a bare ref and a URL are removed', commitSubject('reset the cursor #12') === 'fix: reset the cursor' && commitSubject('see https://x.y/z reset') === 'fix: see reset');
  check('only the first line counts', commitSubject('reset the cursor\n\nCo-Authored-By: Someone') === 'fix: reset the cursor');
  check('a subject that credits a tool falls back to the default', commitSubject('Fix by Claude') === 'fix: address the review' && commitSubject('Generated with love') === 'fix: address the review' && commitSubject('AI cleanup') === 'fix: address the review');
  check('a subject that names the machinery falls back too', commitSubject('answer the Redline findings') === 'fix: address the review' && commitSubject('as the model suggested') === 'fix: address the review');
  check('an empty line falls back', commitSubject('') === 'fix: address the review' && commitSubject(null) === 'fix: address the review');
  const long = commitSubject(`keep ${'the cursor '.repeat(20)}steady`);
  check(`a long subject is cut at a word under ${LIMITS.subjectChars} characters`, long.length <= LIMITS.subjectChars && !/\s$/.test(long) && long.startsWith('fix: keep the cursor'));
  check('trailing punctuation is dropped', commitSubject('reset the cursor.') === 'fix: reset the cursor');
  check('the banned list catches the shapes forge refuses', ['co-authored', 'signed-off', 'Claude', 'GPT', 'Copilot', 'LLM'].every((w) => SUBJECT_BANNED.test(w)));
  check('an attribution trailer in a message is found', hasAttributionTrailer('fix: x\n\nCo-Authored-By: A <a@b>') && hasAttributionTrailer('x\n\nGenerated with a tool') && hasAttributionTrailer('x\nSigned-off-by: a'));
  check('a clean message has none', !hasAttributionTrailer('fix: reset the cursor\n\nAnswers the review at https://github.com/a/b/pull/1#pullrequestreview-2.'));
}

console.log('\n  notes for the PR comment');
{
  check('a bare ref becomes a code span', neutraliseRefs('see #12 and #345.') === 'see `#12` and `#345`.');
  check('a ref already in code is left alone', neutraliseRefs('see `#12` and ``#13``') === 'see `#12` and ``#13``');
  check('a ref in a fenced block is left alone', neutraliseRefs('a #1\n```\n#2\n```\n#3') === 'a `#1`\n```\n#2\n```\n`#3`');
  check('an owner/repo#N ref is neutralised as a whole', neutraliseRefs('see askalf/dario#5.') === 'see `askalf/dario#5`.');
  check('a word glued to a ref is not a ref', neutraliseRefs('issue#5') === 'issue#5');
  check('an HTML entity and a heading are not refs', neutraliseRefs('&#39; and # heading and c#') === '&#39; and # heading and c#');
  const n = cleanNotes('Done \u2014 twice.\nCo-Authored-By: X <x@y>\nGenerated with tool\nSee #4.\n');
  check('cleanNotes drops trailer lines, replaces dashes and neutralises refs', n === 'Done, twice.\nSee `#4`.');
  check(`cleanNotes caps at ${LIMITS.notesChars}`, cleanNotes('x'.repeat(LIMITS.notesChars + 500)).length <= LIMITS.notesChars && cleanNotes('x'.repeat(LIMITS.notesChars + 500)).endsWith('(truncated)'));
  check('TAP totals are summarised', summariseTests('ok 1\n# tests 3\n# pass 2\n# fail 1\n') === '2 pass, 1 fail');
  check('a jest summary line is summarised', summariseTests('Tests:       3 passed, 3 total\n') === '3 passed, 3 total');
  check('the own-style line is summarised', summariseTests('  12 pass, 0 fail\n') === '12 pass, 0 fail');
  check('anything else is the tail', summariseTests('a\nb\nc\nd\n') === 'b | c | d');
  const r = renderNotes({ outcome: 'fixed', summary: 'Reads the token from the config \u2014 see #3.', files: ['src/b.js'], tests: { command: 'npm test', exit_code: 0, summary: '2 pass, 0 fail' }, skipped: [{ path: '.github/x', why: 'under .github/' }] });
  check('fixed notes: summary, files, what was left out, tests; clean', r.includes('Reads the token from the config, see `#3`.') && r.includes('Files: `src/b.js`') && r.includes('Left out: `.github/x` (under .github/)') && r.includes('Tests: `npm test` exited 0 (2 pass, 0 fail)') && !/[\u2013\u2014]/.test(r));
  check('refused notes are the reason', renderNotes({ outcome: 'refused', reason: 'the head moved' }) === 'the head moved');
  check('no_change notes say so', /No file changed\./.test(renderNotes({ outcome: 'no_change', summary: 's' })));
  check('fixed notes without a test script say so', /no test script/.test(renderNotes({ outcome: 'fixed', summary: 's', files: ['a'] })));
}

console.log('\n  fix.json');
{
  const base = { repo: 'askalf/r', pr: 7, headSha: HEAD, model: 'm' };
  const fixed = fixRecord({ ...base, outcome: 'fixed', newHead: OTHER, commits: [{ sha: OTHER, subject: 'fix: x' }], files: ['a'], tests: { command: 'npm test', exit_code: 0, summary: '1 pass, 0 fail' }, turns: 3, notes: 'n' });
  check('the record has exactly the contract keys', Object.keys(fixed).join() === 'version,repo,pr,base_head,new_head,outcome,commits,files,tests,turns,model,notes,description');
  check('fixed passes', fixProblem(fixed) === null && fixed.version === FIX_VERSION);
  check('no_change passes with no commit', fixProblem(fixRecord({ ...base, outcome: 'no_change', notes: 'n', turns: 1 })) === null);
  check('tests_failed passes with files and tests and no commit', fixProblem(fixRecord({ ...base, outcome: 'tests_failed', files: ['a'], tests: { command: 'npm test', exit_code: 1, summary: '' }, notes: 'n' })) === null);
  check('refused passes', fixProblem(fixRecord({ ...base, outcome: 'refused', notes: 'why' })) === null);
  check('a dry-run fixed record has files, no commit and no new head', fixProblem(fixRecord({ ...base, outcome: 'fixed', files: ['a'], notes: 'n' })) === null);
  const bad = (patch) => fixProblem({ ...fixed, ...patch });
  check('schema: version', /version/.test(bad({ version: 2 })));
  check('schema: repo, pr, base_head', /repo/.test(bad({ repo: 'x' })) && /pr/.test(bad({ pr: '7' })) && /base_head/.test(bad({ base_head: HEAD.slice(0, 7) })));
  check('schema: new_head is a sha or null', /new_head/.test(bad({ new_head: 'abc' })) && bad({ new_head: null, commits: [] }) === null);
  check('schema: outcome is one of the four', /outcome/.test(bad({ outcome: 'done' })) && OUTCOMES.join() === 'fixed,no_change,tests_failed,refused');
  check('schema: commits need sha and subject', /commit 1/.test(bad({ commits: [{ sha: OTHER }] })));
  check('schema: new_head is the last commit', /last commit/.test(bad({ new_head: HEAD })));
  check('schema: a non-fixed outcome carries no commit', /carries no commit/.test(bad({ outcome: 'refused' })));
  check('schema: files are paths', /files/.test(bad({ files: [''] })) && /files/.test(bad({ files: 'a' })));
  check('schema: tests is null or the triple', /tests/.test(bad({ tests: { command: 'x' } })) && bad({ tests: null }) === null);
  check('schema: turns, model, notes', /turns/.test(bad({ turns: -1 })) && /model/.test(bad({ model: 1 })) && /notes/.test(bad({ notes: 'a \u2014 b' })) && /notes/.test(bad({ notes: 'x'.repeat(LIMITS.notesChars + 1) })));
  check('schema: not an object', /object/.test(fixProblem(null)) && /object/.test(fixProblem([fixed])));
  const dir = mkdtempSync(join(tmpdir(), 'redline-fix-json-'));
  saveFix(join(dir, 'nested'), fixed);
  check('saveFix writes fix.json and notes.md', JSON.stringify(JSON.parse(readFileSync(join(dir, 'nested', 'fix.json'), 'utf8'))) === JSON.stringify(fixed) && readFileSync(join(dir, 'nested', 'notes.md'), 'utf8') === 'n\n');
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n  finish_fix and the loop');
{
  check('the tool set is the contract', TOOLS.map((t) => t.name).join() === 'fix_list,fix_read,fix_search,fix_write,fix_run,fix_describe,finish_fix');
  // dario remaps a client tool with a common name (read_file, write_file, run, search, list_files, ...)
  // onto Claude Code's own and sends the rest as mcp__client__<name>. Every name must be one no client
  // uses, so the whole set goes out one way.
  const COMMON = ['list_files', 'read_file', 'search', 'write_file', 'run', 'read', 'write', 'edit', 'bash', 'grep', 'glob', 'shell', 'ls', 'list_dir'];
  check('every tool is fix_* or finish_fix, and none is a common tool name dario remaps',
    TOOLS.every((t) => /^(fix_[a-z]+|finish_fix)$/.test(t.name) && !COMMON.includes(t.name)));
  check('finish_fix needs a summary and, when fixed, a subject', /summary/.test(checkFinish({ outcome: 'fixed' }).error) && /subject/.test(checkFinish({ outcome: 'fixed', summary: 's' }).error));
  check('refused needs a reason', /reason/.test(checkFinish({ outcome: 'refused' }).error) && checkFinish({ outcome: 'refused', reason: 'r' }).sub.reason === 'r');
  check('an unknown outcome is refused', /outcome/.test(checkFinish({ outcome: 'partial', summary: 's', subject: 'x' }).error));
  check('the subject is sanitised on the way in', checkFinish({ outcome: 'fixed', summary: 's', subject: 'Fix: reset \u2014 now (fixes #1)' }).sub.subject === 'fix: reset, now');
  check('machinery narration in the summary is bounced with the phrase', /"AI-generated"/.test(checkFinish({ outcome: 'fixed', summary: 'Removed the AI-generated line.', subject: 'x' }).error));
  check('machinery narration in the reason is bounced', /"gating lane"/.test(checkFinish({ outcome: 'refused', reason: 'The gating lane is wrong.' }).error));
  const m = [{ role: 'user', content: 'brief' }];
  askForFinish(m); askForFinish(m);
  check('askForFinish appends the instruction to the last user turn once', m[0].content === `brief\n\n${FINISH_REQUIRED}`);
  const arr = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'x' }] }];
  askForFinish(arr);
  check('and as a text block after tool results', arr[0].content.length === 2 && arr[0].content[1].text === FINISH_REQUIRED);
}
const use = (name, input, id = `${name}-${Math.random()}`) => ({ content: [{ type: 'tool_use', id, name, input }] });
function loopWorld(turns, { canForce = true } = {}) {
  const calls = [];
  const tools = [];
  let t = 0;
  const ctx = {
    call: async (messages, toolChoice) => { calls.push({ messages: JSON.parse(JSON.stringify(messages)), toolChoice }); const step = turns[Math.min(calls.length - 1, turns.length - 1)]; return typeof step === 'function' ? step(messages, toolChoice) : step; },
    tool: async (name, input) => { tools.push([name, input]); return `ran ${name}`; },
    finalize: async (input) => (input.summary ? { sub: { outcome: 'fixed', ...input } } : { error: 'summary is required' }),
    now: () => (t += 1000), log: () => {}, canForce,
  };
  return { ctx, calls, tools };
}
{
  const w = loopWorld([use('fix_read', { path: 'a' }), use('finish_fix', { summary: 's', subject: 'x' })]);
  const r = await runLoop(w.ctx, 'brief');
  check('a tool call runs and its result goes back; finish_fix ends the loop', r.sub?.summary === 's' && r.turns === 2 && w.tools[0][0] === 'fix_read' && JSON.stringify(w.calls[1].messages.at(-1)).includes('ran fix_read'));
  check('the brief is the first user turn, ending with the instruction', w.calls[0].messages[0].content.endsWith('finish with finish_fix.'));
}
{
  const w = loopWorld([use('fix_list', {})]);
  const r = await runLoop(w.ctx, 'brief');
  check(`a model that never finishes is refused after ${LIMITS.turns} turns, not thrown`, /within 40 turns/.test(r.refused) && r.turns === LIMITS.turns && w.calls.length === LIMITS.turns);
  check(`tools are refused from turn ${LIMITS.forceFinishAt} on, with a forced tool_choice`, w.calls[LIMITS.forceFinishAt - 1].toolChoice?.name === 'finish_fix' && JSON.stringify(w.calls[LIMITS.forceFinishAt].messages.at(-1)).includes('budget is spent') && w.tools.length === LIMITS.forceFinishAt - 1);
}
{
  const w = loopWorld([(messages, tc) => (tc?.type === 'auto' && JSON.stringify(messages.at(-1)).includes(FINISH_REQUIRED.slice(0, 20)) ? use('finish_fix', { summary: 's', subject: 'x' }) : use('fix_list', {}))], { canForce: false });
  const r = await runLoop(w.ctx, 'brief');
  check('a model that rejects a forced choice gets tool_choice auto and the instruction in the user turn, then finishes',
    r.sub && w.calls.length === LIMITS.forceFinishAt && w.calls.every((c) => c.toolChoice?.type !== 'tool') && w.calls.at(-1).toolChoice?.type === 'auto');
}
{
  const w = loopWorld([{ content: [{ type: 'text', text: 'thinking' }] }, use('finish_fix', { summary: 's', subject: 'x' })]);
  const r = await runLoop(w.ctx, 'brief');
  check('a text-only turn is nudged back to the tools', r.sub && /discarded/.test(w.calls[1].messages.at(-1).content));
  const t = loopWorld([{ content: [{ type: 'text', text: 'prose' }] }]);
  const rr = await runLoop(t.ctx, 'brief');
  check(`${LIMITS.textOnlyTurns} text-only answers in a row are refused early`, /text-only/.test(rr.refused) && t.calls.length === LIMITS.textOnlyTurns);
  const e = loopWorld([{ content: [] }]);
  const re = await runLoop(e.ctx, 'brief');
  check('empty replies never enter the history and end the same way', /text-only/.test(re.refused) && e.calls.at(-1).messages.length === 1);
  const n = loopWorld([{}]);
  check('a reply with no content array throws', (await throws(() => runLoop(n.ctx, 'brief')))?.message.includes('no message content'));
}
{
  const w = loopWorld([use('finish_fix', { subject: 'x' }), use('finish_fix', { summary: 's', subject: 'x' })]);
  const r = await runLoop(w.ctx, 'brief');
  check('a bounced finish_fix is returned as an error and retried', r.sub && JSON.stringify(w.calls[1].messages.at(-1)).includes('is_error'));
}
{
  const env = childEnv({ PATH: '/bin', GH_READ_TOKEN: 't', DARIO_API_KEY: 'k', HOME: '/root', SYSTEMROOT: 'C:\\Windows' }, '/scratch');
  check('children get PATH, a scratch HOME and CI, and no token or key', env.PATH === '/bin' && env.HOME === '/scratch' && env.CI === '1' && !('GH_READ_TOKEN' in env) && !('DARIO_API_KEY' in env));
  const f = onlyOrigins(async (u) => `ok ${u}`, ['https://api.github.com', 'http://127.0.0.1:3456/']);
  check('fetch is limited to GitHub and dario', (await f('https://api.github.com/x')) === 'ok https://api.github.com/x' && (await f('http://127.0.0.1:3456/v1/messages')).startsWith('ok') && (await throws(() => f('https://example.com/'))) !== null && (await throws(() => f('nope'))) !== null);
  const brief = buildBrief({ pr: { number: 7, title: 't', body: 'b', head: { ref: 'f' }, base: { ref: 'main', repo: { full_name: 'askalf/r' } } }, files: [{ status: 'modified', additions: 1, deletions: 0, filename: 'src/b.js' }], headSha: HEAD,
    review: parseReviewBody(BODY), items: inlineItems([{ path: 'src/b.js', line: 1, body: 'c' }]), plan: { pm: 'npm', scripts: ['test'] }, installNote: 'ok', diff: '+x' });
  check('the brief carries the PR, the findings, the inline comments, the allowlist and the test script', /PR #7: t/.test(brief) && /\[1\] blocking `src\/b\.js:1`/.test(brief) && /\[1\] src\/b\.js:1\nc/.test(brief) && /run accepts: npm test, node <file>/.test(brief) && /Test script: `npm test`/.test(brief) && /PR diff:\n\+x/.test(brief));
}

console.log('\n  the run account and the proxy');
{
  const rejects = (n) => { try { runAccount(n); return false; } catch { return true; } };
  check('FIX_RUN_AS: a plain user name or nothing; anything else throws',
    runAccount('redline-run') === 'redline-run' && runAccount(' gha_run ') === 'gha_run' && runAccount('') === '' && runAccount(undefined) === ''
      && ['Bad Name', 'a;b', '-u', '../x', 'Root', 'x'.repeat(33), 'a$(id)'].every(rejects));
  const argv = asRunAccount('redline-run', { PATH: '/bin', HOME: '/h' }, ['timeout', '-k', '10', '5', 'npm', 'test']);
  check('a command runs through sudo as the run account, from an empty environment holding only its own variables',
    argv.join(' ') === 'sudo -n -u redline-run -- env -i PATH=/bin HOME=/h timeout -k 10 5 npm test');
  check('the run account is never root or this account, and a uid id -u did not print is no uid',
    runAccountUidProblem('1002\n', 1001) === null && /is root/.test(runAccountUidProblem('0\n', 1001))
      && /is this account/.test(runAccountUidProblem('1001\n', 1001)) && /could not be read/.test(runAccountUidProblem('', 1001))
      && /could not be read/.test(runAccountUidProblem('uid=0(root)', 1001)) && /could not be read/.test(runAccountUidProblem(undefined, 1001)));
  const p = proxyEnv('http://127.0.0.1:3128');
  check('FIX_PROXY reaches every package manager, and nothing is exempt from it',
    ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'npm_config_proxy', 'npm_config_https_proxy', 'YARN_HTTP_PROXY', 'YARN_HTTPS_PROXY'].every((k) => p[k] === 'http://127.0.0.1:3128')
      && p.NO_PROXY === '' && p.no_proxy === '' && Object.keys(proxyEnv('')).length === 0);
  check('the children\'s environment carries the proxy when there is one', childEnv({ PATH: '/bin' }, '/h', 'http://p:1').HTTPS_PROXY === 'http://p:1' && !('HTTPS_PROXY' in childEnv({ PATH: '/bin' }, '/h')));
}

console.log('\n  credentials');
{
  const secrets = runSecrets({ darioKey: 'dk_live_0123456789', readToken: 'ghs_abcdefghij', other: 'x' });
  check('the run\'s secrets are the key and the read token; short stand-ins are not secrets', secrets.join() === 'dk_live_0123456789,ghs_abcdefghij' && runSecrets({ darioKey: 'k', readToken: 'read' }).length === 0);
  check('a secret anywhere in the text is found', leaksSecret('+const k = "dk_live_0123456789";', secrets) && !leaksSecret('nothing here', secrets));
  check('the log masks every occurrence', maskSecrets('a dk_live_0123456789 b dk_live_0123456789 ghs_abcdefghij', secrets) === 'a *** b *** ***');
}

// ---------- end to end: a fake GitHub, a fake model, a real repository ----------

function sh(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function makeRepo({ pkg = null, testExit = 0, testBody = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'redline-fix-repo-'));
  sh(dir, ['init', '-q']);
  sh(dir, ['config', 'core.autocrlf', 'false']);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'b.js'), 'export const token = process.env.X;\nconst y = 2;\n');
  writeFileSync(join(dir, 'test.mjs'), testBody ?? `process.exit(${testExit});\n`);
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  if (pkg) writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  sh(dir, ['add', '-A']);
  sh(dir, ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'feat: add token']);
  return { dir, head: sh(dir, ['rev-parse', 'HEAD']) };
}
function world(repo, { turns, prHead, reviewState = 'CHANGES_REQUESTED', reviewCommit, body = BODY, comments = [{ path: 'src/b.js', line: 1, body: 'Read it from the config instead.' }], dryRun = false, model = 'm', reviewUrl = REVIEW_URL } = {}) {
  const calls = { model: [], gh: [] };
  const head = prHead ?? repo.head;
  const json = (b, status = 200) => ({ ok: status < 300, status, json: async () => b, text: async () => JSON.stringify(b) });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/v1/messages')) {
      const b = JSON.parse(init.body);
      calls.model.push({ ...b, key: init.headers['x-api-key'] });
      const step = turns[Math.min(calls.model.length - 1, turns.length - 1)];
      const res = typeof step === 'function' ? step(b) : step;
      return json(res.content ? res : { content: res });
    }
    calls.gh.push(u.pathname);
    const p = u.pathname;
    if (/\/pulls\/7$/.test(p)) return json({ number: 7, state: 'open', title: 'feat: add token', body: 'Adds it.', user: { login: 'askalf' }, head: { sha: head, ref: 'feat/x', repo: { full_name: 'askalf/r' } }, base: { ref: 'main', repo: { full_name: 'askalf/r' } } });
    if (/\/reviews\/99$/.test(p)) return json({ id: 99, state: reviewState, commit_id: reviewCommit ?? repo.head, body, html_url: REVIEW_URL, user: { login: 'sprayberry-redline' } });
    if (/\/reviews\/99\/comments$/.test(p)) return json(u.searchParams.get('page') === '1' ? comments : []);
    if (p.endsWith('/files')) return json(u.searchParams.get('page') === '1' ? [{ filename: 'src/b.js', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n+export const token = process.env.X;\n const y = 2;' }] : []);
    return json({ message: `unexpected ${p}` }, 404);
  };
  const out = join(repo.dir, '..', `redline-fix-out-${Math.random().toString(36).slice(2)}`);
  let t = 0;
  const ctx = { repo: 'askalf/r', pr: 7, headSha: repo.head, reviewUrl, checkout: repo.dir, out, readToken: 'read', darioUrl: 'http://dario/', darioKey: 'k', model, system: 'sys',
    fetch, sleep: async () => {}, now: () => (t += 1000), log: () => {}, dryRun };
  return { ctx, calls, out };
}
const tool = (name, input) => ({ content: [{ type: 'tool_use', id: `${name}-${Math.random()}`, name, input }] });
const finish = (input) => tool('finish_fix', { outcome: 'fixed', subject: 'read the token from the config', summary: 'Reads the token from the config in `src/b.js` instead of the environment.', tests_run: 'node test.mjs, exit 0', ...input });
const FIXED_B = 'import { read } from "./config.js";\nexport const token = read();\nconst y = 2;\n';

if (!gitOk) {
  console.log('\n  skip the end-to-end tests: no git here');
} else {
  console.log('\n  runFix: a fix');
  {
    const repo = makeRepo();
    const w = world(repo, { turns: [tool('fix_read', { path: 'src/b.js' }), tool('fix_write', { path: 'src/b.js', content: FIXED_B }), tool('fix_run', { command: 'node test.mjs' }), finish()] });
    const { record: r } = await runFix(w.ctx);
    check('outcome fixed with a new head past the base', r.outcome === 'fixed' && SHA.test(r.new_head) && r.new_head !== repo.head && r.base_head === repo.head);
    check('one commit, the sanitised subject, the file', r.commits.length === 1 && r.commits[0].sha === r.new_head && r.commits[0].subject === 'fix: read the token from the config' && r.files.join() === 'src/b.js');
    check('no test script: tests is null and the notes say so', r.tests === null && /no test script/.test(r.notes));
    check('the record passes the schema and carries the turns and the model', fixProblem(r) === null && r.turns === 4 && r.model === 'm');
    check('the notes are the summary, files and tests, clean', r.notes.startsWith('Reads the token from the config') && r.notes.includes('Files: `src/b.js`') && !/[\u2013\u2014]/.test(r.notes));
    check('the model got the brief with the findings and the tools, the key in a header', w.calls.model[0].messages[0].content.includes('[1] blocking `src/b.js:1`') && w.calls.model[0].tools.length === 7 && w.calls.model[0].key === 'k');
    check('the read went back to the model, the write and run reported', JSON.stringify(w.calls.model[1].messages.at(-1)).includes('export const token') && JSON.stringify(w.calls.model[2].messages.at(-1)).includes('wrote src/b.js') && JSON.stringify(w.calls.model[3].messages.at(-1)).includes('exit 0'));
    const bundle = join(w.out, 'fix.bundle');
    check('fix.bundle exists and verifies against the repo', existsSync(bundle) && spawnSync('git', ['bundle', 'verify', bundle], { cwd: repo.dir, encoding: 'utf8' }).status === 0);
    check('no diff.patch on a real fix', !existsSync(join(w.out, 'diff.patch')));
    const heads = spawnSync('git', ['bundle', 'list-heads', bundle], { encoding: 'utf8' }).stdout;
    check('the bundle carries HEAD at the new commit, requiring the base', heads.includes(`${r.new_head} HEAD`) && spawnSync('git', ['bundle', 'verify', bundle], { cwd: repo.dir, encoding: 'utf8' }).stdout.includes(repo.head));
    const show = sh(repo.dir, ['log', '-1', '--format=%an%n%ae%n%cn%n%ce%n%B', r.new_head]).split('\n');
    check('authored and committed as askalf', show[0] === AUTHOR.name && show[1] === AUTHOR.email && show[2] === AUTHOR.name && show[3] === AUTHOR.email);
    check('the message is the subject and the body naming the review, no trailer', show[4] === 'fix: read the token from the config' && show[5] === '' && show[6] === `Answers the review at ${REVIEW_URL}.` && !hasAttributionTrailer(show.slice(4).join('\n')));
    check('the commit is a fast-forward of the base', sh(repo.dir, ['merge-base', '--is-ancestor', repo.head, r.new_head]) === '');
    const clone = mkdtempSync(join(tmpdir(), 'redline-fix-clone-'));
    sh(clone, ['init', '-q']);
    sh(clone, ['fetch', '-q', repo.dir, repo.head]);
    const fetched = spawnSync('git', ['fetch', '-q', bundle, 'HEAD'], { cwd: clone, encoding: 'utf8' });
    check('another repository at the base can fetch the bundle', fetched.status === 0 && sh(clone, ['rev-parse', 'FETCH_HEAD']) === r.new_head);
    check('the fetched tree has the fix', spawnSync('git', ['show', `${r.new_head}:src/b.js`], { cwd: clone, encoding: 'utf8' }).stdout === FIXED_B);
    rmSync(clone, { recursive: true, force: true });
    rmSync(w.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }

  console.log('\n  runFix: a dry run');
  {
    const repo = makeRepo();
    const w = world(repo, { dryRun: true, turns: [tool('fix_write', { path: 'src/b.js', content: FIXED_B }), tool('fix_run', { command: 'node test.mjs' }), finish()] });
    const { record: r } = await runFix(w.ctx);
    check('a dry run is fixed with no commit and no new head', r.outcome === 'fixed' && r.new_head === null && r.commits.length === 0 && r.files.join() === 'src/b.js' && fixProblem(r) === null);
    check('diff.patch holds the change and no bundle is written', existsSync(join(w.out, 'diff.patch')) && readFileSync(join(w.out, 'diff.patch'), 'utf8').includes('+export const token = read();') && !existsSync(join(w.out, 'fix.bundle')));
    check('the repository head did not move', sh(repo.dir, ['rev-parse', 'HEAD']) === repo.head);
    rmSync(w.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }

  console.log('\n  runFix: the write sandbox and the allowlist, as the model sees them');
  {
    const repo = makeRepo();
    const w = world(repo, { turns: [
      tool('fix_write', { path: '../escape.js', content: 'x' }), tool('fix_write', { path: '.github/workflows/ci.yml', content: 'x' }),
      tool('fix_write', { path: 'src/../../escape.js', content: 'x' }), tool('fix_run', { command: 'npm test' }), tool('fix_run', { command: 'node test.mjs; rm -rf /' }),
      tool('fix_run', { command: 'node ../x.mjs' }), tool('fix_read', { path: '../../etc/passwd' }), finish(),
    ] });
    const { record: r } = await runFix(w.ctx);
    const result = (i) => JSON.stringify(w.calls.model[i].messages.at(-1));
    check('a write outside the checkout is refused', /outside the checkout/.test(result(1)));
    check('a write under .github is refused', /\.github/.test(result(2)));
    check('a traversal through a subdirectory is refused', /outside the checkout/.test(result(3)));
    check('a command not in the allowlist is refused (no package.json here)', /allowlist/.test(result(4)));
    check('a shell chain is refused', /without a shell/.test(result(5)));
    check('node on a file outside is refused', /outside/.test(result(6)));
    check('a read outside is refused', /outside/.test(result(7)));
    check('nothing was written, so the outcome is no_change with no bundle', r.outcome === 'no_change' && !existsSync(join(w.out, 'fix.bundle')) && !existsSync(join(repo.dir, '..', 'escape.js')) && fixProblem(r) === null);
    check('no_change notes say so', /No file changed/.test(r.notes));
    rmSync(w.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }

  console.log('\n  runFix: a credential never leaves');
  {
    const KEY = 'dk_live_0123456789';
    const repo = makeRepo();
    const w = world(repo, { turns: [tool('fix_write', { path: 'src/b.js', content: `export const token = '${KEY}';\n` }), finish()] });
    const { record: r } = await runFix({ ...w.ctx, darioKey: KEY });
    check('a change that carries the model key is refused with no bundle and no patch', r.outcome === 'refused' && /credential/.test(r.notes) && !existsSync(join(w.out, 'fix.bundle')) && !existsSync(join(w.out, 'diff.patch')) && !JSON.stringify(r).includes(KEY) && fixProblem(r) === null);
    check('the repository head did not move', sh(repo.dir, ['rev-parse', 'HEAD']) === repo.head);
    rmSync(w.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }

  console.log('\n  runFix: a file the repository marks redline-protected');
  {
    const repo = makeRepo();
    writeFileSync(join(repo.dir, '.gitattributes'), `src/b.js ${PROTECTED_ATTR}\n`);
    sh(repo.dir, ['add', '-A']);
    sh(repo.dir, ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'chore: mark the captured file']);
    repo.head = sh(repo.dir, ['rev-parse', 'HEAD']);
    const w = world(repo, { turns: [
      tool('fix_write', { path: 'src/b.js', content: FIXED_B }), tool('fix_write', { path: '.gitattributes', content: '' }),
      tool('fix_write', { path: 'src/c.js', content: 'export const c = 1;\n' }), finish({ summary: 'Adds `src/c.js`; the finding about `src/b.js` is about captured data, left as it is.' }),
    ] });
    const { record: r } = await runFix(w.ctx);
    const result = (i) => JSON.stringify(w.calls.model[i].messages.at(-1));
    check('the brief names the protected file', w.calls.model[0].messages[0].content.includes(`marked ${PROTECTED_ATTR}`) && w.calls.model[0].messages[0].content.includes('src/b.js'));
    check('a write to the protected file is refused at the tool', new RegExp(`src/b.js is marked ${PROTECTED_ATTR}`).test(result(1)));
    check('a write to .gitattributes is refused, so the mark cannot be lifted first', /gitattributes is never written/.test(result(2)));
    check('the protected file is unchanged on disk', readFileSync(join(repo.dir, 'src', 'b.js'), 'utf8') === 'export const token = process.env.X;\nconst y = 2;\n');
    check('the fix commits the other file only', r.outcome === 'fixed' && r.files.join() === 'src/c.js' && fixProblem(r) === null);
    rmSync(w.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
  {
    // A NUL makes the file binary, so the diff carries it base85-encoded; the file's own bytes are checked.
    const KEY = 'dk_live_0123456789';
    const repo = makeRepo();
    const w = world(repo, { turns: [tool('fix_write', { path: 'src/blob.bin', content: `\u0000${KEY}\u0000` }), finish()] });
    const { record: r } = await runFix({ ...w.ctx, darioKey: KEY });
    check('a binary file that carries the key is refused, with no bundle', r.outcome === 'refused' && /credential/.test(r.notes) && !existsSync(join(w.out, 'fix.bundle')) && fixProblem(r) === null);
    rmSync(w.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
  {
    // The protected file reached through an unmarked directory symlink lands on the same file.
    const repo = makeRepo();
    mkdirSync(join(repo.dir, 'data'));
    writeFileSync(join(repo.dir, 'data', 'payload.json'), '{"captured":true}\n');
    writeFileSync(join(repo.dir, '.gitattributes'), `data/payload.json ${PROTECTED_ATTR}\n`);
    let aliased = true;
    try { symlinkSync('data', join(repo.dir, 'alias'), 'dir'); } catch { aliased = false; }
    if (aliased) {
      sh(repo.dir, ['add', '-A']);
      sh(repo.dir, ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'chore: captured payload and an alias']);
      repo.head = sh(repo.dir, ['rev-parse', 'HEAD']);
      const w = world(repo, { turns: [tool('fix_write', { path: 'alias/payload.json', content: '{"captured":false}\n' }), finish()] });
      const { record: r } = await runFix(w.ctx);
      check('a write through a directory symlink onto a protected file is refused',
        new RegExp(`data/payload.json is marked ${PROTECTED_ATTR}`).test(JSON.stringify(w.calls.model[1].messages.at(-1))));
      check('the protected file is unchanged on disk', readFileSync(join(repo.dir, 'data', 'payload.json'), 'utf8') === '{"captured":true}\n');
      check('nothing was written, so no_change', r.outcome === 'no_change' && fixProblem(r) === null);
      rmSync(w.out, { recursive: true, force: true });
    } else {
      console.log('  skip: no directory symlinks here');
    }
    rmSync(repo.dir, { recursive: true, force: true });
  }
  {
    // An allowed command clears the mark in the checkout and edits the payload: the marks come
    // from the reviewed head, so the payload stays out of the commit.
    const repo = makeRepo();
    mkdirSync(join(repo.dir, 'data'));
    writeFileSync(join(repo.dir, 'data', 'payload.json'), '{"captured":true}\n');
    writeFileSync(join(repo.dir, '.gitattributes'), `data/payload.json ${PROTECTED_ATTR}\n`);
    sh(repo.dir, ['add', '-A']);
    sh(repo.dir, ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'chore: captured payload']);
    repo.head = sh(repo.dir, ['rev-parse', 'HEAD']);
    const helper = "import { writeFileSync } from 'node:fs';\nwriteFileSync('.gitattributes', '');\nwriteFileSync('data/payload.json', '{\"captured\":false}\\n');\n";
    const w = world(repo, { turns: [tool('fix_write', { path: 'clear.mjs', content: helper }), tool('fix_run', { command: 'node clear.mjs' }), finish()] });
    const { record: r } = await runFix(w.ctx);
    check('the command did clear the mark and edit the payload in the checkout',
      readFileSync(join(repo.dir, '.gitattributes'), 'utf8') === '' && readFileSync(join(repo.dir, 'data', 'payload.json'), 'utf8') === '{"captured":false}\n');
    check('the commit leaves out the payload and .gitattributes, still marked at the reviewed head',
      r.outcome === 'fixed' && r.files.join() === 'clear.mjs' && fixProblem(r) === null, JSON.stringify(r.files));
    check('the payload in the commit is the reviewed one',
      spawnSync('git', ['show', `${r.new_head}:data/payload.json`], { cwd: repo.dir, encoding: 'utf8' }).stdout === '{"captured":true}\n');
    check('the notes say why the payload was left out', new RegExp(`data/payload.json.*${PROTECTED_ATTR}`).test(r.notes), r.notes);
    rmSync(w.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
  {
    const KEY = 'dk_live_0123456789';
    const repo = makeRepo();
    const w = world(repo, { turns: [tool('fix_write', { path: 'src/b.js', content: FIXED_B }), finish({ summary: `Used ${KEY} to check it.` })] });
    const { record: r } = await runFix({ ...w.ctx, darioKey: KEY });
    check('notes that carry the key: refused, and the bundle already written is removed', r.outcome === 'refused' && !JSON.stringify(r).includes(KEY) && !existsSync(join(w.out, 'fix.bundle')) && fixProblem(r) === null);
    rmSync(w.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
  {
    // The same, and the command also commits on its own, then fix_write tries the payload again:
    // the commit starts from the reviewed head, so neither the payload nor the mark's removal lands.
    const repo = makeRepo();
    mkdirSync(join(repo.dir, 'data'));
    writeFileSync(join(repo.dir, 'data', 'payload.json'), '{"captured":true}\n');
    writeFileSync(join(repo.dir, '.gitattributes'), `data/payload.json ${PROTECTED_ATTR}\n`);
    sh(repo.dir, ['add', '-A']);
    sh(repo.dir, ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'chore: captured payload']);
    repo.head = sh(repo.dir, ['rev-parse', 'HEAD']);
    const lift = [
      "import { writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      "writeFileSync('.gitattributes', '');",
      "writeFileSync('data/payload.json', '{\"captured\":false}\\n');",
      "spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-a', '-m', 'lift'], { stdio: 'ignore' });",
      '',
    ].join('\n');
    const w = world(repo, { turns: [
      tool('fix_write', { path: 'lift.mjs', content: lift }), tool('fix_run', { command: 'node lift.mjs' }),
      tool('fix_write', { path: 'data/payload.json', content: '{"captured":"again"}\n' }),
      tool('fix_write', { path: 'src/c.js', content: 'export const c = 1;\n' }), finish(),
    ] });
    const { record: r } = await runFix(w.ctx);
    check('a command that empties .gitattributes does not lift the mark for fix_write',
      new RegExp(`data/payload.json is marked ${PROTECTED_ATTR}`).test(JSON.stringify(w.calls.model[3].messages.at(-1))));
    check('a commit the command made is not carried: one fix commit on top of the reviewed head',
      r.outcome === 'fixed' && r.files.join() === 'lift.mjs,src/c.js' && fixProblem(r) === null
      && sh(repo.dir, ['rev-parse', 'HEAD~1']) === repo.head);
    check('the payload and .gitattributes are unchanged in the commit',
      sh(repo.dir, ['diff', '--name-only', repo.head, 'HEAD']).split('\n').join() === 'lift.mjs,src/c.js');
    rmSync(w.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }

  console.log('\n  runFix: a finding on the description');
  {
    const repo = makeRepo();
    const body = '### 1. Blocking: `PR description:1`\n\n> Adds it.\n\nSay what is added.';
    const w = world(repo, { body, comments: [], turns: [
      tool('fix_describe', { body: 'Adds it \u2014 the token.' }),
      tool('fix_describe', { body: 'Adds the token, read from the environment.' }),
      finish({ summary: 'The description says what the PR adds.' }),
    ] });
    const { record: r, description } = await runFix(w.ctx);
    check('a description the rules refuse is answered with the reason', /dash/.test(JSON.stringify(w.calls.model[1].messages.at(-1))));
    check('a description-only answer is no_change with description true', r.outcome === 'no_change' && r.description === true && fixProblem(r) === null, JSON.stringify(r));
    check('runFix returns the text', description === 'Adds the token, read from the environment.');
    check('the notes say the description is replaced', /description is replaced/.test(r.notes));
    saveFix(w.out, r, description);
    check('saveFix writes description.md next to fix.json', readFileSync(join(w.out, 'description.md'), 'utf8') === 'Adds the token, read from the environment.\n');
    check('a run without fix_describe writes no description.md', (() => { const d = mkdtempSync(join(tmpdir(), 'redline-fix-nodesc-')); saveFix(d, fixRecord({ repo: 'askalf/r', pr: 7, headSha: repo.head, outcome: 'no_change' }), null); const ok = !existsSync(join(d, 'description.md')); rmSync(d, { recursive: true, force: true }); return ok; })());
    check('fix.json refuses a description on a refusal', /carries no description/.test(fixProblem({ ...r, outcome: 'refused', description: true })));
    rmSync(w.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
  {
    // A description that carries a credential of the run is refused like any other output.
    const KEY = 'dk_live_0123456789';
    const repo = makeRepo();
    const body = '### 1. Blocking: `PR description:1`\n\n> Adds it.\n\nSay what is added.';
    const w = world(repo, { body, comments: [], turns: [
      tool('fix_describe', { body: `Adds the token. Key: ${KEY}` }),
      finish({ summary: 'The description says what the PR adds.' }),
    ] });
    const { record: r, description } = await runFix({ ...w.ctx, darioKey: KEY });
    check('a description carrying the model key refuses the run, with no description returned',
      r.outcome === 'refused' && /credential/.test(r.notes) && r.description !== true && (description ?? null) === null && fixProblem(r) === null, JSON.stringify(r));
    saveFix(w.out, r, description ?? null);
    check('and no description.md is written', !existsSync(join(w.out, 'description.md')));
    rmSync(w.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
  {
    // A clean filter (written by a command: a .gitattributes rule and a .git/config entry) stages a
    // binary blob with the key while the working-tree file stays harmless. The index is checked.
    const KEY = 'dk_live_0123456789';
    const repo = makeRepo();
    const lift = [
      "import { writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      "writeFileSync('leak.sh', \"printf '\\\\000dk_live_%s\\\\000' 0123456789\\n\");",
      "writeFileSync('.gitattributes', 'harmless.txt filter=leak\\n');",
      "spawnSync('git', ['config', 'filter.leak.clean', 'sh leak.sh']);",
      "writeFileSync('harmless.txt', 'harmless\\n');",
      '',
    ].join('\n');
    const w = world(repo, { turns: [tool('fix_write', { path: 'lift.mjs', content: lift }), tool('fix_run', { command: 'node lift.mjs' }), finish()] });
    const { record: r } = await runFix({ ...w.ctx, darioKey: KEY });
    check('the command did set up the filter, and the working tree carries no key', readFileSync(join(repo.dir, 'harmless.txt'), 'utf8') === 'harmless\n' && !readFileSync(join(repo.dir, 'leak.sh'), 'utf8').includes(KEY));
    check('a key that a clean filter put into the staged blob is refused, with no bundle', r.outcome === 'refused' && /credential/.test(r.notes) && !existsSync(join(w.out, 'fix.bundle')) && fixProblem(r) === null);
    rmSync(w.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
  if (process.platform !== 'win32') {
    // The filter turns a small working-tree file into a staged blob of the key and 70 MB of zeros:
    // past any read buffer, small as a compressed patch. It is refused by its staged size.
    const KEY = 'dk_live_0123456789';
    const repo = makeRepo();
    const lift = [
      "import { writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      "writeFileSync('leak.sh', \"printf 'dk_live_%s' 0123456789; head -c 70000000 /dev/zero\\n\");",
      "writeFileSync('.gitattributes', 'harmless.txt filter=leak\\n');",
      "spawnSync('git', ['config', 'filter.leak.clean', 'sh leak.sh']);",
      "writeFileSync('harmless.txt', 'harmless\\n');",
      '',
    ].join('\n');
    const w = world(repo, { turns: [tool('fix_write', { path: 'lift.mjs', content: lift }), tool('fix_run', { command: 'node lift.mjs' }), finish()] });
    const { record: r } = await runFix({ ...w.ctx, darioKey: KEY });
    check('a staged blob past the size limit is refused before it is read, with no bundle or patch',
      r.outcome === 'refused' && /harmless\.txt is \d+ bytes; the limit is/.test(r.notes) && !existsSync(join(w.out, 'fix.bundle')) && !existsSync(join(w.out, 'diff.patch')) && fixProblem(r) === null);
    rmSync(w.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
  if (process.platform !== 'win32') {
    // The reviewed head tracks a file named `*`; a command deletes it and writes under .github.
    // With no file of that name left, a plain pathspec `*` is a pattern that would also stage
    // .github; taken literally it stages the deletion alone.
    const repo = makeRepo();
    writeFileSync(join(repo.dir, '*'), 'star\n');
    sh(repo.dir, ['add', '-A']);
    sh(repo.dir, ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'chore: a file named star']);
    repo.head = sh(repo.dir, ['rev-parse', 'HEAD']);
    const star = "import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';\nunlinkSync('*');\nmkdirSync('.github', { recursive: true });\nwriteFileSync('.github/x.yml', 'x\\n');\n";
    const w = world(repo, { turns: [tool('fix_write', { path: 'star.mjs', content: star }), tool('fix_run', { command: 'node star.mjs' }), finish()] });
    const { record: r } = await runFix(w.ctx);
    check('a deleted file named * is staged literally: the commit holds its deletion and nothing under .github',
      r.outcome === 'fixed' && r.files.sort().join() === '*,star.mjs' && sh(repo.dir, ['diff', '--name-only', repo.head, 'HEAD']).split('\n').sort().join() === '*,star.mjs' && fixProblem(r) === null);
    rmSync(w.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
  if (process.platform !== 'win32') {
    // A stub yarn stands in for Berry: it reports a version and logs the install it is given.
    const stub = mkdtempSync(join(tmpdir(), 'redline-yarn-'));
    const log = join(stub, 'calls.log');
    const yarnStub = (version) => writeFileSync(join(stub, 'yarn'), `#!/bin/sh\necho "$YARN_ENABLE_SCRIPTS $*" >> '${log}'\ncase "$1" in --version) ${version} ;; install) exit 0 ;; test) exec node test.mjs ;; esac\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${stub}:${process.env.PATH}` };
    const yarnRepo = () => makeRepo({ pkg: { name: 'r', private: true, packageManager: 'yarn@2.4.2', scripts: { test: 'node test.mjs' } } });
    {
      yarnStub('echo 2.4.2');
      const repo = yarnRepo();
      const w = world(repo, { turns: [tool('fix_write', { path: 'src/b.js', content: FIXED_B }), finish()] });
      const { record: r } = await runFix({ ...w.ctx, env });
      const calls = readFileSync(log, 'utf8');
      check('yarn 2: the version is read, then the install skips builds by flag and by variable', calls.includes('false --version\n') && calls.includes('false install --immutable --skip-builds\n') && r.outcome === 'fixed');
      rmSync(w.out, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
      rmSync(log, { force: true });
    }
    {
      yarnStub('exit 1');
      const repo = yarnRepo();
      const w = world(repo, { turns: [tool('fix_write', { path: 'src/b.js', content: FIXED_B }), finish()] });
      await runFix({ ...w.ctx, env });
      const calls = readFileSync(log, 'utf8');
      check('a yarn version that cannot be read installs nothing, and the brief says so', !/ install/.test(calls) && w.calls.model[0].messages[0].content.includes('nothing installed'));
      rmSync(w.out, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
    }
    rmSync(stub, { recursive: true, force: true });
  }

  console.log('\n  runFix: limits');
  {
    const repo = makeRepo();
    const w = world(repo, { turns: [tool('fix_list', {})] });
    const { record: r } = await runFix(w.ctx);
    check(`turns: refused after ${LIMITS.turns} model calls`, r.outcome === 'refused' && /within 40 turns/.test(r.notes) && r.turns === LIMITS.turns && w.calls.model.length === LIMITS.turns && fixProblem(r) === null);
    rmSync(w.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
  {
    const repo = makeRepo();
    const gen = `import { writeFileSync } from 'node:fs'; for (let i = 0; i < ${LIMITS.files}; i++) writeFileSync('g' + i + '.txt', 'x');\n`;
    const w = world(repo, { turns: [tool('fix_write', { path: 'gen.mjs', content: gen }), tool('fix_run', { command: 'node gen.mjs' }), finish()] });
    const { record: r } = await runFix(w.ctx);
    check(`files: more than ${LIMITS.files} changed files is refused, with no bundle`, r.outcome === 'refused' && /files; the limit is 30/.test(r.notes) && !existsSync(join(w.out, 'fix.bundle')) && fixProblem(r) === null);
    rmSync(w.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
  {
    const repo = makeRepo();
    const writes = [];
    for (let i = 0; i < LIMITS.files; i++) writes.push(tool('fix_write', { path: `f${i}.txt`, content: 'x' }));
    const w = world(repo, { turns: [...writes, tool('fix_write', { path: 'one-more.txt', content: 'x' }), finish()] });
    const { record: r } = await runFix(w.ctx);
    check(`files: the ${LIMITS.files + 1}th write is refused at the tool and the fix stays at the limit`, /the limit; no further file/.test(JSON.stringify(w.calls.model[LIMITS.files + 1].messages.at(-1))) && r.outcome === 'fixed' && r.files.length === LIMITS.files);
    rmSync(w.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }
  {
    const repo = makeRepo();
    const half = 'y'.repeat(LIMITS.diffBytes / 2 + 1000);
    const w = world(repo, { turns: [tool('fix_write', { path: 'a.txt', content: half }), tool('fix_write', { path: 'b.txt', content: half }), finish()] });
    const { record: r } = await runFix(w.ctx);
    check(`size: a diff over ${LIMITS.diffBytes} bytes is refused, with no bundle`, r.outcome === 'refused' && /the diff is \d+ bytes; the limit/.test(r.notes) && !existsSync(join(w.out, 'fix.bundle')));
    const big = world(makeRepo(), { turns: [tool('fix_write', { path: 'a.txt', content: 'z'.repeat(LIMITS.writeBytes + 1) }), finish()] });
    const { record: rb } = await runFix(big.ctx);
    check(`size: one write over ${LIMITS.writeBytes} bytes is refused at the tool`, /larger than/.test(JSON.stringify(big.calls.model[1].messages.at(-1))) && rb.outcome === 'no_change');
    rmSync(w.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(big.out, { recursive: true, force: true });
    rmSync(big.ctx.checkout, { recursive: true, force: true });
  }

  console.log('\n  runFix: refusals before the model');
  {
    const repo = makeRepo();
    const cases = [
      ['a review link on another PR', world(repo, { turns: [finish()], reviewUrl: 'https://github.com/askalf/r/pull/8#pullrequestreview-99' }), /another repository or pull request/],
      ['a link that is not a review', world(repo, { turns: [finish()], reviewUrl: 'https://github.com/askalf/r/pull/7' }), /not a pull request review link/],
      ['a head that moved', world(repo, { turns: [finish()], prHead: OTHER }), /head moved/],
      ['a review that is not CHANGES_REQUESTED', world(repo, { turns: [finish()], reviewState: 'APPROVED' }), /not CHANGES_REQUESTED/],
      ['a review at another head', world(repo, { turns: [finish()], reviewCommit: OTHER }), /not at the head/],
      ['a review with nothing to answer', world(repo, { turns: [finish()], body: '', comments: [] }), /no finding/],
    ];
    for (const [name, w, re] of cases) {
      const { record: r } = await runFix(w.ctx);
      check(`${name}: refused, no model call, schema ok`, r.outcome === 'refused' && re.test(r.notes) && w.calls.model.length === 0 && fixProblem(r) === null);
      rmSync(w.out, { recursive: true, force: true });
    }
    const wrongHead = world(repo, { turns: [finish()] });
    wrongHead.ctx.headSha = OTHER;
    wrongHead.ctx.fetch = (u, i) => world(repo, { turns: [finish()], prHead: OTHER, reviewCommit: OTHER }).ctx.fetch(u, i);
    const { record: rh } = await runFix(wrongHead.ctx);
    check('a checkout that is not at the head is refused', rh.outcome === 'refused' && /checkout is not at the reviewed head/.test(rh.notes));
    rmSync(wrongHead.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }

  console.log('\n  runFix: the model refuses, or narrates');
  {
    const repo = makeRepo();
    const w = world(repo, { turns: [tool('finish_fix', { outcome: 'refused', reason: 'The finding asks for a behaviour the PR does not add.' })] });
    const { record: r } = await runFix(w.ctx);
    check('a refusal from the model is refused with its reason and no bundle', r.outcome === 'refused' && r.notes === 'The finding asks for a behaviour the PR does not add.' && !existsSync(join(w.out, 'fix.bundle')) && r.turns === 1);
    rmSync(w.out, { recursive: true, force: true });
    const w2 = world(repo, { turns: [tool('fix_write', { path: 'src/b.js', content: FIXED_B }), finish({ summary: 'Removed the AI-generated line.' }), finish()] });
    const { record: r2 } = await runFix(w2.ctx);
    const bounced = w2.calls.model[2].messages.at(-1).content[0];
    check('a summary that narrates is bounced with the phrase named, and the clean one lands', r2.outcome === 'fixed' && bounced.is_error === true && /"AI-generated"/.test(bounced.content) && r2.turns === 3);
    rmSync(w2.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }

  console.log('\n  runFix: the model that rejects a forced tool_choice');
  {
    const repo = makeRepo();
    const w = world(repo, { model: DEFAULT_MODEL, turns: [(b) => (JSON.stringify(b.messages.at(-1)).includes('budget is spent') ? finish() : tool('fix_list', {}))] });
    const { record: r } = await runFix(w.ctx);
    check(`${DEFAULT_MODEL}: no request carries a forced choice, the instruction arrives at turn ${LIMITS.forceFinishAt}, and it finishes`,
      r.outcome === 'no_change' && w.calls.model.every((b) => b.tool_choice?.type !== 'tool') && w.calls.model.length === LIMITS.forceFinishAt && w.calls.model.at(-1).tool_choice?.type === 'auto');
    rmSync(w.out, { recursive: true, force: true });
    rmSync(repo.dir, { recursive: true, force: true });
  }

  if (!npmOk) {
    console.log('\n  skip the test-script runs: no npm on PATH here (they run in CI)');
  } else {
    if (process.platform !== 'win32') {
      console.log('\n  runFix: commands as the run account');
      // A stand-in sudo and setfacl log what they are given; sudo runs the command as this account,
      // answers id -u with `uid` (another account's by default), reports the guard files unreadable
      // and .git unwritable, and leaves kill and find out. The ps check runs for real and finds no
      // process of an account that does not exist.
      const stub = mkdtempSync(join(tmpdir(), 'redline-runas-'));
      const log = join(stub, 'calls.log');
      const stubs = ({ guardReadable = false, socketWritable = false, sudoWorks = true, uid = process.getuid() + 1 } = {}) => {
        writeFileSync(join(stub, 'sudo'), [
          '#!/bin/sh', `echo "sudo $*" >> '${log}'`, ...(sudoWorks ? [] : ['exit 1']),
          'shift 3; [ "$1" = -- ] && shift',
          // The access checks reach the account as `bash -c 'test "$1" "$2"' redline-access <flag> <path>`.
          '[ "$1" = bash ] && [ "$4" = redline-access ] && set -- test "$5" "$6"',
          '[ "$1" = bash ] && [ "$3" = "kill -KILL -1" ] && exit 0',
          `case "$1 $2" in "id -u") echo ${uid}; exit 0;; "test -r") exit ${guardReadable ? 0 : 1};; "test -w") case "$3" in */.git) exit 1;; *.sock) exit ${socketWritable ? 0 : 1};; esac;; kill*|find*) exit 0;; esac`,
          'exec "$@"', '',
        ].join('\n'), { mode: 0o755 });
        writeFileSync(join(stub, 'setfacl'), `#!/bin/sh\necho "setfacl $*" >> '${log}'\n`, { mode: 0o755 });
      };
      const env = { ...process.env, PATH: `${stub}:${process.env.PATH}` };
      const repoWithTests = () => makeRepo({ pkg: { name: 'r', private: true, scripts: { test: 'node test.mjs' } } });
      {
        stubs();
        const repo = repoWithTests();
        const w = world(repo, { turns: [tool('fix_write', { path: 'src/b.js', content: FIXED_B }), tool('fix_run', { command: 'node test.mjs' }), finish()] });
        const { record: r } = await runFix({ ...w.ctx, env, runAs: 'redline-run', guardFiles: ['/etc/askalf/fix-exec.env'], guardSockets: ['/run/model/key.sock'] });
        const calls = readFileSync(log, 'utf8').split('\n');
        const at = (re) => calls.findIndex((l) => re.test(l));
        check('the run account is proved first: it works, is another account, cannot read the guard files and cannot connect to the key socket',
          at(/^sudo -n -u redline-run -- id -u$/) === 0 && at(/^sudo -n -u redline-run -- bash -c test "\$1" "\$2" redline-access -r \/etc\/askalf\/fix-exec\.env$/) === 1
            && at(/^sudo -n -u redline-run -- bash -c test "\$1" "\$2" redline-access -w \/run\/model\/key\.sock$/) === 2);
        check('it may write the checkout, reads .git only, and has a HOME of its own',
          at(new RegExp(`^setfacl -R -m u:redline-run:rwX,d:u:redline-run:rwX,d:u:[^ ]+:rwX ${repo.dir}$`)) > 1
            && at(new RegExp(`^setfacl -R -m u:redline-run:rX,d:u:redline-run:rX ${repo.dir}/\\.git$`)) > 1 && at(/^setfacl -m u:redline-run:rwx,.* \/.*redline-fix-home-/) > 1);
        const ran = calls.filter((l) => / -- env -i /.test(l));
        check('the install, node <file> and the test script all run as the run account, under timeout, from a clean environment',
          ran.some((l) => /timeout -k 10 \d+ npm install /.test(l)) && ran.some((l) => /timeout -k 10 \d+ node test\.mjs$/.test(l)) && ran.some((l) => /timeout -k 10 \d+ npm test$/.test(l))
            && ran.every((l) => /^sudo -n -u redline-run -- env -i PATH=/.test(l) && !/GH_READ_TOKEN|DARIO_API_KEY/.test(l)));
        const killAfter = ran.every((l) => {
          const i = calls.indexOf(l);
          return /^sudo -n -u redline-run -- bash -c kill -KILL -1$/.test(calls[i + 1]) && /^sudo -n -u redline-run -- chmod -R u\+rwX /.test(calls[i + 2])
            && /^sudo -n -u redline-run -- setfacl -R -m u:[^:]+:rwX,d:u:[^:]+:rwX /.test(calls[i + 3]);
        });
        check('after every command its processes are killed and what it made is readable again', killAfter);
        check('and the fix goes through', r.outcome === 'fixed' && r.files.join() === 'src/b.js' && fixProblem(r) === null);
        rmSync(w.out, { recursive: true, force: true });
        rmSync(repo.dir, { recursive: true, force: true });
        rmSync(log, { force: true });
      }
      {
        stubs({ guardReadable: true });
        const repo = repoWithTests();
        const w = world(repo, { turns: [tool('fix_write', { path: 'src/b.js', content: FIXED_B }), finish()] });
        const { record: r } = await runFix({ ...w.ctx, env, runAs: 'redline-run', guardFiles: ['/etc/askalf/fix-exec.env'] });
        const calls = readFileSync(log, 'utf8');
        check('a run account that can read the key file is refused before anything runs, and is never sent kill -1',
          r.outcome === 'refused' && /can read fix-exec\.env/.test(r.notes) && w.calls.model.length === 0 && !calls.includes(' -- env -i ') && !calls.includes(' -- bash -c kill '));
        rmSync(w.out, { recursive: true, force: true });
        rmSync(repo.dir, { recursive: true, force: true });
        rmSync(log, { force: true });
      }
      {
        stubs({ socketWritable: true });
        const repo = repoWithTests();
        const w = world(repo, { turns: [tool('fix_write', { path: 'src/b.js', content: FIXED_B }), finish()] });
        const { record: r } = await runFix({ ...w.ctx, env, runAs: 'redline-run', guardFiles: ['/etc/askalf/fix-exec.env'], guardSockets: ['/run/model/key.sock'] });
        const calls = readFileSync(log, 'utf8');
        check('a run account that can connect to dario\'s key socket is refused before anything runs, and is never sent kill -1',
          r.outcome === 'refused' && /can connect to key\.sock, dario's key socket/.test(r.notes) && w.calls.model.length === 0 && !calls.includes(' -- env -i ') && !calls.includes(' -- bash -c kill '));
        rmSync(w.out, { recursive: true, force: true });
        rmSync(repo.dir, { recursive: true, force: true });
        rmSync(log, { force: true });
      }
      // Run as root, this account is root, which the root check names first.
      for (const [who, uid, re] of [['root', 0, /is root/], ['this account', process.getuid(), process.getuid() === 0 ? /is root/ : /is this account/], ['an account id -u cannot name', 'x', /could not be read/]]) {
        stubs({ uid });
        const repo = repoWithTests();
        const w = world(repo, { turns: [finish()] });
        const { record: r } = await runFix({ ...w.ctx, env, runAs: 'redline-run', guardFiles: ['/etc/askalf/fix-exec.env'] });
        const calls = readFileSync(log, 'utf8');
        check(`a run account that is ${who} is refused before anything runs, and is never sent kill -1`,
          r.outcome === 'refused' && re.test(r.notes) && w.calls.model.length === 0 && !calls.includes(' -- env -i ') && !calls.includes(' -- bash -c kill '));
        rmSync(w.out, { recursive: true, force: true });
        rmSync(repo.dir, { recursive: true, force: true });
        rmSync(log, { force: true });
      }
      {
        stubs({ sudoWorks: false });
        const repo = repoWithTests();
        const w = world(repo, { turns: [finish()] });
        const { record: r } = await runFix({ ...w.ctx, env, runAs: 'redline-run' });
        check('a run account sudo cannot reach is refused, and is never sent kill -1',
          r.outcome === 'refused' && /cannot run as the run account/.test(r.notes) && w.calls.model.length === 0 && !readFileSync(log, 'utf8').includes(' -- bash -c kill '));
        rmSync(w.out, { recursive: true, force: true });
        rmSync(repo.dir, { recursive: true, force: true });
        rmSync(log, { force: true });
      }
      {
        const repo = repoWithTests();
        const lines = [];
        const w = world(repo, { turns: [tool('fix_write', { path: 'src/b.js', content: FIXED_B }), finish()] });
        const { record: r } = await runFix({ ...w.ctx, log: (l) => lines.push(l) });
        check('without FIX_RUN_AS the fix still runs, and the log warns that commands could read the key',
          r.outcome === 'fixed' && lines.some((l) => /^::warning::FIX_RUN_AS is not set/.test(l)));
        const socketLines = [];
        const repo2 = repoWithTests();
        const w2 = world(repo2, { turns: [finish()] });
        await runFix({ ...w2.ctx, guardSockets: ['/run/model/key.sock'], log: (l) => socketLines.push(l) });
        check('with a key socket and no FIX_RUN_AS, the warning says commands could spend the key through it',
          socketLines.some((l) => /^::warning::FIX_RUN_AS is not set: .*spend the model key through dario's key socket/.test(l)));
        rmSync(w2.out, { recursive: true, force: true });
        rmSync(repo2.dir, { recursive: true, force: true });
        check('a FIX_RUN_AS that is not a user name is refused', (await runFix({ ...world(repo, { turns: [finish()] }).ctx, runAs: 'a b' })).record.outcome === 'refused');
        rmSync(w.out, { recursive: true, force: true });
        rmSync(repo.dir, { recursive: true, force: true });
      }
      rmSync(stub, { recursive: true, force: true });
    }
    // With REDLINE_TEST_RUN_AS (the self-test makes the account), the checkout's commands run as a
    // real second account and try the boundary: the key file, .git, and the git configuration
    // this process's own git might read. Set but unusable is a failure, never a skip.
    const realRunAs = process.env.REDLINE_TEST_RUN_AS ?? '';
    if (!realRunAs) {
      console.log('\n  skip the real run-account tests: REDLINE_TEST_RUN_AS is not set (the self-test sets it)');
    } else {
      console.log(`\n  runFix: a real run account (${realRunAs})`);
      check('sudo reaches the run account', spawnSync('sudo', ['-n', '-u', realRunAs, '--', 'true']).status === 0);
      const secretDir = mkdtempSync(join(tmpdir(), 'redline-secret-'));
      const secret = join(secretDir, 'fix-exec.env');
      writeFileSync(secret, 'DARIO_API_KEY=dk_live_0123456789\n', { mode: 0o600 });
      const realRun = async (testBody, inspect = () => {}, extra = {}) => {
        const repo = makeRepo({ pkg: { name: 'r', private: true, scripts: { test: 'node test.mjs' } }, testBody });
        const w = world(repo, { turns: [tool('fix_write', { path: 'src/b.js', content: FIXED_B }), finish()] });
        // A throw is a refusal, as the CLI makes it.
        let r;
        try { ({ record: r } = await runFix({ ...w.ctx, runAs: realRunAs, guardFiles: [secret], ...extra })); } catch (e) { r = { outcome: 'refused', notes: e.message }; }
        inspect(repo.dir);
        return { r, repo, w };
      };
      const done = ({ repo, w }) => { rmSync(w.out, { recursive: true, force: true }); rmSync(repo.dir, { recursive: true, force: true }); };
      {
        // The report goes into the checkout: /tmp is sticky, and this account could not remove a
        // file the run account made there.
        const body = [
          "import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';",
          'const r = { uid: process.getuid(), env: Object.keys(process.env) };',
          `try { readFileSync(${JSON.stringify(secret)}); r.key = 'read'; } catch (e) { r.key = e.code; }`,
          "try { appendFileSync('.git/config', '#'); r.git = 'written'; } catch (e) { r.git = e.code; }",
          "try { writeFileSync('scratch.txt', 'x'); r.checkout = 'written'; } catch (e) { r.checkout = e.code; }",
          "writeFileSync('report.json', JSON.stringify(r));", '',
        ].join('\n');
        let seen = {};
        const run = await realRun(body, (dir) => { try { seen = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')); } catch { /* no report */ } });
        check('the tests run as the run account and cannot read the key file or write .git, but can write the checkout',
          seen.uid !== process.getuid() && seen.key === 'EACCES' && seen.git === 'EACCES' && seen.checkout === 'written' && !seen.env.includes('GH_READ_TOKEN'));
        check('and the fix goes through', run.r.outcome === 'fixed' && fixProblem(run.r) === null, run.r.notes);
        done(run);
      }
      for (const [name, body] of [
        // .git is read-only but its directory entry is not: rename it and put a writable copy,
        // with a command in its config, in its place.
        ['a replaced .git', (mark) => "import { renameSync, cpSync, appendFileSync } from 'node:fs';\nrenameSync('.git', '.git-old');\ncpSync('.git-old', '.git', { recursive: true });\nappendFileSync('.gitignore', '.git-old/\\n');\n"
          + `appendFileSync('.git/config', '[core]\\n\\tfsmonitor = touch ${mark}\\n[safe]\\n\\tdirectory = *\\n');\n`],
        // The commands' HOME: a global git config there, which a git run with that HOME would read.
        ['a .gitconfig in the commands\' HOME', (mark) => "import { writeFileSync } from 'node:fs';\n"
          + `writeFileSync(process.env.HOME + '/.gitconfig', '[core]\\n\\tfsmonitor = touch ${mark}\\n[safe]\\n\\tdirectory = *\\n');\n`],
        // prepare-commit-msg and post-commit hooks (--no-verify skips neither) where the commit's
        // hooks directory would be if it lived in the commands' HOME.
        ['commit hooks planted in the commands\' HOME', (mark) => "import { mkdirSync, writeFileSync } from 'node:fs';\n"
          + "mkdirSync(process.env.HOME + '/no-hooks', { recursive: true });\n"
          + `for (const h of ['prepare-commit-msg', 'post-commit']) writeFileSync(process.env.HOME + '/no-hooks/' + h, '#!/bin/sh\\ntouch ${mark}\\n', { mode: 0o755 });\n`],
      ]) {
        const mark = join(tmpdir(), `redline-pwned-${process.pid}-${Math.random().toString(36).slice(2)}`);
        const run = await realRun(body(mark));
        check(`${name} runs nothing as this account`, !existsSync(mark) && run.r.outcome !== 'refused', run.r.notes);
        rmSync(mark, { force: true });
        done(run);
      }
      {
        // The test strips the inherited ACL from a directory and a file it made and locks them to
        // itself (700, 600, and a 000 directory inside). This account still reaches and commits them.
        const lock = "import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\n"
          + "mkdirSync('locked/inner', { recursive: true });\nwriteFileSync('locked/f.txt', 'x\\n');\nwriteFileSync('locked/inner/g.txt', 'y\\n');\n"
          + "spawnSync('setfacl', ['-R', '-b', 'locked']);\nchmodSync('locked/f.txt', 0o600);\nchmodSync('locked/inner/g.txt', 0o600);\nchmodSync('locked/inner', 0o000);\nchmodSync('locked', 0o700);\n";
        const run = await realRun(lock);
        check('files the run account locked to itself are reached and committed, and nothing is left this account cannot remove',
          run.r.outcome === 'fixed' && ['locked/f.txt', 'locked/inner/g.txt'].every((f) => run.r.files.includes(f)), run.r.notes);
        done(run);
      }
      {
        // A detached process that hops: each instance logs, starts the next and exits at once, so a
        // list of process ids is stale by the time it is signalled (pkill lets it run on). Its
        // script lives outside the checkout and the commands' HOME, so only the kill can stop it.
        // After the run its log must have stopped growing, and the run goes on.
        const hopDir = mkdtempSync(join(tmpdir(), 'redline-hop-'));
        chmodSync(hopDir, 0o777);
        const hopLog = join(hopDir, 'hops.log');
        const forker = "import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\n"
          + `writeFileSync('${hopDir}/hop.sh', 'echo . >> ${hopLog}\\nsh "$0" &\\nexit 0\\n');\n`
          + `spawn('sh', ['${hopDir}/hop.sh'], { detached: true, stdio: 'ignore' }).unref();\n`;
        const run = await realRun(forker);
        const size = () => { try { return statSync(hopLog).size; } catch { return 0; } };
        const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
        const first = size();
        wait(700);
        const second = size();
        check('a detached process that keeps hopping to new process ids is stopped before the checkout is read again, and the fix goes through',
          first > 0 && second === first && run.r.outcome === 'fixed', `${first} -> ${second}: ${run.r.notes}`);
        for (let i = 0; i < 5; i++) spawnSync('sudo', ['-n', '-u', realRunAs, '--', 'kill', '-KILL', '-1']);
        rmSync(hopDir, { recursive: true, force: true });
        done(run);
      }
      {
        // dario's key socket: in a directory only this account can enter, the run account cannot
        // connect and the run goes on; where it can connect, the run is refused before anything runs.
        const sockDir = mkdtempSync(join(tmpdir(), 'redline-sock-'));
        chmodSync(sockDir, 0o700);
        const sock = join(sockDir, 'fix.sock');
        const server = createNetServer((c) => c.destroy());
        await new Promise((r) => server.listen(sock, r));
        let connected = null;
        const probe = "import { connect } from 'node:net';\nimport { writeFileSync } from 'node:fs';\n"
          + `const c = connect(${JSON.stringify(sock)});\nc.on('connect', () => { writeFileSync('sock.txt', 'connected'); c.destroy(); });\nc.on('error', (e) => writeFileSync('sock.txt', e.code));\n`;
        const closed = await realRun(probe, (dir) => { try { connected = readFileSync(join(dir, 'sock.txt'), 'utf8'); } catch { /* none */ } }, { guardSockets: [sock] });
        check('a key socket the run account cannot reach: the run goes on, and its tests cannot connect',
          closed.r.outcome === 'fixed' && connected !== null && connected !== 'connected', `${connected} ${closed.r.notes}`);
        done(closed);
        chmodSync(sockDir, 0o755);
        chmodSync(sock, 0o666);
        const open = await realRun('', () => {}, { guardSockets: [sock] });
        check('a key socket the run account can connect to: refused before anything runs',
          open.r.outcome === 'refused' && /can connect to fix\.sock, dario's key socket/.test(open.r.notes) && open.w.calls.model.length === 0, open.r.notes);
        done(open);
        await new Promise((r) => server.close(r));
        rmSync(sockDir, { recursive: true, force: true });
      }
      rmSync(secretDir, { recursive: true, force: true });
    }
    console.log('\n  runFix: the test script');
    {
      const repo = makeRepo({ pkg: { name: 'r', private: true, scripts: { test: 'node test.mjs' } } });
      const w = world(repo, { turns: [tool('fix_write', { path: 'src/b.js', content: FIXED_B }), finish()] });
      const { record: r } = await runFix(w.ctx);
      check('the model skipped the tests: the script ran them after the last edit and recorded them', r.outcome === 'fixed' && r.tests?.command === 'npm test' && r.tests.exit_code === 0 && /Tests: `npm test` exited 0/.test(r.notes) && fixProblem(r) === null);
      check('package.json and package-lock.json from the install are not in the commit', r.files.join() === 'src/b.js');
      rmSync(w.out, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
    }
    {
      const repo = makeRepo({ pkg: { name: 'r', private: true, scripts: { test: 'node test.mjs' } }, testExit: 1 });
      const w = world(repo, { turns: [tool('fix_write', { path: 'src/b.js', content: FIXED_B }), finish(), finish()] });
      const { record: r } = await runFix(w.ctx);
      check('a failing suite is bounced to the model once, then reported as tests_failed', r.outcome === 'tests_failed' && r.tests.exit_code === 1 && JSON.stringify(w.calls.model[2].messages.at(-1)).includes('test script fails') && w.calls.model.length === 3);
      check('tests_failed: diff.patch, no bundle, no commit, schema ok', existsSync(join(w.out, 'diff.patch')) && !existsSync(join(w.out, 'fix.bundle')) && r.new_head === null && sh(repo.dir, ['rev-parse', 'HEAD']) === repo.head && fixProblem(r) === null);
      rmSync(w.out, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
    }
    {
      // The root package's own postinstall stands in for a dependency's: --ignore-scripts skips both.
      const postinstall = 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'x\')"';
      const repo = makeRepo({ pkg: { name: 'r', private: true, scripts: { test: 'node test.mjs', postinstall } } });
      const w = world(repo, { turns: [tool('fix_write', { path: 'src/b.js', content: FIXED_B }), finish()] });
      const { record: r } = await runFix(w.ctx);
      check('the install runs no lifecycle script, and the brief says so', r.outcome === 'fixed' && !existsSync(join(repo.dir, 'ran.txt')) && w.calls.model[0].messages[0].content.includes('install scripts were skipped'));
      rmSync(w.out, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
    }
    {
      // The clock jumps past hardMs after the edit: the suite is not started (the bounce says why),
      // no model call starts after it, and the run is refused, never fixed.
      let late = false;
      let t = 0;
      const repo = makeRepo({ pkg: { name: 'r', private: true, scripts: { test: 'node test.mjs' } } });
      const w = world(repo, { turns: [tool('fix_write', { path: 'src/b.js', content: FIXED_B }), () => { late = true; return finish(); }] });
      const { record: r } = await runFix({ ...w.ctx, now: () => (late ? LIMITS.hardMs + 60_000 : 0) + (t += 1) });
      check('no time left for the suite, nor for another model call: refused, never fixed', r.outcome === 'refused' && /time budget/.test(r.notes) && w.calls.model.length === 2 && !existsSync(join(w.out, 'fix.bundle')) && !existsSync(join(w.out, 'diff.patch')) && fixProblem(r) === null);
      rmSync(w.out, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
    }
    {
      // A file changed by a node <file> after the passing run makes that run stale: the suite runs
      // again on the files as they are, and fails.
      const repo = makeRepo({ pkg: { name: 'r', private: true, scripts: { test: 'node test.mjs' } } });
      const w = world(repo, { turns: [
        tool('fix_write', { path: 'src/b.js', content: FIXED_B }),
        tool('fix_write', { path: 'mutate.mjs', content: "import { writeFileSync } from 'node:fs';\nwriteFileSync('test.mjs', 'process.exit(1);\\n');\n" }),
        tool('fix_run', { command: 'npm test' }), tool('fix_run', { command: 'node mutate.mjs' }), finish(), finish(),
      ] });
      const { record: r } = await runFix(w.ctx);
      check('a change made by node <file> after the tests is tested again, never passed on the old run', r.outcome === 'tests_failed' && r.tests.exit_code === 1 && !existsSync(join(w.out, 'fix.bundle')) && fixProblem(r) === null);
      rmSync(w.out, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
    }
    {
      // A command commits every change on its own: the test gate still sees the change and runs the
      // suite, and a failing suite keeps it from being a fix.
      const repo = makeRepo({ pkg: { name: 'r', private: true, scripts: { test: 'node test.mjs' } }, testExit: 1 });
      const commitAll = "import { writeFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\n"
        + `writeFileSync('src/b.js', ${JSON.stringify(FIXED_B)});\n`
        + "spawnSync('git', ['add', '-A'], { stdio: 'ignore' });\nspawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'all'], { stdio: 'ignore' });\n";
      const w = world(repo, { turns: [tool('fix_write', { path: 'commit-all.mjs', content: commitAll }), tool('fix_run', { command: 'node commit-all.mjs' }), finish(), finish()] });
      const { record: r } = await runFix(w.ctx);
      check('a change a command committed on its own still goes through the test gate',
        r.outcome === 'tests_failed' && r.tests?.command === 'npm test' && r.tests.exit_code === 1 && fixProblem(r) === null, JSON.stringify({ outcome: r.outcome, tests: r.tests }));
      check('and no bundle is written for it', !existsSync(join(w.out, 'fix.bundle')) && r.new_head === null);
      rmSync(w.out, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
    }
    if (process.platform !== 'win32') {
      // Same bytes, executable bit gone: the passing run is stale, and the suite that runs the
      // script now fails.
      const repo = makeRepo({ pkg: { name: 'r', private: true, scripts: { test: './check.sh' } } });
      writeFileSync(join(repo.dir, 'check.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      sh(repo.dir, ['add', '-A']);
      sh(repo.dir, ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'test: a script the suite runs']);
      repo.head = sh(repo.dir, ['rev-parse', 'HEAD']);
      const w = world(repo, { turns: [
        tool('fix_write', { path: 'check.sh', content: '#!/bin/sh\n# checked\nexit 0\n' }),
        tool('fix_write', { path: 'chmod.mjs', content: "import { chmodSync } from 'node:fs';\nchmodSync('check.sh', 0o644);\n" }),
        tool('fix_run', { command: 'npm test' }), tool('fix_run', { command: 'node chmod.mjs' }), finish(), finish(),
      ] });
      const { record: r } = await runFix(w.ctx);
      check('a script that lost its executable bit after the tests is tested again, never passed on the old run',
        JSON.stringify(w.calls.model[3].messages.at(-1)).includes('exit 0') && r.outcome === 'tests_failed' && r.tests.exit_code !== 0 && !existsSync(join(w.out, 'fix.bundle')) && fixProblem(r) === null);
      rmSync(w.out, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
    }
    {
      const repo = makeRepo({ pkg: { name: 'r', private: true, scripts: { test: 'node test.mjs' } } });
      const w = world(repo, { turns: [tool('fix_write', { path: 'src/b.js', content: FIXED_B }), tool('fix_run', { command: 'npm test' }), finish()] });
      const { record: r } = await runFix(w.ctx);
      check('a test run by the model after its edit is the one recorded', r.outcome === 'fixed' && r.tests?.command === 'npm test' && w.calls.model.length === 3 && JSON.stringify(w.calls.model[2].messages.at(-1)).includes('exit 0'));
      rmSync(w.out, { recursive: true, force: true });
      rmSync(repo.dir, { recursive: true, force: true });
    }
  }
}

console.log('\n  failingTests');
{
  const tap = 'TAP version 13\n# Subtest: a.mjs\nok 1 - a.mjs\nnot ok 2 - oauth-detector.mjs\n    not ok 1 - nested case\nnot ok 3 - later.mjs # TODO not yet\nnot ok 4 - skipped.mjs # SKIP no binary\nnot ok 5 - oauth-detector.mjs\n';
  check('TAP: not ok names in order, nested included, TODO and SKIP left out, unique', failingTests(tap).join('|') === 'oauth-detector.mjs|nested case');
  check('jest/vitest FAIL lines', failingTests(' PASS  a.test.js\n FAIL  src/b.test.js\nFAIL c.test.ts\n').join('|') === 'src/b.test.js|c.test.ts');
  check('a [FAIL] marker inside a test is not a name', failingTests('# [FAIL] source is detected\n  [FAIL] x\n').length === 0);
  check('an output that names nothing: empty', failingTests('Error: boom\n').length === 0 && failingTests(undefined).length === 0);
  const many = Array.from({ length: FAILING_NAMES_MAX + 5 }, (_, i) => `not ok ${i + 1} - t${i}`).join('\n');
  check(`at most ${FAILING_NAMES_MAX} names`, failingTests(many).length === FAILING_NAMES_MAX);
  check('notes name the failed tests', renderNotes({ outcome: 'tests_failed', files: ['a'], tests: { command: 'npm test', exit_code: 1, summary: '1 pass, 1 fail', failing: ['new.mjs'] } }).includes('Failed: `new.mjs`'));
  const passing = renderNotes({ outcome: 'fixed', files: ['a'], tests: { command: 'npm test', exit_code: 0, summary: '2 pass, 0 fail' } });
  check('a passing run says only that it passed', passing.includes('Tests: `npm test` exited 0') && !passing.includes('Failed:') && !passing.includes('no test script'));
}

if (gitOk && npmOk) {
  console.log('\n  runFix: a failing suite names what failed');
  const repo = makeRepo({ pkg: { name: 'r', private: true, scripts: { test: 'node test.mjs' } },
    testBody: "console.log('TAP version 13');\nconsole.log('ok 1 - a.mjs');\nconsole.log('not ok 2 - old.mjs');\nprocess.exit(1);\n" });
  const w = world(repo, { turns: [tool('fix_write', { path: 'src/b.js', content: FIXED_B }), finish(), finish()] });
  const { record: r } = await runFix(w.ctx);
  const bounce = JSON.stringify(w.calls.model[2]?.messages.at(-1) ?? '');
  check('the bounce names the failed test', bounce.includes('Failed: old.mjs'));
  check('still tests_failed: a named failure is never excused', r.outcome === 'tests_failed' && r.new_head === null && r.tests.exit_code === 1);
  check('fix.json and notes carry the name', r.tests.failing.join() === 'old.mjs' && r.notes.includes('Failed: `old.mjs`') && fixProblem(r) === null);
  rmSync(w.out, { recursive: true, force: true });
  rmSync(repo.dir, { recursive: true, force: true });
}

console.log('\n  CLI');
{
  const script = fileURLToPath(new URL('./fix.mjs', import.meta.url));
  // The fixer's prompt is a file on the exec runner host, named by FIX_PROMPT_FILE; the tests hand
  // the script the three-line stand-in under test-fixtures.
  const PROMPT_FIXTURE = fileURLToPath(new URL('./test-fixtures/fix-prompt.md', import.meta.url));
  check('the stand-in is three lines, not a brief', readFileSync(PROMPT_FIXTURE, 'utf8').split('\n').filter(Boolean).length === 3);
  const src = readFileSync(script, 'utf8');
  check('fix.mjs reads the prompt from FIX_PROMPT_FILE and bundles none', src.includes("readPrompt(env, 'FIX_PROMPT_FILE')") && !/new URL\(['"]\.\/[\w.-]*prompt/.test(src));
  const r = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '' }, encoding: 'utf8' });
  check('missing configuration exits 2 with an annotation', r.status === 2 && r.stderr.includes('::error::FIX_ENV_FILE is not set'));
  const dir = mkdtempSync(join(tmpdir(), 'redline-fix-cli-'));
  const envFile = join(dir, 'fix.env');
  writeFileSync(envFile, 'DARIO_URL=http://127.0.0.1:9\n');
  const outDir = join(dir, 'fix-out');
  mkdirSync(outDir);
  writeFileSync(join(outDir, 'fix.json'), '{"stale":true}\n');
  const base = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '', FIX_ENV_FILE: envFile, FIX_OUT: outDir, REPO: 'askalf/r', PR: '7', HEAD_SHA: HEAD, REVIEW_URL, CHECKOUT: dir, GH_READ_TOKEN: 'read' };
  const noPrompt = spawnSync(process.execPath, [script], { env: base, encoding: 'utf8' });
  check('no FIX_PROMPT_FILE: exit 2, the error names the variable, and the stale output is untouched', noPrompt.status === 2 && noPrompt.stderr.includes('::error::FIX_PROMPT_FILE is not set') && existsSync(join(outDir, 'fix.json')));
  writeFileSync(join(dir, 'empty.md'), '\n');
  const empty = spawnSync(process.execPath, [script], { env: { ...base, FIX_PROMPT_FILE: join(dir, 'empty.md') }, encoding: 'utf8' });
  check('an empty prompt file: exit 2, the error names the variable', empty.status === 2 && /::error::FIX_PROMPT_FILE: .*empty\.md is empty/.test(empty.stderr));
  const s = spawnSync(process.execPath, [script], { env: { ...base, FIX_PROMPT_FILE: PROMPT_FIXTURE }, encoding: 'utf8' });
  check('the model key is required from the env file, never from the environment, unless there is a key socket', s.status === 2 && s.stderr.includes('::error::DARIO_API_KEY is not set (or set DARIO_SOCKET'));
  writeFileSync(envFile, 'DARIO_SOCKET=run/dario.sock\n');
  const rel = spawnSync(process.execPath, [script], { env: { ...base, FIX_PROMPT_FILE: PROMPT_FIXTURE }, encoding: 'utf8' });
  check('a DARIO_SOCKET that is not absolute: exit 2, the error names it', rel.status === 2 && rel.stderr.includes('::error::DARIO_SOCKET must be an absolute path'));
  writeFileSync(envFile, 'DARIO_URL=http://127.0.0.1:9\n');
  check('an earlier run\'s output is removed before anything starts', !existsSync(join(outDir, 'fix.json')));
  if (gitOk) {
    const repo = makeRepo();
    writeFileSync(envFile, 'DARIO_API_KEY=dk_test\nDARIO_URL=http://127.0.0.1:9\n');
    const bad = spawnSync(process.execPath, [script], {
      env: { ...base, FIX_PROMPT_FILE: PROMPT_FIXTURE, HEAD_SHA: repo.head, REVIEW_URL: 'https://github.com/askalf/r/pull/7', CHECKOUT: repo.dir },
      encoding: 'utf8',
    });
    const written = JSON.parse(readFileSync(join(outDir, 'fix.json'), 'utf8'));
    check('a refusal writes fix.json and notes.md and exits 1', bad.status === 1 && written.outcome === 'refused' && /not a pull request review link/.test(written.notes) && readFileSync(join(outDir, 'notes.md'), 'utf8') === `${written.notes}\n` && fixProblem(written) === null);
    check('the key is never printed', !/dk_test/.test(bad.stdout + bad.stderr));
    rmSync(repo.dir, { recursive: true, force: true });
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n  the reusable workflow');
{
  const wf = readFileSync(fileURLToPath(new URL('../../.github/workflows/redline-fix-run.yml', import.meta.url)), 'utf8');
  check('it is a reusable workflow', /^on:\s*\n\s+workflow_call:/m.test(wf));
  const input = (name, type, required) => new RegExp(`\\n      ${name}:\\n(?:        .*\\n)*?        required: ${required}\\n(?:        .*\\n)*?        type: ${type}\\n`).test(wf);
  check('runner-label, redline-ref, pr, head and review are required string inputs', ['runner-label', 'redline-ref', 'pr', 'head', 'review'].every((n) => input(n, 'string', 'true')));
  check('dry_run is an optional boolean, default false', input('dry_run', 'boolean', 'false') && /\n      dry_run:\n(?:        .*\n)*?        default: false\n/.test(wf));
  const steps = wf.split(/\n      - /).slice(1);
  const at = (name) => steps.findIndex((s) => s.startsWith(`name: ${name}\n`));
  const guardAt = at('Check the review ref is a full commit sha');
  const inputsAt = at('Check the head and the review link');
  const mainAt = at('Check the review ref is on askalf/ci main');
  const fetchAt = at('Fetch the fix script from askalf/ci');
  const prAt = at('Check out the PR head to fix');
  const headAt = at('Check the checkout is at the head');
  const nodeAt = steps.findIndex((s) => s.startsWith('uses: actions/setup-node@'));
  const fixAt = at('Fix');
  const uploadAt = at('Upload the fix');
  const cleanAt = at('Remove the checkouts');
  check('the sha guard is the first step, the input guard the second, the on-main check third', guardAt === 0 && inputsAt === 1 && mainAt === 2);
  check('then the script fetch, the PR checkout, the head check, node, the fix, the upload and the cleanup, in that order',
    fetchAt === 3 && prAt === 4 && headAt === 5 && nodeAt === 6 && fixAt === 7 && uploadAt === 8 && cleanAt === 9 && steps.length === 10);
  check('the script is fetched at redline-ref, not job_workflow_sha or a branch',
    steps[fetchAt].includes('ref: ${{ inputs.redline-ref }}') && steps[fetchAt].includes('sparse-checkout: scripts/redline') && !/ref: \$\{\{ github\.job_workflow_sha/.test(wf) && !/ref: main\b/.test(wf));
  check('the script comes from askalf/ci, the on-main check compares against it, and nothing names the old home',
    steps[fetchAt].includes('repository: askalf/ci\n') && steps[mainAt].includes('repos/askalf/ci/compare/') && !wf.includes('askalf/askalf'));
  check('the PR is checked out at the head input, into pr/', steps[prAt].includes('ref: ${{ inputs.head }}') && steps[prAt].includes('path: pr\n'));
  check('no input is interpolated into a run step: everything goes through env', steps.every((s) => !s.includes('run:') || !/\$\{\{\s*inputs\./.test(s.slice(s.indexOf('run:')))));
  check('the head check compares the checkout with HEAD_SHA from env and fails', steps[headAt].includes('HEAD_SHA: ${{ inputs.head }}') && /git -C pr rev-parse HEAD/.test(steps[headAt]) && /exit 1/.test(steps[headAt]));
  const shell = (i) => /run: \|\n((?: {10}.*\n?)+)/.exec(steps[i] ?? '')?.[1].replace(/^ {10}/gm, '') ?? 'exit 0';
  if (!bashOk) {
    console.log('  skip the guards\' shell: no bash here');
  } else {
    const guard = (ref) => spawnSync('bash', ['-e', '-c', shell(guardAt)], { env: { ...process.env, REDLINE_REF: ref }, encoding: 'utf8' }).status;
    check('the sha guard passes a full sha and fails empty, branch, short, uppercase and padded refs',
      guard(HEAD) === 0 && guard('') !== 0 && guard('main') !== 0 && guard(HEAD.slice(0, 7)) !== 0 && guard(HEAD.toUpperCase()) !== 0 && guard(`${HEAD}\nmain`) !== 0);
    const inputs = (env) => spawnSync('bash', ['-e', '-c', shell(inputsAt)], { env: { ...process.env, HEAD_SHA: HEAD, PR: '7', REVIEW_URL: REVIEW_URL, REPO: 'askalf/r', ...env }, encoding: 'utf8' }).status;
    check('the input guard passes a good head, PR and review link', inputs({}) === 0);
    check('the input guard fails a short head, a non-numeric PR and a review link on another repo or PR',
      inputs({ HEAD_SHA: HEAD.slice(0, 7) }) !== 0 && inputs({ PR: 'x' }) !== 0 && inputs({ PR: '07' }) !== 0
      && inputs({ REVIEW_URL: 'https://github.com/askalf/other/pull/7#pullrequestreview-99' }) !== 0 && inputs({ REVIEW_URL: 'https://github.com/askalf/r/pull/8#pullrequestreview-99' }) !== 0
      && inputs({ REVIEW_URL: 'https://github.com/askalf/r/pull/7#issuecomment-99' }) !== 0 && inputs({ REVIEW_URL: `${REVIEW_URL}x` }) !== 0);
    const headCheck = (at2) => spawnSync('bash', ['-e', '-c', shell(headAt).replace('git -C pr rev-parse HEAD', `echo ${at2}`)], { env: { ...process.env, HEAD_SHA: HEAD }, encoding: 'utf8' }).status;
    check('the head check passes the head and fails another sha', headCheck(HEAD) === 0 && headCheck(OTHER) !== 0);
  }
  check('it runs on the caller\'s exec runner label', /runs-on: \[self-hosted, "\$\{\{ inputs\.runner-label \}\}"\]/.test(wf));
  check('both checkouts keep no credentials', (wf.match(/persist-credentials: false/g) ?? []).length === 2);
  const permBlock = /\npermissions:\n((?: {2}.*\n)+)/.exec(wf)?.[1] ?? '';
  check('the job token is read-only', permBlock === '  contents: read\n  pull-requests: read\n' && (wf.match(/^\s*permissions:/gm) ?? []).length === 1);
  check('third-party actions are pinned by sha', [...wf.matchAll(/uses: ([^\s]+)/g)].every((m) => /@[0-9a-f]{40}$/.test(m[1])) && (wf.match(/uses: /g) ?? []).length === 4);
  const fix = steps[fixAt] ?? '';
  check('the fix step runs the fetched script with the contract env', fix.includes('run: node .redline/scripts/redline/fix.mjs') && fix.includes('CHECKOUT: ${{ github.workspace }}/pr') && fix.includes('FIX_OUT: ${{ github.workspace }}/fix-out')
    && fix.includes('FIX_ENV_FILE: /etc/askalf/fix-exec.env') && fix.includes('GH_READ_TOKEN: ${{ github.token }}') && fix.includes('REVIEW_URL: ${{ inputs.review }}') && fix.includes("DRY_RUN: ${{ inputs.dry_run && '1' || '0' }}"));
  check('the fix step names the host prompt file, and no prompt is fetched with the script', fix.includes('FIX_PROMPT_FILE: /etc/askalf/fix-prompt.md') && !/prompt/.test(steps[fetchAt]));
  check('no secret from GitHub reaches the fix step', !/secrets\./.test(wf));
  const upload = steps[uploadAt] ?? '';
  check('the upload runs whatever the outcome, as redline-fix from fix-out, short-lived, overwriting',
    upload.includes('if: always()\n') && /uses: actions\/upload-artifact@[0-9a-f]{40} # v4\./.test(upload) && upload.includes('name: redline-fix\n') && upload.includes('path: fix-out\n') && /retention-days: [1-7]\n/.test(upload) && upload.includes('overwrite: true'));
  const review = readFileSync(fileURLToPath(new URL('../../.github/workflows/redline-review.yml', import.meta.url)), 'utf8');
  check('the upload action is the version redline-review.yml uses', /uses: actions\/upload-artifact@([0-9a-f]{40})/.exec(upload)?.[1] === /uses: actions\/upload-artifact@([0-9a-f]{40})/.exec(review)?.[1]);
  check('the cleanup removes the PR, the script and the output', /run: rm -rf pr \.redline fix-out\s*$/.test(steps[cleanAt] ?? '') && (steps[cleanAt] ?? '').includes('if: always()'));
  check('the job has a timeout past the fix\'s wall limit', Number(/timeout-minutes: (\d+)/.exec(wf)?.[1]) * 60_000 > LIMITS.timeMs);
  check('the hard deadline leaves the job five minutes for its other steps and the upload', LIMITS.timeMs < LIMITS.hardMs && Number(/timeout-minutes: (\d+)/.exec(wf)?.[1]) * 60_000 >= LIMITS.hardMs + 5 * 60_000);
  check('the env file comment names the account boundary', /readable by the exec account only/i.test(wf) && /never by an account that runs untrusted code/i.test(wf));
}

console.log('\n  the caller');
{
  const NEW = 'c0ffee0000000000000000000000000000000001';
  const y = fixCallerYaml(NEW, 'dario-exec', 'askalf/ci#80');
  check('name and run-name', /^name: Redline fix$/m.test(y) && y.includes('run-name: Redline fix ${{ github.repository }}#${{ inputs.pr }} @ ${{ inputs.head }}\n'));
  const on = /\non:\n((?:  .*\n|\n)+?)(?=\S)/.exec(y)?.[1] ?? '';
  check('it runs on workflow_dispatch only', /^  workflow_dispatch:\n/.test(on) && !/pull_request|push|schedule/.test(on));
  const input = (name, type, required) => new RegExp(`\\n      ${name}:\\n(?:        .*\\n)*?        required: ${required}\\n(?:        .*\\n)*?        type: ${type}\\n`).test(y);
  check('pr, head and review are required string inputs; dry_run an optional boolean default false', input('pr', 'string', 'true') && input('head', 'string', 'true') && input('review', 'string', 'true') && input('dry_run', 'boolean', 'false') && /default: false/.test(y));
  check('permissions are read-only', /\npermissions:\n  contents: read\n  pull-requests: read\n\n/.test(y) && !/write/.test(y));
  check('one queued run per PR', y.includes('group: fix-${{ github.repository }}-${{ inputs.pr }}\n') && y.includes('cancel-in-progress: false'));
  const jobs = [...y.slice(y.search(/^jobs:/m)).matchAll(/^  ([\w-]+):$/gm)].map((m) => m[1]);
  check('one job, fix, calling the pinned reusable workflow with redline-ref at the same sha', jobs.join() === 'fix' && y.includes(`uses: ${FIX_WORKFLOW}@${NEW} # askalf/ci#80\n`) && y.includes(`redline-ref: ${NEW}\n`));
  check('the workflow it pins is this repository\'s, and the caller names no other home', FIX_WORKFLOW === 'askalf/ci/.github/workflows/redline-fix-run.yml' && !y.includes('askalf/askalf'));
  check('the runner label and every dispatch input are passed through', y.includes('runner-label: dario-exec\n') && y.includes('pr: ${{ inputs.pr }}') && y.includes('head: ${{ inputs.head }}') && y.includes('review: ${{ inputs.review }}') && y.includes('dry_run: ${{ inputs.dry_run }}'));
  check('the caller job has no runs-on of its own', !/runs-on/.test(y));
  check('no em dash', !/[\u2013\u2014]/.test(y));
  check('a bad sha or label is refused', (await throws(() => fixCallerYaml('main', 'dario-exec'))) && (await throws(() => fixCallerYaml(NEW, 'Dario Exec'))));
}

console.log('\n  pin bump, both callers');
{
  const NEW = 'c0ffee0000000000000000000000000000000001';
  const OLD = '116935d3803fc5904d96efb56991b93539c1714c';
  const note = 'main 2026-09-27, askalf/ci#80';
  const refs = (y) => [...y.matchAll(/redline-ref: (\S+)/g)].map((m) => m[1]);
  check('the two callers are known by workflow and path', CALLERS.map((c) => c.path).join() === '.github/workflows/redline.yml,.github/workflows/redline-fix.yml' && CALLERS[0].workflow === REVIEW_WORKFLOW && CALLERS[1].workflow === FIX_WORKFLOW);
  const fixCaller = fixCallerYaml(OLD, 'dario-exec', 'old');
  const b = bumpCaller(fixCaller, NEW, note);
  check('the fix caller: the pin and redline-ref both move, once each', b.includes(`uses: ${FIX_WORKFLOW}@${NEW} # ${note}\n`) && refs(b).join() === NEW && !b.includes(OLD));
  check('the fix caller: the other inputs stay', b.includes('runner-label: dario-exec\n') && b.includes('review: ${{ inputs.review }}'));
  check('a second bump changes nothing', bumpCaller(b, NEW, note) === b);
  check('the bumped caller is the generated caller', b === fixCallerYaml(NEW, 'dario-exec', note));
  const reviewCaller = `name: Redline\n\non:\n  pull_request:\n\njobs:\n  review:\n    uses: ${REVIEW_WORKFLOW}@${OLD} # old\n    with:\n      redline-ref: ${OLD}\n      runner-label: redline\n`;
  const r = bumpCaller(reviewCaller, NEW, note);
  check('the review caller still bumps', r.includes(`uses: ${REVIEW_WORKFLOW}@${NEW} # ${note}\n`) && refs(r).join() === NEW);
  check('a file that calls neither is refused', (await throws(() => bumpCaller('name: x\n', NEW)))?.message.includes('no askalf/ci/.github/workflows/redline-review.yml or askalf/ci/.github/workflows/redline-fix-run.yml call'));
  const bump = readFileSync(fileURLToPath(new URL('../../.github/workflows/redline-pin-bump.yml', import.meta.url)), 'utf8');
  check('the bump workflow rewrites both caller paths with pin.mjs', /CALLER_PATHS: .*redline\.yml .*redline-fix\.yml/.test(bump.replace(/\n\s+/g, ' ')) && bump.includes('node scripts/redline/pin.mjs "$SHA" "$note"') && /redline-\(review\|fix-run\)\.yml/.test(bump));
  const pinPaths = (/\n      PIN_PATHS: >-\n((?: {8}\S.*\n)+)/.exec(bump)?.[1] ?? '').split(/\s+/).filter(Boolean);
  check('a change to the fix workflow moves the pin', pinPaths.includes('.github/workflows/redline-fix-run.yml'));
  check('the tests, their fixtures and the README move no pin',
    ['scripts/redline/*.test.mjs', 'scripts/redline/test-fixtures', 'scripts/redline/README.md'].every((x) => pinPaths.includes(`:(exclude)${x}`))
      && pinPaths.indexOf(':(exclude)scripts/redline/*.test.mjs') > pinPaths.indexOf('scripts/redline'));
  // Batched: a burst of merges here is one bump wave, and an open bump PR is not reset for no change.
  const on = /\non:\n((?: {2}.*\n)+)/.exec(bump)?.[1] ?? '';
  check('the bump runs hourly and on dispatch, never per push', /^  schedule:\n    - cron: '\d+ \* \* \* \*'\n  workflow_dispatch:\n$/.test(on));
  check('a scheduled bump waits for the newest change to be quiet; a dispatch does not',
    /QUIET_MINUTES: \d+/.test(bump) && bump.includes('if [ "$EVENT" = schedule ] && [ "$age" -lt "$QUIET_MINUTES" ]; then')
      && bump.includes("git log -1 --first-parent --format='%H %ct' HEAD -- $PIN_PATHS") && bump.includes('SHA: ${{ steps.pick.outputs.sha }}')
      && bump.includes('fetch-depth: 0'));
  {
    // The pick step itself, in a scratch history: a branch whose runtime change is hours old,
    // merged into main a minute ago, is picked as the merge and waits out the quiet window.
    const lines = bump.split('\n');
    const at = lines.findIndex((l) => l.includes('- name: Pick the commit to pin'));
    const runAt = lines.findIndex((l, i) => i > at && l.trim() === 'run: |');
    const script = [];
    for (const l of lines.slice(runAt + 1)) { if (l.trim() && !l.startsWith('          ')) break; script.push(l.slice(10)); }
    const pinPaths = (/\n      PIN_PATHS: >-\n((?: {8}\S.*\n)+)/.exec(bump)?.[1] ?? '').split(/\s+/).filter(Boolean).join(' ');
    if (!gitOk || process.platform === 'win32' || spawnSync('bash', ['-c', 'true']).status !== 0) {
      console.log('  skip the pick step run: no POSIX bash and git here');
    } else {
      const d = mkdtempSync(join(tmpdir(), 'pick-'));
      const now = Math.floor(Date.now() / 1000);
      const git = (args, when) => spawnSync('git', args, { cwd: d, encoding: 'utf8', env: { ...process.env,
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x',
        GIT_AUTHOR_DATE: `${when} +0000`, GIT_COMMITTER_DATE: `${when} +0000` } });
      const put = (f, x) => { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), x); };
      git(['init', '-q', '-b', 'main'], now);
      put('scripts/redline/review.mjs', 'v1\n'); git(['add', '-A'], now - 86400); git(['commit', '-qm', 'base'], now - 86400);
      git(['checkout', '-qb', 'topic'], now);
      put('scripts/redline/review.mjs', 'v2\n'); git(['commit', '-qam', 'runtime change, hours old'], now - 5 * 3600);
      git(['checkout', '-q', 'main'], now);
      put('README.md', 'x\n'); git(['add', '-A'], now - 3600); git(['commit', '-qm', 'docs on main'], now - 3600);
      git(['merge', '-q', '--no-ff', '-m', 'merge topic', 'topic'], now - 60);
      const merge = git(['rev-parse', 'HEAD'], now).stdout.trim();
      const out = join(d, 'out');
      writeFileSync(out, '');
      const r = spawnSync('bash', ['-c', script.join('\n')], { cwd: d, encoding: 'utf8',
        env: { ...process.env, EVENT: 'schedule', PIN_PATHS: pinPaths, QUIET_MINUTES: '60', GITHUB_OUTPUT: out } });
      const got = readFileSync(out, 'utf8');
      check('a branch merged a minute ago is picked as the merge and waits for the quiet window',
        r.status === 0 && got.includes('ok=false') && r.stdout.includes(`newest change a caller runs: ${merge.slice(0, 7)}`));
      rmSync(d, { recursive: true, force: true });
    }
  }
  {
    // The bump step itself, run twice against a fake gh: an hourly run that finds its bump PR
    // already proposing the picked commit changes nothing; one that finds an older proposal resets it.
    const lines = bump.split('\n');
    const at = lines.findIndex((l) => l.includes('- name: Open or update a bump PR in each caller'));
    const runAt = lines.findIndex((l, i) => i > at && l.trim() === 'run: |');
    const script = [];
    for (const l of lines.slice(runAt + 1)) { if (l.trim() && !l.startsWith('          ')) break; script.push(l.slice(10)); }
    const bashOk = spawnSync('bash', ['-c', 'true']).status === 0;
    if (!bashOk || process.platform === 'win32') {
      console.log('  skip the bump step run: no POSIX bash here');
    } else {
      const NEWSHA = 'b'.repeat(40), OLDSHA = 'a'.repeat(40);
      const caller = (sha) => `jobs:\n  review:\n    uses: askalf/ci/.github/workflows/redline-review.yml@${sha} # main\n    with:\n      redline-ref: ${sha}\n`;
      const run = (branchSha) => {
        const d = mkdtempSync(join(tmpdir(), 'bump-'));
        const b64 = (x) => Buffer.from(x).toString('base64');
        writeFileSync(join(d, 'gh'), `#!/usr/bin/env bash
echo "$*" >> "${d}/calls"
case "$*" in
  *"commits/${NEWSHA}/pulls"*) ;;
  "api repos/askalf/x --jq .default_branch") echo main ;;
  *"git/ref/heads/main"*) echo tip0000 ;;
  *"git/ref/heads/bot/redline-pin"*) echo exists ;;
  *"contents/.github/workflows/redline.yml?ref=tip0000"*) echo "${b64(caller(OLDSHA))}" ;;
  *"contents/.github/workflows/redline.yml?ref=bot/redline-pin --jq .sha"*) echo blob1 ;;
  *"contents/.github/workflows/redline.yml?ref=bot/redline-pin"*) echo "${b64(caller(branchSha))}" ;;
  *"pr list"*) echo 7 ;;
esac
`);
        chmodSync(join(d, 'gh'), 0o755);
        // The step runs pin.mjs from the checkout and writes caller.yml in its working directory.
        mkdirSync(join(d, 'work', 'scripts', 'redline'), { recursive: true });
        writeFileSync(join(d, 'work', 'scripts', 'redline', 'pin.mjs'), readFileSync(fileURLToPath(new URL('./pin.mjs', import.meta.url))));
        const r = spawnSync('bash', ['-c', script.join('\n')], { encoding: 'utf8', cwd: join(d, 'work'),
          env: { ...process.env, PATH: `${d}:${process.env.PATH}`, GH_TOKEN: 't', SHA: NEWSHA, SOURCE: 'askalf/ci', CALLERS: 'askalf/x',
            BRANCH: 'bot/redline-pin', CALLER_PATHS: '.github/workflows/redline.yml' } });
        const calls = existsSync(join(d, 'calls')) ? readFileSync(join(d, 'calls'), 'utf8') : '';
        rmSync(d, { recursive: true, force: true });
        return { out: r.stdout + r.stderr, calls, status: r.status };
      };
      const same = run(NEWSHA);
      check('an hourly run whose open bump PR already proposes the commit resets nothing and writes nothing',
        same.status === 0 && /#7 already proposes bbbbbbb/.test(same.out) && !/-X PATCH|-X POST|-X PUT|pr edit|pr create/.test(same.calls), same.out + same.calls);
      const stale = run(OLDSHA);
      check('one whose open bump PR proposes an older commit resets the branch and writes the new pin',
        /-X PATCH repos\/askalf\/x\/git\/refs\/heads\/bot\/redline-pin/.test(stale.calls) && /-X PUT repos\/askalf\/x\/contents\/\.github\/workflows\/redline\.yml/.test(stale.calls), stale.out + stale.calls);
    }
  }
  {
    // The skip comes before the branch is reset, and needs both the pin and redline-ref at the sha.
    const skipAt = bump.indexOf('already proposes ${short}');
    const resetAt = bump.indexOf('-X PATCH "repos/${repo}/git/refs/heads/${BRANCH}"');
    check('an open bump PR that already carries the picked commit is left alone, before any reset',
      skipAt > 0 && resetAt > skipAt
        && /grep -Eq "redline-\(review\|fix-run\)\.yml@\$\{SHA\}" \|\| ! printf '%s\\n' "\$current" \| grep -q "redline-ref: \$\{SHA\}"/.test(bump)
        && bump.includes('contents/${path}?ref=${BRANCH}'));
  }
  const selfTest = readFileSync(fileURLToPath(new URL('../../.github/workflows/redline-self-test.yml', import.meta.url)), 'utf8');
  // `test` is a required check, so it must report on every PR: no paths filter, which would leave a
  // PR outside the paths with a check that never runs.
  const runAccountJob = selfTest.slice(selfTest.indexOf('\n  run-account:'));
  check('test uses a run account where it can lend or make one, and skips the real tests only with a notice',
    /sudo -n -u redline-run -- true[^\n]*\n\s+echo "REDLINE_TEST_RUN_AS=redline-run" >> "\$GITHUB_ENV"/.test(selfTest)
      && /elif sudo -n true[^\n]*\n\s+sudo useradd [^\n]* redline-run\n/.test(selfTest) && /::notice::no run account/.test(selfTest));
  check('the run-account job runs the real run-account tests on GitHub\'s runners, whichever runner test used',
    runAccountJob.startsWith('\n  run-account:\n    runs-on: ubuntu-latest\n') && /sudo useradd [^\n]* redline-run\n/.test(runAccountJob)
      && /- run: node scripts\/redline\/fix\.test\.mjs\n\s+env:\n\s+REDLINE_TEST_RUN_AS: redline-run\n/.test(runAccountJob));
  check('the self-test runs these tests on every pull request', selfTest.includes('node scripts/redline/fix.test.mjs')
    && /^on:\n {2}pull_request:\n\n/m.test(selfTest.replace(/\r\n/g, '\n')) && !/^\s+paths(-ignore)?:/m.test(selfTest));
}

rmSync(root, { recursive: true, force: true });
rmSync(outside, { recursive: true, force: true });
console.log(`\n  ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
