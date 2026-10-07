// Redline: the gating code review, run as a CI job on a pull request.
//
// One run reviews one head. It reads the PR (metadata, commits, per-file patches) with the
// workflow's read-only token, lets the model read the PR checkout through read-only tools
// (redline_list, redline_read, redline_search; nothing executes), and ends when the model calls
// redline_submit. The process exits 0 on APPROVE and 1 on REQUEST_CHANGES, so the job's own check is
// the verdict.
//
// Posting. The finished review is written as verdict.json (REDLINE_VERDICT_FILE), which the workflow
// uploads as the redline-verdict artifact. When the env file holds a reviewer token, the review is
// also posted here as sprayberry-redline (posted: true). When it holds none, nothing is posted
// (posted: false) and the forge posts it after checking where the run came from, so the reviewer
// token never has to sit on a CI runner that a pull request's own workflow files can reach.
//
// Hardening, each with a reason:
//   - A verdict already posted at this head is reused, never posted twice (re-runs are free),
//     except in a re-read (REDLINE_REREAD=1, forge's dispatch after a description-only finding
//     was answered by an edit), which reviews the head again.
//   - A draft is not reviewed.
//   - The head is re-read before posting; a head that moved gets no review (the newer run owns it).
//   - Every path a tool touches must resolve inside the checkout, symlinks included.
//   - Findings must quote text that is in the diff, the PR text or a commit message, or, for a
//     changed file the diff could not show (past the diff cap, or no patch from GitHub), in that
//     file in the checkout. One repair round is offered; findings still ungrounded are dropped, and
//     a REQUEST_CHANGES left with no grounded finding fails closed with a note rather than approving.
//   - redline_search runs in a child process with a time cap: the pattern is the model's and the
//     files are the PR's, so a pattern that backtracks without end must not stall the run.
//   - Blocking findings force REQUEST_CHANGES whatever verdict the model named.
//   - Turns, wall time, tool output and diff size are all bounded; near the end the model is
//     forced to submit. A model that rejects a forced tool_choice (rejectsForcedToolChoice) is
//     told in that turn's user content to submit, and every other tool call is refused.
//   - A reply with no tool call is logged with its text, so the next failure explains itself.
//     Three in a row end the run. An EMPTY reply (dario at its concurrency ceiling on 2026-09-25
//     18:27Z answered five runs that way from turn 6 to 30) is not kept in the history, since an
//     empty assistant turn is rejected upstream; the same request is simply sent again. A reply
//     with no content array at all fails the run at once.
//
//   - A model dario reports parked (a 429 marked pool_parked: every seat is over that model's quota,
//     with a reset past the retry budget) is not retried; the turn is sent again on
//     REDLINE_FALLBACK_MODEL. On 2026-09-28 every seat was out of Fable's included-overage credit
//     for four days while Opus still served, and each review burned its retries and failed.
//   - A model dario refuses as unroutable (a 400 marked model_unroutable: no provider lists it) goes
//     to REDLINE_FALLBACK_MODEL the same way: the same turn is sent again, with the history kept.
//     A 400 without that marker still fails the run.
//
// CLI (the workflow's review step):
//   REPO=owner/name PR=<n> HEAD_SHA=<sha> CHECKOUT=<dir> GH_READ_TOKEN=... [REDLINE_REREAD=1] \
//   REDLINE_ENV_FILE=/etc/askalf/redline.env REDLINE_PROMPT_FILE=/etc/askalf/redline-prompt.md node review.mjs
// The env file holds DARIO_API_KEY, or DARIO_SOCKET (a dario key socket: the socket is the key, and
// no key is stored or sent), and optionally REDLINE_GITHUB_TOKEN (or GITHUB_PAT_REVIEWER),
// DARIO_URL (default http://127.0.0.1:3456), REDLINE_MODEL and REDLINE_FALLBACK_MODEL (default
// claude-opus-5-5; set it empty for no fallback), and REDLINE_PIN_MODEL (default claude-opus-5-5,
// the model for a PR that only moves Redline pins; set it empty to read those on REDLINE_MODEL). REDLINE_PROMPT_FILE names the system
// prompt, installed on the runner host: this repository is public and carries no prompt, so there is
// no bundled fallback, and a variable that is unset, a file that cannot be read or an empty file ends
// the run. REDLINE_VERDICT_FILE, when set, is where verdict.json goes.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, realpathSync, appendFileSync, openSync, readSync, closeSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';

export const REVIEWER_LOGIN = 'sprayberry-redline';

// The review is public text on a public repository. It talks about the change and never about the
// reviewer's own machinery. Until 2026-09-26 every review opened with a "fleet code reviewer /
// gating lane" header, and 82 approvals since the CI rollout recited the checks that found nothing
// ("contains no AI attribution; the PR text reads as a human-written triage"). These phrases are
// that narration. A submission carrying one is bounced back to the model with the phrase named, so
// the fix happens before anything is posted. Deliberately narrow: words with legitimate uses in the
// repositories under review (attribution in truecopy, LLM and fleet in dario) are left to the prompt.
export const META_PHRASES = [
  /\bAI[- ]attribution\b/i, /\bhuman[- ]written\b/i, /\breads?[- ]as[- ]generated\b/i,
  /\bAI[- ]generated\b/i, /\bgenerated (?:by|with) (?:an? )?(?:AI|LLM|model)\b/i,
  /\bgating (?:lane|review)\b/i, /\bfleet code reviewer\b/i, /\bautomated review from\b/i,
  /\bthis prompt\b/i, /\bthese rules\b/i, /\bas an AI\b/i,
];
/** The first machinery phrase in a piece of review prose, or null. */
export function metaPhrase(text) {
  for (const re of META_PHRASES) { const m = re.exec(String(text ?? '')); if (m) return m[0]; }
  return null;
}
export const DEFAULT_MODEL = 'claude-fable-5-1';
export const DEFAULT_FALLBACK_MODEL = 'claude-opus-5-5';
// A PR that only moves Redline pins (redline-pin-bump.yml opens one in every caller) is read on
// this model instead of REDLINE_MODEL: it changes one commit sha per caller file, and every bump
// wave is a review in each caller, so it does not spend the reviewer model's seat.
export const DEFAULT_PIN_MODEL = 'claude-opus-5-5';

