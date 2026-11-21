// The model bump: moves Redline's model pins to the newest model of each pin's family that dario
// lists, through a pull request in the repository that holds the pins.
//
// Every Redline run writes models.json (review.mjs, modelsRecord): the pins, the family each one
// tracks, and the whole model list dario served. Its artifact is redline-models, and the second
// lens's is redline-models-second. This reads the newest record of each lens from the completed
// runs of a repository's redline.yml, reads the lens's pins file from PINS_REPO's default branch,
// and moves each pin with a `<KEY>_TRACKS` line to the newest id of that family in the record's
// list (newestMatching). When a pin moves it opens one pull request on BRANCH with every move, or
// updates the open one; a pull request that already proposes the same files is left alone, so its
// review and checks are not restarted. The title carries [hold]: a person merges it.
//
// The new commit is built on the default branch's head and the branch is moved straight to it,
// never to the head itself: a branch moved to its base has no commits, and GitHub closes its open
// pull request.
//
// Environment (all set by .github/workflows/redline-model-bump.yml):
//   READ_TOKEN      reads the record repositories' runs and artifacts (the job's GITHUB_TOKEN)
//   WRITE_TOKEN     reads PINS_REPO and writes BRANCH and the pull request (the pin bump App)
//   PINS_REPO       owner/name of the repository with the pins files
//   RECORDS_FIRST   owner/name whose redline.yml runs carry the redline-models artifact
//   RECORDS_SECOND  owner/name whose redline.yml runs carry redline-models-second (empty: skipped)
//   BRANCH          the bump's branch in PINS_REPO
//   DRY_RUN         1: say what would move, write nothing
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gh, ghBytes, newestMatching, parseEnvFile, trackMatcher, MODEL_KEYS } from './review.mjs';
import { zipEntry } from './zip.mjs';

/** The two lenses: the artifact that carries each one's record, and its pins file in PINS_REPO. */
export const TARGETS = [
  { lens: 'first', artifact: 'redline-models', path: 'deploy/redline/redline-models.env', records: 'RECORDS_FIRST' },
  { lens: 'second', artifact: 'redline-models-second', path: 'deploy/redline/redline-second-models.env', records: 'RECORDS_SECOND' },
];
/** A record older than this says nothing about today's list. */
export const RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How many of the newest completed runs are searched for a record. */
export const RUNS_TO_READ = 30;
/** What a pin may be set to: a model id, never a line break or a shell character. */
const MODEL_ID = /^[A-Za-z0-9._:/-]+$/;

/**
 * The pins file with each tracked pin moved to its family's newest in `catalog`, and the moves.
 * A pin moves only when its key is on exactly one line, its family is valid, and the newest is a
 * model id other than the pin. Line endings and every other line are kept as they are. Pure.
 */
export function bumpPins(text, catalog) {
  const pins = parseEnvFile(text);
  const changes = [];
  let out = text;
  for (const key of MODEL_KEYS) {
    const tracks = pins[`${key}_TRACKS`];
    if (!tracks || !trackMatcher(tracks) || !Object.hasOwn(pins, key)) continue;
    const to = newestMatching(tracks, catalog);
    const from = pins[key];
    if (!to || to === from || !MODEL_ID.test(to)) continue;
    const line = new RegExp(`^${key}=[^\\r\\n]*`, 'gm');
    if ((out.match(line) ?? []).length !== 1) continue;
    out = out.replace(line, `${key}=${to}`);
    changes.push({ key, from, to, tracks });
  }
  return { text: out, changes };
}

/**
 * The newest usable record of `artifact` among `repo`'s completed redline.yml runs, newest first:
 * one with version 1 and a non-empty list, from a run started within maxAgeMs. Null when none.
 */
export async function newestRecord(ctx, { repo, artifact, maxRuns = RUNS_TO_READ, maxAgeMs = RECORD_MAX_AGE_MS }) {
  const runs = await gh(ctx, `/repos/${repo}/actions/workflows/redline.yml/runs?status=completed&per_page=${maxRuns}`);
  for (const run of runs?.workflow_runs ?? []) {
    if (ctx.now() - Date.parse(run.created_at) > maxAgeMs) break;
    const arts = await gh(ctx, `/repos/${repo}/actions/runs/${run.id}/artifacts`);
    const a = (arts?.artifacts ?? []).find((x) => x?.name === artifact && x.expired !== true && Number.isInteger(x.id));
    if (!a) continue;
    const entry = zipEntry(await ghBytes(ctx, `/repos/${repo}/actions/artifacts/${a.id}/zip`), 'models.json');
    if (!entry) continue;
    let record;
    try { record = JSON.parse(entry.toString('utf8')); } catch { continue; }
    if (record?.version !== 1 || !Array.isArray(record.catalog) || record.catalog.length === 0) continue;
    return { record, run: { id: run.id, url: run.html_url, at: run.created_at } };
  }
  return null;
}

