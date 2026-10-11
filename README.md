# devkit

Shared GitHub Actions, reusable workflows, configs and the `devkit` CLI for
[gingur-root](https://github.com/gingur-root), and later the agent pipeline.
Standards and conventions: [`AGENTS.md`](./AGENTS.md). Design:
gingur-root/devkit#1.

| Piece                                                          | Use                                                                   |
| -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `actions/toolchain.setup`                                      | Install the repo's declared runtimes with proto, then `pnpm install`. |
| `.github/workflows/toolchain.verify.yml`                       | Format, lint, typecheck, test, build.                                 |
| `actions/bitwarden.secrets.fetch`                              | Fetch Bitwarden secrets by UUID (`bitwarden/sm-action`).              |
| `actions/github.app.token`                                     | A short-lived, narrowed token from the gingur-root pipeline App.      |
| `actions/gitleaks.scan`, `.github/workflows/gitleaks.scan.yml` | Secret scanning with a pinned, checksum-verified gitleaks.            |
| `.github/admission.txt`                                        | The admission gate every credential-holding job carries.              |
| `configs/`                                                     | oxlint, oxfmt, tsconfig and lint-staged, via the `exports` map.       |
| `bin/`                                                         | `devkit lint`, `fmt`, `staged`, `hooks install`.                      |

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
