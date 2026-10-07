// Unit and end-to-end tests for scripts/redline/review.mjs. Run: node scripts/redline/review.test.mjs
// The model and GitHub are stubbed through ctx.fetch; nothing leaves the machine.

import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseEnvFile, readPrompt, safePath, buildDiff, planDiff, unshownFiles, checkoutCorpus, quoteIsGrounded, corpusOf, checkSubmission, finalVerdict,
  renderBody, verdictAtHead, runTool, runReview, buildBrief, REVIEWER_LOGIN, LIMITS, metaPhrase,
  verdictRecord, verdictProblem, saveVerdict, VERDICT_VERSION,
} from './review.mjs';
import * as reviewModule from './review.mjs';
import { withRetry, OutOfTime, darioAccess, socketFetch, withDarioSocket, callModelWith } from './review.mjs';
import { createServer as createHttpServer } from 'node:http';
import { bumpCaller, REVIEW_WORKFLOW } from './pin.mjs';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}`); fail++; }
}
async function throws(fn) { try { await fn(); return null; } catch (e) { return e; } }

const HEAD = '47536435fb5c9540d8cb36fd26d81e101955b364';
const OTHER = '34b7875f46525f7899a4e6601fbca4be75443903';

console.log('\n  parseEnvFile');
{
  const e = parseEnvFile('# c\nA=1\n\nB="two words"\nC=\'x=y\'\n bad \nD = spaced \r\n');
  check('values, quotes and = inside a value', e.A === '1' && e.B === 'two words' && e.C === 'x=y' && e.D === 'spaced');
  check('comments and malformed lines are skipped', !('# c' in e) && !('bad' in e));
}

// The prompt is a file on the runner host, named by an environment variable; this repository is
// public and carries none, so the tests use the three-line stand-in under test-fixtures.
const PROMPT_FIXTURE = fileURLToPath(new URL('./test-fixtures/prompt.md', import.meta.url));
console.log('\n  readPrompt');
{
  const dir = mkdtempSync(join(tmpdir(), 'redline-prompt-'));
  const err = (env) => { try { readPrompt(env, 'REDLINE_PROMPT_FILE'); return ''; } catch (e) { return e.message; } };
  check('the file the variable names is the prompt, whole', readPrompt({ REDLINE_PROMPT_FILE: PROMPT_FIXTURE }, 'REDLINE_PROMPT_FILE') === readFileSync(PROMPT_FIXTURE, 'utf8'));
  check('an unset or empty variable is an error naming it', /^REDLINE_PROMPT_FILE is not set/.test(err({})) && /^REDLINE_PROMPT_FILE is not set/.test(err({ REDLINE_PROMPT_FILE: '' })));
  check('a file that cannot be read is an error naming the variable and the file', /^REDLINE_PROMPT_FILE: cannot read .*nope\.md/.test(err({ REDLINE_PROMPT_FILE: join(dir, 'nope.md') })));
  writeFileSync(join(dir, 'empty.md'), ' \n\n');
  check('an empty file is an error naming the variable', /^REDLINE_PROMPT_FILE: .*empty\.md is empty$/.test(err({ REDLINE_PROMPT_FILE: join(dir, 'empty.md') })));
  check('the stand-in is three lines, not a rubric', readFileSync(PROMPT_FIXTURE, 'utf8').split('\n').filter(Boolean).length === 3);
  const src = readFileSync(fileURLToPath(new URL('./review.mjs', import.meta.url)), 'utf8');
  check('review.mjs reads the prompt from REDLINE_PROMPT_FILE and bundles none', src.includes("readPrompt(env, 'REDLINE_PROMPT_FILE')") && !/new URL\(['"]\.\/[\w.-]*prompt/.test(src));
  rmSync(dir, { recursive: true, force: true });
}

const root = mkdtempSync(join(tmpdir(), 'redline-'));
const outside = mkdtempSync(join(tmpdir(), 'redline-out-'));
mkdirSync(join(root, 'src'));
writeFileSync(join(root, 'src', 'a.js'), Array.from({ length: 900 }, (_, i) => `line ${i + 1}`).join('\n'));
writeFileSync(join(root, 'src', 'b.js'), 'export const token = process.env.X;\nconst y = 2;\n');
writeFileSync(join(root, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
writeFileSync(join(outside, 'secret.txt'), 'top secret');
let symlinked = true;
try { symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt')); } catch { symlinked = false; }

console.log('\n  safePath');
check('a path inside resolves', safePath(root, 'src/a.js').endsWith('a.js'));
check('.. is refused', /outside/.test(runTool(root, 'redline_read', { path: '../x' })));
check('a leading slash is relative to the checkout, not the host', /no such file/.test(runTool(root, 'redline_read', { path: '/etc/passwd' })));
if (symlinked) check('a symlink out of the checkout is refused', /outside the checkout/.test(runTool(root, 'redline_read', { path: 'leak.txt' })));

console.log('\n  tools');
check('redline_list lists, directories with a slash', runTool(root, 'redline_list', {}).split('\n').includes('src/'));
{
  const r = runTool(root, 'redline_read', { path: 'src/a.js', start_line: 10, end_line: 12 });
  check('redline_read returns the numbered range', r.startsWith('10\tline 10\n11\tline 11\n12\tline 12\n') && r.includes('(file has 900 lines)'));
  const big = runTool(root, 'redline_read', { path: 'src/a.js' });
  check(`redline_read stops at ${LIMITS.readLines} lines`, big.includes(`${LIMITS.readLines}\tline ${LIMITS.readLines}\n`) && !big.includes(`${LIMITS.readLines + 1}\tline`));
}
check('redline_read refuses a binary file', /binary/.test(runTool(root, 'redline_read', { path: 'img.png' })));
check('redline_read on a directory says so', /directory/.test(runTool(root, 'redline_read', { path: 'src' })));
check('grep finds file:line: text', runTool(root, 'redline_search', { pattern: 'process\\.env' }) === 'src/b.js:1: export const token = process.env.X;');
check('grep skips binaries and reports no matches', runTool(root, 'redline_search', { pattern: 'PNG' }) === '(no matches)');
check('grep reports a bad pattern', /bad pattern/.test(runTool(root, 'redline_search', { pattern: '(' })));
check('grep caps its matches', runTool(root, 'redline_search', { pattern: 'line' }).endsWith('(match cap reached)'));
check('an unknown tool is an error, not a throw', /unknown tool/.test(runTool(root, 'exec', {})));
{
  // A pattern that backtracks without end, over a file the PR controls: the child is killed at
  // searchMs and the run goes on.
  const slow = mkdtempSync(join(tmpdir(), 'redline-redos-'));
  writeFileSync(join(slow, 'x.txt'), `${'a'.repeat(40)}b\n`);
  const saved = LIMITS.searchMs;
  LIMITS.searchMs = 1_500;
  const t0 = Date.now();
  const r = runTool(slow, 'redline_search', { pattern: '(a+)+$' });
  const took = Date.now() - t0;
  LIMITS.searchMs = saved;
  check('a search that runs away is stopped at the cap and says so', /was stopped/.test(r) && took < 10_000);
  check('a quick search in the same tree still answers', runTool(slow, 'redline_search', { pattern: '^a{3}' }) === `x.txt:1: ${'a'.repeat(40)}b`);
  rmSync(slow, { recursive: true, force: true });
}

console.log('\n  retries inside a deadline');
{
  let t = 0;
  const ctx = { now: () => t, sleep: async (ms) => { t += ms; } };
  const seen = [];
  // Every attempt times out after the whole of the time it was given.
  const e = await throws(() => withRetry(ctx, 'model', async (left) => { seen.push(left); t += Math.min(left, 240_000); throw new Error('timed out'); }, 300_000));
  check('each attempt is given only the time left, and no retry starts or waits past the deadline',
    e instanceof OutOfTime && seen[0] === 300_000 && seen.every((l, i) => i === 0 || l < seen[i - 1]) && t <= 300_000);
  t = 0;
  const late = await throws(() => withRetry(ctx, 'model', async () => ({ ok: true }), -1));
  check('a call after the deadline is not made', late instanceof OutOfTime && /time budget is spent/.test(late.message));
  t = 0;
  let calls = 0;
  const ok = await withRetry(ctx, 'model', async () => (++calls < 2 ? { ok: false, status: 503, text: async () => '' } : { ok: true }));
  check('with no deadline the retries are as before', ok.ok && calls === 2 && t === 5_000);
}

console.log('\n  dario: a key or a key socket');
{
  const key = darioAccess({ DARIO_API_KEY: 'dk_x' });
  check('a key alone: sent as before, at the default URL', key.darioKey === 'dk_x' && key.darioSocket === '' && key.darioUrl === 'http://127.0.0.1:3456' && !key.error && !key.warning);
  const sock = darioAccess({ DARIO_SOCKET: '/run/model/key.sock' });
  check('a key socket alone: no key needed, none sent', sock.darioKey === '' && sock.darioSocket === '/run/model/key.sock' && !sock.error && !sock.warning);
  const both = darioAccess({ DARIO_SOCKET: '/run/model/key.sock', DARIO_API_KEY: 'dk_x' });
  check('both: the socket wins, the key is not used, and a warning says to remove it', both.darioKey === '' && /remove it/.test(both.warning));
  check('a relative socket path is an error', /absolute/.test(darioAccess({ DARIO_SOCKET: 'run/fix.sock' }).error ?? ''));
  check('neither is an error that names both', /DARIO_API_KEY is not set .*DARIO_SOCKET/.test(darioAccess({}).error ?? ''));
}
if (process.platform !== 'win32') {
  const dir = mkdtempSync(join(tmpdir(), 'redline-sock-'));
  const sock = join(dir, 'dario.sock');
  const seen = [];
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === '/hang') return;
      res.writeHead(req.url === '/gone' ? 204 : req.url === '/reset' ? 205 : 200, { 'content-type': 'application/json', 'x-dario-upstream-rejection': 'none' });
      res.end(['/gone', '/reset'].includes(req.url) ? undefined : JSON.stringify({ content: [{ type: 'text', text: 'PONG' }] }));
    });
  });
  await new Promise((r) => server.listen(sock, r));
  const f = socketFetch(sock);
  const r = await f('http://127.0.0.1:3456/v1/messages?x=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":"é"}' });
  check('socketFetch: method, path, query and body arrive over the socket', seen[0]?.method === 'POST' && seen[0].url === '/v1/messages?x=1' && seen[0].body === '{"a":"é"}' && seen[0].headers['content-length'] === String(Buffer.byteLength('{"a":"é"}')));
  check('socketFetch: a Response with status, headers and body', r.ok && r.status === 200 && r.headers.get('x-dario-upstream-rejection') === 'none' && (await r.json()).content[0].text === 'PONG');
  const empty = await f('http://127.0.0.1:3456/gone');
  check('socketFetch: a 204 has no body', empty.status === 204 && (await empty.text()) === '');
  const reset = await throws(async () => { const r205 = await f('http://127.0.0.1:3456/reset'); if (r205.status !== 205 || (await r205.text()) !== '') throw new Error(`got ${r205.status}`); });
  check('socketFetch: a 205 resolves with no body instead of throwing in a listener', reset === null);
  const hung = await throws(() => f('http://127.0.0.1:3456/hang', { signal: AbortSignal.timeout(100) }));
  check('socketFetch: a timeout aborts the request', hung?.name === 'TimeoutError');
  const elsewhere = [];
  const routed = withDarioSocket((url) => { elsewhere.push(String(url)); return Promise.resolve(new Response('{}')); }, 'http://127.0.0.1:3456', sock);
  seen.length = 0;
  await routed('https://api.github.com/repos/a/b');
  const res = await callModelWith({ darioUrl: 'http://127.0.0.1:3456', darioKey: '', model: 'm', fetch: routed, sleep: async () => {}, now: () => Date.now() }, { system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });
  check('withDarioSocket: dario goes over the socket, everything else through the given fetch', elsewhere.join() === 'https://api.github.com/repos/a/b' && seen.length === 1 && seen[0].url === '/v1/messages');
  check('callModelWith over a key socket sends no x-api-key, and gets the reply', !('x-api-key' in seen[0].headers) && JSON.parse(seen[0].body).model === 'm' && res.content[0].text === 'PONG');
  check('withDarioSocket without a socket is the given fetch', withDarioSocket(globalThis.fetch, 'http://127.0.0.1:3456', '') === globalThis.fetch);
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n  diff, brief and grounding');
{
  const files = [
    { filename: 'src/b.js', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n+export const token = process.env.X;\n const y = 2;' },
    { filename: 'img.png', status: 'added', additions: 0, deletions: 0 },
  ];
  const diff = buildDiff(files);
  check('a patch is included and a binary is named', diff.includes('+export const token') && diff.includes('diff --git a/img.png b/img.png\n(no patch'));
  check('the cap names what it left out', buildDiff(files, 60).includes('not shown, read them with redline_read: src/b.js'));
  check('planDiff returns the files the cap left out', planDiff(files, 60).omitted.join() === 'src/b.js,img.png' && planDiff(files).omitted.length === 0);
  const changed = [
    { filename: 'src/a.js', status: 'modified' },
    { filename: 'src/b.js', status: 'modified', patch: '+x' },
    { filename: 'gone.js', status: 'removed' },
  ];
  check('unshown files: no patch, or left out by the cap; never a removed file',
    unshownFiles(changed, []).join() === 'src/a.js' && unshownFiles(changed, ['src/b.js']).join() === 'src/a.js,src/b.js');
  const fromCheckout = checkoutCorpus(root, ['src/a.js', '../outside', 'img.png', 'missing.js']);
  check('a quote from a changed file the diff could not show is grounded by the checkout', quoteIsGrounded('line 899', fromCheckout) && quoteIsGrounded('line 899', corpusOf(buildDiff(changed))) === false);
  {
    // Under grepFileBytes, but more short lines than a call takes arguments.
    const many = mkdtempSync(join(tmpdir(), 'redline-many-'));
    writeFileSync(join(many, 'big.txt'), `${Array.from({ length: 300_000 }, (_, i) => `x${i % 10}`).join('\n')}\nthe unique last line\n`);
    check('a file of hundreds of thousands of short lines grounds a quote from its end', quoteIsGrounded('the unique last line', checkoutCorpus(many, ['big.txt'])));
    rmSync(many, { recursive: true, force: true });
  }
  check('the checkout corpus skips paths outside, binaries and missing files', !fromCheckout.some((l) => /PNG/.test(l)) && fromCheckout.length === 900);
  const pr = { number: 7, title: 'feat: add token', body: '- adds the token\n\nGenerated with a tool', user: { login: 'askalf' },
    head: { ref: 'feat/x', sha: HEAD }, base: { ref: 'main', repo: { full_name: 'askalf/r' } } };
  const brief = buildBrief(pr, files, [{ sha: HEAD, commit: { message: 'feat: add token\n\nCo-Authored-By: Someone' } }], diff);
  const corpus = corpusOf(brief);
  check('a quote copied with its + marker is grounded', quoteIsGrounded('+export const token = process.env.X;', corpus));
  check('a quote copied without the marker is grounded', quoteIsGrounded('export const token = process.env.X;', corpus));
  check('a markdown list line from the PR body is grounded', quoteIsGrounded('- adds the token', corpus));
  check('a commit message line is grounded', quoteIsGrounded('Co-Authored-By: Someone', corpus));
  check('an invented line is not', !quoteIsGrounded('eval(userInput);', corpus));
  check('a fragment too short to prove anything is not', !quoteIsGrounded('y = 2', corpus));
  check('every line of a multi-line quote must be there', !quoteIsGrounded('const y = 2;\nconst z = 3;', corpus));
}

console.log('\n  submission, verdict and body');
{
  check('verdict must be one of the two', /verdict/.test(checkSubmission({ verdict: 'COMMENT', summary: 's', findings: [] }).error));
  check('summary is required', /summary/.test(checkSubmission({ verdict: 'APPROVE', summary: ' ', findings: [] }).error));
  check('a finding needs a quote', /quote/.test(checkSubmission({ verdict: 'REQUEST_CHANGES', summary: 's', findings: [{ severity: 'blocking', file: 'a', problem: 'p' }] }).error));
  check('an odd rule slug becomes none', checkSubmission({ verdict: 'REQUEST_CHANGES', summary: 's', findings: [], rule: 'Bad Rule!' }).review.rule === 'none');
  const blocking = { severity: 'blocking', file: 'src/b.js', line: 1, quote: 'export const token = process.env.X;', problem: 'Leaks X.', suggestion: 'const x = `a`;' };
  const approveButBlocking = checkSubmission({ verdict: 'APPROVE', summary: 'Looks fine.', findings: [blocking], rule: 'secret-exposure' }).review;
  check('a blocking finding forces REQUEST_CHANGES', finalVerdict(approveButBlocking) === 'REQUEST_CHANGES');
  check('minor findings do not', finalVerdict(checkSubmission({ verdict: 'APPROVE', summary: 's', findings: [{ ...blocking, severity: 'minor' }] }).review) === 'APPROVE');
  const body = renderBody(approveButBlocking, 'REQUEST_CHANGES', HEAD, ['a note']);
  check('body opens with the verdict, no header', body.startsWith('**Verdict: request changes.**'));
  check('body never names the reviewer machinery', !/Automated review|gating lane|fleet code reviewer/i.test(body));
  check('body quotes the finding, names file:line and ends with the rule and head marker',
    body.includes('`src/b.js:1`') && body.includes('> export const token') && body.includes('rule:secret-exposure') && body.endsWith(`<!-- redline:head=${HEAD} -->`));
  const fenced = { ...blocking, suggestion: 'Run:\n```\nnpm test\n```' };
  const fencedBody = renderBody(checkSubmission({ verdict: 'REQUEST_CHANGES', summary: 's', findings: [fenced] }).review, 'REQUEST_CHANGES', HEAD);
  check('a suggestion containing a 3-backtick fence gets a 4-backtick fence', fencedBody.includes('````\nRun:\n```\nnpm test\n```\n````'));
  check('a suggestion with no backticks keeps a 3-backtick fence', renderBody(checkSubmission({ verdict: 'REQUEST_CHANGES', summary: 's', findings: [{ ...blocking, suggestion: 'const x = 1;' }] }).review, 'REQUEST_CHANGES', HEAD).includes('```\nconst x = 1;\n```\n'));
  check('an approval carries no rule line', !renderBody(checkSubmission({ verdict: 'APPROVE', summary: 's', findings: [] }).review, 'APPROVE', HEAD).includes('rule:'));
  check('the fixed text uses no em dash', !renderBody(approveButBlocking, 'REQUEST_CHANGES', HEAD, ['n']).replace(/Leaks X\.|Looks fine\./g, '').includes(String.fromCharCode(0x2014)));
}

// The review is public. 2026-09-26: truecopy#221's approval read "contains no secrets, private hosts,
// or AI attribution; the PR text reads as a human-written triage", under a "fleet code reviewer /
// gating lane" header. The guard bounces that prose before it is posted; the negatives keep it from
// biting words the reviewed repositories use legitimately.
console.log('\n  public voice: no machinery narration in the review');
{
  const meta = (summary) => checkSubmission({ verdict: 'APPROVE', summary, findings: [] }).error ?? '';
  check('AI attribution narration is bounced', /"AI attribution"/.test(meta('Contains no secrets or AI attribution.')));
  check('human-written narration is bounced', /"human-written"/.test(meta('The PR text reads as a human-written triage.')));
  check('reads-as-generated narration is bounced', /reads as generated/.test(meta('The README addition reads as generated.')));
  check('a lane or header mention is bounced', /"gating lane"/.test(meta('Reviewed by the gating lane.')));
  check('the bounce tells the model what to do instead', /call redline_submit again/.test(meta('AI-generated text in the README.')));
  const problemHit = checkSubmission({ verdict: 'REQUEST_CHANGES', summary: 'One issue.', findings: [{ severity: 'blocking', file: 'README.md', quote: 'x', problem: 'This paragraph reads as generated.' }] }).error ?? '';
  check('a finding problem is checked too', /finding 1 problem/.test(problemHit));
  check('a plain summary passes', !meta('Adds one acceptance entry; the hash is 64 hex and the JSON stays valid.'));
  check('provenance attribution in truecopy passes', !meta('The attribution check compares the manifest author to the tarball.'));
  check('the dario fleet key passes', !meta('The fleet key budget is read once per request.'));
  check('an LLM proxy passes', !meta('Requests to the LLM backend now retry once on 429.'));
  check('metaPhrase returns null on clean text', metaPhrase('Fixes the off-by-one in the pager.') === null);
}

console.log('\n  verdictAtHead');
{
  const r = (login, state, commit_id) => ({ user: { login }, state, commit_id, html_url: `u-${state}` });
  check('none', verdictAtHead([], HEAD) === null);
  check('comments, other logins and other heads do not count',
    verdictAtHead([r(REVIEWER_LOGIN, 'COMMENTED', HEAD), r('someone', 'APPROVED', HEAD), r(REVIEWER_LOGIN, 'APPROVED', OTHER)], HEAD) === null);
  check('the last verdict at the head wins', verdictAtHead([r(REVIEWER_LOGIN, 'CHANGES_REQUESTED', HEAD), r(REVIEWER_LOGIN, 'APPROVED', HEAD)], HEAD).state === 'APPROVED');
  check('a dismissed review is not a verdict', verdictAtHead([r(REVIEWER_LOGIN, 'DISMISSED', HEAD)], HEAD) === null);
}

// ---------- end to end against a fake GitHub and a fake model ----------


const PATCH = '@@ -1 +1,2 @@\n+export const token = process.env.X;\n const y = 2;';
function world({ reviews = [], heads = [HEAD], turns, modelStatus = [], draft = false, files = null } = {}) {
  const calls = { posted: [], model: [], sleeps: 0 };
  let headReads = 0;
  const json = (body, status = 200, headers = {}) => ({ ok: status < 300, status, headers: new Headers(headers), json: async () => body, text: async () => JSON.stringify(body) });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/v1/messages')) {
      const body = JSON.parse(init.body);
      calls.model.push(body);
      if (modelStatus.length) {
        // A status, or a function of the request body returning one (or [status, headers]).
        const next = modelStatus.shift();
        const [s, h] = [].concat(typeof next === 'function' ? next(body) : next);
        if (s !== 200) return json({ error: 'busy' }, s, h);
      }
      const step = turns[Math.min(calls.model.length - 1, turns.length - 1)];
      return json({ content: typeof step === 'function' ? step(body) : step });
    }
    const p = u.pathname;
    if (init.method === 'POST' && p.endsWith('/reviews')) { const b = JSON.parse(init.body); calls.posted.push({ ...b, auth: init.headers.authorization }); return json({ html_url: 'https://x/review/1' }); }
    if (/\/pulls\/7$/.test(p)) { const sha = heads[Math.min(headReads++, heads.length - 1)]; return json({ number: 7, state: 'open', draft, title: 'feat: add token', body: 'Adds it.', user: { login: 'askalf' }, head: { sha, ref: 'feat/x', repo: { full_name: 'askalf/r' } }, base: { ref: 'main', repo: { full_name: 'askalf/r' } } }); }
    if (p.endsWith('/reviews')) return json(u.searchParams.get('page') === '1' ? reviews : []);
    if (p.endsWith('/files')) return json(u.searchParams.get('page') === '1' ? (files ?? [{ filename: 'src/b.js', status: 'modified', additions: 1, deletions: 0, patch: PATCH }]) : []);
    if (p.endsWith('/commits')) return json(u.searchParams.get('page') === '1' ? [{ sha: HEAD, commit: { message: 'feat: add token' } }] : []);
    return json({ message: `unexpected ${p}` }, 404);
  };
  let t = 0;
  const ctx = { repo: 'askalf/r', pr: 7, headSha: HEAD, checkout: root, readToken: 'read', reviewToken: 'review', darioUrl: 'http://dario/', darioKey: 'k',
    model: 'm', system: 'sys', fetch, sleep: async () => { calls.sleeps++; }, now: () => (t += 1000) };
  return { ctx, calls };
}
const use = (name, input, id = name) => [{ type: 'tool_use', id, name, input }];
const submit = (input) => use('redline_submit', input, `s${Math.random()}`);
const APPROVE = { verdict: 'APPROVE', summary: 'No blocking issues; read src/b.js.', findings: [] };
const GOOD = { severity: 'blocking', file: 'src/b.js', line: 1, quote: '+export const token = process.env.X;', problem: 'Exports a secret from the environment.' };

console.log('\n  runReview');
{
  const { ctx, calls } = world({ turns: [use('redline_read', { path: 'src/b.js' }), submit(APPROVE)] });
  const r = await runReview(ctx);
  check('approve: posted at the head with the reviewer token', r.outcome === 'posted' && r.verdict === 'APPROVE'
    && calls.posted.length === 1 && calls.posted[0].commit_id === HEAD && calls.posted[0].event === 'APPROVE' && calls.posted[0].auth === 'Bearer review');
  check('the tool result went back to the model', JSON.stringify(calls.model[1].messages.at(-1)).includes('export const token'));
  check('the model got the diff and the tools, and no forced choice early', calls.model[0].messages[0].content.includes('+export const token') && calls.model[0].tools.length === 4 && !calls.model[0].tool_choice);
}
{
  const { ctx, calls } = world({ reviews: [{ user: { login: REVIEWER_LOGIN }, state: 'CHANGES_REQUESTED', commit_id: HEAD, html_url: 'old' }], turns: [submit(APPROVE)] });
  const r = await runReview(ctx);
  check('a verdict already at the head is reused: no model call, no post', r.outcome === 'existing' && r.verdict === 'REQUEST_CHANGES' && calls.model.length === 0 && calls.posted.length === 0);
}
{
  const { ctx, calls } = world({ reviews: [{ user: { login: REVIEWER_LOGIN }, state: 'CHANGES_REQUESTED', commit_id: HEAD, html_url: 'old' }], turns: [submit(APPROVE)] });
  const r = await runReview({ ...ctx, reread: true });
  check('a re-read reviews the head again and posts at it', r.outcome === 'posted' && r.verdict === 'APPROVE' && calls.model.length === 1 && calls.posted.length === 1 && calls.posted[0].commit_id === HEAD);
}
{
  const { ctx, calls } = world({ draft: true, turns: [submit(APPROVE)] });
  const r = await runReview(ctx);
  check('a draft is skipped before the model is called', r.outcome === 'skipped' && /draft/.test(r.reason) && calls.model.length === 0);
}
{
  const { ctx, calls } = world({ heads: [OTHER], turns: [submit(APPROVE)] });
  const r = await runReview(ctx);
  check('a head that already moved is skipped', r.outcome === 'skipped' && calls.model.length === 0);
}
{
  const { ctx, calls } = world({ heads: [HEAD, OTHER], turns: [submit(APPROVE)] });
  const r = await runReview(ctx);
  check('a head that moves during the review gets no post', r.outcome === 'skipped' && calls.posted.length === 0);
}
{
  const bad = { ...GOOD, quote: 'eval(userInput); // never in the diff' };
  const { ctx, calls } = world({ turns: [submit({ verdict: 'REQUEST_CHANGES', summary: 'Two problems.', findings: [bad], rule: 'security' }), submit({ verdict: 'REQUEST_CHANGES', summary: 'One problem.', findings: [GOOD], rule: 'secret-exposure' })] });
  const r = await runReview(ctx);
  check('an ungrounded finding gets one repair round, then the grounded review posts',
    r.verdict === 'REQUEST_CHANGES' && calls.model.length === 2 && JSON.stringify(calls.model[1].messages.at(-1)).includes('not in the diff')
      && calls.posted[0].body.includes('rule:secret-exposure'));
}
{
  const bad = { ...GOOD, quote: 'eval(userInput); // never in the diff' };
  const { ctx, calls } = world({ turns: [submit({ verdict: 'REQUEST_CHANGES', summary: 'Problem.', findings: [bad] })] });
  const r = await runReview(ctx);
  check('still ungrounded after the repair: dropped, and the review fails closed with a note',
    r.verdict === 'REQUEST_CHANGES' && calls.posted[0].body.includes('could be grounded') && !calls.posted[0].body.includes('eval(userInput)'));
}
{
  const { ctx, calls } = world({ turns: [submit({ ...APPROVE, findings: [GOOD] })] });
  const r = await runReview(ctx);
  check('APPROVE with a blocking finding posts REQUEST_CHANGES', r.verdict === 'REQUEST_CHANGES' && calls.posted[0].event === 'REQUEST_CHANGES');
}
{
  const { ctx, calls } = world({ modelStatus: [429, 503], turns: [submit(APPROVE)] });
  const r = await runReview(ctx);
  check('429 and 5xx from the model are retried with backoff', r.verdict === 'APPROVE' && calls.sleeps === 2);
}
{
  const parked = (retryAfter) => [429, { 'x-dario-upstream-rejection': 'pool_parked', 'retry-after': String(retryAfter) }];
  {
    const { ctx, calls } = world({ modelStatus: [parked(351838)], turns: [submit(APPROVE)] });
    ctx.model = 'claude-fable-5-1'; ctx.fallbackModel = 'claude-opus-5-5';
    const lines = [];
    ctx.log = (l) => lines.push(l);
    const r = await runReview(ctx);
    check('a model parked past the retry budget is not retried: the turn goes again on the fallback',
      r.verdict === 'APPROVE' && calls.sleeps === 0 && calls.model.map((b) => b.model).join() === 'claude-fable-5-1,claude-opus-5-5');
    check('the switch is logged with the park', lines.some((l) => l.includes('claude-fable-5-1 is parked in dario for 351838s; the review continues on claude-opus-5-5')));
    check('the fallback sees the same first turn', calls.model[1].messages.length === 1 && calls.model[1].messages[0].content === calls.model[0].messages[0].content);
  }
  {
    const { ctx, calls } = world({ modelStatus: [200, 200, parked(351838)], turns: [use('redline_list', {}), use('redline_list', {}), submit(APPROVE)] });
    ctx.model = 'claude-fable-5-1'; ctx.fallbackModel = 'claude-opus-5-5';
    const r = await runReview(ctx);
    check('a park mid-review keeps the history and finishes on the fallback',
      r.verdict === 'APPROVE' && calls.model.map((b) => b.model).join() === 'claude-fable-5-1,claude-fable-5-1,claude-fable-5-1,claude-opus-5-5'
        && JSON.stringify(calls.model[3].messages) === JSON.stringify(calls.model[2].messages));
  }
  {
    const { ctx, calls } = world({ modelStatus: [parked(351838), parked(351838)], turns: [submit(APPROVE)] });
    ctx.model = 'claude-fable-5-1'; ctx.fallbackModel = 'claude-opus-5-5';
    const e = await throws(() => runReview(ctx));
    check('a parked fallback fails the run, with no third model', e instanceof reviewModule.ModelParked && /pool_parked/.test(e.message) && calls.model.length === 2 && calls.posted.length === 0);
  }
  {
    const { ctx, calls } = world({ modelStatus: [parked(351838)], turns: [submit(APPROVE)] });
    ctx.fallbackModel = '';
    const e = await throws(() => runReview(ctx));
    check('with no fallback a park fails the run at once', e instanceof reviewModule.ModelParked && calls.model.length === 1 && calls.sleeps === 0);
  }
  {
    const unroutable = [400, { 'x-dario-upstream-rejection': 'model_unroutable' }];
    {
      const { ctx, calls } = world({ modelStatus: [200, unroutable], turns: [use('redline_list', {}), submit(APPROVE)] });
      ctx.model = 'gpt-6-astra'; ctx.fallbackModel = 'claude-opus-5-5';
      const lines = [];
      ctx.log = (l) => lines.push(l);
      const r = await runReview(ctx);
      check('a model dario stops listing mid-review is not retried: the turn goes again on the fallback',
        r.verdict === 'APPROVE' && calls.sleeps === 0 && calls.model.map((b) => b.model).join() === 'gpt-6-astra,gpt-6-astra,claude-opus-5-5'
          && JSON.stringify(calls.model[2].messages) === JSON.stringify(calls.model[1].messages));
      check('the switch is logged with the reason', lines.some((l) => l.includes('no provider in dario lists gpt-6-astra; the review continues on claude-opus-5-5')));
    }
    {
      const { ctx, calls } = world({ modelStatus: [unroutable], turns: [submit(APPROVE)] });
      ctx.model = 'gpt-6-astra'; ctx.fallbackModel = '';
      const e = await throws(() => runReview(ctx));
      check('with no fallback an unroutable model fails the run at once', e instanceof reviewModule.ModelUnroutable && /model_unroutable/.test(e.message) && calls.model.length === 1 && calls.sleeps === 0);
    }
    {
      const { ctx, calls } = world({ modelStatus: [400], turns: [submit(APPROVE)] });
      ctx.fallbackModel = 'claude-opus-5-5';
      const e = await throws(() => runReview(ctx));
      check('a plain 400 is not a fallback: it fails the run on the same model', !(e instanceof reviewModule.ModelUnroutable) && /HTTP 400/.test(e.message) && calls.model.length === 1);
    }
  }
  {
    const { ctx, calls } = world({ modelStatus: [parked(10)], turns: [submit(APPROVE)] });
    ctx.fallbackModel = 'claude-opus-5-5';
    const r = await runReview(ctx);
    check('a park that ends within the retry budget is waited out on the same model',
      r.verdict === 'APPROVE' && calls.sleeps === 1 && calls.model.every((b) => b.model === 'm'));
  }
  {
    const { ctx, calls } = world({ modelStatus: [(b) => (b.tool_choice ? 200 : parked(351838))], turns: [(b) => (b.tool_choice || b.model !== 'claude-opus-4-6' ? submit(APPROVE) : use('redline_list', {}))] });
    ctx.model = 'claude-fable-5-1'; ctx.fallbackModel = 'claude-opus-4-6';
    const r = await runReview(ctx);
    check('the fallback\'s own tool_choice rules apply from the switch on',
      r.verdict === 'APPROVE' && calls.model[1].model === 'claude-opus-4-6' && calls.model.at(-1).tool_choice?.name === 'redline_submit');
  }
}
{
  const { ctx, calls } = world({ modelStatus: [400], turns: [submit(APPROVE)] });
  const e = await throws(() => runReview(ctx));
  check('a 400 from the model is not retried and fails the run', e && /HTTP 400/.test(e.message) && calls.sleeps === 0 && calls.posted.length === 0);
}
{
  const { ctx, calls } = world({ turns: [(b) => (b.tool_choice ? submit(APPROVE) : use('redline_list', {}))] });
  const r = await runReview(ctx);
  check(`the model is forced to submit at turn ${LIMITS.forceSubmitAt}`, r.verdict === 'APPROVE' && calls.model.length === LIMITS.forceSubmitAt && calls.model.at(-1).tool_choice.name === 'redline_submit');
  check('a forced turn keeps every tool in the request (history may name them)', calls.model.at(-1).tools.length === 4);
}
{
  const { ctx } = world({ turns: [use('redline_list', {})] });
  const lines = [];
  ctx.log = (l) => lines.push(l);
  const e = await throws(() => runReview(ctx));
  check('each turn is logged with its tools, and the forced turns are marked',
    lines[0] === 'turn 1: redline_list; stop=-' && lines.some((l) => l.startsWith(`turn ${LIMITS.forceSubmitAt} (forced): redline_list`)));
  check('a model that never submits fails the run', e && /no review submitted/.test(e.message));
}
{
  const { ctx, calls } = world({ turns: [(b) => (b.messages.length > 2 * LIMITS.forceSubmitAt + 1 ? submit(APPROVE) : use('redline_read', { path: 'src/b.js' }))] });
  const r = await runReview(ctx);
  const forcedResult = JSON.stringify(calls.model[LIMITS.forceSubmitAt].messages.at(-1));
  check('a read past the forced turn is refused, not run, and the model then submits',
    r.verdict === 'APPROVE' && forcedResult.includes('read budget is spent') && !forcedResult.includes('export const token'));
}
{
  const { ctx, calls } = world({ turns: [[{ type: 'text', text: 'thinking' }], submit(APPROVE)] });
  const r = await runReview(ctx);
  check('a text-only turn is nudged back to the tools', r.verdict === 'APPROVE' && calls.model[1].messages.at(-1).content.includes('redline_submit'));
  check('the nudge says the text was discarded', calls.model[1].messages.at(-1).content.startsWith('That text was discarded'));
}
{
  const { ctx, calls } = world({ turns: [[{ type: 'text', text: 'Here is my review in prose.' }]] });
  const e = await throws(() => runReview(ctx));
  check(`${LIMITS.textOnlyTurns} text-only answers in a row fail the run early, not at turn ${LIMITS.turns}`,
    e && /text-only answers in a row/.test(e.message) && calls.model.length === LIMITS.textOnlyTurns);
}
{
  const { ctx, calls } = world({ turns: [[{ type: 'text', text: 'a' }], use('redline_read', { path: 'src/b.js' }), [{ type: 'text', text: 'b' }], [{ type: 'text', text: 'c' }], submit(APPROVE)] });
  const r = await runReview(ctx);
  check('a tool call in between resets the text-only count', r.verdict === 'APPROVE' && calls.model.length === 5);
}
{
  const { ctx, calls } = world({ turns: [[{ type: 'text', text: 'Looks  fine\nto me.' }], submit(APPROVE)] });
  const lines = [];
  ctx.log = (l) => lines.push(l);
  const r = await runReview(ctx);
  check('a reply without a tool call is logged with its text, whitespace collapsed', r.verdict === 'APPROVE' && lines[0] === 'turn 1: no tool call; stop=- text="Looks fine to me."');
  check('a reply with a tool call logs no text', lines[1] === 'turn 2: redline_submit; stop=-' && calls.model.length === 2);
}
{
  // Empty replies (dario at its concurrency ceiling, 2026-09-25): not kept as history, and the same early end.
  const { ctx, calls } = world({ turns: [[]] });
  const e = await throws(() => runReview(ctx));
  check('empty replies end the run like text-only ones and never enter the history',
    e && /text-only answers in a row/.test(e.message) && calls.model.length === LIMITS.textOnlyTurns && calls.model.at(-1).messages.length === 1);
}
{
  const { ctx, calls } = world({ turns: [() => undefined] });
  const e = await throws(() => runReview(ctx));
  check('a reply with no content array fails the run at once', e && /no message content/.test(e.message) && calls.model.length === 1);
}

console.log('\n  models that reject a forced tool_choice');
{
  const rejects = reviewModule.rejectsForcedToolChoice;
  const has = typeof rejects === 'function';
  check('rejectsForcedToolChoice is exported', has);
  const yes = ['claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-opus-5-5-20261001', 'claude-fable-5-1[1m]', 'Claude-Fable-5-1', 'claude-fable-5-2', 'claude-fable-6', 'claude-mythos-6-1', 'claude-opus-6'];
  const no = ['claude-fable-5', 'claude-mythos-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5-20260101', 'gpt-5.6-terra', 'm', '', undefined];
  check('Fable 5.1, Mythos 5.1, Opus 5.5 and later ids of those families reject it', has && yes.every((id) => rejects(id) === true));
  check('Fable 5, Mythos 5, Opus 5, Opus 4.x, Sonnet, Haiku and unknown ids accept it', has && no.every((id) => rejects(id) === false));
}
const SUBMIT_TEXT = reviewModule.SUBMIT_REQUIRED ?? '\u0000no SUBMIT_REQUIRED export';
const carriesSubmit = (msg) => JSON.stringify(msg?.content ?? '').includes(JSON.stringify(SUBMIT_TEXT).slice(1, -1));
const forcedChoice = (b) => b.tool_choice?.type === 'tool' || b.tool_choice?.type === 'any';
{
  // claude-fable-5-1 at the force point: no forced tool_choice, the instruction in that turn's user content.
  const { ctx, calls } = world({ turns: [(b) => (carriesSubmit(b.messages.at(-1)) ? submit(APPROVE) : use('redline_list', {}))] });
  ctx.model = 'claude-fable-5-1';
  const lines = [];
  ctx.log = (l) => lines.push(l);
  const r = await runReview(ctx).catch((e) => ({ error: e.message }));
  const at = calls.model[LIMITS.forceSubmitAt - 1];
  check('claude-fable-5-1: no request carries a forced tool_choice', r.verdict === 'APPROVE' && calls.model.every((b) => !forcedChoice(b)));
  check(`claude-fable-5-1: turn ${LIMITS.forceSubmitAt} sends tool_choice auto, asks for redline_submit in its user content, and the model submits`,
    calls.model.length === LIMITS.forceSubmitAt && at?.tool_choice?.type === 'auto' && carriesSubmit(at?.messages.at(-1)) && /redline_submit/.test(SUBMIT_TEXT));
  check('claude-fable-5-1: no earlier turn carries the instruction', calls.model.slice(0, LIMITS.forceSubmitAt - 1).every((b) => !b.messages.some(carriesSubmit)));
  check('claude-fable-5-1: the turn is logged as submit required, not forced',
    lines.some((l) => l.startsWith(`turn ${LIMITS.forceSubmitAt} (submit required): redline_submit`)) && !lines.some((l) => l.includes('(forced)')));
}
{
  // Every request is the previous one plus new turns: nothing the model already answered is edited.
  const { ctx, calls } = world({ turns: [(b) => (b.messages.length > 2 * LIMITS.forceSubmitAt + 3 ? submit(APPROVE) : use('redline_read', { path: 'src/b.js' }))] });
  ctx.model = 'claude-fable-5-1';
  const r = await runReview(ctx).catch((e) => ({ error: e.message }));
  const forcedResult = JSON.stringify(calls.model[LIMITS.forceSubmitAt].messages.at(-1));
  const appendOnly = calls.model.every((b, i) => i === 0 || JSON.stringify(calls.model[i - 1].messages) === JSON.stringify(b.messages.slice(0, calls.model[i - 1].messages.length)));
  check('claude-fable-5-1: a read past the force point is refused, the instruction repeats with it, and the history only grows',
    r.verdict === 'APPROVE' && forcedResult.includes('read budget is spent') && !forcedResult.includes('export const token') && carriesSubmit(calls.model[LIMITS.forceSubmitAt].messages.at(-1)) && appendOnly);
}
{
  // A model that accepts a forced choice keeps it.
  const { ctx, calls } = world({ turns: [(b) => (b.tool_choice ? submit(APPROVE) : use('redline_list', {}))] });
  ctx.model = 'claude-opus-5';
  const r = await runReview(ctx).catch((e) => ({ error: e.message }));
  check('claude-opus-5 is still forced to submit, with no added instruction',
    r.verdict === 'APPROVE' && calls.model.length === LIMITS.forceSubmitAt && calls.model.at(-1).tool_choice?.name === 'redline_submit' && !calls.model.some((b) => b.messages.some(carriesSubmit)));
}
{
  // Non-forcing path, a text answer at the force point: nudged, still asked for the submit, then it submits.
  const { ctx, calls } = world({ turns: [(b) => {
    if (!carriesSubmit(b.messages.at(-1))) return use('redline_list', {});
    return b.messages.at(-2)?.role === 'assistant' && b.messages.at(-2).content[0]?.type === 'text' ? submit(APPROVE) : [{ type: 'text', text: 'Here is my review in prose.' }];
  }] });
  ctx.model = 'claude-fable-5-1';
  const r = await runReview(ctx).catch((e) => ({ error: e.message }));
  const after = calls.model.at(-1).messages.at(-1);
  check('claude-fable-5-1: a text-only answer at the force point is nudged, asked again, and ends in a submit',
    r.verdict === 'APPROVE' && calls.model.length === LIMITS.forceSubmitAt + 1 && typeof after.content === 'string'
      && after.content.startsWith('That text was discarded') && carriesSubmit(after) && calls.model.every((b) => !forcedChoice(b)));
}
{
  // Non-forcing path, text-only from the force point on: a clear failure, never a forced request.
  const { ctx, calls } = world({ turns: [(b) => (carriesSubmit(b.messages.at(-1)) ? [{ type: 'text', text: 'No.' }] : use('redline_list', {}))] });
  ctx.model = 'claude-fable-5-1';
  const e = await throws(() => runReview(ctx));
  check('claude-fable-5-1: text-only answers after the force point fail the run clearly',
    e && /text-only answers in a row/.test(e.message) && calls.model.length === LIMITS.forceSubmitAt - 1 + LIMITS.textOnlyTurns && calls.model.every((b) => !forcedChoice(b)));
}
{
  const { ctx, calls } = world({ turns: [submit({ verdict: 'MAYBE', summary: 's', findings: [] }), submit(APPROVE)] });
  const lines = [];
  ctx.log = (l) => lines.push(l);
  const r = await runReview(ctx);
  check('a rejected submission is logged with its reason', lines.some((l) => l.includes('submission rejected: verdict must be')));
  check('a malformed submission is returned as an error and retried', r.verdict === 'APPROVE' && JSON.stringify(calls.model[1].messages.at(-1)).includes('is_error'));
}

{
  const { ctx, calls } = world({ turns: [submit({ ...APPROVE, findings: [GOOD] })] });
  ctx.dryRun = true;
  const r = await runReview(ctx);
  check('a dry run returns the verdict and body and posts nothing', r.outcome === 'dry-run' && r.verdict === 'REQUEST_CHANGES' && r.body.includes('> +export const token') && calls.posted.length === 0);
}

console.log('\n  the verdict file');
{
  const { ctx, calls } = world({ turns: [submit(APPROVE)] });
  const r = await runReview(ctx);
  const v = r.record;
  check('with a reviewer token: posted, and the record says posted: true', r.outcome === 'posted' && calls.posted.length === 1 && v?.posted === true);
  check('the record is the posted review exactly', v.event === calls.posted[0].event && v.body === calls.posted[0].body && v.head_sha === calls.posted[0].commit_id);
  check('the record names the repo, PR and head', v.version === VERDICT_VERSION && v.repo === 'askalf/r' && v.pr === 7 && v.head_sha === HEAD);
  check('the record passes the schema', verdictProblem(v) === null && Array.isArray(v.comments) && v.comments.length === 0);
  check('the record has exactly the contract keys', Object.keys(v).sort().join() === 'body,comments,event,head_sha,posted,pr,repo,version');
}
{
  const { ctx, calls } = world({ turns: [submit(APPROVE)] });
  ctx.reviewToken = '';
  const r = await runReview(ctx);
  check('without a reviewer token: nothing is posted', r.outcome === 'unposted' && calls.posted.length === 0);
  check('without a reviewer token: the record says posted: false', r.record?.posted === false && r.record.event === 'APPROVE' && verdictProblem(r.record) === null);
  check('without a reviewer token: the verdict still decides the exit', r.verdict === 'APPROVE');
  check('the unposted body is the same review body', r.record.body.startsWith('**Verdict: approve.**') && r.record.body.includes(`<!-- redline:head=${HEAD} -->`));
}
{
  const { ctx, calls } = world({ turns: [submit({ ...APPROVE, findings: [GOOD] })] });
  ctx.reviewToken = '';
  const r = await runReview(ctx);
  check('without a reviewer token: request changes is recorded, not posted', r.verdict === 'REQUEST_CHANGES' && r.record.event === 'REQUEST_CHANGES'
    && r.record.posted === false && r.record.body.includes('> +export const token') && calls.posted.length === 0);
}
{
  const { ctx } = world({ heads: [HEAD, OTHER], turns: [submit(APPROVE)] });
  ctx.reviewToken = '';
  const r = await runReview(ctx);
  check('a head that moves during the review leaves no record', r.outcome === 'skipped' && r.record === undefined);
  const e = world({ reviews: [{ user: { login: REVIEWER_LOGIN }, state: 'APPROVED', commit_id: HEAD, html_url: 'old' }], turns: [submit(APPROVE)] });
  e.ctx.reviewToken = '';
  const x = await runReview(e.ctx);
  check('a verdict already at the head leaves no record', x.outcome === 'existing' && x.record === undefined);
  const d = world({ turns: [submit(APPROVE)] });
  d.ctx.dryRun = true;
  check('a dry run leaves no record', (await runReview(d.ctx)).record === undefined);
}
{
  const good = verdictRecord({ repo: 'askalf/r', pr: 7, headSha: HEAD, event: 'COMMENT', body: 'b', posted: false });
  check('COMMENT is a valid event', verdictProblem(good) === null);
  check('posted is coerced to a boolean', verdictRecord({ repo: 'a/b', pr: 1, headSha: HEAD, event: 'APPROVE', body: 'b' }).posted === false);
  const bad = (patch) => verdictProblem({ ...good, ...patch });
  check('schema: version must be 1', /version/.test(bad({ version: 2 })) && /version/.test(bad({ version: '1' })));
  check('schema: repo must be owner/name', /repo/.test(bad({ repo: 'askalf' })) && /repo/.test(bad({ repo: 'a/b/c' })) && /repo/.test(bad({ repo: 7 })));
  check('schema: pr must be a positive integer', /pr/.test(bad({ pr: '7' })) && /pr/.test(bad({ pr: 0 })) && /pr/.test(bad({ pr: 1.5 })));
  check('schema: head_sha must be a full lowercase sha', /head_sha/.test(bad({ head_sha: HEAD.slice(0, 7) })) && /head_sha/.test(bad({ head_sha: HEAD.toUpperCase() })));
  check('schema: event must be a review event', /event/.test(bad({ event: 'APPROVED' })) && /event/.test(bad({ event: 'DISMISS' })));
  check('schema: body is required', /body/.test(bad({ body: ' ' })) && /body/.test(bad({ body: null })));
  check('schema: comments must be an array of path, line, side, body', /comments/.test(bad({ comments: {} }))
    && /comment 1/.test(bad({ comments: [{ path: 'a', line: 1, side: 'UP', body: 'x' }] }))
    && /comment 1/.test(bad({ comments: [{ path: 'a', side: 'RIGHT', body: 'x' }] }))
    && bad({ comments: [{ path: 'a', line: 1, side: 'RIGHT', body: 'x' }] }) === null);
  check('schema: posted must be a boolean', /posted/.test(bad({ posted: 'false' })) && /posted/.test(bad({ posted: undefined })));
  check('schema: not an object', /object/.test(verdictProblem(null)) && /object/.test(verdictProblem([good])));
  const dir = mkdtempSync(join(tmpdir(), 'redline-verdict-'));
  const file = join(dir, 'nested', 'verdict.json');
  saveVerdict(file, good);
  const back = JSON.parse(readFileSync(file, 'utf8'));
  check('saveVerdict creates the directory and the JSON reads back', JSON.stringify(back) === JSON.stringify(good) && readFileSync(file, 'utf8').endsWith('}\n'));
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n  CLI');
{
  const script = fileURLToPath(new URL('./review.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  check('missing configuration exits 2 with an annotation', r.status === 2 && r.stderr.includes('::error::REDLINE_ENV_FILE is not set'));
  const dir = mkdtempSync(join(tmpdir(), 'redline-cli-'));
  const envFile = join(dir, 'redline.env');
  const stale = join(dir, 'redline-verdict', 'verdict.json');
  writeFileSync(envFile, 'DARIO_URL=http://127.0.0.1:9\n');
  mkdirSync(join(dir, 'redline-verdict'));
  writeFileSync(stale, '{"stale":true}\n');
  const base = { PATH: process.env.PATH, REDLINE_ENV_FILE: envFile, REDLINE_VERDICT_FILE: stale, REPO: 'askalf/r', PR: '7', HEAD_SHA: HEAD, CHECKOUT: dir, GH_READ_TOKEN: 'read' };
  const run = (env) => spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  const noPrompt = run(base);
  check('no REDLINE_PROMPT_FILE: exit 2, the error names the variable, nothing else is tried', noPrompt.status === 2 && noPrompt.stderr.includes('::error::REDLINE_PROMPT_FILE is not set') && !/DARIO_API_KEY/.test(noPrompt.stderr));
  const gone = run({ ...base, REDLINE_PROMPT_FILE: join(dir, 'gone.md') });
  check('a prompt file that is not there: exit 2, the error names the variable and the file', gone.status === 2 && /::error::REDLINE_PROMPT_FILE: cannot read .*gone\.md/.test(gone.stderr));
  writeFileSync(join(dir, 'empty.md'), '\n');
  const empty = run({ ...base, REDLINE_PROMPT_FILE: join(dir, 'empty.md') });
  check('an empty prompt file: exit 2, the error names the variable', empty.status === 2 && /::error::REDLINE_PROMPT_FILE: .*empty\.md is empty/.test(empty.stderr));
  const s = run({ ...base, REDLINE_PROMPT_FILE: PROMPT_FIXTURE });
  check('with the prompt file, a reviewer token is optional: the next missing key is the model key', s.status === 2 && s.stderr.includes('::error::DARIO_API_KEY is not set (or set DARIO_SOCKET') && !/GITHUB_PAT_REVIEWER|REDLINE_GITHUB_TOKEN|REDLINE_PROMPT_FILE/.test(s.stderr));
  let staleLeft = true;
  try { readFileSync(stale); } catch { staleLeft = false; }
  check('a verdict file left by an earlier run is removed before the review starts', !staleLeft);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n  the reusable workflow');
{
  const wf = readFileSync(fileURLToPath(new URL('../../.github/workflows/redline-review.yml', import.meta.url)), 'utf8');
  check('it is a reusable workflow', /^on:\s*\n\s+workflow_call:/m.test(wf));
  check('redline-ref is a required string input', /\n      redline-ref:\n(?:        .*\n)*?        required: true\n        type: string\n/.test(wf));
  const steps = wf.split(/\n      - /).slice(1);
  const stepNamed = (name) => steps.findIndex((s) => s.startsWith(`name: ${name}\n`));
  const fetchAt = stepNamed('Fetch the review script from askalf/ci');
  check('the script is fetched at redline-ref, not job_workflow_sha or a branch',
    fetchAt >= 0 && steps[fetchAt].includes('ref: ${{ inputs.redline-ref }}') && !/ref: \$\{\{ github\.job_workflow_sha/.test(wf) && !/ref: main\b/.test(wf));
  check('the script comes from askalf/ci, and nothing names the old home', steps[fetchAt].includes('repository: askalf/ci\n') && !wf.includes('askalf/askalf'));
  const guardAt = stepNamed('Check the review ref is a full commit sha');
  check('the sha guard is the first step', guardAt === 0);
  const mainAt = stepNamed('Check the review ref is on askalf/ci main');
  check('the on-main check runs before the fetch', mainAt > guardAt && mainAt < fetchAt);
  check('the on-main check compares against askalf/ci', (steps[mainAt] ?? '').includes('repos/askalf/ci/compare/'));
  check('the ref reaches the guards through env, not interpolated into run',
    steps.every((s) => !s.includes('run:') || !s.slice(s.indexOf('run:')).includes('${{ inputs.redline-ref')));
  // The guard's own shell, run against good and bad refs.
  const guardRun = /run: \|\n((?: {10}.*\n?)+)/.exec(steps[guardAt] ?? '')?.[1].replace(/^ {10}/gm, '') ?? 'exit 0';
  const bash = spawnSync('bash', ['-c', 'exit 0'], { encoding: 'utf8' });
  if (bash.error) {
    console.log('  skip the guard\'s shell: no bash here');
  } else {
    const guard = (ref) => spawnSync('bash', ['-e', '-c', guardRun], { env: { ...process.env, REDLINE_REF: ref }, encoding: 'utf8' }).status;
    check('the guard passes a full sha', guard(HEAD) === 0);
    check('the guard fails an empty ref', guard('') !== 0);
    check('the guard fails a branch name', guard('main') !== 0);
    check('the guard fails a short sha', guard(HEAD.slice(0, 7)) !== 0);
    check('the guard fails an uppercase or padded sha', guard(HEAD.toUpperCase()) !== 0 && guard(`${HEAD}\nmain`) !== 0 && guard(` ${HEAD}`) !== 0);
  }
  check('it runs on the caller\'s self-hosted runner label', /runs-on: \[self-hosted, "\$\{\{ inputs\.runner-label \}\}"\]/.test(wf));
  check('it refuses fork PRs itself', wf.includes('github.event.pull_request.head.repo.full_name == github.repository'));
  check('the PR checkout keeps no credentials', (wf.match(/persist-credentials: false/g) ?? []).length === 2);
  const permBlock = /\npermissions:\n((?: {2}.*\n)+)/.exec(wf)?.[1] ?? '';
  check('the job token is read-only', permBlock === '  contents: read\n  pull-requests: read\n' && (wf.match(/^\s*permissions:/gm) ?? []).length === 1);
  check('third-party actions are pinned by sha', [...wf.matchAll(/uses: ([^\s]+)/g)].every((m) => /@[0-9a-f]{40}$/.test(m[1])));
  const reviewAt = stepNamed('Review');
  const uploadAt = stepNamed('Upload the verdict');
  const cleanAt = stepNamed('Remove the checkouts');
  const upload = steps[uploadAt] ?? '';
  check('the review step names the verdict file in the workspace', (steps[reviewAt] ?? '').includes('REDLINE_VERDICT_FILE: ${{ github.workspace }}/redline-verdict/verdict.json'));
  check('the review step names the host prompt file, and no prompt is fetched with the script',
    (steps[reviewAt] ?? '').includes('REDLINE_PROMPT_FILE: /etc/askalf/redline-prompt.md') && !/prompt/.test(steps[fetchAt]));
  check('the verdict is uploaded after the review, before the cleanup', reviewAt >= 0 && uploadAt === reviewAt + 1 && cleanAt === uploadAt + 1);
  check('the upload runs on pass or fail, only when there is a file', upload.includes("if: always() && hashFiles('redline-verdict/verdict.json') != ''"));
  check('the upload is the pinned upload-artifact, as redline-verdict, short-lived',
    /uses: actions\/upload-artifact@[0-9a-f]{40} # v4\./.test(upload) && upload.includes('name: redline-verdict\n')
    && upload.includes('path: redline-verdict/verdict.json\n') && /retention-days: [1-7]\n/.test(upload));
  check('the cleanup removes the verdict too', /run: rm -rf pr \.redline redline-verdict\s*$/.test(steps[cleanAt] ?? ''));
  check('nothing from the PR is interpolated into a run step',!/run:[^\n]*\$\{\{\s*github\.event\.pull_request\.(title|body|head\.ref)/.test(wf));

  // Dispatch mode: forge dispatches the caller on the default branch with pr, head and reread.
  check('pr and head are optional string inputs, reread an optional boolean',
    /\n      pr:\n(?:        .*\n)*?        required: false\n        default: ''\n        type: string\n/.test(wf)
    && /\n      head:\n(?:        .*\n)*?        required: false\n        default: ''\n        type: string\n/.test(wf)
    && /\n      reread:\n(?:        .*\n)*?        required: false\n        default: false\n        type: boolean\n/.test(wf));
  check('the job runs for a dispatch or a same-repo non-draft PR',
    wf.includes("if: inputs.pr != '' || (github.event.pull_request.head.repo.full_name == github.repository && !github.event.pull_request.draft)"));
  const dispatchAt = stepNamed('Check the dispatched PR');
  const checkoutAt = stepNamed('Check out the PR head to read');
  const ds = steps[dispatchAt] ?? '';
  check('the dispatch check runs only in dispatch mode, after the ref checks and before anything is fetched',
    ds.startsWith("name: Check the dispatched PR\n        if: inputs.pr != ''\n") && dispatchAt > mainAt && dispatchAt < fetchAt && dispatchAt < checkoutAt);
  check('the inputs reach every run step through env, never interpolated into it',
    steps.every((s) => !s.includes('run:') || !/\$\{\{\s*inputs\.(pr|head|reread)/.test(s.slice(s.indexOf('run:')))));
  check('the dispatch check reads the PR and refuses closed, draft, fork and moved heads',
    ds.includes('/repos/${REPO}/pulls/${PR}') && ds.includes('pr.state !== "open"') && ds.includes('if (pr.draft)')
    && ds.includes('pr.head?.repo?.full_name !== REPO') && ds.includes('pr.head?.sha !== HEAD_SHA'));
  const dsScript = /node --input-type=module -e '\n([\s\S]*?)\n\s*'\s*$/.exec(ds)?.[1] ?? '';
  const dsRun = (env) => spawnSync(process.execPath, ['--input-type=module', '-e', dsScript], {
    env: { PATH: process.env.PATH, GH_READ_TOKEN: 'x', REPO: 'askalf/r', DEFAULT_BRANCH: 'main', REF: 'refs/heads/main', EVENT_NAME: 'workflow_dispatch', PR: '7', HEAD_SHA: HEAD, ...env },
    encoding: 'utf8', timeout: 20_000,
  });
  const refused = (env, why) => { const r = dsRun(env); return r.status === 1 && why.test(r.stdout); };
  check('the dispatch check script was found', dsScript.includes('workflow_dispatch'));
  check('a pr input on pull_request is refused before any read', refused({ EVENT_NAME: 'pull_request' }, /only on workflow_dispatch/));
  check('a dispatch off the default branch is refused before any read', refused({ REF: 'refs/heads/feat/x' }, /default branch/) && refused({ DEFAULT_BRANCH: '' }, /default branch/));
  check('a pr that is not a number is refused before any read', refused({ PR: '7; rm -rf /' }, /pull request number/) && refused({ PR: '0' }, /pull request number/));
  check('a head that is not a full sha is refused before any read', refused({ HEAD_SHA: 'main' }, /full 40-character/) && refused({ HEAD_SHA: HEAD.slice(0, 7) }, /full 40-character/));
  check('the PR checkout takes the dispatched head, else the event head', (steps[checkoutAt] ?? '').includes('ref: ${{ inputs.head || github.event.pull_request.head.sha }}'));
  const rs = steps[reviewAt] ?? '';
  check('the review takes the dispatched PR and head, else the event\'s',
    rs.includes('PR: ${{ inputs.pr || github.event.pull_request.number }}') && rs.includes('HEAD_SHA: ${{ inputs.head || github.event.pull_request.head.sha }}'));
  check('a re-read is set only in dispatch mode', rs.includes("REDLINE_REREAD: ${{ inputs.pr != '' && inputs.reread && '1' || '0' }}"));
}

console.log('\n  pin bump');
{
  const NEW = 'c0ffee0000000000000000000000000000000001';
  const OLD = '116935d3803fc5904d96efb56991b93539c1714c';
  const job = (body) => `name: Redline\n\non:\n  pull_request:\n\njobs:\n  review:\n    if: github.event.pull_request.draft == false\n${body}`;
  const NOTE = 'main 2026-09-27, askalf/ci#72';
  const uses = (sha) => `    uses: ${REVIEW_WORKFLOW}@${sha}  # main 2026-09-25, askalf/ci#64\n`;
  const pinnedTo = (y) => y.includes(`uses: ${REVIEW_WORKFLOW}@${NEW} # ${NOTE}\n`);
  const refs = (y) => [...y.matchAll(/redline-ref: (\S+)/g)].map((m) => m[1]);
  check('the workflows pinned are this repository\'s', REVIEW_WORKFLOW === 'askalf/ci/.github/workflows/redline-review.yml');

  const oldShape = job(`${uses(OLD)}    with:\n      runner-label: redline\n`);
  const a = bumpCaller(oldShape, NEW, NOTE);
  check('old shape: the pin moves', pinnedTo(a) && !a.includes(OLD));
  check('old shape: redline-ref is added under with, at the same sha', a.includes(`    with:\n      redline-ref: ${NEW}\n      runner-label: redline\n`));

  const newShape = job(`${uses(OLD)}    with:\n      runner-label: redline\n      redline-ref: ${OLD}\n`);
  const b = bumpCaller(newShape, NEW, NOTE);
  check('new shape: the pin and redline-ref both move, once each', pinnedTo(b) && refs(b).join() === NEW && !b.includes(OLD));
  check('new shape: the other input stays', b.includes('      runner-label: redline\n'));
  check('a second bump changes nothing', bumpCaller(b, NEW, NOTE) === b);

  const withFirst = job(`    with:\n      runner-label: redline\n${uses(OLD)}`);
  const c = bumpCaller(withFirst, NEW, NOTE);
  check('with above uses: redline-ref still lands in it', c.includes(`    with:\n      redline-ref: ${NEW}\n      runner-label: redline\n`) && pinnedTo(c));

  const noWith = job(uses(OLD));
  const d = bumpCaller(noWith, NEW, NOTE);
  check('no with block: one is added with redline-ref', d.includes(`@${NEW} # ${NOTE}\n    with:\n      redline-ref: ${NEW}\n`));

  const nextJob = job(`${uses(OLD)}    with:\n      runner-label: redline\n\n  other:\n    runs-on: x\n    with:\n      redline-ref: keep\n`);
  const e = bumpCaller(nextJob, NEW, 'n');
  check('another job\'s inputs are left alone', refs(e).join() === `${NEW},keep`);

  check('a short or branch ref is refused', (() => { try { bumpCaller(oldShape, 'main'); return false; } catch { return true; } })()
    && (() => { try { bumpCaller(oldShape, NEW.slice(0, 7)); return false; } catch { return true; } })());
  check('a caller without the call is refused', (() => { try { bumpCaller('name: x\n', NEW); return false; } catch { return true; } })());

  const own = readFileSync(fileURLToPath(new URL('../../.github/workflows/redline.yml', import.meta.url)), 'utf8');
  const f = bumpCaller(own, NEW, 'n');
  check('this repo\'s own caller bumps cleanly', refs(f).join() === NEW && f.includes(`@${NEW} # n\n`) && f.split('\n').length === own.split('\n').length + (refs(own).length ? 0 : 1));

  const bump = readFileSync(fileURLToPath(new URL('../../.github/workflows/redline-pin-bump.yml', import.meta.url)), 'utf8');
  check('the bump workflow rewrites callers with pin.mjs', bump.includes('node scripts/redline/pin.mjs "$SHA" "$note"') && !/sed -E/.test(bump));
  const callers = (/\n      CALLERS: >-\n((?: {8}\S.*\n)+)/.exec(bump)?.[1] ?? '').split(/\s+/).filter(Boolean);
  const expected = ['askalf/ci', 'askalf/askalf', 'askalf/dario', 'askalf/amnesia', 'askalf/browser-bridge', 'askalf/redstamp',
    'askalf/truecopy', 'askalf/truecopy-action', 'askalf/cordon', 'askalf/plumbline', 'askalf/checkout-with-retry'];
  check('the bump job knows the eleven callers, this repository first', callers.join() === expected.join());
  check('this repo\'s caller pins askalf/ci and the same sha as redline-ref',
    /uses: askalf\/ci\/\.github\/workflows\/redline-review\.yml@([0-9a-f]{40})/.exec(own)?.[1] === refs(own)[0] && !own.includes('askalf/askalf/') && own.includes('runner-label: redline\n'));

  // Forge dispatches the caller on the default branch and
  // finds its run by this exact title, so the title and the inputs are a contract with forge.
  check('this repo\'s caller takes forge\'s dispatch: pr, head, reread',
    /\n  workflow_dispatch:\n    inputs:\n      pr:\n(?:        .*\n)*?        type: string\n      head:\n(?:        .*\n)*?        type: string\n      reread:\n(?:        .*\n)*?        default: false\n        type: boolean\n/.test(own));
  check('the dispatch title is the one forge parses',
    own.includes("run-name: ${{ github.event_name == 'workflow_dispatch' && format('Redline review {0}#{1} @ {2}{3}', github.repository, inputs.pr, inputs.head, inputs.reread && ' (re-read)' || '') || github.event.pull_request.title }}\n"));
  // A concurrency group holds one pending run and a newer one cancels it, so each dispatch (head and
  // mode) gets a group of its own; a push still cancels the older pull_request run.
  check('a dispatch has a group per head and mode and is never cancelled; a push cancels the older pull_request run',
    own.includes("  group: redline-${{ github.event_name }}-${{ github.event.pull_request.number || inputs.pr }}${{ inputs.head && format('-{0}-{1}', inputs.head, inputs.reread) || '' }}\n")
    && own.includes("  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n"));
  check('the job runs for a dispatch or a same-repo non-draft PR',
    own.includes("if: github.event_name == 'workflow_dispatch' || (github.event.pull_request.draft == false && github.event.pull_request.head.repo.full_name == github.repository)\n"));
  check('the caller passes the dispatch inputs through',
    own.includes('      pr: ${{ inputs.pr }}\n      head: ${{ inputs.head }}\n      reread: ${{ inputs.reread == true }}\n'));
}