/** The pull request's title: every pin it moves to, in the order of the moves. Pure. */
export function bumpTitle(moves) {
  const to = [...new Set(moves.flatMap((m) => m.changes.map((c) => c.to)))];
  return `[hold] redline: model pins to ${to.join(', ')}`;
}

/** The pull request's body: each move, the record it came from, and the list it was picked from. Pure. */
export function bumpBody(moves) {
  const lines = [
    'Moves Redline\'s model pins to the newest model of each pin\'s family that dario lists. Opened by the model bump (askalf/ci `.github/workflows/redline-model-bump.yml`); a person merges it, and the host deploy installs the files.',
    '',
  ];
  for (const m of moves) {
    lines.push(`**\`${m.path}\`** (the ${m.lens === 'first' ? 'first reviewer' : 'second lens'})`, '', '| Pin | Family | From | To |', '|---|---|---|---|');
    for (const c of m.changes) lines.push(`| \`${c.key}\` | \`${c.tracks}\` | \`${c.from || '(empty)'}\` | \`${c.to}\` |`);
    lines.push('', `From the models record of ${m.run.url} (${m.run.at}), which lists ${m.record.catalog.length} models:`, '', m.record.catalog.map((id) => `\`${id}\``).join(', '), '');
  }
  lines.push('Before this merges, the dario keys that read with these pins must allow each new model (`dario keys list` shows them).');
  return lines.join('\n');
}

/**
 * Write the moves to PINS_REPO: one commit on the default branch's head with every changed file,
 * BRANCH moved to it, and the pull request opened or updated. Returns what was done.
 */