// Claude Fable 5.1, Claude Mythos 5.1 and Claude Opus 5.5 answer a forced tool_choice (type "tool"
// or "any") with 400 `tool_choice: type "tool" and "any" are not supported for this model.`, on
// the Messages API, count_tokens and Batches alike. It is a restriction of those models, not of
// thinking: Claude Fable 5, Claude Mythos 5, Claude Opus 5 and earlier accept a forced choice.
// Later ids of the same families are taken to keep it. The API's migration path is tool_choice
// auto with the required tool named in the prompt.
const NO_FORCED_CHOICE_FROM = { fable: [5, 1], mythos: [5, 1], opus: [5, 5] };
/** Whether the model rejects a forced tool_choice, from its id (`claude-fable-5-1`, `claude-opus-5-5-20261001`, ...). */
export function rejectsForcedToolChoice(model) {
  const m = /^claude-(fable|mythos|opus)-(\d+)(?:-(\d{1,2}))?(?![0-9])/.exec(String(model ?? '').trim().toLowerCase());
  if (!m) return false;
  const [floorMajor, floorMinor] = NO_FORCED_CHOICE_FROM[m[1]];
  const major = Number(m[2]);
  const minor = m[3] === undefined ? 0 : Number(m[3]);
  return major > floorMajor || (major === floorMajor && minor >= floorMinor);
}
// Sent in the user turn at the force point when the model cannot be forced.
export const SUBMIT_REQUIRED = 'The read budget is spent. Your next response must be a redline_submit tool call '
  + 'with verdict, summary and findings, based on what you have read. Do not call any other tool and do not answer in text.';
export const LIMITS = {
  diffChars: 180_000, bodyChars: 8_000, commitChars: 600, commits: 100,
  readLines: 400, readBytes: 64_000, listEntries: 400,
  grepResults: 80, grepFiles: 5_000, grepFileBytes: 1_000_000, grepPattern: 200, searchMs: 10_000,
  corpusBytes: 8_000_000,
  // timeMs forces the submit; past hardMs no model call starts or retries, so the run ends inside
  // the job's 20-minute timeout.
  turns: 30, forceSubmitAt: 24, timeMs: 12 * 60_000, hardMs: 18 * 60_000, maxTokens: 8_000, modelTimeoutMs: 240_000,
  textOnlyTurns: 3,
};
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', 'vendor', '.next']);

// ---------- pure helpers ----------

/** KEY=VALUE lines; blank lines and # comments ignored; one layer of matching quotes stripped. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let v = line.slice(eq + 1).trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

/**
 * The system prompt: the whole of the file named by env[name]. The prompt is installed on the
 * runner host and is never committed to this public repository, so there is no fallback: an
 * unset variable, a file that cannot be read and an empty file each throw, naming the variable.
 */
export function readPrompt(env, name) {
  const file = env[name];
  if (!file) throw new Error(`${name} is not set; it must name the system prompt file on the runner host`);
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { throw new Error(`${name}: cannot read ${file} (${e.code ?? e.message})`); }
  if (!text.trim()) throw new Error(`${name}: ${file} is empty`);
  return text;
}

/** Resolve p under root, refusing anything (including a symlink) that lands outside it. */
export function safePath(root, p) {
  const rootReal = realpathSync(root);
  const abs = resolve(rootReal, String(p ?? '.').replace(/^\/+/, ''));
  const rel = relative(rootReal, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('path is outside the checkout');
  let real;
  try { real = realpathSync(abs); } catch { throw new Error('no such file or directory'); }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) throw new Error('path resolves outside the checkout');
  return real;
}

function isBinary(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally { closeSync(fd); }
}

/**
 * The PR's per-file patches as one unified diff, capped; files without a patch are named.
 * Returns { text, omitted }: omitted lists the files the cap left out.
 */
export function planDiff(files, cap = LIMITS.diffChars) {
  let out = '';
  const omitted = [];
  for (const f of files) {
    const head = `diff --git a/${f.previous_filename ?? f.filename} b/${f.filename}\n`;
    const part = f.patch ? `${head}${f.patch}\n` : `${head}(no patch: binary, too large, or a rename without changes)\n`;
    if (out.length + part.length > cap) { omitted.push(f.filename); continue; }
    out += part;
  }
  if (omitted.length) out += `\n(diff cap reached; not shown, read them with redline_read: ${omitted.join(', ')})\n`;
  return { text: out, omitted };
}

/** The PR's per-file patches as one unified diff, capped. */
export function buildDiff(files, cap = LIMITS.diffChars) {
  return planDiff(files, cap).text;
}

/**
 * Changed files whose text the diff does not carry: left out by the cap, or sent by GitHub with
 * no patch (too large). Removed files are not in the checkout, so they are not named.
 */
export function unshownFiles(files, omitted) {
  return files.filter((f) => f.status !== 'removed' && (!f.patch || omitted.includes(f.filename))).map((f) => f.filename);
}

/**
 * Grounding lines from files in the checkout, as corpusOf makes them. A finding on a changed file
 * the diff could not show quotes what the model read with redline_read, so those files ground
 * quotes too. Binary files, files over grepFileBytes and anything past corpusBytes in all are skipped.
 */
