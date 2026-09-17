import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { allowedNodeEnvironmentFlags, execPath } from 'node:process';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));

for (const format of ['module', 'commonjs']) {
  test(`utilities render through the published ${format} export`, () => {
    // Earlier Node 20 releases cannot require ESM at all; later releases need
    // this flag so a leftover require('micromark') cannot pass accidentally.
    const flags = allowedNodeEnvironmentFlags.has('--no-experimental-require-module')
      ? ['--no-experimental-require-module']
      : [];
    const load =
      format === 'module'
        ? "import { markdownToHtml } from '@better-claw/sdk/utilities';"
        : "const { markdownToHtml } = require('@better-claw/sdk/utilities');";
    execFileSync(
      execPath,
      [
        ...flags,
        `--input-type=${format}`,
        '--eval',
        `${load}\nif (markdownToHtml('# Hello') !== '<h1>Hello</h1>') throw new Error('Unexpected HTML');`,
      ],
      { cwd: root, stdio: 'pipe' },
    );
  });
}

function bundle(contents, minify = false) {
  return build({
    stdin: { contents, resolveDir: root },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    external: ['react', 'vue', 'ws'],
    minify,
    write: false,
    metafile: true,
  });
}

for (const entry of ['@better-claw/sdk', '@better-claw/sdk/react', '@better-claw/sdk/vue']) {
  for (const format of ['esm', 'cjs']) {
    test(`${entry} (${format}) excludes the Markdown parser`, async () => {
      const source = format === 'esm' ? `export * from '${entry}';` : `module.exports = require('${entry}');`;
      const result = await bundle(source);
      // Follow shared chunks and dependencies, not just the entry-point file.
      for (const input of Object.keys(result.metafile.inputs)) {
        assert.doesNotMatch(input, /micromark|[/\\]utilities[./\\]/);
      }
      // The CommonJS build can inline the parser into an existing SDK module.
      assert.doesNotMatch(result.outputFiles[0].text, /\b(?:micromark|markdownToHtml)\b/);
    });
  }
}

for (const [name, source, limit] of [
  ['client and auth', "export { BetterClawClient, SessionTokenAuth } from '@better-claw/sdk';", 5_500],
  ['utilities', "export { markdownToHtml } from '@better-claw/sdk/utilities';", 20_000],
]) {
  test(`${name} stays within its gzip budget`, async () => {
    const result = await bundle(source, true);
    const size = gzipSync(result.outputFiles[0].contents).length;
    assert.ok(size <= limit, `${name}: ${size} bytes gzipped exceeds the ${limit}-byte budget`);
  });
}
