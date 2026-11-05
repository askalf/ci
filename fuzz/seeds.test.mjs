// Tests for the fuzz harness that need no fuzzer: every seed under fuzz/seeds/<target>/ goes through
// its target once, so a target that rots (an import that moved, a contract the code no longer keeps)
// fails the required test check and not only the weekly fuzz run, and the shared helpers keep a
// broken contract apart from a refusal. Run: node fuzz/seeds.test.mjs
// Most seeds are inputs a crash was found on; each must pass its target on the fixed code.

import { readdirSync, readFileSync } from 'node:fs';
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

console.log(`\n  ${pass} pass, ${failed} fail`);
if (failed > 0) process.exit(1);
