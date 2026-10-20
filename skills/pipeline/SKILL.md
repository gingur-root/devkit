---
name: pipeline
description: Use when Troy asks to run the pipeline in this session instead of on GitHub, or to plan, build and review an issue that is a file (under .devkit/issues/) rather than a GitHub issue.
---

# Pipeline

Run the GitHub pipeline (`docs/pipeline.md`) from a desk session. Each stage
is a fresh subagent with that stage's role files. You are the controller: you
hold the gates, run the checks, and do every GitHub write as Troy's `gh` user.
Role files and the result schema are devkit's own, so the session and the
GitHub pipeline can't drift apart.

## The pieces

| Pipeline on GitHub         | This session                                                                     |
| -------------------------- | -------------------------------------------------------------------------------- |
| Issue                      | `.devkit/issues/<slug>.md` in the target repo: what Troy wants and how he'd know |
| `$AGENT_IN` / `$AGENT_OUT` | One job dir in your scratchpad, `$JOB`                                           |
| `agent:build` / Continue   | Troy's yes to the plan in this session                                           |
| Plan, review, repair       | Subagents, as in the table below                                                 |
| Publish                    | You: branch, push, draft PR, PR reviews, issues                                  |

| Stage  | Subagent model (`bin/agent/roles.ts`) | Role files after `worker.md`, `contract.md` |
| ------ | ------------------------------------- | ------------------------------------------- |
| plan   | Opus 5.5                              | `plan.md`                                   |
| build  | Codex (preflight 2)                   | `build.md`                                  |
| review | Opus 5.5, read-only tools             | `review.md`                                 |
| repair | same as build                         | `build.md`, `repair.md`                     |
| retro  | Opus 5.5, read-only tools             | `retro.md`                                  |
| memory | Sonnet 5.5 (planned, devkit#260)      | `memory.md`, once it exists                 |

Use each role's effort from `bin/agent/roles.ts`. Every stage also gets each
`skills/*/SKILL.md` whose `roles:` line names it, and a repo's `.devkit/<path>`
replaces devkit's file of the same path. For review and repair, give the stage
the repo's `.devkit/` files from the build's base (for example,
`git show <base>:.devkit/agents/review.md`), never from the candidate worktree.
Codex builds and Claude reviews, so a
second model checks the first. A Claude build is allowed only when Troy says
so, and the PR then says Claude both built and reviewed it.

## Subagent prompt

Give every stage the same prompt shape. Never write the stage's work into it:
the role files are the instructions.

```text
You are the <stage> stage of the devkit pipeline, run from a desk session.
Read these files in order and follow them as your instructions:
<devkit>/agents/worker.md, <devkit>/agents/contract.md, <role files>, <skills>.
Skip the "This runner" section of worker.md. Instead:
- Job directory and output directory: $JOB. Repo: <worktree>.
- The issue is $JOB/issue.md. <stage inputs: plan.md, candidate.patch, review.json>
- Write only in $JOB: your report file, and the result envelope as $JOB/<stage>.json.
  It must parse with `Result` from <devkit>/bin/agent/result.ts.
- Don't commit, push, or call gh write commands. The controller publishes.
- Don't load the pipeline skill. You are one stage of it.
```

Check each envelope before you act on it:

```bash
node --input-type=module -e "import {readFileSync} from 'node:fs'; import {Result} from '<devkit>/bin/agent/result.ts'; Result.parse(JSON.parse(readFileSync('$JOB/<stage>.json','utf8')))"
```

A stage that fails the parse or writes no envelope has stopped (step 9).

Build and repair run on Codex, from the controller, with the same prompt.
`--output-schema` makes its last message the envelope, as the pipeline's Codex
run does:

```bash
node --input-type=module -e "import {RESULT_JSON_SCHEMA} from '<devkit>/bin/agent/result.ts'; console.log(JSON.stringify(RESULT_JSON_SCHEMA))" > $JOB/result.schema.json
codex exec -C <worktree> --add-dir $JOB -s danger-full-access -c model_reasoning_effort=high \
  --output-schema $JOB/result.schema.json -o $JOB/<stage>.json "<prompt>"
```

## Preflight

Run these once per session, before the first run's step 1. A later run in the
same session skips them when an earlier run already passed them. Each failure
names its fix; show Troy the fix and stop. Don't install anything yourself.

1. **GitHub user.** `gh api user -q .login` prints `gingur`. Fix:
   `gh auth login`.
2. **Codex.** `codex --version` runs and `codex login status` says logged in.
   Fix when `command -v codex` finds nothing:
   - `bash -lc 'command -v codex'` finds it: this session's PATH is missing
     Vite+'s bin. Use that path for `codex` in this run.
   - Otherwise: `vp install -g @openai/codex`.

   Fix when logged out: `codex login`.

3. **devkit.** A devkit checkout at the default branch's head, with
   `pnpm install` done. `<devkit>` in this skill means that checkout.

## Procedure

1. **Set up.** Make a
   worktree of the target repo from its default branch on
   `agent/<slug>`. If Troy gave the issue only in chat, write his words to
   `.devkit/issues/<slug>.md` yourself (`<slug>`: a few kebab-case words).
   Copy it to `$JOB/issue.md`. Record its revision:
   `git hash-object .devkit/issues/<slug>.md`.
2. **Plan.** Run the plan subagent.
   - `needs-input`: show Troy its questions and stop. He edits the issue
     file; you plan again.
   - `subtasks` (a story): write each one as its own
     `.devkit/issues/<slug>-<n>.md`, starting with the story's title and body.
     A story never builds. Stop and tell Troy to run each one.
   - `ready`: show Troy the plan's `summary` and ask for his yes.
3. **Approve.** Only Troy's yes to this plan starts the build. A yes given
   before the plan existed ("build it when it's ready") counts, like
   **Continue**, only if the plan is `ready` with no questions. If the issue
   file's revision changed since the plan, the plan is void: go back to 2.
4. **Build.** Run the build subagent with `$JOB/plan.md`.
   Then, as controller:
   - Commit the change without the issue file. If the issue file is on the
     default branch, `git rm` it in that commit, so the merge deletes it.
     Otherwise leave it untracked. Either way it never reaches main.
   - Merge the default branch in, confirm the push target is
     `agent/<slug>`, push, and open a draft PR. Its body is the build
     `summary`, then the issue and the plan.
5. **Review.** Run the review subagent on the pushed commit, with
   `candidate.patch` (`git diff <base>..<candidate>`). At the same time, run
   the repo's own checks (its `package.json` format, lint, typecheck, test
   and build scripts, as `toolchain.verify` does) and wait for PR CI on that
   commit. Red CI is a
   blocking `CI` finding. Post the review as one `COMMENT` review on the PR:
   `gh pr review <n> --comment --body-file $JOB/review.md`.
