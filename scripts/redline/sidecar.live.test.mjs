// The dario sidecar of hosted mode, for real: the "Start the dario sidecar" step of
// redline-review.yml, as written there, against the pinned dario image and a stand-in lock
// service whose account registry holds one made-up seat.
// Run: node scripts/redline/sidecar.live.test.mjs   (needs docker and the image; see redline-sidecar-self-test.yml)
//
// What it proves that the stubbed tests in review.test.mjs cannot: that dario, started with
// nothing but the file the runner check writes, takes its seat from the registry and answers
// /health; that the step sees it ready; and that the key made for the run is the one dario asks
// for. It stops at dario's door: the seat is made up, and no model is called.
// Not in test-all.mjs or the `test` check: it pulls an image and runs a container.

import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// The image a test run pulls. Moved by hand with a dario release: a tag would move under the test.
export const DARIO_IMAGE = process.env.DARIO_IMAGE || 'ghcr.io/askalf/dario@sha256:6826f8f53d6269da39e9bd05aed3a72331f16bcf850a437c89b00ee807e33f71';
const CONTAINER = 'redline-dario';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}`); fail++; }
}

const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
if (docker('version', '--format', '{{.Server.Version}}').status !== 0) {
  console.log('  skip: no docker daemon here');
  process.exit(process.env.REQUIRE_DOCKER === '1' ? 1 : 0);
}

const wf = readFileSync(fileURLToPath(new URL('../../.github/workflows/redline-review.yml', import.meta.url)), 'utf8');
const step = wf.split(/\n      - /).slice(1).find((s) => s.startsWith('name: Start the dario sidecar\n')) ?? '';
const startRun = /run: \|\n((?: {10}.*\n?)+)/.exec(step)?.[1].replace(/^ {10}/gm, '') ?? '';
check('the start step is in the workflow', startRun.includes('docker run -d --name redline-dario'));

// The stand-in lock service. It answers the account registry with one seat and everything else
// with an empty object, which dario reads as nothing to adopt; a wrong bearer is refused.
const LOCK_TOKEN = randomBytes(16).toString('hex');
const seen = [];
const lock = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const authed = req.headers.authorization === `Bearer ${LOCK_TOKEN}`;
    seen.push({ url: req.url, authed });
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!authed) return send(401, { error: 'unauthorized' });
    if (req.url === '/accounts/list') {
      return send(200, { accounts: { hosted: { alias: 'hosted', accessToken: 'stand-in-access', refreshToken: 'stand-in-refresh', expiresAt: Date.now() + 6 * 3600_000, scopes: ['user:inference'], deviceId: 'd'.repeat(64), accountUuid: '00000000-0000-4000-8000-000000000001', grantedAt: Date.now() - 60_000 } }, removed: {} });
    }
    if (req.url === '/codex-accounts/list') return send(200, { accounts: {}, removed: {} });
    return send(200, {});
  });
});
await new Promise((r) => lock.listen(0, '0.0.0.0', r));
const gateway = docker('network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}').stdout.trim();
check('docker\'s bridge has a gateway the container can reach this process on', /^\d+\.\d+\.\d+\.\d+$/.test(gateway));

const dir = mkdtempSync(join(tmpdir(), 'redline-sidecar-'));
const envFile = join(dir, 'dario.env');
const key = randomBytes(32).toString('hex');
// The file the runner check writes (review.test.mjs holds it to these five settings), with the
// lock service's address this process's: the check itself takes only an https address.
writeFileSync(envFile, `DARIO_API_KEY=${key}\nDARIO_REFRESH_LOCK_URL=http://${gateway}:${lock.address().port}\nDARIO_REFRESH_LOCK_TOKEN=${LOCK_TOKEN}\nDARIO_POOL_SHARED_ACCOUNTS=1\nDARIO_POOL_SHARED_STATE=1\n`, { mode: 0o600 });

// Async, so this process keeps answering as the lock service while the step waits on dario.
const runStep = (file) => new Promise((resolve) => {
  const child = spawn('bash', ['-c', startRun], { env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '', DARIO_IMAGE, DARIO_ENV_FILE: file } });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  child.on('close', (status) => resolve({ status, out }));
});
// dario's own listing of its pool: it asks for the key and answers from memory, so the key is
// checked without a request leaving the runner.
const accounts = async (apiKey) => {
  try {
    const res = await fetch('http://127.0.0.1:3456/accounts', { headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(10_000) });
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  } catch (e) { return { status: `no answer (${e.message})`, body: null }; }
};

try {
  const started = Date.now();
  const up = await runStep(envFile);
  console.log(up.out.trimEnd().split('\n').map((l) => `    ${l}`).join('\n'));
  check(`the step ends ready (in ${Math.round((Date.now() - started) / 1000)} s)`, up.status === 0 && /the dario sidecar is ready/.test(up.out));
  check('dario read the account registry with the lock token', seen.some((s) => s.url === '/accounts/list' && s.authed) && seen.every((s) => s.authed));
  const logs = docker('logs', CONTAINER);
  check('dario took the seat from the registry', /added account "hosted"/.test(`${logs.stdout}${logs.stderr}`));
  const ports = docker('port', CONTAINER).stdout.trim();
  check('the container is published on loopback only', ports === '3456/tcp -> 127.0.0.1:3456');
  check('a key that is not the run\'s is refused', (await accounts('not-the-key')).status === 401);
  const withKey = await accounts(key);
  check('the run\'s key is accepted, and the pool dario lists is the registry\'s one seat',
    withKey.status === 200 && withKey.body?.accounts?.length === 1 && withKey.body.accounts[0].alias === 'hosted');

  // A registry with no seat for it: dario has nothing to serve and exits; the step says so.
  docker('rm', '-f', '-v', CONTAINER);
  const emptyFile = join(dir, 'empty.env');
  writeFileSync(emptyFile, readFileSync(envFile, 'utf8').replace(LOCK_TOKEN, 'not-the-token'), { mode: 0o600 });
  const down = await runStep(emptyFile);
  check('with a lock token the service refuses, the step fails and shows dario\'s last lines', down.status === 1 && /did not become ready/.test(down.out) && /Not authenticated|unreachable|401/.test(down.out));
} finally {
  docker('rm', '-f', '-v', CONTAINER);
  lock.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n  ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
