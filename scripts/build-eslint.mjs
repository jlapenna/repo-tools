import { build } from 'esbuild';

await build({
  bundle: true,
  entryPoints: ['eslint/src/index.ts'],
  format: 'esm',
  outfile: 'eslint/index.mjs',
  packages: 'external',
  platform: 'node',
});
