# devkit: standards

The single instruction source for gingur-root's devkit (shared GitHub Actions,
reusable workflows, configs, the `devkit` CLI and, later, the agent pipeline)
and for the repos that call it. `CLAUDE.md` imports this file. The design is
in gingur-root/devkit#1.

## Principles

These override anything below that conflicts with them.

- **Simple first.** The minimal implementation that works and is easy to
  understand. Delete before adding.
- **OSS and built-ins first.** An official action, an OSS tool or a built-in
  GitHub feature before code of our own.
- **Reusable and composable.** Small single-purpose pieces (composites, CLI
  commands) that combine.
- **Test only what's critical:** where a failure would be silent or dangerous
  (the admission gate; the loader, tools, router and hooks code). Prove the rest
  by running it.
- **Break fast, fix fast.** A loud failure and a quick fix over defensive code.
- **No forks.** Nothing supports or routes fork PRs; admission keeps everyone but
  the owner off every credential-holding job.

## Naming

| Tier                                                | Convention                                                         | Examples                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| **File names** (workflows, action dirs)             | `lowercase.dot.notation`, broad → specific: `<subject>.<action…>`  | `toolchain.verify.yml`, `secrets.scan.yml`, `actions/secrets.fetch/` |
| **Identifiers** (inputs, outputs, job and step ids) | `camelCase`, one word when possible                                | `token`, `appId`, `repositories`, `verify`                           |
| **Env vars and secrets**                            | `SCREAMING_SNAKE_CASE`, spelled the way the provider spells itself | `BWS_PIPELINE_TOKEN`, `PIPELINE_APP_ID`                              |

- Name by subject, never by provider: `secrets.fetch`, not
  `bitwarden.secrets.fetch`. The provider is an internal detail, or an input
  if a subject ever has more than one. Compound lifecycles add dots, never
  hyphens.
- Actions are named for intent (`verify`, `scan`, `fetch`), not trigger (`ci`).
- No kebab-case or snake_case identifiers. Prefix an input with its provider
  only when a surface spans several providers.
- A workflow and the composite under it share a name: `secrets.scan.yml` over
  `actions/secrets.scan/`.

## Repo structure

```
.github/workflows/   reusable workflows — uses: gingur-root/devkit/.github/workflows/<name>.yml@main
actions/             composite actions  — uses: gingur-root/devkit/actions/<name>@main
configs/             shared tool configs (oxlint, oxfmt, tsconfig, …)
bin/                 the `devkit` CLI — the local half of the same contract
  commands/          one file per command; the path IS the command
```

- **`bin/` ships as source, never built.** Consumers install devkit as a git
  dependency (`github:gingur-root/devkit#main`), so whatever is committed is what
  runs. No bundler, no `prepare` script — adding an install lifecycle would
  force consumers into a pnpm `onlyBuiltDependencies` entry.
