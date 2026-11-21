// Tests for scripts/redline/model-bump.mjs against a stubbed GitHub. Run: node scripts/redline/model-bump.test.mjs
// Nothing leaves the machine.

import { deflateRawSync } from 'node:zlib';
import { bumpPins, newestRecord, bumpTitle, bumpBody, runBump, TARGETS, RECORD_MAX_AGE_MS } from './model-bump.mjs';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}`); fail++; }
}

/** A zip of one entry, deflated: what an Actions artifact download holds. */
function makeZip(name, text) {
  const data = Buffer.from(text, 'utf8');
  const body = deflateRawSync(data);
  const n = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + n.length + body.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + n.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, n, body, central, n, eocd]);
}

const SEAT = ['claude-fable-5-1', 'claude-fable-5-2', 'claude-opus-5', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'gpt-5.6-terra', 'gpt-6-astra',
  'gpt-6-sol', 'gpt-6.1-terra', 'gpt-6.2-astra', 'gpt-6.2-sol'];
const FIRST = [
  '# pins', 'REDLINE_MODEL_TRACKS=gpt-*-sol', 'REDLINE_MODEL=gpt-5.6-terra', '', 'REDLINE_DEEP_MODEL_TRACKS=gpt-*-astra', 'REDLINE_DEEP_MODEL=gpt-6-astra',
  'REDLINE_PIN_MODEL_TRACKS=gpt-*-terra', 'REDLINE_PIN_MODEL=gpt-5.6-terra', 'REDLINE_FALLBACK_MODEL_TRACKS=gpt-*-astra', 'REDLINE_FALLBACK_MODEL=gpt-6-astra', '',
].join('\n');
const SECOND = ['REDLINE_MODEL_TRACKS=claude-opus-*', 'REDLINE_MODEL=claude-opus-5-5', 'REDLINE_DEEP_MODEL_TRACKS=claude-fable-*', 'REDLINE_DEEP_MODEL=claude-fable-5-2', 'REDLINE_PIN_MODEL=', ''].join('\n');

console.log('\n  bumpPins: each tracked pin to its family\'s newest');
{
  const { text, changes } = bumpPins(FIRST, SEAT);
  check('each pin moves to the newest of its family', changes.map((c) => `${c.key}:${c.from}>${c.to}`).join() ===
    'REDLINE_MODEL:gpt-5.6-terra>gpt-6.2-sol,REDLINE_DEEP_MODEL:gpt-6-astra>gpt-6.2-astra,REDLINE_PIN_MODEL:gpt-5.6-terra>gpt-6.1-terra,REDLINE_FALLBACK_MODEL:gpt-6-astra>gpt-6.2-astra');
  check('only the pin lines change: comments, families and blank lines stay',
    text.split('\n').length === FIRST.split('\n').length && text.includes('# pins\n') && text.includes('REDLINE_MODEL_TRACKS=gpt-*-sol\n') && text.includes('REDLINE_MODEL=gpt-6.2-sol\n'));
  check('a file already at the newest moves nothing', bumpPins(text, SEAT).changes.length === 0 && bumpPins(text, SEAT).text === text);
  check('a pin with no family, or an empty untracked pin, stays', bumpPins(SECOND, SEAT).changes.map((c) => c.key).join() === '' && bumpPins(SECOND, SEAT).text === SECOND);
  check('a family nothing in the list matches leaves its pin', bumpPins('REDLINE_MODEL_TRACKS=gpt-*-nova\nREDLINE_MODEL=gpt-6-sol\n', SEAT).changes.length === 0);
  check('an empty pin with a family is filled', bumpPins('REDLINE_PIN_MODEL_TRACKS=gpt-*-terra\nREDLINE_PIN_MODEL=\n', SEAT).text === 'REDLINE_PIN_MODEL_TRACKS=gpt-*-terra\nREDLINE_PIN_MODEL=gpt-6.1-terra\n');
  check('a key on two lines is not guessed at', bumpPins('REDLINE_MODEL_TRACKS=gpt-*-sol\nREDLINE_MODEL=gpt-6-sol\nREDLINE_MODEL=gpt-6-sol\n', SEAT).changes.length === 0);
  check('an indented second assignment counts as a second line, as the env parser reads it', (() => {
    const two = 'REDLINE_MODEL_TRACKS=gpt-*-sol\nREDLINE_MODEL=gpt-6-sol\n REDLINE_MODEL = gpt-6-sol\n';
    const r = bumpPins(two, SEAT);
    return r.changes.length === 0 && r.text === two;
  })());
  check('one indented assignment is the key\'s line, rewritten', bumpPins('REDLINE_MODEL_TRACKS=gpt-*-sol\n  REDLINE_MODEL = gpt-6-sol\n# REDLINE_MODEL=gpt-5-sol\n', SEAT).text
    === 'REDLINE_MODEL_TRACKS=gpt-*-sol\nREDLINE_MODEL=gpt-6.2-sol\n# REDLINE_MODEL=gpt-5-sol\n');
  check('a family that is not a family moves nothing', bumpPins('REDLINE_MODEL_TRACKS=gpt-6-sol\nREDLINE_MODEL=gpt-5\n', SEAT).changes.length === 0);
  const crlf = bumpPins('REDLINE_MODEL_TRACKS=gpt-*-sol\r\nREDLINE_MODEL=gpt-6-sol\r\n', SEAT);
  check('CRLF line endings are kept', crlf.text === 'REDLINE_MODEL_TRACKS=gpt-*-sol\r\nREDLINE_MODEL=gpt-6.2-sol\r\n');
  check('a pin ahead of the record\'s list is never moved back', bumpPins('REDLINE_MODEL_TRACKS=gpt-*-sol\nREDLINE_MODEL=gpt-6.3-sol\n', SEAT).changes.length === 0);
  check('the same version spelled another way is not moved', bumpPins('REDLINE_MODEL_TRACKS=gpt-*-sol\nREDLINE_MODEL=gpt-6.2.0-sol\n', SEAT).changes.length === 0);
  check('a pin outside its family moves into it', bumpPins('REDLINE_MODEL_TRACKS=gpt-*-sol\nREDLINE_MODEL=gpt-5.6-terra\n', SEAT).changes.map((c) => c.to).join() === 'gpt-6.2-sol');
  check('the second lens moves to the newest Opus and Fable, past [1m]', bumpPins(SECOND.replace('claude-fable-5-2', 'claude-fable-5-1'), SEAT).changes.map((c) => c.to).join() === 'claude-fable-5-2');
}

/** A stubbed GitHub. `routes` answers GET paths; every other call is recorded in `writes`. */
function fakeGitHub({ now, runs = {}, artifacts = {}, zips = {}, files = {}, branchFiles = {}, branchExists = false, openPulls = [], failRuns = new Set() }) {
  const writes = [];
  const reads = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const p = u.pathname;
    const method = init.method ?? 'GET';
    if (method !== 'GET') {
      const body = init.body ? JSON.parse(init.body) : null;
      writes.push({ method, path: p, body, token: init.headers.authorization });
      if (p.endsWith('/git/blobs')) return json({ sha: `blob-${writes.length}` }, 201);
      if (p.endsWith('/git/trees')) return json({ sha: 'tree-new' }, 201);
      if (p.endsWith('/git/commits')) return json({ sha: 'c0ffee' }, 201);
      if (p.endsWith('/pulls') && method === 'POST') return json({ number: 9, html_url: 'https://github.com/o/pins/pull/9' }, 201);
      return json({});
    }
    reads.push({ path: p, token: init.headers.authorization });
    let m;
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/redline\.yml\/runs$/.exec(p))) {
      if (failRuns.has(m[1])) return new Response('nope', { status: 403 });
      return json({ workflow_runs: runs[m[1]] ?? [] });
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/artifacts$/.exec(p))) return json({ artifacts: artifacts[m[1]] ?? [] });
    if ((m = /^\/repos\/[^/]+\/[^/]+\/actions\/artifacts\/(\d+)\/zip$/.exec(p))) return new Response(zips[m[1]], { status: 200 });
    if (p === '/repos/o/pins') return json({ default_branch: 'main' });
    if (p === '/repos/o/pins/git/ref/heads/main') return json({ object: { sha: 'base000' } });
    if (p === '/repos/o/pins/git/ref/heads/redline/model-bump') return branchExists ? json({ object: { sha: 'old' } }) : json({ message: 'Not Found' }, 404);
    if (p === '/repos/o/pins/git/commits/base000') return json({ tree: { sha: 'tree-base' } });
    if (p === '/repos/o/pins/pulls') return json(openPulls);
    if ((m = /^\/repos\/o\/pins\/contents\/(.+)$/.exec(p))) {
      const ref = u.searchParams.get('ref');
      const src = ref === 'base000' ? files : branchFiles;
      const text = src[m[1]];
      if (text === undefined) return json({ message: 'Not Found' }, 404);
      return json({ content: Buffer.from(text).toString('base64'), sha: `sha-${m[1]}` });
    }
    return json({ message: `unrouted ${p}` }, 404);
  };
  const logs = [];
  const ctx = { readToken: 'read-tok', writeToken: 'write-tok', fetch, sleep: async () => {}, now: () => now, log: (l) => logs.push(l) };
  return { ctx, writes, reads, logs };
}

const NOW = Date.parse('2026-11-21T12:00:00Z');
const rec = (lens, catalog = SEAT) => JSON.stringify({ version: 1, lens, catalog, pins: {}, tracks: {}, newest: {}, behind: [] });
const run = (id, hoursAgo) => ({ id, html_url: `https://github.com/r/r/actions/runs/${id}`, created_at: new Date(NOW - hoursAgo * 3_600_000).toISOString() });