// ---------- a PR that only moves Redline pins ----------
{
  const { pinOnly } = reviewModule;
  const A = 'a'.repeat(40), B = 'b'.repeat(40);
  const bump = (path = '.github/workflows/redline.yml') => ({ filename: path, status: 'modified', patch:
    `@@ -9,7 +9,7 @@\n jobs:\n   review:\n-    uses: askalf/ci/.github/workflows/redline-review.yml@${A}  # main 2026-10-05\n+    uses: askalf/ci/.github/workflows/redline-review.yml@${B}  # main 2026-10-06, askalf/ci#27\n     with:\n-      redline-ref: ${A}\n+      redline-ref: ${B}` });
  check('a bump of the review caller is pin-only', pinOnly([bump()]));
  check('the review and fix callers together are pin-only', pinOnly([bump(), bump('.github/workflows/redline-fix.yml')]));
  check('the fix-run pin is a pin line', pinOnly([{ filename: '.github/workflows/redline-fix.yml', status: 'modified',
    patch: `@@ -1 +1 @@\n-    uses: askalf/ci/.github/workflows/redline-fix-run.yml@${A}\n+    uses: askalf/ci/.github/workflows/redline-fix-run.yml@${B}` }]));
  check('any other line in a caller is not', !pinOnly([{ filename: '.github/workflows/redline.yml', status: 'modified',
    patch: `@@ -1 +1,2 @@\n+    secrets: inherit\n-      redline-ref: ${A}\n+      redline-ref: ${B}` }]));
  check('another repo\'s reusable workflow is not a Redline pin', !pinOnly([{ filename: '.github/workflows/redline.yml', status: 'modified',
    patch: `@@ -1 +1 @@\n-    uses: someone/ci/.github/workflows/redline-review.yml@${A}\n+    uses: someone/ci/.github/workflows/redline-review.yml@${B}` }]));
  check('any other file is not', !pinOnly([bump(), { filename: 'src/b.js', status: 'modified', patch: PATCH }]));
  check('a new or renamed caller is not', !pinOnly([{ ...bump(), status: 'added' }]));
  check('a file with no patch (too large to show) is not', !pinOnly([{ filename: '.github/workflows/redline.yml', status: 'modified' }]));
  check('no files is not', !pinOnly([]));

  {
    const { ctx, calls } = world({ files: [bump()], turns: [submit({ ...APPROVE, summary: 'Moves the pin; read .github/workflows/redline.yml.' })] });
    ctx.model = 'gpt-6-astra'; ctx.pinModel = 'claude-opus-5-5';
    const lines = [];
    ctx.log = (l) => lines.push(l);
    await runReview(ctx);
    check('a pin-only PR is read on the pin model', calls.model.length > 0 && calls.model.every((b) => b.model === 'claude-opus-5-5'));
    check('and the switch is logged', lines.some((l) => l.includes('only moves Redline pins; read on claude-opus-5-5 instead of gpt-6-astra')));
  }
  {
    const { ctx, calls } = world({ turns: [submit(APPROVE)] });
    ctx.model = 'gpt-6-astra'; ctx.pinModel = 'claude-opus-5-5';
    await runReview(ctx);
    check('a code PR stays on REDLINE_MODEL', calls.model.every((b) => b.model === 'gpt-6-astra'));
  }
  {
    const { ctx, calls } = world({ files: [bump()], turns: [submit(APPROVE)] });
    ctx.model = 'gpt-6-astra'; ctx.pinModel = '';
    await runReview(ctx);
    check('an empty REDLINE_PIN_MODEL reads pin bumps on REDLINE_MODEL', calls.model.every((b) => b.model === 'gpt-6-astra'));
  }
}

