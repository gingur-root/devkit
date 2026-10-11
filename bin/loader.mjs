// Lets devkit ship real TypeScript.
//
// Node refuses to strip types for any file under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) — deliberately, to discourage
// packages from shipping TypeScript — and that is exactly where a consumer runs
// devkit from. nodejs/node#57215 is closed `not_planned`, so there is nothing to
// wait for. A loader is the only way to author .ts here without a build step.
//
// oxc-transform rather than tsx: no install script (tsx pulls esbuild, whose
// blocked postinstall prints a warning on every consumer install), a third the
// size, and the same vendor as the oxlint/oxfmt already pinned here — one
// release stream to track instead of two.
//
// Imported for side effects: `import './loader.mjs'` installs the hook.

import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import { transformSync } from 'oxc-transform';

// ESM TypeScript only. `.cts` is deliberately absent: it would need
// `format: 'commonjs'` below, and nothing here is CommonJS.
const TYPESCRIPT = /\.(?:m?ts|tsx)$/;

process.setSourceMapsEnabled(true);

registerHooks({
  load(url, context, nextLoad) {
    if (!TYPESCRIPT.test(new URL(url).pathname)) return nextLoad(url, context);

    const path = fileURLToPath(url);
    const { code, map, errors } = transformSync(path, readFileSync(path, 'utf8'), {
      sourcemap: true,
    });

    // oxc's parser recovers from syntax errors and RETURNS them rather than
    // throwing, so without this a broken file yields silently wrong code.
    if (errors.length > 0) {
      throw new SyntaxError(`${path}\n${errors.map((e) => e.message).join('\n')}`);
    }

    // Not optional for a CLI: without the map, a stack trace points at the
    // post-transform line and sends you to the wrong place in the source.
    const inline = map
      ? `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(
          JSON.stringify(map),
        ).toString('base64')}\n`
      : '';

    return { format: 'module', source: code + inline, shortCircuit: true };
  },
});