6. **Repair.** If the review requested changes and asked nothing, run the
   repair subagent with `review.json`. It must map every finding ID in
   `changes[].ref`. Comment what it changed on the PR, push, and review again
   (step 5). Cap: `REPAIR_ROUNDS` in `bin/agent/constants.ts` (2).
7. **Finish.** A pass (every axis passes, nothing blocking, no question, CI
   green) gets `gh pr ready <n>`. Anything else leaves the PR draft and goes
   to Troy, with the open blocking IDs: a question, an inconclusive review,
   findings left after the cap, or a repair that changed nothing. A pass merges
   only when `denyRules` (`bin/agent/merge.ts`) returns no stop; the deny
   table is in [the pipeline docs](../../docs/pipeline.md). A stopped PR is
   Troy's, or a project thread's under its merge policy.
8. **Follow-ups.** File each stage's `followups` as an issue in the repo with
   no label, at most 5 per stage. End each body with
   `<!-- devkit:followup <slug> <stage> -->`. Before filing, search for that
   marker and title, so a rerun files only what is missing.
9. **Retro.** When a stage fails or step 7 goes to Troy, run the retro
   subagent on `$JOB`. Tell it the run's files sit flat in `$JOB`
   (`issue.md`, `<stage>.json` and each report), not under `run/`, and that
   there is no `timeline.md`. Its `followups` become one issue labelled `retro` and
   `agent:plan`, in the target repo (devkit when the findings span repos),
   linking the PR. No findings: file nothing, and say so.
10. **Memory, after the PR merges.** Skip if
    `gh pr list -R gingur-root/pipeline --head memory/<repo>-<pr> --state all`
    finds one: the pipeline already ran it. Skip, and say so, if devkit has no
    `agents/memory.md` yet. Otherwise run the memory subagent with
    `gingur-root/pipeline/memory/` (`_org/` and `<repo>/`), the PR body and
    its diff. Apply its proposal on `memory/<repo>-<pr>` in a clone of
    `gingur-root/pipeline`, run `devkit memory index` and `check`, and open a
    PR there. Never write memory to main.

## Common mistakes

- Doing a stage yourself instead of in a subagent. You then review your own
  work.
- Treating "I'm in a hurry, get it merged" as a plan approval or a merge. A
  hurry changes nothing: plan, approve, build, review, ready, stop.
- Keeping the issue file in the PR, or never committing the change that
  deletes it.
- Writing session lessons to `agent-context/memory`. gingur-root facts go
  through step 10 only.
