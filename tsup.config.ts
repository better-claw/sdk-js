import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    // Node-only. A separate entry point is what makes ApiKeyAuth structurally
    // unreachable from a browser bundle rather than merely discouraged.
    server: 'src/server.ts',
    react: 'src/react/index.ts',
    vue: 'src/vue/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Frameworks are peer deps; `ws` is only reached from the server entry, where
  // it is a real Node dependency of the consumer's runtime.
  external: ['react', 'vue', 'ws'],
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
});