console.log('\n  newestRecord: the newest usable models record');
{
  const { ctx } = fakeGitHub({
    now: NOW,
    runs: { 'r/r': [run(1, 1), run(2, 2), run(3, 3), run(4, 4)] },
    artifacts: { 1: [{ id: 11, name: 'redline-verdict' }], 2: [{ id: 21, name: 'redline-models', expired: true }], 3: [{ id: 31, name: 'redline-models' }], 4: [{ id: 41, name: 'redline-models' }] },
    zips: { 31: makeZip('models.json', '{not json'), 41: makeZip('models.json', rec('first')) },
  });
  const found = await newestRecord(ctx, { repo: 'r/r', artifact: 'redline-models' });
  check('runs without the artifact, an expired one and unreadable JSON are passed over', found?.run.id === 4 && found.record.catalog.length === SEAT.length);
  const empty = fakeGitHub({ now: NOW, runs: { 'r/r': [run(5, 1)] }, artifacts: { 5: [{ id: 51, name: 'redline-models' }] }, zips: { 51: makeZip('models.json', rec('first', [])) } });
  check('a record with an empty list is no record', (await newestRecord(empty.ctx, { repo: 'r/r', artifact: 'redline-models' })) === null);
  const old = fakeGitHub({ now: NOW, runs: { 'r/r': [run(6, 24 * 8)] }, artifacts: { 6: [{ id: 61, name: 'redline-models' }] }, zips: { 61: makeZip('models.json', rec('first')) } });
  check('a record older than the age limit is no record', (await newestRecord(old.ctx, { repo: 'r/r', artifact: 'redline-models' })) === null && RECORD_MAX_AGE_MS === 7 * 86_400_000);
}

