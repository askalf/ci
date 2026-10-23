#!/usr/bin/env node
// Public text: fails a pull request that adds an em or en dash (U+2014, U+2013) to what people
// read, or whose title, description or a commit message credits a model or an AI tool (a
// co-author trailer, a "generated with" footer, a session link). The review leaves dashes to this
// check and still blocks a credit itself; this check reads every line, so each costs one quick
// failing check instead of a review round, and every one shows in one run. Dashes are read in the added lines of each changed file, the PR
// title and description, and the commit messages; credits only in the PR text and the commit
// messages, since code and docs may name these tools for other reasons. Lines the PR does not add
// are never read, so a file that already holds dashes can still be changed. A file the base
// commit marks redline-protected (captured data, see review.mjs) is skipped.
//
// CLI: REPO=owner/name PR=<number> GH_READ_TOKEN=<token> node scripts/redline/public-text.mjs
// A text file too large for GitHub to send a patch is read whole at the merge base and the head
// and diffed with git, the same two sides the PR's own diff compares. A PR with more changed files
// than the files API lists (it stops at 3,000), or more commits than the commits API lists (it
// stops at 250), is incomplete and fails.
// Exit 0 when nothing adds a dash or a credit, 1 when something does, 2 when the PR or a changed
// file could not be read: an unread file never passes.

import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { gh, ghAll, baseAttributes, protectedIn, withRetry } from './review.mjs';

// Built from char codes so the source carries no dash of its own.
const DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
const TOOL = '(claude|anthropic|openai|chatgpt|gpt|copilot|codex|gemini)';
const CREDIT = [
  new RegExp(`\\bgenerated (with|by) \\[?${TOOL}\\b`, 'i'),
  /\bclaude\.ai\/code\/session_/i,
  /^\s*claude-session:/i,
];
// A co-author is a tool when the whole display name is one (a model vendor alone, or an optional
// vendor, then a tool, then only model words and versions) or the address is one a tool commits as. A person who shares a tool's first
// name, or works at its vendor, is not.
const VENDOR = new Set(['anthropic', 'openai', 'github', 'google']);
const TOOL_NAME = new Set(['claude', 'chatgpt', 'gpt', 'copilot', 'codex', 'gemini']);
const MODEL_WORD = new Set(['opus', 'sonnet', 'haiku', 'code', 'pro', 'flash', 'ultra', 'nano', 'mini', 'turbo', 'swe', 'agent', 'cli', 'bot']);
const TOOL_ADDRESS = [
  /^no-?reply@(anthropic|openai)\.com$/,
  /^copilot@github\.com$/,
  /^(\d+\+)?copilot(-swe-agent)?(\[bot\])?@users\.noreply\.github\.com$/,
];

/** Whether a co-author display name is a tool's identity rather than a person's. Pure. */
function toolName(name) {
  const words = name.toLowerCase().replace(/\[bot\]$/, '').split(/[\s-]+/).filter(Boolean);
  if (!words.length) return false;
  if (words.length === 1 && /^(anthropic|openai)$/.test(words[0])) return true;
  if (VENDOR.has(words[0])) words.shift();
  if (!words.length) return false;
  const [first, ...rest] = words;
  const tool = TOOL_NAME.has(first) || /^gpt\d[\w.]*$/.test(first);
  return tool && rest.every((w) => MODEL_WORD.has(w) || /^v?\d[\w.]*$/.test(w) || /^o\d+$/.test(w));
}

/** Whether a line is a co-author trailer naming a model or an AI tool. Pure. */
function creditsCoAuthor(line) {
  const m = /^\s*co-authored-by:\s*(.*?)\s*(?:<([^>]*)>)?\s*$/i.exec(line);
  if (!m) return false;
  return toolName(m[1]) || TOOL_ADDRESS.some((re) => re.test((m[2] ?? '').trim().toLowerCase()));
}

/** Pushes { where, line, text } onto `hits` for each line of `text` that `test` accepts. */
function scanLines(hits, where, text, test) {
  String(text ?? '').replace(/\r\n/g, '\n').split('\n')
    .forEach((t, i) => { if (test(t)) hits.push({ where, line: i + 1, text: t }); });
}

/** Every line of the PR title, description or a commit message that credits a model or an AI tool. Pure. */
export function creditHits({ title = '', body = '', commits = [] }) {
  const hits = [];
  const credits = (t) => creditsCoAuthor(t) || CREDIT.some((re) => re.test(t));
  scanLines(hits, 'PR title', title, credits);
  scanLines(hits, 'PR description', body, credits);
  for (const c of commits) scanLines(hits, `commit ${String(c.sha).slice(0, 7)} message`, c.commit?.message, credits);
  return hits;
}