export function checkoutCorpus(root, paths) {
  const out = [];
  let bytes = 0;
  for (const p of paths) {
    try {
      const file = safePath(root, p);
      const st = lstatSync(file);
      if (!st.isFile() || st.size > LIMITS.grepFileBytes || bytes + st.size > LIMITS.corpusBytes || isBinary(file)) continue;
      bytes += st.size;
      // One push per line: spreading a file of many short lines into one call passes the
      // engine's argument limit, and the RangeError would drop the whole file.
      for (const line of corpusOf(readFileSync(file, 'utf8'))) out.push(line);
    } catch { /* gone or outside the checkout: grounds nothing */ }
  }
  return out;
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Every non-empty quoted line must appear in the corpus, whitespace-normalised. A leading diff
 * marker may or may not be copied, so each quoted line matches with or without its first + - or space.
 */
export function quoteIsGrounded(quote, corpusLines) {
  const lines = String(quote ?? '').split('\n').filter((l) => norm(l));
  // A fragment this short matches almost anything, so it proves nothing.
  if (norm(lines.join(' ')).length < 8) return false;
  return lines.every((l) => {
    const forms = [norm(l), norm(l.replace(/^[+\- ]/, ''))].filter(Boolean);
    return forms.some((q) => corpusLines.some((c) => c.includes(q)));
  });
}

/** The brief's lines, each both as written and without a leading diff marker, normalised. */
export function corpusOf(brief) {
  const out = [];
  for (const l of brief.split('\n')) {
    const a = norm(l);
    if (a) out.push(a);
    const b = norm(l.replace(/^[+\- ]/, ''));
    if (b && b !== a) out.push(b);
  }
  return out;
}

/** Validate redline_submit input; returns { review } or { error }. */
export function checkSubmission(input) {
  if (!input || typeof input !== 'object') return { error: 'redline_submit needs an object' };
  if (input.verdict !== 'APPROVE' && input.verdict !== 'REQUEST_CHANGES') return { error: 'verdict must be APPROVE or REQUEST_CHANGES' };
  if (typeof input.summary !== 'string' || !input.summary.trim()) return { error: 'summary is required' };
  const findings = Array.isArray(input.findings) ? input.findings : [];
  for (const [i, f] of findings.entries()) {
    if (!f || (f.severity !== 'blocking' && f.severity !== 'minor')) return { error: `finding ${i + 1}: severity must be blocking or minor` };
    for (const k of ['file', 'quote', 'problem']) if (typeof f[k] !== 'string' || !f[k].trim()) return { error: `finding ${i + 1}: ${k} is required` };
  }
  // Prose only: the quote is copied from the diff and the rule slug is a machine field.
  const prose = [['summary', input.summary]];
  findings.forEach((f, i) => { prose.push([`finding ${i + 1} problem`, f.problem]); if (f.suggestion) prose.push([`finding ${i + 1} suggestion`, f.suggestion]); });
  for (const [where, text] of prose) {
    const hit = metaPhrase(text);
    if (hit) {
      return { error: `${where} says "${hit}". The review is public and describes only the change: quote the text or code, say what is wrong with it (the claim the code does not support, the filler sentence, the narrated history), and never mention attribution, generation, the reviewer, its rules or lanes. Rewrite and call redline_submit again.` };
    }
  }
  const rule = typeof input.rule === 'string' && /^[a-z0-9-]{1,40}$/.test(input.rule) ? input.rule : 'none';
  return { review: { verdict: input.verdict, summary: input.summary.trim(), findings, rule } };
}

/** Findings the corpus does not back. */
export function ungrounded(review, corpusLines) {
  return review.findings.filter((f) => !quoteIsGrounded(f.quote, corpusLines));
}

/** Final verdict: blocking findings always request changes. */
export function finalVerdict(review) {
  return review.findings.some((f) => f.severity === 'blocking') ? 'REQUEST_CHANGES' : review.verdict;
}

const fence = (s) => { const t = String(s); const n = Math.max(3, ...(t.match(/`+/g) ?? []).map((m) => m.length + 1)); return '`'.repeat(n); };

export function renderBody(review, verdict, headSha, notes = [], fingerprint = '') {
  const parts = [`**Verdict: ${verdict === 'APPROVE' ? 'approve' : 'request changes'}.** ${review.summary}`];
  const blocking = review.findings.filter((f) => f.severity === 'blocking');
  const minor = review.findings.filter((f) => f.severity === 'minor');
  blocking.forEach((f, i) => {
    const where = f.line ? `${f.file}:${f.line}` : f.file;
    let s = `### ${i + 1}. Blocking: \`${where}\`\n\n${String(f.quote).split('\n').map((l) => `> ${l}`).join('\n')}\n\n${f.problem.trim()}`;
    if (f.suggestion && String(f.suggestion).trim()) { const fc = fence(f.suggestion); s += `\n\nSuggested fix:\n\n${fc}\n${String(f.suggestion).trim()}\n${fc}`; }
    parts.push(s);
  });
  if (minor.length) parts.push(`Minor:\n${minor.map((f) => `- \`${f.line ? `${f.file}:${f.line}` : f.file}\`: ${norm(f.problem)}`).join('\n')}`);
  for (const n of notes) parts.push(`_${n}_`);
  if (verdict === 'REQUEST_CHANGES') parts.push(`rule:${review.rule}`);
  parts.push(`<!-- redline:head=${headSha} -->`);
  if (fingerprint) parts.push(`<!-- redline:diff=${fingerprint} -->`);
  return parts.join('\n\n');
}

/** A merge of a branch into the PR branch in git's own words, with nothing else in the message. */
const ROUTINE_MERGE = /^Merge (?:remote-tracking )?branch '[\w./-]+'(?: of [\w./:@-]+)? into [\w./-]+\n?$/;

/**
 * The identity of what a review reads: the title, description and base; each changed file's name,
 * status, previous name, blob and patch against the base, with only the hunk line numbers dropped;
 * and every commit message but a routine merge's. Merging the base in keeps it when the merge changes
 * none of the PR's files relative to the base. A base change to a file the PR changes alters that
 * file's patch, and any other commit message counts. A file whose patch GitHub does not show (too
 * large, or binary) leaves the change unidentified: the result is '' and nothing carries over. Pure.
 */
export function diffFingerprint(pr, files, commits) {
  if (files.some((f) => typeof f.patch !== 'string')) return '';
  const messages = [...new Set(commits.map((c) => String(c.commit?.message ?? '')).filter((m) => !ROUTINE_MERGE.test(m)))].sort();
  const changed = files
    .map((f) => [f.filename, f.status, f.previous_filename ?? '', f.sha ?? '', f.patch.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm, '@@')])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash('sha256').update(JSON.stringify({ title: pr.title ?? '', body: pr.body ?? '', base: pr.base?.ref ?? '', changed, messages })).digest('hex');
}

/**
 * The approval to carry over to a new head: the reviewer's latest verdict on this PR (at any head,
 * dismissed or not, since a push dismisses it) when that verdict approved and carries this
 * fingerprint. A later request for changes, or no fingerprint, means a full review. Pure.
 */
export function carriedApproval(reviews, fingerprint) {
  if (!fingerprint) return null;
  let last = null;
  for (const r of reviews) {
    if ((r.user?.login ?? '') !== REVIEWER_LOGIN) continue;
    const body = String(r.body ?? '');
    if (!/^\*\*Verdict: (approve|request changes)\.\*\*/.test(body)) continue;
    last = r;
  }
  if (!last || !String(last.body).startsWith('**Verdict: approve.**')) return null;
  return String(last.body).includes(`<!-- redline:diff=${fingerprint} -->`) ? last : null;
}

/** The carried approval's body, at the new head. Pure. */
export function carriedBody(prior, headSha, fingerprint) {
  const kept = String(prior.body)
    .replace(/\n\n<!-- redline:head=[0-9a-f]+ -->/g, '')
    .replace(/\n\n<!-- redline:diff=[0-9a-f]+ -->/g, '')
    .replace(/\n\n_The change is unchanged since [^_\n]+_/g, '');
  return [kept, `_The change is unchanged since ${String(prior.commit_id ?? '').slice(0, 7)} (the same files and patches against the base, text and commits), so this verdict carries over._`,
    `<!-- redline:head=${headSha} -->`, `<!-- redline:diff=${fingerprint} -->`].join('\n\n');
}

/** The standing Redline verdict at this head, or null. */
export function verdictAtHead(reviews, headSha) {
  let v = null;
  for (const r of reviews) {
    if ((r.user?.login ?? '') !== REVIEWER_LOGIN || r.commit_id !== headSha) continue;
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') v = r;
  }
  return v;
}

// ---------- the verdict file ----------

export const VERDICT_VERSION = 1;
export const VERDICT_EVENTS = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'];

/** verdict.json: the review exactly as it is (or would be) posted, and whether it was. */
export function verdictRecord({ repo, pr, headSha, event, body, comments = [], posted }) {
  return { version: VERDICT_VERSION, repo, pr, head_sha: headSha, event, body, comments, posted: posted === true };
}

/** Why a parsed verdict.json is malformed, or null. The forge applies its own checks as well. */
export function verdictProblem(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'not an object';
  if (v.version !== VERDICT_VERSION) return `version must be ${VERDICT_VERSION}`;
  if (typeof v.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(v.repo)) return 'repo must be owner/name';
  if (!Number.isInteger(v.pr) || v.pr <= 0) return 'pr must be a positive integer';
  if (typeof v.head_sha !== 'string' || !/^[0-9a-f]{40}$/.test(v.head_sha)) return 'head_sha must be a full commit sha';
  if (!VERDICT_EVENTS.includes(v.event)) return `event must be one of ${VERDICT_EVENTS.join(', ')}`;
  if (typeof v.body !== 'string' || !v.body.trim()) return 'body is required';
  if (!Array.isArray(v.comments)) return 'comments must be an array';
  for (const [i, c] of v.comments.entries()) {
    if (!c || typeof c.path !== 'string' || !Number.isInteger(c.line) || (c.side !== 'LEFT' && c.side !== 'RIGHT') || typeof c.body !== 'string') {
      return `comment ${i + 1} needs path, line, side (LEFT or RIGHT) and body`;
    }
  }
  if (typeof v.posted !== 'boolean') return 'posted must be true or false';
  return null;
}

/** Write verdict.json, creating its directory. */
export function saveVerdict(file, record) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

// ---------- tools over the checkout ----------

export const TOOLS = [
  { name: 'redline_list', description: 'List a directory of the PR checkout (directories end with /).',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Directory relative to the repo root; default the root.' } } } },
  { name: 'redline_read', description: `Read lines of a file in the PR checkout, numbered. At most ${LIMITS.readLines} lines per call.`,
    input_schema: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } }, required: ['path'] } },
  { name: 'redline_search', description: `Search the PR checkout with a JavaScript regular expression. At most ${LIMITS.grepResults} matches.`,
    input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Directory or file to search; default the root.' } }, required: ['pattern'] } },
  { name: 'redline_submit', description: 'Submit the review. Call exactly once, last.',
    input_schema: { type: 'object', required: ['verdict', 'summary', 'findings'], properties: {
      verdict: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES'] },
      summary: { type: 'string', description: 'One short paragraph: the verdict in a sentence and what you checked.' },
      rule: { type: 'string', description: 'For REQUEST_CHANGES: the most severe blocking finding\'s rule slug, or none.' },
      findings: { type: 'array', items: { type: 'object', required: ['severity', 'file', 'quote', 'problem'], properties: {
        severity: { type: 'string', enum: ['blocking', 'minor'] },
        file: { type: 'string' }, line: { type: 'integer' },
        quote: { type: 'string', description: 'The exact lines, copied from the diff, PR text or a commit message.' },
        problem: { type: 'string', description: 'What is wrong: the input or state, and the wrong result.' },
        suggestion: { type: 'string' } } } } } } },
];

export function runTool(root, name, input = {}) {
  try {
    if (name === 'redline_list') {
      const dir = safePath(root, input.path);
      const rows = readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== '.git')
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
      return rows.length > LIMITS.listEntries ? `${rows.slice(0, LIMITS.listEntries).join('\n')}\n(${rows.length - LIMITS.listEntries} more not shown)` : rows.join('\n') || '(empty)';
    }
    if (name === 'redline_read') {
      const file = safePath(root, input.path);
      if (lstatSync(file).isDirectory()) return 'error: that is a directory; use redline_list';
      if (isBinary(file)) return 'error: binary file, not readable as text';
      const lines = readFileSync(file, 'utf8').split('\n');
      const start = Math.max(1, Number(input.start_line) || 1);
      const end = Math.min(lines.length, Number(input.end_line) || start + LIMITS.readLines - 1, start + LIMITS.readLines - 1);
      let out = '';
      for (let i = start; i <= end; i++) {
        const row = `${i}\t${lines[i - 1]}\n`;
        if (out.length + row.length > LIMITS.readBytes) { out += `(output cap reached at line ${i - 1})\n`; break; }
        out += row;
      }
      return `${out}(file has ${lines.length} lines)`;
    }
    if (name === 'redline_search') {
      const pat = String(input.pattern ?? '');
      if (!pat || pat.length > LIMITS.grepPattern) return `error: pattern must be 1-${LIMITS.grepPattern} characters`;
      try { new RegExp(pat); } catch (e) { return `error: bad pattern: ${e.message}`; }
      const start = safePath(root, input.path);
      const rootReal = realpathSync(root);
      // The match runs in a child that is killed at searchMs: a regular expression cannot be
      // interrupted in this process, and the files it runs over are the PR's.
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), SEARCH_WORKER], {
        input: JSON.stringify({ rootReal, start, pattern: pat }), encoding: 'utf8', timeout: LIMITS.searchMs,
        killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
        env: process.platform === 'win32' ? { SYSTEMROOT: process.env.SYSTEMROOT ?? '' } : {},
      });
      if (r.error?.code === 'ETIMEDOUT' || r.signal) return `error: the search ran past ${LIMITS.searchMs / 1000}s and was stopped; use a simpler pattern or a narrower path`;
      if (r.status !== 0) return `error: the search failed: ${String(r.stderr || r.error?.message || '').trim().slice(0, 200)}`;
      return r.stdout;
    }
    return `error: unknown tool ${name}`;
  } catch (e) {
    return `error: ${e.message}`;
  }
}

const SEARCH_WORKER = '--search-worker';

/** The search itself: matches of pattern under start, as redline_search reports them. Pure but for reads. */
export function searchFiles(rootReal, start, pattern) {
  const re = new RegExp(pattern);
  const hits = [];
  let files = 0;
  const walk = (p) => {
    if (hits.length >= LIMITS.grepResults || files >= LIMITS.grepFiles) return;
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const e of readdirSync(p).sort()) if (!SKIP_DIRS.has(e)) walk(join(p, e));
      return;
    }
    files++;
    if (st.size > LIMITS.grepFileBytes || isBinary(p)) return;
    const lines = readFileSync(p, 'utf8').split('\n');
    for (let i = 0; i < lines.length && hits.length < LIMITS.grepResults; i++) {
      if (re.test(lines[i])) hits.push(`${relative(rootReal, p).split(sep).join('/')}:${i + 1}: ${lines[i].slice(0, 300)}`);
    }
  };
  walk(start);
  return hits.length ? hits.join('\n') + (hits.length >= LIMITS.grepResults ? '\n(match cap reached)' : '') : '(no matches)';
}

/** The child redline_search starts: the request on stdin, the result on stdout. */
function searchWorker() {
  const { rootReal, start, pattern } = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(searchFiles(rootReal, start, pattern));
}

// ---------- GitHub and the model ----------

/**
 * dario's answer when every seat is over the requested model's quota (x-dario-upstream-rejection:
 * pool_parked). Nothing was sent upstream, and the same model cannot be served before retryAfterMs.
 */
export class ModelParked extends Error {
  constructor(what, retryAfterMs, detail) {
    super(`${what}: HTTP 429 pool_parked, the model is parked for ${Math.ceil(retryAfterMs / 1000)}s: ${detail}`);
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * dario's answer when no provider lists the requested model (x-dario-upstream-rejection:
 * model_unroutable), as when the account that serves it drops out. Nothing was sent upstream.
 */
export class ModelUnroutable extends Error {
  constructor(what, detail) {
    super(`${what}: HTTP 400 model_unroutable: ${detail}`);
  }
}

/** A call that would start, or wait to retry, past the run's deadline. */
export class OutOfTime extends Error {}

// Shared with fix.mjs: the same retry, GitHub read and model call serve the review and the fix.
// deadline is an absolute ctx.now() time: no attempt starts and no retry waits past it, and fn
// gets the milliseconds left so each attempt's own timeout can stop there too.
export async function withRetry(ctx, what, fn, deadline = Infinity) {
  const waits = [5_000, 15_000, 45_000];
  const left = () => deadline - (ctx.now ?? Date.now)();
  for (let attempt = 0; ; attempt++) {
    if (left() <= 0) throw new OutOfTime(`${what}: the time budget is spent`);
    let res;
    try { res = await fn(left()); } catch (e) {
      if (attempt >= waits.length) throw new Error(`${what}: ${e.message}`);
      if (left() <= waits[attempt]) throw new OutOfTime(`${what}: ${e.message}; no time left to retry`);
      await ctx.sleep(waits[attempt]); continue;
    }
    if (res.ok) return res;
    // A park that outlasts the waits left cannot be retried out of; say so now, not after them.
    if (res.status === 429 && res.headers?.get?.('x-dario-upstream-rejection') === 'pool_parked') {
      const retryAfterMs = (Number(res.headers.get('retry-after')) || 0) * 1000;
      const budget = waits.slice(attempt).reduce((a, b) => a + b, 0);
      if (!(retryAfterMs > 0) || retryAfterMs > budget) throw new ModelParked(what, retryAfterMs, (await res.text()).slice(0, 300));
    }
    if (res.status === 400 && res.headers?.get?.('x-dario-upstream-rejection') === 'model_unroutable') {
      throw new ModelUnroutable(what, (await res.text()).slice(0, 300));
    }
    if ((res.status === 429 || res.status >= 500) && attempt < waits.length) {
      if (left() <= waits[attempt]) throw new OutOfTime(`${what}: HTTP ${res.status}; no time left to retry`);
      await ctx.sleep(waits[attempt]); continue;
    }
    throw new Error(`${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

export function gh(ctx, path, { token = ctx.readToken, method = 'GET', body } = {}) {
  return withRetry(ctx, `GitHub ${method} ${path.split('?')[0]}`, () => ctx.fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  })).then((r) => r.json());
}

export async function ghAll(ctx, path, max = 30) {
  const out = [];
  for (let page = 1; page <= max; page++) {
    const rows = await gh(ctx, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

/**
 * A fetch over dario's key socket (DARIO_SOCKET): a unix socket dario binds to one named key, so
 * the request carries no secret and the host holds none. Only what callModelWith sends is needed:
 * a method, string headers, a string body and a signal.
 */
export function socketFetch(socketPath) {
  return (url, init = {}) => new Promise((resolvePromise, reject) => {
    const signal = init.signal;
    if (signal?.aborted) { reject(signal.reason); return; }
    const u = new URL(String(url));
    const body = init.body == null ? null : Buffer.from(String(init.body));
    const req = httpRequest({
      socketPath, method: init.method ?? 'GET', path: `${u.pathname}${u.search}`,
      headers: { host: u.host, ...(init.headers ?? {}), ...(body ? { 'content-length': String(body.length) } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        signal?.removeEventListener('abort', onAbort);
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const one of [v].flat()) if (one !== undefined) headers.append(k, one);
        const status = res.statusCode ?? 502;
        // A null-body status takes no body, and a status Response cannot hold rejects the fetch:
        // a throw here, in an event listener, would end the process instead.
        try { resolvePromise(new Response([101, 103, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers })); } catch (e) { reject(e); }
      });
    });
    const onAbort = () => { req.destroy(); reject(signal.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e); });
    if (body) req.write(body);
    req.end();
  });
}

/** fetchFn, except that requests for darioUrl's origin go over the key socket when there is one. */
export function withDarioSocket(fetchFn, darioUrl, socketPath) {
  if (!socketPath) return fetchFn;
  const origin = new URL(darioUrl).origin;
  const viaSocket = socketFetch(socketPath);
  return (url, init) => {
    let o = '';
    try { o = new URL(String(url)).origin; } catch { o = ''; }
    return o === origin ? viaSocket(url, init) : fetchFn(url, init);
  };
}

/**
 * dario's address and credential from an env file: DARIO_SOCKET, a key socket, needs no key and
 * sends none (the socket is the key); otherwise DARIO_API_KEY is required. Returns null and says
 * why when neither is set.
 */
export function darioAccess(secrets) {
  const darioUrl = secrets.DARIO_URL || 'http://127.0.0.1:3456';
  const darioSocket = secrets.DARIO_SOCKET || '';
  if (darioSocket) {
    if (!isAbsolute(darioSocket)) return { error: 'DARIO_SOCKET must be an absolute path' };
    return { darioUrl, darioSocket, darioKey: '', warning: secrets.DARIO_API_KEY ? 'DARIO_API_KEY is set next to DARIO_SOCKET: the socket is the credential, so the key is not used; remove it from the env file' : '' };
  }
  if (!secrets.DARIO_API_KEY) return { error: 'DARIO_API_KEY is not set (or set DARIO_SOCKET to a dario key socket)' };
  return { darioUrl, darioSocket: '', darioKey: secrets.DARIO_API_KEY, warning: '' };
}

/**
 * One Messages call through dario. The key travels in a header, never in argv or a URL; over a
 * key socket there is no key to send.
 */
export async function callModelWith(ctx, { system, messages, tools, toolChoice, maxTokens = LIMITS.maxTokens, timeoutMs = LIMITS.modelTimeoutMs, deadline = Infinity }) {
  const res = await withRetry(ctx, 'model', (leftMs) => ctx.fetch(`${ctx.darioUrl.replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ctx.darioKey ? { 'x-api-key': ctx.darioKey } : {}), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: ctx.model, max_tokens: maxTokens, system, messages, tools,
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
    }),
    signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(timeoutMs, leftMs)))),
  }), deadline);
  return res.json();
}

/**
 * Put SUBMIT_REQUIRED in the last user turn, once. That turn is the one about to be sent (the
 * brief, a nudge or tool results), so no turn the model has already answered is edited: an empty
 * reply resends the same request, which already carries it.
 */
export function askForSubmit(messages) {
  const last = messages.at(-1);
  if (!last || last.role !== 'user') return;
  if (typeof last.content === 'string') {
    if (!last.content.includes(SUBMIT_REQUIRED)) last.content = `${last.content}\n\n${SUBMIT_REQUIRED}`;
    return;
  }
  if (Array.isArray(last.content) && !last.content.some((b) => b.type === 'text' && b.text === SUBMIT_REQUIRED)) {
    last.content.push({ type: 'text', text: SUBMIT_REQUIRED });
  }
}

export function buildBrief(pr, files, commits, diff) {
  const body = (pr.body ?? '').slice(0, LIMITS.bodyChars);
  const commitLines = commits.slice(0, LIMITS.commits).map((c) => `- ${c.sha.slice(0, 7)} ${String(c.commit?.message ?? '').slice(0, LIMITS.commitChars).replace(/\n/g, '\n  ')}`);
  return [
    `Repository: ${pr.base.repo.full_name}`,
    `PR #${pr.number}: ${pr.title}`,
    `Author: ${pr.user?.login}; ${pr.head.ref} -> ${pr.base.ref}; head ${pr.head.sha}`,
    '', 'PR description:', body || '(empty)',
    '', `Commits (${commits.length}):`, ...commitLines,
    '', `Changed files (${files.length}):`, ...files.map((f) => `- ${f.status} +${f.additions} -${f.deletions} ${f.filename}`),
    '', 'Diff:', diff,
  ].join('\n');
}

const PIN_CALLERS = new Set(['.github/workflows/redline.yml', '.github/workflows/redline-fix.yml']);
// The lines pin.mjs writes: the pinned call, the redline-ref input naming the same commit, and comments.
const PIN_LINE = /^\s*(?:uses: askalf\/ci\/\.github\/workflows\/redline-(?:review|fix-run)\.yml@[0-9a-f]{40}|redline-ref: ['"]?[0-9a-f]{40}['"]?)?\s*(?:#.*)?$/;

/**
 * True when the PR changes nothing but Redline pins: only the caller files, each modified, and
 * every added or removed line a pinned call, a redline-ref input or a comment. Pure.
 * @param {{ filename: string, status: string, patch?: string }[]} files
 */
export function pinOnly(files) {
  if (!files.length) return false;
  return files.every((f) => {
    if (!PIN_CALLERS.has(f.filename) || f.status !== 'modified' || typeof f.patch !== 'string') return false;
    const changed = f.patch.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
    return changed.length > 0 && changed.every((l) => PIN_LINE.test(l.slice(1)));
  });
}

/**
 * Review one PR head. ctx: { repo, pr, headSha, checkout, readToken, reviewToken, darioUrl, darioKey,
 * model, fallbackModel, system, fetch, sleep, now, log }. With no reviewToken the review is built but not posted.
 * Returns { outcome: 'posted'|'unposted'|'existing'|'skipped'|'dry-run', verdict?, url?, reason?, record? };
 * record (verdict.json) is set when a review was built for this head, posted or not.
 */
export async function runReview(ctx) {
  const { repo, pr: n, headSha } = ctx;
  const deadline = ctx.now() + LIMITS.hardMs;
  const pr = await gh(ctx, `/repos/${repo}/pulls/${n}`);
  if (pr.state !== 'open') return { outcome: 'skipped', reason: `PR is ${pr.state}` };
  if (pr.head.sha !== headSha) return { outcome: 'skipped', reason: `head moved to ${pr.head.sha.slice(0, 7)}` };
  if (pr.head.repo?.full_name !== repo) return { outcome: 'skipped', reason: 'fork PR' };
  if (pr.draft) return { outcome: 'skipped', reason: 'draft PR' };

  // A re-read reviews the head again: the verdict standing there is the one being reconsidered.
  const reviews = ctx.reread ? [] : await ghAll(ctx, `/repos/${repo}/pulls/${n}/reviews`);
  const standing = ctx.reread ? null : verdictAtHead(reviews, headSha);
  if (standing) return { outcome: 'existing', verdict: standing.state === 'APPROVED' ? 'APPROVE' : 'REQUEST_CHANGES', url: standing.html_url };

  const files = await ghAll(ctx, `/repos/${repo}/pulls/${n}/files`);
  const commits = await ghAll(ctx, `/repos/${repo}/pulls/${n}/commits`, 3);
  const fingerprint = diffFingerprint(pr, files, commits);
  // The reviewer's latest verdict approved a head with this same fingerprint: the same files with the
  // same patches against the base, the same text and no new commit message but a routine merge. That
  // approval carries over; a re-read, or a change no fingerprint covers, is read in full.
  const prior = ctx.reread || !fingerprint ? null : carriedApproval(reviews, fingerprint);
  if (prior) {
    ctx.log?.(`the change is unchanged since ${String(prior.commit_id ?? '').slice(0, 7)}; its approval carries over to ${headSha.slice(0, 7)}`);
    const body = carriedBody(prior, headSha, fingerprint);
    if (ctx.dryRun) return { outcome: 'dry-run', verdict: 'APPROVE', body };
    const record = (posted) => verdictRecord({ repo, pr: n, headSha, event: 'APPROVE', body, comments: [], posted });
    if (!ctx.reviewToken) return { outcome: 'unposted', verdict: 'APPROVE', record: record(false) };
    const posted = await gh(ctx, `/repos/${repo}/pulls/${n}/reviews`, {
      token: ctx.reviewToken, method: 'POST',
      body: { commit_id: headSha, event: 'APPROVE', body },
    });
    return { outcome: 'posted', verdict: 'APPROVE', url: posted.html_url, record: record(true) };
  }
  if (ctx.pinModel && ctx.pinModel !== ctx.model && pinOnly(files)) {
    ctx.log?.(`the PR only moves Redline pins; read on ${ctx.pinModel} instead of ${ctx.model}`);
    ctx.model = ctx.pinModel;
  }
  const diff = planDiff(files);
  const brief = buildBrief(pr, files, commits, diff.text);
  const corpus = [...corpusOf(brief), ...checkoutCorpus(ctx.checkout, unshownFiles(files, diff.omitted))];

  const messages = [{ role: 'user', content: `${brief}\n\nReview this change and finish with redline_submit.` }];
  const started = ctx.now();
  let review = null;
  let repaired = false;
  let textOnly = 0;
  const notes = [];
  // A text answer is not a review: nothing in prose is graded, grounded or posted. Five of eight
  // live runs on 2026-09-25 answered in prose for 25 turns straight, because the gateway between
  // this script and the model drops tool_choice, so the forced turns never forced anything.
  const TEXT_ONLY_NUDGE = 'That text was discarded: a review is accepted only as a redline_submit tool call. '
    + 'Call redline_submit now with verdict, summary and findings; do not answer in text again.';
  for (let turn = 1; turn <= LIMITS.turns && !review; turn++) {
    const force = turn >= LIMITS.forceSubmitAt || ctx.now() - started > LIMITS.timeMs;
    // Read per turn: a fallback below can change the model mid-review.
    const canForce = !rejectsForcedToolChoice(ctx.model);
    if (force && !canForce) askForSubmit(messages);
    let res;
    try {
      res = await callModelWith(ctx, {
        system: ctx.system, messages, tools: TOOLS,
        toolChoice: !force ? null : canForce ? { type: 'tool', name: 'redline_submit' } : { type: 'auto' },
        deadline,
      });
    } catch (e) {
      if (!(e instanceof ModelParked || e instanceof ModelUnroutable) || !ctx.fallbackModel || ctx.fallbackModel === ctx.model) throw e;
      ctx.log?.(e instanceof ModelParked
        ? `${ctx.model} is parked in dario for ${Math.ceil(e.retryAfterMs / 1000)}s; the review continues on ${ctx.fallbackModel}`
        : `no provider in dario lists ${ctx.model}; the review continues on ${ctx.fallbackModel}`);
      ctx.model = ctx.fallbackModel;
      turn--;
      continue;
    }
    if (!Array.isArray(res?.content)) {
      throw new Error(`the model returned no message content: ${JSON.stringify(res ?? null).slice(0, 300)}`);
    }
    const uses = res.content.filter((b) => b.type === 'tool_use');
    const text = res.content.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join(' ').replace(/\s+/g, ' ').trim();
    ctx.log?.(`turn ${turn}${force ? (canForce ? ' (forced)' : ' (submit required)') : ''}: ${uses.map((u) => u.name).join(', ') || 'no tool call'}; stop=${res.stop_reason ?? '-'}`
      + (uses.length ? '' : ` text=${JSON.stringify(text.slice(0, 200))}`));
    if (!uses.length) {
      textOnly++;
      if (textOnly >= LIMITS.textOnlyTurns) throw new Error(`no review submitted: ${textOnly} text-only answers in a row (the model will not call redline_submit)`);
      if (res.content.length) {
        // Prose is kept and answered; an empty reply is not history, the same request goes again.
        messages.push({ role: 'assistant', content: res.content });
        messages.push({ role: 'user', content: TEXT_ONLY_NUDGE });
      }
      continue;
    }
    textOnly = 0;
    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const u of uses) {
      if (u.name !== 'redline_submit') {
        // Past the forced turn a read is refused, not run, so the model cannot keep reading whether or
        // not a gateway kept tool_choice (dario#1423, 2026-09-25: 30 turns of reading past it).
        results.push(force
          ? { type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'The read budget is spent. Call redline_submit now with what you have read.' }
          : { type: 'tool_result', tool_use_id: u.id, content: runTool(ctx.checkout, u.name, u.input) });
        continue;
      }
      const checked = checkSubmission(u.input);
      if (checked.error) {
        ctx.log?.(`  submission rejected: ${checked.error}`);
        results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: checked.error });
        continue;
      }
      const bad = ungrounded(checked.review, corpus);
      if (bad.length && !repaired && turn < LIMITS.turns) {
        repaired = true;
        ctx.log?.(`  ${bad.length} ungrounded finding(s): one repair round offered`);
        results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content:
          `These findings quote text that is not in the diff, the changed files the diff could not show, the PR text or a commit message: ${bad.map((f) => `${f.file} ("${norm(f.quote).slice(0, 80)}")`).join('; ')}. Copy the quote exactly from the diff, or drop the finding, then call redline_submit again.` });
        continue;
      }
      if (bad.length) {
        checked.review.findings = checked.review.findings.filter((f) => !bad.includes(f));
        notes.push(`${bad.length} finding(s) dropped: their quotes are not in the diff.`);
        if (checked.review.verdict === 'REQUEST_CHANGES' && !checked.review.findings.some((f) => f.severity === 'blocking')) {
          notes.push('The review asked for changes but none of its blocking findings could be grounded in the diff. Re-run the check.');
        }
      }
      review = checked.review;
      break;
    }
    if (!review) messages.push({ role: 'user', content: results });
  }
  if (!review) throw new Error(`no review submitted within ${LIMITS.turns} turns`);

  const verdict = finalVerdict(review);
  if (ctx.dryRun) return { outcome: 'dry-run', verdict, body: renderBody(review, verdict, headSha, notes, fingerprint) };
  const now = await gh(ctx, `/repos/${repo}/pulls/${n}`);
  if (now.head.sha !== headSha) return { outcome: 'skipped', reason: `head moved to ${now.head.sha.slice(0, 7)} during the review` };
  const body = renderBody(review, verdict, headSha, notes, fingerprint);
  const record = (posted) => verdictRecord({ repo, pr: n, headSha, event: verdict, body, comments: [], posted });
  if (!ctx.reviewToken) return { outcome: 'unposted', verdict, record: record(false) };
  const posted = await gh(ctx, `/repos/${repo}/pulls/${n}/reviews`, {
    token: ctx.reviewToken, method: 'POST',
    body: { commit_id: headSha, event: verdict, body },
  });
  return { outcome: 'posted', verdict, url: posted.html_url, record: record(true) };
}

// ---------- CLI ----------

async function main() {
  const env = process.env;
  const need = (k, src = env) => { if (!src[k]) { console.error(`::error::${k} is not set`); process.exit(2); } return src[k]; };
  let secrets;
  try { secrets = parseEnvFile(readFileSync(need('REDLINE_ENV_FILE'), 'utf8')); } catch (e) {
    console.error(`::error::REDLINE_ENV_FILE: cannot read ${env.REDLINE_ENV_FILE} (${e.code ?? e.message})`); process.exit(2);
  }
  let system;
  try { system = readPrompt(env, 'REDLINE_PROMPT_FILE'); } catch (e) { console.error(`::error::${e.message}`); process.exit(2); }
  // The runner's workspace outlives the job, so a file from an earlier run is removed before this
  // one can leave it to be uploaded.
  const verdictFile = env.REDLINE_VERDICT_FILE || '';
  if (verdictFile) rmSync(verdictFile, { force: true });
  const dario = darioAccess(secrets);
  if (dario.error) { console.error(`::error::${dario.error}`); process.exit(2); }
  if (dario.warning) console.log(`::warning::${dario.warning}`);
  const ctx = {
    repo: need('REPO'), pr: Number(need('PR')), headSha: need('HEAD_SHA'), checkout: need('CHECKOUT'),
    readToken: need('GH_READ_TOKEN'),
    reviewToken: secrets.REDLINE_GITHUB_TOKEN || secrets.GITHUB_PAT_REVIEWER || '',
    darioUrl: dario.darioUrl, darioKey: dario.darioKey,
    model: secrets.REDLINE_MODEL || DEFAULT_MODEL,
    fallbackModel: secrets.REDLINE_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL,
    pinModel: secrets.REDLINE_PIN_MODEL ?? DEFAULT_PIN_MODEL,
    system,
    fetch: withDarioSocket(globalThis.fetch, dario.darioUrl, dario.darioSocket), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(),
    dryRun: env.REDLINE_DRY_RUN === '1',
    reread: env.REDLINE_REREAD === '1',
    log: (line) => console.log(line),
  };
  let result;
  try { result = await runReview(ctx); } catch (e) {
    console.error(`::error::Redline could not finish the review: ${e.message}`);
    process.exit(2);
  }
  try { if (result.record && verdictFile) saveVerdict(verdictFile, result.record); } catch (e) {
    console.error(`::error::Redline could not write ${verdictFile}: ${e.message}`); process.exit(2);
  }
  const line = result.outcome === 'skipped' ? `Redline skipped: ${result.reason}`
    : result.outcome === 'dry-run' ? `Redline dry run (nothing posted): ${result.verdict}`
      : result.outcome === 'unposted' ? `Redline verdict, left to the forge to post: ${result.verdict}`
        : `Redline ${result.outcome === 'existing' ? 'already reviewed' : 'posted'}: ${result.verdict} ${result.url ?? ''}`;
  console.log(line);
  if (result.body) console.log(`\n${result.body}`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  process.exit(result.verdict === 'REQUEST_CHANGES' ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv[2] === SEARCH_WORKER) searchWorker();
  // Anything main does not catch is still an error exit (2), never the 1 of REQUEST_CHANGES.
  else main().catch((e) => { console.error(`::error::Redline failed: ${e.message}`); process.exit(2); });
}
