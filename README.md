# devkit

Shared GitHub Actions, reusable workflows, configs and the `devkit` CLI for
[gingur-root](https://github.com/gingur-root), and later the agent pipeline.
Standards and conventions: [`AGENTS.md`](./AGENTS.md). Design:
gingur-root/devkit#1.

| Piece                                                        | Use                                                                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `actions/toolchain.setup`                                    | Install the repo's declared runtimes with proto, then `pnpm install`.                   |
| `.github/workflows/toolchain.verify.yml`                     | Format, lint, typecheck, test, build.                                                   |
| `actions/secrets.fetch`                                      | Fetch Bitwarden secrets by UUID (`bitwarden/sm-action`).                                |
| `actions/app.token`                                          | A short-lived, narrowed token from the gingur-root pipeline App.                        |
| `actions/secrets.scan`, `.github/workflows/secrets.scan.yml` | Secret scanning with a pinned, checksum-verified gitleaks.                              |
| `.github/admission.txt`                                      | The admission gate every credential-holding job carries.                                |
| `configs/`                                                   | oxlint, oxfmt, tsconfig and lint-staged, via the `exports` map.                         |
| `bin/`                                                       | `devkit lint`, `fmt`, `staged`, `hooks install`, `agent …`.                             |
| `.github/workflows/agent.plan.yml`, `actions/agent.run`      | The plan stage: `agent:plan` or `/plan` → plan comment → Needs you.                     |
| `.github/workflows/agent.build.yml`                          | The build stage: `agent:build` on a ready plan → draft PR on `agent/issue-<n>` → Ready. |
| `agents/`, `skills/`                                         | Role instructions and the writing skills; a repo overrides any file under `.devkit/`.   |

```yaml
jobs:
  verify:
    uses: gingur-root/devkit/.github/workflows/toolchain.verify.yml@main
    with:
      runner: ${{ vars.RUNNER }}
```

```sh
pnpm install && pnpm hooks:install
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
- **Both:** the agent's env is an allowlist holding only its own credential, so
  an API key in the job never reaches it, and a run whose agent reports a
  non-subscription login stops.
- **Callers:** an agent with a shell (a Bash role, or any Codex run) can read
  its parent processes' env from `/proc`, so start the step with `exec env -i`
  and only the variables the run needs, never the job's whole env.

The SDKs are optional peer dependencies, so repos that use devkit only to
lint never install them. Agent jobs run devkit from its own checkout, where
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