console.log('\n  the pull request\'s title and body');
{
  const where = { id: 4, url: run(4, 4).html_url, at: run(4, 4).created_at };
  const moves = [{ lens: 'first', path: 'deploy/redline/redline-models.env', changes: bumpPins(FIRST, SEAT).changes, record: { catalog: SEAT }, run: where }];
  check('the title names every pin it moves to, once, with [hold]', bumpTitle(moves) === '[hold] redline: model pins to gpt-6.2-sol, gpt-6.2-astra, gpt-6.1-terra');
  const body = bumpBody(moves);
  check('the body has a row per move, the record\'s run and the whole list',
    body.includes('| `REDLINE_MODEL` | `gpt-*-sol` | `gpt-5.6-terra` | `gpt-6.2-sol` |') && body.includes(`${where.url} (${where.at})`) && body.includes('`claude-opus-5-5[1m]`') && body.includes('dario keys'));
}

/** A full GitHub: records for both lenses and the two pins files at the base. */
const full = (over = {}) => fakeGitHub({
  now: NOW,
  runs: { 'r/first': [run(1, 1)], 'r/second': [run(2, 1)] },
  artifacts: { 1: [{ id: 11, name: 'redline-models' }], 2: [{ id: 21, name: 'redline-models-second' }] },
  zips: { 11: makeZip('models.json', rec('first')), 21: makeZip('models.json', rec('second')) },
  files: { [TARGETS[0].path]: FIRST, [TARGETS[1].path]: SECOND.replace('claude-fable-5-2', 'claude-fable-5-1') },
  ...over,
});
const opts = { pinsRepo: 'o/pins', branch: 'redline/model-bump', records: { RECORDS_FIRST: 'r/first', RECORDS_SECOND: 'r/second' }, dryRun: false };

