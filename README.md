# devkit

Shared GitHub Actions, reusable workflows, configs and the `devkit` CLI for
[gingur-root](https://github.com/gingur-root), and later the agent pipeline.
Standards and conventions: [`AGENTS.md`](./AGENTS.md). Using the pipeline:
[`docs/pipeline.md`](./docs/pipeline.md). Design:
gingur-root/devkit#1.

| Piece                                                        | Use                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `actions/toolchain.setup`                                    | Install Vite+, the repo's Node.js and package manager, then its dependencies.                           |
| `.github/workflows/toolchain.verify.yml`                     | Format, lint, typecheck, test, build.                                                                   |
| `actions/secrets.fetch`                                      | Fetch Bitwarden secrets by UUID (`bitwarden/sm-action`).                                                |
| `actions/app.token`                                          | A short-lived, narrowed token from the gingur-root pipeline App.                                        |
| `actions/agent.token`                                        | The agents' sealed, read-only token for every repo the App reaches.                                     |
| `actions/secrets.scan`, `.github/workflows/secrets.scan.yml` | Secret scanning with a pinned, checksum-verified gitleaks.                                              |
| `.github/admission.txt`                                      | The admission gate every credential-holding job carries.                                                |
| `configs/`                                                   | The Vite+ preset (lint, fmt, staged) and tsconfig, via the `exports` map.                               |
| `bin/`                                                       | `devkit agent …`. Lint, format and hooks are `vp`.                                                      |
| `.github/workflows/agent.plan.yml`, `actions/agent.run`      | The plan stage: `agent:plan` or `/plan` → plan comment → Needs you.                                     |
| `.github/workflows/agent.build.yml`                          | The build stage: `/approve` (or `agent:build`) on a ready plan → draft PR on `agent/issue-<n>` → Ready. |
| `agents/`, `skills/`                                         | Role instructions and per-role skills; a repo overrides or adds them under `.devkit/`.                  |

```yaml
jobs:
  verify:
    uses: gingur-root/devkit/.github/workflows/toolchain.verify.yml@main
    with:
      runner: ${{ vars.RUNNER }}
```

```sh
pnpm install && pnpm exec vp config
pnpm fmt:check && pnpm lint && pnpm typecheck && pnpm test
```

## `devkit agent run`

Runs one role (`bin/agent/roles.ts`) on the runner's own `claude` or `codex`
through the vendor SDKs, on the subscription login only. The run gets only what
the role declares:

- **Claude:** no settings files, CLAUDE.md, plugins, skills, account connectors
  or auto-memory, and only the role's built-in tools (so no subagents).
- **Codex:** account apps, remote plugins, hooks, memories, subagents and
  bundled skills off. The run stops if the Codex home holds a `config.toml` or
  `AGENTS.md`, or isn't a ChatGPT login.
- **Both:** the agent's env is an allowlist holding its subscription credential
  and the role's declared MCP credentials. Ambient API keys never reach it,
  and a run whose agent reports a non-subscription login stops.
- **Callers:** an agent with a shell (a Bash role, or any Codex run) can read
  its parent processes' env from `/proc`, so start the step with `exec env -i`
  and only the variables the run needs, never the job's whole env.

The SDKs are optional peer dependencies, so repos that use devkit only for its
configs never install them. Agent jobs run devkit from its own checkout, where
they're dev dependencies.

```sh
devkit agent run --role hello --prompt 'Say hello.'                  # role's executor
devkit agent run --role hello --executor codex --prompt 'Say hello.' # override it
```

A pipeline stage adds `--in` (the job file and `issue.md` from `devkit agent
render`) and `--out`, where a role with a result writes `result.json`.
`devkit agent publish` validates it against the live issue, upserts the
stage's marker comment, removes the label and sets the card's Status.
`--executor stub` writes a fixture result (`DEVKIT_STUB_FIXTURE=ready|invalid`)
so a smoke run of the chain takes seconds.

Output is one JSON object per line (`init`, `message`, `tool`, `result`,
`error`); the exit code is non-zero when the run fails.

## Agent tools

Add `.devkit/tools.json` to the target repo to declare MCP servers and required
CLIs. Without the file, devkit uses its defaults: keyless Context7 at
`https://mcp.context7.com/mcp` for plan, build, repair, replan, review and verify,
and no required CLIs. Web search follows the role's `web` setting, independently
of MCP servers: on for plan, build, repair, replan, review and verify, off for retro
and hello. There is no research role.

`agent render` reads the manifest from the job's trusted commit
(`job.base ?? job.source`) and writes it as `tools.json` in the job directory.
Plan and build use the default branch; review and repair use the build's base.
A candidate's manifest cannot change configs or credential requests. A manifest
change takes effect after it merges. Local and eval runs without `tools.json`
in the job directory use the defaults.

Instruction and skill overrides under `.devkit/` come from the same trusted
commit. `agent render` copies the role's instruction files and each skill's
`SKILL.md` into `overrides/` in the job directory. `agent run` reads overrides
only from there, never from the candidate checkout. Override changes take
effect after merge. Local and eval runs without job-directory overrides use
devkit's own instructions and skills.

For every role, `agent render` also copies `memory/_org/` and the target repo's
folder from `gingur-root/pipeline` at one `main` commit into the job directory's
`memory/`, with a joined `INDEX.md` generated from entry frontmatter. `job.memory` records that commit, or is null
until `pipeline/memory/` exists. Each render step uses a separate `MEMORY_TOKEN`
scoped to `pipeline` with only `contents: read`. Desk runs use the usual GitHub
credential when `MEMORY_TOKEN` is unset.

```json
{
  "mcpServers": {
    "docsApi": {
      "url": "https://docs.example.com/mcp",
      "secret": "11111111-1111-4111-8111-111111111111",
      "roles": ["plan", "review"]
    },
    "localDocs": {
      "command": "docs-mcp",
      "args": ["--stdio"],
      "secret": "22222222-2222-4222-8222-222222222222",
      "env": "MCP_DOCS_API_KEY",
      "roles": ["build", "repair"]
    },
    "context7": {
      "url": "https://mcp.context7.com/mcp",
      "roles": []
    }
  },
  "clis": ["docs-mcp"]
}
```

The zod schema rejects unknown fields, invalid URLs or UUIDs, and unknown roles.
An invalid manifest stops the run with its validation error.

| Field              | Meaning                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcpServers`       | Map of server names to configs; defaults to `{}`. Names start with a lowercase letter and contain only letters and digits.                        |
| `url` or `command` | Exactly one is required: a streamable HTTP URL or a nonempty stdio command.                                                                       |
| `args`             | String array of stdio arguments; defaults to `[]`.                                                                                                |
| `secret`           | Optional Bitwarden `agents` secret UUID. Omit it for a keyless server.                                                                            |
| `env`              | Optional credential env name matching `^MCP_[A-Z0-9_]+$`. Defaults to `MCP_<SCREAMING_SNAKE_NAME>_TOKEN`; `docsApi` becomes `MCP_DOCS_API_TOKEN`. |
| `roles`            | Required array of allowed roles: `hello`, `plan`, `build`, `repair`, `review`, `replan`, `verify`, `memory`, `retro`. `[]` turns the server off.  |
| `clis`             | Required CLI names on PATH for every role; defaults to `[]`. A missing executable stops the run with `<name> is not on PATH.`                     |

Repo entries add new servers or replace a default's whole config by name.
To turn a default off, replace it with its URL or command and `"roles": []`.
CLI requirements are the union of defaults and repo entries, with duplicates
removed.

Inspect the selected role's Claude and Codex configs before running it:

```sh
devkit agent tools --role plan --in /path/to/job
devkit agent tools --role plan --in /path/to/job --secrets
```

The first command prints `{claude, codex, secrets}` as JSON. The second prints
`<uuid> > <ENV_NAME>` lines for `secrets.fetch`; it prints no credential values.
The stub executor's `init` event also prints both configs and agent env names.

`agent.run` fetches only the role's requested UUIDs from Bitwarden `agents`,
with `setEnv: false`. It passes the resulting JSON in `DEVKIT_MCP_SECRETS` to
the run process. Providers select only that role's credential env vars and
drop the JSON bag before starting the agent. A missing credential stops a
Claude or Codex run. The stub needs no credential
values, even for a credentialed manifest. For a local Claude or Codex run,
supply the same JSON object keyed by credential env name.

Claude gets a temporary mode-600 `--mcp-config` file containing `${VAR}`
references, removed after success or failure. HTTP servers receive
`Authorization: Bearer ${VAR}`; stdio servers receive `env: {VAR: "${VAR}"}`.
Codex gets `bearer_token_env_var` for HTTP or `env_vars` for stdio through SDK
config overrides, plus a shell-env exclusion for those names. Credential
values stay out of the provider config arguments. A role with a shell can
still read credentials held by its process; this is role scoping.

GitHub reads use #182's per-run App installation token (#125) (`GH_TOKEN`,
`contents: read`), rather than a PAT or a second App. That token is minted
per run outside this manifest and is not stored in Bitwarden `agents`.
The defaults have no `github` MCP server. #182 covers the read-only credential.

Skills keep their existing registry: frontmatter `roles:` in
`skills/<name>/SKILL.md`, with repo replacements or additions under
`.devkit/skills/`. Instructions inline the selected skills; nothing is copied
to `~/.codex`. `plain-english` covers plan, build, repair, review
and retro; `simple-english` covers build and repair. Playwright and
frontend-design remain follow-up work for later manifest entries.