/** The lines a unified-diff patch adds, as { line, text } with line numbers in the new file. Pure. */
export function addedLines(patch) {
  const out = [];
  let line = 0;
  for (const raw of String(patch ?? '').split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (line === 0) continue;
    if (raw.startsWith('+')) { out.push({ line, text: raw.slice(1) }); line++; }
    else if (raw.startsWith(' ')) line++;
    // '-' lines are not in the new file; '\ No newline at end of file' is not a line at all.
  }
  return out;
}

/**
 * The lines `head` adds to `base`, as { line, text }, by the same diff a patch shows: git diff
 * --no-index in a scratch directory with no global or system config, so no diff driver or textconv
 * from anywhere reaches the answer. A line moved to another place counts as added there. For a
 * file GitHub sends no patch for (too large). Throws when git cannot say.
 */
export function addedByContent(base, head) {
  const dir = mkdtempSync(join(tmpdir(), 'public-text-'));
  try {
    const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, GIT_CONFIG_NOSYSTEM: '1' };
    const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n');
    writeFileSync(join(dir, 'base'), norm(base));
    writeFileSync(join(dir, 'head'), norm(head));
    const r = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--text', '-U0', '--', 'base', 'head'],
      { cwd: dir, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    // git diff --no-index exits 1 when the files differ and 0 when they do not; anything else failed.
    if (r.status !== 0 && r.status !== 1) throw new Error(`git diff failed: ${(r.stderr || r.error?.message || '').trim().slice(0, 200)}`);
    return addedLines(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The changed files GitHub sent no patch for that still need reading: a text file too large for a
 * patch. GitHub counts no changed lines in a binary file, so one with no patch and no changes is
 * binary and has nothing to read. Pure.
 */
export function needsContent(files, protectedPaths = new Set()) {
  return files.filter((f) => f.status !== 'removed' && !protectedPaths.has(f.filename) && typeof f.patch !== 'string' && f.changes > 0);
}

/**
 * Every added dash as { where, line, text, file }, file set for a changed file's line, plus
 * `unread`: the files with no patch whose base and head `contents` (filename to { base, head },
 * from needsContent) could not be read. A head holding a NUL byte is binary and skipped. Runs git
 * for a file read whole (addedByContent); otherwise pure.
 */
export function dashHits({ title = '', body = '', commits = [], files = [], protectedPaths = new Set(), contents = new Map() }) {
  const hits = [];
  const dashed = (t) => DASH.test(t);
  scanLines(hits, 'PR title', title, dashed);
  scanLines(hits, 'PR description', body, dashed);
  for (const c of commits) scanLines(hits, `commit ${String(c.sha).slice(0, 7)} message`, c.commit?.message, dashed);
  const unread = [];
  const wide = new Set(needsContent(files, protectedPaths).map((f) => f.filename));
  for (const f of files) {
    if (f.status === 'removed' || protectedPaths.has(f.filename)) continue;
    let added;
    if (typeof f.patch === 'string') added = addedLines(f.patch);
    else if (!wide.has(f.filename)) continue;
    else {
      const c = contents.get(f.filename);
      if (!c || typeof c.head !== 'string' || typeof c.base !== 'string') { unread.push(f.filename); continue; }
      if (c.head.includes('\0')) continue;
      added = addedByContent(c.base, c.head);
    }
    for (const a of added) if (DASH.test(a.text)) hits.push({ where: f.filename, line: a.line, text: a.text, file: true });
  }
  return { hits, unread };
}

/** A file's text at `ref`, '' when it is not there (404), or null when it could not be read. */
async function readAt(ctx, path, ref) {
  const at = path.split('/').map(encodeURIComponent).join('/');
  try {
    const res = await withRetry(ctx, `GitHub GET contents/${path}`, () => ctx.fetch(`https://api.github.com/repos/${ctx.repo}/contents/${at}?ref=${ref}`, {
      headers: { authorization: `Bearer ${ctx.readToken}`, accept: 'application/vnd.github.raw+json', 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(60_000),
    }).then((r) => (r.status === 404 ? { ok: true, text: async () => '' } : r)));
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * The commit the PR's diff is taken from: the merge base of its base and head, not the base
 * branch tip, which may have moved on and dropped lines the PR keeps. null when it could not be read.
 */
async function mergeBase(ctx, pr) {
  try {
    const cmp = await gh(ctx, `/repos/${ctx.repo}/compare/${pr.base.sha}...${pr.head.sha}?per_page=1`);
    const sha = cmp?.merge_base_commit?.sha;
    return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Checks PR `n` and returns { code, summary, annotations }: code 0 clean, 1 a dash, 2 a changed file
 * or a commit message that could not be read or was not listed. ctx: { repo, readToken, fetch, sleep, now }.
 */
export async function check(ctx, n) {
  const pr = await gh(ctx, `/repos/${ctx.repo}/pulls/${n}`);
  const files = await ghAll(ctx, `/repos/${ctx.repo}/pulls/${n}/files`);
  const commits = await ghAll(ctx, `/repos/${ctx.repo}/pulls/${n}/commits`, 3);
  const protectedPaths = protectedIn(await baseAttributes(ctx, pr), files.map((f) => f.filename));
  const contents = new Map();
  const wide = needsContent(files, protectedPaths);
  const from = wide.some((f) => f.status !== 'added') ? await mergeBase(ctx, pr) : null;
  for (const f of wide) {
    const base = f.status === 'added' ? '' : from ? await readAt(ctx, f.previous_filename ?? f.filename, from) : null;
    const head = await readAt(ctx, f.filename, pr.head.sha);
    if (base !== null && head !== null) contents.set(f.filename, { base, head });
  }
  const { hits, unread } = dashHits({ title: pr.title, body: pr.body, commits, files, protectedPaths, contents });
  // The files API lists at most 3,000 files; the rest of a larger change was never read.
  const unlisted = Math.max(0, Number(pr.changed_files ?? 0) - files.length);
  // The commits API lists at most 250 commits; the messages of the rest were never read.
  const unlistedCommits = Math.max(0, Number(pr.commits ?? 0) - commits.length);
  const annotations = unread.map((u) => `::error file=${u}::GitHub sent no patch for ${u} and its text could not be read, so its added lines are unchecked`);
  if (unlisted) {
    annotations.push(`::error::This pull request changes ${pr.changed_files} files and the files API listed ${files.length}, so ${unlisted} were not checked`);
    unread.push(`${unlisted} changed file(s) the files API did not list`);
  }
  if (unlistedCommits) {
    annotations.push(`::error::This pull request has ${pr.commits} commits and the commits API listed ${commits.length}, so ${unlistedCommits} commit message(s) were not checked`);
    unread.push(`${unlistedCommits} commit message(s) the commits API did not list`);
  }
  const credits = creditHits({ title: pr.title, body: pr.body, commits });
  const listOf = (found) => found.map((h) => `- ${h.file ? `${h.where}:${h.line}` : `${h.where}, line ${h.line}`}: \`${h.text.trim().slice(0, 200).replace(/`/g, "'")}\``).join('\n');
  for (const h of hits) if (h.file) annotations.push(`::error file=${h.where},line=${h.line}::This line adds an em or en dash`);
  for (const h of credits) annotations.push(`::error::${h.where}, line ${h.line} credits a model or an AI tool`);
  const parts = [];
  if (hits.length) parts.push(`${hits.length} added line(s) carry an em or en dash. Use a comma, colon, semicolon, parentheses or two sentences, and a hyphen for a range.\n\n${listOf(hits)}\n`);
  if (credits.length) parts.push(`${credits.length} line(s) credit a model or an AI tool. Remove them: the account that commits is the author.\n\n${listOf(credits)}\n`);
  if (unread.length) parts.push(`Not every added line could be read: ${unread.join(', ')}. Re-run the check.\n`);
  if (!parts.length) parts.push('No added line carries an em or en dash, and nothing credits a model or an AI tool.\n');
  return { code: hits.length || credits.length ? 1 : unread.length ? 2 : 0, summary: parts.join('\n'), annotations };
}

async function main() {
  const env = process.env;
  for (const k of ['REPO', 'PR', 'GH_READ_TOKEN']) if (!env[k]) { console.error(`::error::${k} is not set`); process.exit(2); }
  const ctx = { repo: env.REPO, readToken: env.GH_READ_TOKEN, fetch: globalThis.fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() };
  const { code, summary, annotations } = await check(ctx, Number(env.PR));
  for (const a of annotations) console.log(a);
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  process.exit(code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error(`::error::public-text could not read the pull request: ${e.message}`); process.exit(2); });
}