export async function proposeBump(ctx, { repo, branch, base, baseSha, moves, existing }) {
  const write = { token: ctx.writeToken };
  const baseCommit = await gh(ctx, `/repos/${repo}/git/commits/${baseSha}`, write);
  const tree = [];
  for (const m of moves) {
    const blob = await gh(ctx, `/repos/${repo}/git/blobs`, { ...write, method: 'POST', body: { content: m.text, encoding: 'utf-8' } });
    tree.push({ path: m.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await gh(ctx, `/repos/${repo}/git/trees`, { ...write, method: 'POST', body: { base_tree: baseCommit.tree.sha, tree } });
  const message = `redline: model pins to ${[...new Set(moves.flatMap((m) => m.changes.map((c) => c.to)))].join(', ')}`;
  const commit = await gh(ctx, `/repos/${repo}/git/commits`, { ...write, method: 'POST', body: { message, tree: newTree.sha, parents: [baseSha] } });
  const ref = await ctx.fetch(`https://api.github.com/repos/${repo}/git/ref/heads/${branch}`, {
    headers: { authorization: `Bearer ${ctx.writeToken}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  });
  if (ref.status === 200) await gh(ctx, `/repos/${repo}/git/refs/heads/${branch}`, { ...write, method: 'PATCH', body: { sha: commit.sha, force: true } });
  else if (ref.status === 404) await gh(ctx, `/repos/${repo}/git/refs`, { ...write, method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
  else throw new Error(`GitHub GET /repos/${repo}/git/ref/heads/${branch}: HTTP ${ref.status}`);
  const title = bumpTitle(moves);
  const body = bumpBody(moves);
  if (existing) {
    await gh(ctx, `/repos/${repo}/pulls/${existing.number}`, { ...write, method: 'PATCH', body: { title, body } });
    return { outcome: 'updated', number: existing.number, url: existing.html_url, commit: commit.sha };
  }
  const pr = await gh(ctx, `/repos/${repo}/pulls`, { ...write, method: 'POST', body: { title, head: branch, base, body } });
  return { outcome: 'opened', number: pr.number, url: pr.html_url, commit: commit.sha };
}

/** A file's text at a ref of `repo`, with its blob sha; null when the file is absent. */
async function fileAt(ctx, repo, path, ref) {
  const res = await ctx.fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
    headers: { authorization: `Bearer ${ctx.writeToken}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET /repos/${repo}/contents/${path}: HTTP ${res.status}`);
  const body = await res.json();
  return { text: Buffer.from(String(body.content ?? ''), 'base64').toString('utf8'), sha: body.sha };
}

/** One run of the bump. Returns { outcome, ... } and says each step through ctx.log. */
export async function runBump(ctx, { pinsRepo, branch, records, dryRun }) {
  const repoInfo = await gh(ctx, `/repos/${pinsRepo}`, { token: ctx.writeToken });
  const base = repoInfo.default_branch;
  const head = await gh(ctx, `/repos/${pinsRepo}/git/ref/heads/${base}`, { token: ctx.writeToken });
  const baseSha = head.object.sha;
  const moves = [];
  for (const t of TARGETS) {
    const from = records[t.records] || '';
    if (!from) { ctx.log(`${t.lens} lens: no repository named for its records (${t.records}); skipped`); continue; }
    let found;
    try { found = await newestRecord(ctx, { repo: from, artifact: t.artifact }); } catch (e) {
      ctx.log(`::warning::${t.lens} lens: the records of ${from} could not be read (${e.message}); skipped`); continue;
    }
    if (!found) { ctx.log(`${t.lens} lens: no ${t.artifact} record in ${from}'s last ${RUNS_TO_READ} runs within ${RECORD_MAX_AGE_MS / 86_400_000} days; skipped`); continue; }
    const file = await fileAt(ctx, pinsRepo, t.path, baseSha);
    if (!file) { ctx.log(`::warning::${t.lens} lens: ${pinsRepo} has no ${t.path} at ${baseSha.slice(0, 7)}; skipped`); continue; }
    const { text, changes } = bumpPins(file.text, found.record.catalog);
    ctx.log(`${t.lens} lens: record of ${found.run.url} (${found.run.at}), ${found.record.catalog.length} models listed`);
    if (!changes.length) { ctx.log(`${t.lens} lens: every tracked pin in ${t.path} is the newest of its family`); continue; }
    for (const c of changes) ctx.log(`${t.lens} lens: ${c.key} ${c.from || '(empty)'} -> ${c.to} (newest ${c.tracks})`);
    moves.push({ ...t, text, changes, record: found.record, run: found.run });
  }
  if (!moves.length) return { outcome: 'current' };
  const open = await gh(ctx, `/repos/${pinsRepo}/pulls?state=open&head=${encodeURIComponent(`${pinsRepo.split('/')[0]}:${branch}`)}`, { token: ctx.writeToken });
  const existing = Array.isArray(open) && open.length ? open[0] : null;
  if (existing) {
    const same = await Promise.all(moves.map(async (m) => (await fileAt(ctx, pinsRepo, m.path, branch))?.text === m.text));
    if (same.every(Boolean)) return { outcome: 'proposed', number: existing.number, url: existing.html_url };
  }
  if (dryRun) return { outcome: 'dry-run', moves: moves.map((m) => ({ path: m.path, changes: m.changes })) };
  return proposeBump(ctx, { repo: pinsRepo, branch, base, baseSha, moves, existing });
}

async function main() {
  const env = process.env;
  const need = (k) => { if (!env[k]) { console.error(`::error::${k} is not set`); process.exit(2); } return env[k]; };
  const ctx = {
    readToken: need('READ_TOKEN'), writeToken: need('WRITE_TOKEN'),
    fetch: globalThis.fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(),
    log: (line) => console.log(line),
  };
  const result = await runBump(ctx, {
    pinsRepo: need('PINS_REPO'), branch: need('BRANCH'),
    records: { RECORDS_FIRST: env.RECORDS_FIRST || '', RECORDS_SECOND: env.RECORDS_SECOND || '' },
    dryRun: env.DRY_RUN === '1',
  });
  const line = result.outcome === 'current' ? 'Every model pin is the newest of its family; nothing to propose.'
    : result.outcome === 'proposed' ? `The open pull request already proposes these pins: ${result.url}`
      : result.outcome === 'dry-run' ? `Dry run, nothing written: ${JSON.stringify(result.moves)}`
        : `Model pins ${result.outcome}: ${result.url}`;
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error(`::error::The model bump failed: ${e.message}`); process.exit(2); });
}
