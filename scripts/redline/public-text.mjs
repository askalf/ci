#!/usr/bin/env node
// Public text: fails a pull request that adds an em or en dash (U+2014, U+2013) to what people
// read. The review leaves punctuation to this check, which reads every added line, so a dash costs
// one quick failing check instead of a review round, and every dash shows in one run. Read: the
// added lines of each changed file, the PR title and description, and the commit messages. Lines
// the PR does not add are never read, so a file that already holds dashes can still be changed.
// A file the base commit marks redline-protected (captured data, see review.mjs) is skipped.
//
// CLI: REPO=owner/name PR=<number> GH_READ_TOKEN=<token> node scripts/redline/public-text.mjs
// A text file too large for GitHub to send a patch is read whole at the base and the head, and its
// added lines are the head lines the base does not hold.
// Exit 0 when nothing adds a dash, 1 when something does, 2 when the PR or a changed file could
// not be read: an unread file never passes.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gh, ghAll, baseAttributes, protectedIn, withRetry } from './review.mjs';

// Built from char codes so the source carries no dash of its own.
const DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');

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
 * The lines of `head` that `base` does not hold, as { line, text }: each base line matches one
 * equal head line, so a line repeated more often than before counts as added. For a file GitHub
 * sends no patch for (too large). Pure.
 */
export function addedByContent(base, head) {
  const left = new Map();
  for (const l of String(base ?? '').replace(/\r\n/g, '\n').split('\n')) left.set(l, (left.get(l) ?? 0) + 1);
  const out = [];
  String(head ?? '').replace(/\r\n/g, '\n').split('\n').forEach((text, i) => {
    const n = left.get(text) ?? 0;
    if (n > 0) left.set(text, n - 1);
    else out.push({ line: i + 1, text });
  });
  return out;
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
 * from needsContent) could not be read. A head holding a NUL byte is binary and skipped. Pure.
 */
export function dashHits({ title = '', body = '', commits = [], files = [], protectedPaths = new Set(), contents = new Map() }) {
  const hits = [];
  const scan = (where, text) => String(text ?? '').replace(/\r\n/g, '\n').split('\n')
    .forEach((t, i) => { if (DASH.test(t)) hits.push({ where, line: i + 1, text: t }); });
  scan('PR title', title);
  scan('PR description', body);
  for (const c of commits) scan(`commit ${String(c.sha).slice(0, 7)} message`, c.commit?.message);
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
 * Checks PR `n` and returns { code, summary, annotations }: code 0 clean, 1 a dash, 2 a changed file
 * that could not be read. ctx: { repo, readToken, fetch, sleep, now }.
 */
export async function check(ctx, n) {
  const pr = await gh(ctx, `/repos/${ctx.repo}/pulls/${n}`);
  const files = await ghAll(ctx, `/repos/${ctx.repo}/pulls/${n}/files`);
  const commits = await ghAll(ctx, `/repos/${ctx.repo}/pulls/${n}/commits`, 3);
  const protectedPaths = protectedIn(await baseAttributes(ctx, pr), files.map((f) => f.filename));
  const contents = new Map();
  for (const f of needsContent(files, protectedPaths)) {
    const base = f.status === 'added' ? '' : await readAt(ctx, f.previous_filename ?? f.filename, pr.base.sha);
    const head = await readAt(ctx, f.filename, pr.head.sha);
    if (base !== null && head !== null) contents.set(f.filename, { base, head });
  }
  const { hits, unread } = dashHits({ title: pr.title, body: pr.body, commits, files, protectedPaths, contents });
  const annotations = unread.map((u) => `::error file=${u}::GitHub sent no patch for ${u} and its text could not be read, so its added lines are unchecked`);
  const lines = [];
  for (const h of hits) {
    const at = h.file ? `${h.where}:${h.line}` : `${h.where}, line ${h.line}`;
    if (h.file) annotations.push(`::error file=${h.where},line=${h.line}::This line adds an em or en dash`);
    lines.push(`- ${at}: \`${h.text.trim().slice(0, 200).replace(/`/g, "'")}\``);
  }
  const summary = hits.length
    ? `${hits.length} added line(s) carry an em or en dash. Use a comma, colon, semicolon, parentheses or two sentences, and a hyphen for a range.\n\n${lines.join('\n')}\n`
    : unread.length ? `Not every added line could be read: ${unread.join(', ')}. Re-run the check.\n`
      : 'No added line carries an em or en dash.\n';
  return { code: hits.length ? 1 : unread.length ? 2 : 0, summary, annotations };
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
