#!/bin/bash -eu
# Build the Jazzer.js fuzz targets for ClusterFuzzLite / OSS-Fuzz.
#
# The gate scripts here read text they do not control: the workflow files of the repositories
# they check, the pull request text and patches, the run records and verdict artifacts the GitHub
# API returns. Each target feeds hostile input into one of those paths and asserts its contract;
# see the header of each fuzz/*.fuzz.js.

cd "$SRC/ci"

# Jazzer.js comes from its own lockfile (.clusterfuzzlite/package-lock.json): the scripts take no
# dependencies and this repository has no package.json of its own. npm ci verifies every integrity
# hash in the lockfile. The modules are merged into a node_modules at the repository root, where
# compile_javascript_fuzzer expects to resolve them.
npm ci --prefix .clusterfuzzlite --no-audit --no-fund
mkdir -p node_modules
cp -r .clusterfuzzlite/node_modules/. node_modules/

# Jazzer.js 4.0.0 puts its coverage preamble above a module's first line, which makes a module
# that starts with a shebang a syntax error. The scripts keep theirs (they are also run directly),
# so this build image's copy loses it; fuzz/run.mjs does the same for the CI run with a load hook.
find scripts -name '*.mjs' -exec sed -i '1{/^#!/s|^#!|//|}' {} +

# The targets import scripts/ directly, so there is no build step.
for target in public_text workflow_check pin_yaml post_inputs; do
  compile_javascript_fuzzer ci "fuzz/${target}.fuzz.js"
done
