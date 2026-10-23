#!/usr/bin/env node
// Public text: fails a pull request that adds an em or en dash (U+2014, U+2013) to what people
// read. The review leaves punctuation to this check, which reads every added line, so a dash costs
// one quick failing check instead of a review round, and every dash shows in one run. Read: the
// added lines of each changed file, the PR title and description, and the commit messages. Lines
// the PR does not add are never read, so a file that already holds dashes can still be changed.
// A file the base commit marks redline-protected (captured data, see review.mjs) is skipped.
//
// CLI: REPO=owner/name PR=<number> GH_READ_TOKEN=<token> node scripts/redline/public-text.mjs
// Exit 0 when nothing adds a dash, 1 when something does, 2 when the PR could not be read.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gh, ghAll, baseAttributes, protectedIn } from './review.mjs';

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
 * Every added dash as { where, line, text, file }, file set for a changed file's line, plus the files whose patch GitHub did not send
 * (too large, or binary) as `unread`. Pure.
 */
export function dashHits({ title = '', body = '', commits = [], files = [], protectedPaths = new Set() }) {
  const hits = [];
  const scan = (where, text) => String(text ?? '').replace(/\r\n/g, '\n').split('\n')
    .forEach((t, i) => { if (DASH.test(t)) hits.push({ where, line: i + 1, text: t }); });
  scan('PR title', title);
  scan('PR description', body);
  for (const c of commits) scan(`commit ${String(c.sha).slice(0, 7)} message`, c.commit?.message);
  const unread = [];
  for (const f of files) {
    if (f.status === 'removed' || protectedPaths.has(f.filename)) continue;
    if (typeof f.patch !== 'string') { if (f.changes > 0) unread.push(f.filename); continue; }
    for (const a of addedLines(f.patch)) if (DASH.test(a.text)) hits.push({ where: f.filename, line: a.line, text: a.text, file: true });
  }
  return { hits, unread };
}

async function main() {
  const env = process.env;
  for (const k of ['REPO', 'PR', 'GH_READ_TOKEN']) if (!env[k]) { console.error(`::error::${k} is not set`); process.exit(2); }
  const ctx = { repo: env.REPO, readToken: env.GH_READ_TOKEN, fetch: globalThis.fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() };
  const n = Number(env.PR);
  const pr = await gh(ctx, `/repos/${ctx.repo}/pulls/${n}`);
  const files = await ghAll(ctx, `/repos/${ctx.repo}/pulls/${n}/files`);
  const commits = await ghAll(ctx, `/repos/${ctx.repo}/pulls/${n}/commits`, 3);
  const protectedPaths = protectedIn(await baseAttributes(ctx, pr), files.map((f) => f.filename));
  const { hits, unread } = dashHits({ title: pr.title, body: pr.body, commits, files, protectedPaths });
  for (const u of unread) console.log(`::warning file=${u}::GitHub sent no patch for ${u} (too large or binary); its added lines were not checked`);
  const lines = [];
  for (const h of hits) {
    const at = h.file ? `${h.where}:${h.line}` : `${h.where}, line ${h.line}`;
    if (h.file) console.log(`::error file=${h.where},line=${h.line}::This line adds an em or en dash`);
    lines.push(`- ${at}: \`${h.text.trim().slice(0, 200).replace(/`/g, "'")}\``);
  }
  const summary = hits.length
    ? `${hits.length} added line(s) carry an em or en dash. Use a comma, colon, semicolon, parentheses or two sentences, and a hyphen for a range.\n\n${lines.join('\n')}\n`
    : 'No added line carries an em or en dash.\n';
  console.log(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  process.exit(hits.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error(`::error::public-text could not read the pull request: ${e.message}`); process.exit(2); });
}
