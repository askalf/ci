// Tests for the fuzz harness that need no fuzzer: every seed under fuzz/seeds/<target>/ goes through
// its target once, so a target that rots (an import that moved, a contract the code no longer keeps)
// fails the required test check and not only the weekly fuzz run, and the shared helpers keep a
// broken contract apart from a refusal. run.mjs is run against a stand-in for Jazzer, so its
// scheduling is checked here too. Run: node fuzz/seeds.test.mjs
// Most seeds are inputs a crash was found on; each must pass its target on the fixed code.

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Violation, attempt, fail, isRefusal } from './violation.js';

let pass = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? `\n${detail}` : ''}`); failed++; }
}

console.log('\n  a broken contract is never read as a refusal');
{
  const thrown = (f) => { try { f(); return null; } catch (e) { return e; } };
  check('fail throws a Violation, which is an Error but not a refusal', thrown(() => fail('x')) instanceof Violation && !isRefusal(new Violation('x')));
  check('a plain Error is a refusal; a TypeError and a RangeError are not', isRefusal(new Error('x')) && !isRefusal(new TypeError('x')) && !isRefusal(new RangeError('x')));
  check('a SyntaxError is a refusal only where the caller names it', !isRefusal(new SyntaxError('x')) && isRefusal(new SyntaxError('x'), [SyntaxError]));
  check('attempt returns the value, or the refusal', attempt(() => 7).value === 7 && attempt(() => { throw new Error('no'); }).refused.message === 'no');
  check('an assertion that fires inside attempt escapes it', thrown(() => attempt(() => fail('contract broken'))) instanceof Violation);
  check('so does a defect in the code under test', thrown(() => attempt(() => Reflect.get(null, 'x'))) instanceof TypeError);
}

console.log('\n  every seed passes its target');
{
  const root = fileURLToPath(new URL('.', import.meta.url));
  const targets = readdirSync(root).filter((f) => f.endsWith('.fuzz.js')).map((f) => f.replace(/\.fuzz\.js$/, '')).sort();
  check('there are targets', targets.length > 0, targets.join());
  for (const name of targets) {
    const { fuzz } = await import(new URL(`./${name}.fuzz.js`, import.meta.url));
    const dir = join(root, 'seeds', name);
    let seeds = [];
    try { seeds = readdirSync(dir); } catch { /* a target may have none */ }
    check(`${name} has a seed`, seeds.length > 0);
    for (const seed of seeds) {
      let error = null;
      try { fuzz(readFileSync(join(dir, seed))); } catch (e) { error = e; }
      check(`${name}/${seed}`, error === null, error && String(error.stack ?? error).split('\n').slice(0, 4).join('\n'));
    }
    // The empty input and a lone NUL are what a fuzzer tries first.
    for (const [label, bytes] of [['an empty input', Buffer.alloc(0)], ['a lone NUL byte', Buffer.from([0])]]) {
      let error = null;
      try { fuzz(bytes); } catch (e) { error = e; }
      check(`${name}: ${label}`, error === null, error && String(error.stack ?? error).split('\n').slice(0, 4).join('\n'));
    }
  }
}

console.log('\n  run.mjs schedules the targets as FUZZ_JOBS asks');
{
  // A copy of run.mjs in a scratch tree, with a stand-in Jazzer CLI where run.mjs resolves the real
  // one. The stand-in logs when each target starts and ends (with the corpus directory it was given),
  // prints two lines with a pause between, and exits with the number after `fail` in the target's
  // name (0 without one). A failing target ends after a tenth of the pause, so the others are still
  // running, unless its name has `late`. Targets started together may start in any order.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const stub = `const fs = require('node:fs'), path = require('node:path');
