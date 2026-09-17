import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    // Node-only. A separate entry point is what makes ApiKeyAuth structurally
    // unreachable from a browser bundle rather than merely discouraged.
    server: 'src/server.ts',
    react: 'src/react/index.ts',
    vue: 'src/vue/index.ts',
    utilities: 'src/utilities/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Frameworks are peer deps; `ws` is only reached from the server entry, where
  // it is a real Node dependency of the consumer's runtime.
  external: ['react', 'vue', 'ws'],
  // Bundle the ESM-only parser for CommonJS consumers, including early Node 20.
  // ESM consumers resolve it themselves to retain its smaller browser variant.
  noExternal: [/^micromark(?:-|$)/],
  esbuildOptions(options, { format }) {
    if (format === 'esm') {
      options.external = [...(options.external ?? []), 'micromark', 'micromark-*'];
    }
  },
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
});
