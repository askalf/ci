// Fuzz the public-text check's parsers: the pull request title and description, commit messages
// and the unified-diff patch GitHub sends for each changed file. All of it is written by whoever
// opened the pull request, a fork's author included, and the check reads it on every PR.
// Contracts: creditHits, addedLines and dashHits return their documented shapes for any text and
// never throw; every line addedLines reports starts with a plus in the patch; no hit is reported
// for a line that holds no dash; and no pattern takes super-linear time on a hostile line (the
// run reaches libFuzzer's timeout instead).
import { addedLines, creditHits, dashHits, needsContent, ownDescription } from '../scripts/redline/public-text.mjs';
import { fail } from './violation.js';

// Built from char codes so the source carries no dash of its own.
const DASH = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');

export function fuzz(data) {
  const text = data.toString('utf8');
  // One input is split into the fields a PR carries, on the NUL byte, so the engine can grow each
  // field on its own; fewer fields than needed read as empty.
  const [title = '', body = '', message = '', patch = '', name = ''] = text.split('\0');

  const added = addedLines(patch);
  if (!Array.isArray(added)) fail('addedLines did not return a list');
  const patchLines = new Set(patch.split('\n').filter((l) => l.startsWith('+')).map((l) => l.slice(1)));
  for (const a of added) {
    if (!Number.isInteger(a.line) || a.line < 0) fail(`addedLines gave a bad line number: ${a.line}`);
    if (typeof a.text !== 'string' || !patchLines.has(a.text)) fail('addedLines reported a line the patch does not add');
  }

  const commits = [{ sha: name, commit: { message } }, { sha: 1, commit: null }, { sha: undefined }];
  const credits = creditHits({ title, body, commits });
  if (!Array.isArray(credits)) fail('creditHits did not return a list');
  for (const h of credits) {
    if (typeof h.where !== 'string' || !Number.isInteger(h.line) || h.line < 1 || typeof h.text !== 'string') fail('creditHits returned a malformed hit');
  }
  // A text that names no tool and has no trailer cannot credit one.
  if (!/claude|anthropic|openai|chatgpt|gpt|copilot|codex|gemini|co-authored-by/i.test(`${title}\n${body}\n${message}`) && credits.length) {
    fail('creditHits reported a credit in text that names no tool');
  }

  const files = [
    { filename: `p/${name}`, status: 'modified', patch, changes: 1 },
    { filename: 'big.txt', status: 'added', changes: 3 },
    { filename: 'gone.txt', status: 'removed' },
    { filename: 'bin.png', status: 'added', changes: 0 },
  ];
  const protectedPaths = new Set(name ? [`p/${name}`] : []);
  const wide = needsContent(files, protectedPaths);
  if (!Array.isArray(wide) || wide.some((f) => typeof f.patch === 'string')) fail('needsContent returned a file that has a patch');
  // The unread path only: no contents are given for the wide file, so no git process is started.
  const { hits, unread, total } = dashHits({ title, body, commits, files, protectedPaths });
  if (!Array.isArray(hits) || !Array.isArray(unread)) fail('dashHits returned a malformed result');
  if (!Number.isInteger(total) || total < hits.length) fail('dashHits counted fewer lines than it reported');
  for (const h of hits) if (!DASH.test(h.text)) fail('dashHits reported a line with no dash');
  if (!unread.includes('big.txt')) fail('dashHits dropped a wide file whose contents were not read');

  if (ownDescription({ user: { type: 'Bot', login: 'dependabot[bot]' }, body }) !== '') fail('ownDescription kept a Dependabot description');
  if (ownDescription({ body }) !== body) fail('ownDescription changed a person\'s description');
}