const name = path.basename(process.argv[2]).replace(/\\.fuzz$/, '');
const log = (e) => fs.appendFileSync(process.env.STUB_LOG, e + ' ' + name + ' ' + path.basename(process.argv[4]) + '\\n');
const code = Number((name.match(/fail(\\d+)/) || [0, 0])[1]);
const ms = Number(process.env.STUB_MS);
const wait = code && !name.includes('late') ? ms / 10 : ms;
log('start');
process.stdout.write('out ' + name + ' 1\\n');
// A target named big... prints 4 MB before its last line, so its log is still draining when it ends.
// Every target exits only once its last line is written: exit() can cut off output still in a pipe.
setTimeout(() => {
  if (name.startsWith('big')) process.stdout.write(('x'.repeat(1023) + '\\n').repeat(4096));
  process.stdout.write('out ' + name + ' 2\\n', () => { log('end'); process.exit(code); });
}, wait);
`;
  function run(names, jobs) {
    const root = mkdtempSync(join(tmpdir(), 'ci-fuzz-run-test-'));
    mkdirSync(join(root, 'fuzz'));
    for (const f of ['run.mjs', 'shebang-register.mjs', 'shebang-hooks.mjs', 'package.json']) copyFileSync(join(here, f), join(root, 'fuzz', f));
    for (const n of names) writeFileSync(join(root, 'fuzz', `${n}.fuzz.js`), '');
    const core = join(root, '.clusterfuzzlite', 'node_modules', '@jazzer.js', 'core');
    mkdirSync(join(core, 'dist'), { recursive: true });
    writeFileSync(join(root, '.clusterfuzzlite', 'package.json'), '{"private":true}');
    writeFileSync(join(core, 'package.json'), '{"name":"@jazzer.js/core","version":"0.0.0"}');
    writeFileSync(join(core, 'dist', 'cli.js'), stub);
    const logFile = join(root, 'log');
    writeFileSync(logFile, '');
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FUZZ_')));
    Object.assign(env, { FUZZ_SECONDS: '1', FUZZ_CORPUS_DIR: join(root, 'corpus'), STUB_LOG: logFile, STUB_MS: '1000' });
    if (jobs !== undefined) env.FUZZ_JOBS = jobs;
    const r = spawnSync(process.execPath, [join(root, 'fuzz', 'run.mjs')], { cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
    const events = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(' '));
    rmSync(root, { recursive: true, force: true });
    let now = 0;
    let most = 0;
    for (const [e] of events) { now += e === 'start' ? 1 : -1; most = Math.max(most, now); }
    const started = events.filter(([e]) => e === 'start').map(([, n]) => n);
    const ended = events.filter(([e]) => e === 'end').map(([, n]) => n);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, most, started, ended, events };
  }
  // Each target's header is followed directly by both of its lines.
  const grouped = (stdout, names) => names.every((n) => new RegExp(`=== fuzzing ${n} \\(1s\\) ===\\nout ${n} 1\\nout ${n} 2\\n`).test(stdout));
  const show = (r) => `status ${r.status}\n${r.stdout}${r.stderr}\n${r.events.map((e) => e.join(' ')).join('\n')}`;
  const ok = ['a_ok', 'b_ok', 'c_ok'];

  let r = run(ok);
  check('without FUZZ_JOBS the targets run one after another', r.status === 0 && r.most === 1 && r.started.join() === ok.join() && r.ended.length === 3, show(r));
  check('each target gets its own corpus directory', r.events.every(([, n, corpus]) => n === corpus), show(r));
  check('with one job each target is announced before its output', grouped(r.stdout, ok), show(r));

  r = run(ok, '3');
  check('FUZZ_JOBS=3 runs three targets at once', r.status === 0 && r.most === 3 && r.ended.length === 3, show(r));
  check('with more than one job each target prints as one block', grouped(r.stdout, ok), show(r));

  r = run(['a_ok', 'b_ok', 'c_ok', 'd_ok'], '2');
  check('FUZZ_JOBS=2 runs no more than two at once', r.status === 0 && r.most === 2 && r.ended.length === 4, show(r));

  for (const value of ['abc', '0', '-2']) {
    r = run(ok, value);
    check(`FUZZ_JOBS=${value} counts as 1`, r.status === 0 && r.most === 1 && r.ended.length === 3, show(r));
  }

  r = run(ok, '9');
  check('FUZZ_JOBS above the target count runs every target once', r.status === 0 && r.most === 3 && [...r.started].sort().join() === ok.join(), show(r));

  r = run(['a_ok', 'b_fail3', 'c_ok']);
  check('with one job a failure stops the run with its status', r.status === 3 && r.started.join() === 'a_ok,b_fail3', show(r));
  check('the failure names its target', /b_fail3: jazzer exited with 3/.test(r.stderr), show(r));

  r = run(['a_ok', 'b_fail3', 'c_ok'], '2');
  check('after a failure no queued target starts', r.status === 3 && !r.started.includes('c_ok'), show(r));
  check('a target already running finishes its budget', r.events.at(-1)?.slice(0, 2).join(' ') === 'end a_ok', show(r));

  r = run(['a_ok', 'b_fail3', 'c_ok'], '3');
  check('with every target running, all of them finish', r.status === 3 && r.ended.length === 3, show(r));

  r = run(['a_fail5', 'b_late_fail7'], '2');
  check('every failure is reported', /a_fail5: jazzer exited with 5/.test(r.stderr) && /b_late_fail7: jazzer exited with 7/.test(r.stderr), show(r));
  check('the run exits with the first failure\'s status', r.status === 5, show(r));

  r = run(['a_fail5', 'big_late_fail3'], '2');
  check('a failing target that ends last with a large log has all of it printed',
    r.status === 5 && r.stdout.length > 4 * 1024 * 1024 && r.stdout.trimEnd().endsWith('out big_late_fail3 2'),
    `status ${r.status}, ${r.stdout.length} bytes, ends ${JSON.stringify(r.stdout.slice(-80))}`);
}

console.log(`\n  ${pass} pass, ${failed} fail`);
if (failed > 0) process.exit(1);