- **`bin/` is TypeScript, and it runs via a loader — not Node's own stripping.**
  Node refuses to strip types for any file under `node_modules`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), which is exactly where a
  consumer runs devkit from. That is deliberate, it applies to `.ts`/`.mts`/`.cts`
  alike on Node 22 and 24, no flag lifts it, and
  [nodejs/node#57215](https://github.com/nodejs/node/issues/57215) is closed
  `not_planned` — there is nothing to wait for. So `bin/devkit.mjs` installs
  `bin/loader.mjs` (oxc-transform via `module.registerHooks`) and imports
  `cli.ts`. `devkit.mjs`, `loader.mjs` and `tools.mjs` stay JavaScript because
  the loader cannot transform the files that install it.
  - **oxc-transform, not tsx:** no install script (tsx pulls esbuild, whose
    blocked `postinstall` prints a warning on every consumer install), a third
    the size, and the same vendor as the `oxlint`/`oxfmt` pinned here. It is
    pre-1.0 and its API has already churned — **pin it exactly**, as with
    `oxfmt`.
  - **Two details in `loader.mjs` fail silently if removed.** oxc _returns_
    syntax errors instead of throwing, so without the `errors.length` check a
    broken file yields wrong code; and without the inline sourcemap every stack
    trace points at the post-transform line. `bin/loader.test.ts` pins both.
  - **The loader does no type checking.** `tsc --noEmit` in `verify` is the only
    thing that does.
  - **Beware a fixture that appears to disprove all this.** A dependency-free
    package gets symlinked _outside_ `node_modules` and strips fine; devkit has
    dependencies, so it does not. Test with `pnpm pack` + install the tarball,
    and assert `readlink -f` lands inside `node_modules`.
- **`bin/tools.mjs` must stay JavaScript.** It is the one module loaded from two
  runtimes: the CLI (which has the loader) and lint-staged, which devkit spawns
  as a plain `node` child with no loader, reaching it through
  `configs/lint-staged.config.js`. A `.ts` there breaks every consumer's
  pre-commit hook. Its types live in `bin/tools.d.mts`.
- **Nothing invokes a managed tool by bare name.** oxlint, oxfmt, lint-staged
  are devkit's `dependencies`, so under pnpm they are absent from a
  consumer's `node_modules/.bin`. Every call goes through `bin/tools.mjs`, which
  resolves them from devkit's own tree. A bare `oxlint` passes devkit's own CI
  (where it _is_ linked) and fails for every consumer — `bin/tools.test.ts`
  exists to catch exactly that.
- **Commands are files.** `bin/commands/hooks/install.ts` is
  `devkit hooks install`; `bin/router.ts` discovers the tree and registers it
  on Commander. Adding a command means adding a file and nothing else, and
  `bin/router.test.ts` asserts the tree matches the registered paths so a file
  cannot silently fail to register. An `index.ts` in a directory describes the
  group rather than being a command.
- **Every command declares a `kind`, and the two are opposites.**
  `passthrough` (`lint`, `fmt`, `staged`) means devkit parses _nothing_ after
  the subcommand — that blindness is the escape hatch that lets
  `devkit lint --fix` reach oxlint, and it is why those commands also disown
  `--help`. `parsed` (`hooks install`, and every command added later) means
  devkit owns the flags and an unknown one is a usage error. Getting this wrong
  fails silently: the router would swallow `--fix` and oxlint would never see it.
- **Command modules stay thin and are imported eagerly.** Commander needs option
  specs at registration time to build help and reject unknown flags, so lazy
  per-command loading is not available. Keep heavy work (clients, schemas)
  behind a lazy `import()` _inside_ the handler instead — see
  `commands/hooks/install.ts`.
- **Workflows are thin glue** over single-purpose composite actions. Logic that's
  reused across workflows is extracted to a composite so it lives **once**.
- **One concern per action.** If a workflow grows conditionals for a second
  concern, that concern probably wants its own workflow/action.

## Jobs & steps

- **Job id:** camelCase, one word when possible; the human `name:` is Title
  Case.
- **Step id:** camelCase, one word, added only when a later step reads its
  outputs.
- Jobs don't share env, so each job that needs a credential fetches it itself,
  and only the secrets it uses.

## Errors & guards

Prefer **natural errors** over defensive validation. Don't guard or pre-check
conditions that can't occur when things are wired correctly — especially internal
inputs set by our own workflows. Let the underlying tool (the GitHub API,
Bitwarden, an agent CLI) surface its own error; a clear natural failure beats a
hand-formatted one for something that shouldn't fail once defined right.

Reserve explicit handling for genuinely fallible operations (network / API calls)
— and there, surface the **real** underlying error (e.g. the API's error body),
don't replace it with a generic message.

## Availability: single box by choice

The pipeline runs on one VPS, an accepted single point of failure. When it's
down, the `local` runners and everything routed to them are down too. Don't
design redundancy or failover; document the actual behavior and move on.

## Action pinning

Pin by who can move the tag:

- **gingur-root's own** actions and workflows → `@main`.
- **A credible org** (`actions`, `bitwarden`, `moonrepo`, `cloudflare`) → a
  version tag (`@v3`).
- **An individual maintainer** → a full commit SHA with a version comment.
- **A release binary** (gitleaks, actionlint) → a pinned version and its
  SHA-256 from the release's checksums file.

The org allows only `actions/*`, `bitwarden/*`, `cloudflare/*`,
`gingur-root/*`, `moonrepo/*` and `pulumi/*` (gingur-root/infra
`src/constants.ts`). A repeatedly used third-party action lives in one
composite, so it's bumped once.

## Credentials

- **Every secret comes from Bitwarden**, through `secrets.fetch` (in
  CI, by UUID) or `bws` (on the box). No per-repo GitHub secrets.
- **Two tokens, two tiers.** Agent jobs hold only `BWS_AGENTS_TOKEN` (the
  `agents` project). Pipeline jobs hold `BWS_PIPELINE_TOKEN` (`pipeline`: the
  App key, the run-records R2 keys). An agent job never references the pipeline
  token.
- **GitHub writes** go through `app.token`: a short-lived installation
  token for the gingur-root pipeline App, narrowed per call by its
  `permission*` inputs. The App has no `workflows` permission.
- Never print, echo or commit a secret value.

## Admission

`.github/admission.txt` is the gate: owner ID, actor ID, first attempt, and an
event allowlist. Every credential-holding job's `if:` is that expression, or a
top-level `&&` with `(<admission>)` as one operand, e.g.
`always() && (<admission>) && (<route>)`. Never `||` at the top level.
`test/admission.test.ts` pins the text and checks every job in
`.github/workflows/`; change both together, deliberately.

## Runners

- devkit is public: its own CI runs on GitHub-hosted runners, always.
- Callers route with `runner: ${{ vars.RUNNER }}` (the org variable, `local`).
  A caller repo's variables don't resolve inside a cross-repo reusable workflow,
  so a caller that omits the input runs GitHub-hosted.

## Consumer standards

### Toolchain

Runtime and package-manager versions live in the consumer repo (`.nvmrc`,
`.bun-version`, `package.json` `packageManager`/`devEngines`) and are shared by
local development and CI. `actions/toolchain.setup` installs them with proto.

### Reusable workflows

| Goal                                 | Call                                                             |
| ------------------------------------ | ---------------------------------------------------------------- |
| Format, lint, typecheck, test, build | `gingur-root/devkit/.github/workflows/toolchain.verify.yml@main` |
| Scan for secrets                     | `gingur-root/devkit/.github/workflows/secrets.scan.yml@main`     |

### Shared configs are live

Consumers import devkit's configs through the `exports` map
(`"@gingur-root/devkit": "github:gingur-root/devkit#main"`).
`toolchain.setup` runs `pnpm update @gingur-root/devkit` after its frozen
install, so CI always runs against the specifier's head; **CI is
authoritative**. Shared-config changes land backward-compatible or roll out
everywhere the same day.

**`ignorePatterns` in `configs/oxlintrc.base.json` does not reach consumers.**
oxlint honours that key only from a config at the repo root, so
`bin/commands/lint.ts` reads the list and passes it as `--ignore-pattern` flags.
Don't "fix" an ignore problem by adding patterns to the shared config.

### Pre-commit

`devkit hooks install` writes `.githooks/pre-commit` and points
`core.hooksPath` at it. **Commit `.githooks/`; being tracked is the point.** The
hook body lives at `.husky/<hook>`: `devkit staged`, then
`gitleaks git --pre-commit --staged --redact --no-banner` (gitleaks on PATH).
husky itself is gone: its generated, gitignored `.husky/_` doesn't exist in a
`git worktree`, and git silently runs no hook when `core.hooksPath` is missing.
The shim finds `devkit` in the worktree or the main checkout and fails loudly
when it can't. CI (`secrets.scan.yml`) is the backstop for `--no-verify`.

**`hooks install` sets the exec bit twice, and both are load-bearing.** Removing
either one reproduces the silent skip this replaced husky to avoid, so do not
"simplify" it to one call — that regressed once already.

- `chmodSync` — the filesystem bit, which git checks before running the hook in
  _this_ checkout. `copyFileSync` carries the source's mode, but `pnpm pack`
  normalises everything except `package.json` `bin` entries to 644, so a
  tarball-installed consumer has `shim.sh` at 644. The next `git add` then drags
  the tracked mode down to match, so the staged bit alone is not durable either.
- `git update-index --add --chmod=+x` — the tracked bit, which every _other_
  checkout receives. On Windows `chmodSync` cannot set a POSIX bit and Git for
  Windows runs `core.filemode=false`, so the recorded mode would be `100644`.

Every git call _after the first_ passes the resolved repo root as its cwd — the
first cannot, since it is the one resolving the root. `prepare` runs wherever
dependencies are installed, which in a workspace is a package subdirectory, and
`update-index` takes a path relative to the process directory; run from the
wrong one it fails after writing the shim and before setting `core.hooksPath`.