// ---------- an approval carries over a merge of the base ----------
{
  const { diffFingerprint, carriedApproval, carriedBody } = reviewModule;
  const pr = { title: 'feat: add token', body: 'Adds it.', base: { ref: 'main' } };
  const files = [{ filename: 'src/b.js', status: 'modified', sha: 'aaa', additions: 1, deletions: 0, patch: PATCH }];
  const own = [{ sha: HEAD, parents: [{ sha: 'p' }], commit: { message: 'feat: add token' } }];
  const merge = { sha: 'm', parents: [{ sha: 'p1' }, { sha: 'p2' }], commit: { message: "Merge branch 'main' into feat/x" } };
  const fp = diffFingerprint(pr, files, own);
  const approval = (fpx, commit = OTHER, state = 'DISMISSED') => ({ user: { login: REVIEWER_LOGIN }, state, commit_id: commit,
    body: `**Verdict: approve.** Fine.\n\n<!-- redline:head=${commit} -->\n\n<!-- redline:diff=${fpx} -->` });
  check('a merge of the base keeps the fingerprint', diffFingerprint(pr, files, [...own, merge]) === fp);
  const added = { filename: 'a.js', status: 'added', sha: 'b', patch: '@@ -0,0 +1 @@\n+export {};' };
  check('file order does not matter', diffFingerprint(pr, [...files, added], own) === diffFingerprint(pr, [added, ...files], own));
  check('a base change to a file the PR changes alters it, though the merge kept the PR blob',
    diffFingerprint(pr, [{ ...files[0], patch: PATCH.replace(' const y = 2;', ' const y = 3;') }], own) !== fp);
  check('hunk line numbers that only moved do not', diffFingerprint(pr, [{ ...files[0], patch: PATCH.replace('@@ -1 +1,2 @@', '@@ -40 +40,2 @@') }], own) === fp);
  check('a merge with any message but git\'s own words changes it',
    diffFingerprint(pr, files, [...own, { ...merge, commit: { message: "Merge branch 'main' into feat/x\n\nCo-Authored-By: someone" } }]) !== fp
    && diffFingerprint(pr, files, [...own, { ...merge, commit: { message: 'Merge in the token: ghp_x' } }]) !== fp
    && diffFingerprint(pr, files, [...own, { ...merge, commit: { message: "Merge remote-tracking branch 'origin/main' into feat/x" } }]) === fp);
  check('a file GitHub shows no patch for leaves no fingerprint, so nothing carries over',
    diffFingerprint(pr, [...files, { filename: 'big.bin', status: 'modified', sha: 'c' }], own) === ''
      && carriedApproval([approval('')], '') === null);
  check('a changed file, title, description, base or own commit message changes it',
    diffFingerprint(pr, [{ ...files[0], sha: 'bbb' }], own) !== fp
    && diffFingerprint({ ...pr, title: 'x' }, files, own) !== fp
    && diffFingerprint({ ...pr, body: 'Adds it. Also y.' }, files, own) !== fp
    && diffFingerprint({ ...pr, base: { ref: 'next' } }, files, own) !== fp
    && diffFingerprint(pr, files, [...own, { sha: 'c', parents: [{ sha: 'x' }], commit: { message: 'fix: y' } }]) !== fp);
  const changes = (commit = OTHER) => ({ user: { login: REVIEWER_LOGIN }, state: 'CHANGES_REQUESTED', commit_id: commit, body: `**Verdict: request changes.** No.\n\n<!-- redline:head=${commit} -->` });
  check('a dismissed approval with this fingerprint carries over', carriedApproval([approval(fp)], fp)?.commit_id === OTHER);
  check('another fingerprint, or none, does not', carriedApproval([approval('0'.repeat(64))], fp) === null
    && carriedApproval([{ ...approval(fp), body: '**Verdict: approve.** Fine.' }], fp) === null);
  check('a later request for changes stops it', carriedApproval([approval(fp), changes()], fp) === null);
  check('only the reviewer counts', carriedApproval([{ ...approval(fp), user: { login: 'someone' } }], fp) === null);
  const body = carriedBody(approval(fp), HEAD, fp);
  check('the carried body names the new head and the fingerprint once each, and says why',
    body.split('<!-- redline:head=').length === 2 && body.includes(`<!-- redline:head=${HEAD} -->`)
      && body.split('<!-- redline:diff=').length === 2 && body.includes('unchanged since 34b7875') && body.startsWith('**Verdict: approve.**'));
  check('carrying twice keeps one note', carriedBody({ body, commit_id: HEAD }, OTHER, fp).split('carries over').length === 2);

  // End to end: the world's PR is the same change an earlier head approved.
  const worldFp = diffFingerprint({ title: 'feat: add token', body: 'Adds it.', base: { ref: 'main' } },
    [{ filename: 'src/b.js', status: 'modified', additions: 1, deletions: 0, patch: PATCH }], [{ sha: HEAD, commit: { message: 'feat: add token' } }]);
  {
    const { ctx, calls } = world({ reviews: [approval(worldFp)], turns: [submit(APPROVE)] });
    const r = await runReview(ctx);
    check('an unchanged change is approved at the new head with no model call',
      r.outcome === 'posted' && r.verdict === 'APPROVE' && calls.model.length === 0 && calls.posted[0].event === 'APPROVE'
        && calls.posted[0].body.includes(`<!-- redline:head=${HEAD} -->`));
  }
  {
    const { ctx, calls } = world({ reviews: [approval(worldFp)], turns: [submit(APPROVE)] });
    ctx.reread = true;
    await runReview(ctx);
    check('a re-read always reads the change', calls.model.length > 0);
  }
  {
    const { ctx, calls } = world({ reviews: [approval('1'.repeat(64))], turns: [submit(APPROVE)] });
    const r = await runReview(ctx);
    check('a changed change is read in full, and its body carries the fingerprint',
      calls.model.length > 0 && r.outcome === 'posted' && calls.posted[0].body.includes(`<!-- redline:diff=${worldFp} -->`));
  }
}

rmSync(root, { recursive: true, force: true });
rmSync(outside, { recursive: true, force: true });
console.log(`\n  ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
