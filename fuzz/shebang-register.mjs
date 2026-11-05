// Registers shebang-hooks.mjs; run.mjs passes this file to node with --import, ahead of Jazzer.js.
import { register } from 'node:module';

register('./shebang-hooks.mjs', import.meta.url);