console.log('\n  runBump: the pull request in the pins repository');
{
  const g = full();
  const r = await runBump(g.ctx, opts);
  check('it opens one pull request with both files', r.outcome === 'opened' && r.number === 9);
  const blobs = g.writes.filter((w) => w.path.endsWith('/git/blobs'));
  const tree = g.writes.find((w) => w.path.endsWith('/git/trees'));
  const commit = g.writes.find((w) => w.path.endsWith('/git/commits'));
  const ref = g.writes.find((w) => w.path.includes('/git/refs'));
  const pull = g.writes.find((w) => w.path.endsWith('/pulls'));
  check('one commit on the base head, its tree on the base tree, with both files', blobs.length === 2 && tree.body.base_tree === 'tree-base'
    && tree.body.tree.map((t) => t.path).join() === `${TARGETS[0].path},${TARGETS[1].path}` && commit.body.parents.join() === 'base000');
  check('the new file texts are the moved pins', blobs[0].body.content.includes('REDLINE_MODEL=gpt-6.2-sol\n') && blobs[1].body.content.includes('REDLINE_DEEP_MODEL=claude-fable-5-2\n'));
  check('a missing branch is created at the new commit, never at the base', ref.method === 'POST' && ref.body.ref === 'refs/heads/redline/model-bump' && ref.body.sha === 'c0ffee');
  check('the pull request is from the branch to the default branch, held', pull.body.head === 'redline/model-bump' && pull.body.base === 'main' && pull.body.title.startsWith('[hold] '));
  const recordReads = g.reads.filter((x) => x.path.includes('/actions/'));
  check('every write uses the write token and every record read, the artifact download among them, the read token',
    g.writes.every((w) => w.token === 'Bearer write-tok') && recordReads.some((x) => x.path.endsWith('/zip'))
    && recordReads.length > 0 && recordReads.every((x) => x.token === 'Bearer read-tok'));
}
{
  const g = full({ branchExists: true, openPulls: [{ number: 7, html_url: 'https://github.com/o/pins/pull/7' }], branchFiles: { [TARGETS[0].path]: 'older', [TARGETS[1].path]: 'older' } });
  const r = await runBump(g.ctx, opts);
  const ref = g.writes.find((w) => w.path.includes('/git/refs'));
  check('an open pull request that proposes other files is updated: the branch forced to the new commit, the pull request edited',
    r.outcome === 'updated' && r.number === 7 && ref.method === 'PATCH' && ref.body.force === true && ref.body.sha === 'c0ffee'
    && g.writes.some((w) => w.method === 'PATCH' && w.path === '/repos/o/pins/pulls/7') && !g.writes.some((w) => w.method === 'POST' && w.path === '/repos/o/pins/pulls'));
}
{
  const firstNew = bumpPins(FIRST, SEAT).text;
  const secondNew = bumpPins(SECOND.replace('claude-fable-5-2', 'claude-fable-5-1'), SEAT).text;
  const g = full({ branchExists: true, openPulls: [{ number: 7, html_url: 'https://github.com/o/pins/pull/7' }], branchFiles: { [TARGETS[0].path]: firstNew, [TARGETS[1].path]: secondNew } });
  const r = await runBump(g.ctx, opts);
  check('an open pull request that already proposes the same files is left alone', r.outcome === 'proposed' && r.number === 7 && g.writes.length === 0);
}
{
  const g = full({ files: { [TARGETS[0].path]: bumpPins(FIRST, SEAT).text, [TARGETS[1].path]: SECOND } });
  const r = await runBump(g.ctx, opts);
  check('pins already at the newest open nothing', r.outcome === 'current' && g.writes.length === 0 && g.logs.some((l) => l.includes('every tracked pin')));
}
{
  const g = full();
  const r = await runBump(g.ctx, { ...opts, dryRun: true });
  check('a dry run writes nothing and says what would move', r.outcome === 'dry-run' && g.writes.length === 0 && r.moves.length === 2);
}
{
  const g = full();
  const r = await runBump(g.ctx, { ...opts, records: { RECORDS_FIRST: 'r/first', RECORDS_SECOND: '' } });
  const pathsOut = g.writes.find((w) => w.path.endsWith('/git/trees'))?.body.tree.map((t) => t.path) ?? [];
  check('a lens with no records repository is skipped, the other still bumps', r.outcome === 'opened' && pathsOut.join() === TARGETS[0].path && g.logs.some((l) => /second lens: no repository/.test(l)));
}
{
  const g = full({ failRuns: new Set(['r/second']) });
  const r = await runBump(g.ctx, opts);
  check('records that cannot be read are a warning for that lens only', r.outcome === 'opened' && g.logs.some((l) => /::warning::second lens: the records of r\/second could not be read/.test(l)));
}
{
  const g = full({ files: { [TARGETS[0].path]: FIRST } });
  const r = await runBump(g.ctx, opts);
  check('a pins file that is not in the repository is a warning, and the other file still bumps', r.outcome === 'opened' && g.logs.some((l) => /second lens: o\/pins has no deploy\/redline\/redline-second-models\.env/.test(l)));
}

console.log(`\n  ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
