import { build } from 'esbuild'

await build({
  entryPoints: ['./src/main.ts', './src/instrumentation.ts'],
  bundle: true,
  sourcemap: true,
  outdir: './dist',
  format: 'esm',
  platform: 'node',

  plugins: [
    {
      name: 'external-modules',
      setup(build) {
        build.onResolve(
          {
            // don't bundle anything that is NOT a relative import
            // WARNING: we can't use a negative lookahead/lookbehind because esbuild uses Go
            filter: /(?:^[^.])|(?:^\.[^/.])|(?:^\.\.[^/])/,
          },
          args => {
            // ignore tsconfig path imports
            if (args.path.startsWith('~')) return

            return { path: args.path, external: true }
          }
        )
      },
    },
  ],
})
