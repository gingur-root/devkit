#!/usr/bin/env node
// The bin. Installs the TypeScript loader, then hands off to the real entry.
//
// This file stays JavaScript because it is what Node executes directly — the
// loader cannot transform the module that installs it.

import './loader.mjs';

await import('./cli.ts');
