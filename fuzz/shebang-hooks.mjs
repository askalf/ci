// A module load hook that turns a leading `#!` line into a `//` comment, keeping every line number.
// Jazzer.js 4.0.0 instruments ES modules by putting its coverage preamble above the module's first
// line, which moves a shebang off line 1 and makes the module a syntax error. The scripts under
// test start with one because they are also run directly, so the fuzz run loads them through this
// hook, registered first so it runs before Jazzer's own (see shebang-register.mjs).
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (result.format !== 'module' || result.source == null) return result;
  const text = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  if (!text.startsWith('#!')) return result;
  return { ...result, source: `//${text.slice(2)}` };
}
