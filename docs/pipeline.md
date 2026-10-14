# Using the agent pipeline

How to take an issue from idea to merged PR with the agents. Only Troy can
start a stage: every job checks the actor, so labels or comments from anyone
else do nothing. The one exception is the board loop below, which as the
pipeline App may add `agent:plan` and nothing else.

A repo is enrolled when it has a thin `agents.yml` caller (see
[scratch's](https://github.com/gingur-root/scratch/blob/main/.github/workflows/agents.yml))
and the `RUNNER` and `PIPELINE_APP_ID` vars.

## The flow

| Step               | You do                                                                                                   | The pipeline does                                                                                      | Board card       |
| ------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------- |
| 1. File            | Open an issue: what you want and how you'd know it's done. Add `ready-for-agent` to put it on the board. | The board adds the card.                                                                               | Ask              |
| 2. Plan            | Nothing: the board loop starts it. To jump the queue, add `agent:plan` or comment `/plan`.               | Writes one plan comment, removes the label.                                                            | Planning         |
| 3. Answer          | Read the plan. If it asks questions, edit the issue to answer them, then `agent:plan` again.             | Rewrites the same plan comment.                                                                        | Needs you        |
| 4. Approve / build | When the plan says **ready for `agent:build`**, add `agent:build`. That label is the approval.           | Builds on `agent/issue-<n>`, opens a draft PR, comments a link, removes the label.                     | Building → Ready |
| 5. Review / merge  | If the review passed, merge the PR, or have a project thread merge it. Otherwise answer its findings.    | In the same run, Claude reviews the PR; Codex fixes findings, up to 2 rounds; then ready or Needs you. | Ready → Done     |

Anything that stops a run (a failed check, a missing result, a push error, a
cancelled run or a lost runner) posts **"… stopped at `<stage>`"** on the
stage's comment and moves the card to **Needs you**. When the agent's CLI said
why it stopped, the comment names the class (`rate_limit` with its reset time,
`overloaded`, `server_error`, `timeout` or `unknown`). Fix the cause, then add
the label again. Every comment that leaves a card in **Needs you** or
**Ready** mentions @gingur, so the notification arrives then.

## The board loop

`pnpm agent loop` (`bin/agent/loop.ts`, devkit#47) keeps cards moving with no
polling. It runs as the last job of every plan and build run, however the run
ended, and when Troy adds `ready-for-agent`. Each tick on a repo:

1. If the run left its card in **Planning** or **Building** (it was cancelled,
   or died before it published), it says where it stopped and moves the card to
   **Needs you**.
2. If no card in the repo is planning, it adds `agent:plan` to the oldest open
   `ready-for-agent` card in **Ask**, but only if Troy added that label.

Each decision, including what it skipped, goes in the job summary. It never
touches a card in **Needs you**, **Ready** or **Done**, and never runs on the
WSL desk. `--dry-run` prints the decisions without acting.

An enrolled repo's caller runs `agent.loop.yml` on `ready-for-agent` (see
scratch's). If the VPS is down for more than 24 hours, the loop's own job
expires in GitHub's queue and a card can sit until the repo's next event.

## Review and merge stage

The build run also reviews its own PR, so your approval stays the only thing
you add. Claude (Opus 5.5) reviews the exact commit the build pushed, checking
Correctness, Spec and Standards, and posts the result as a PR review. At the
same time `toolchain.verify` runs the repo's own checks (format, lint,
typecheck, test, build) on that same commit, so an enrolled repo needs every
script it runs.

- **Pass** (every axis passes, no blocking finding, no question, and CI green
  on the reviewed commit): the PR is marked ready for review and the card
  stays in **Ready**. Red CI adds a blocking `CI` finding to the review, which
  Codex then fixes like any other. The review comment
  on the issue says it's ready to merge.
- **Changes requested, nothing to ask you:** Codex fixes the findings and
  pushes a new commit to the same PR, then Claude reviews the whole change
  again. The card stays in **Building** meanwhile, and the issue gets a
  **Repair** comment with what Codex changed. This repeats up to 2 rounds
  (`REPAIR_ROUNDS` in `bin/agent/constants.ts`).
- **Anything else** (a question for you, an inconclusive review, findings left
  after 2 rounds, or a repair that changed nothing): the review comment says
  the PR needs your call, and the card moves to **Needs you**.

The pipeline never merges. Merging is yours, or a Claude project thread's under
the project's merge policy. The board moves the card to **Done** when the PR
merges.

## Retros

When a plan or build run fails, or a review leaves the card in **Needs you**,
the same run ends with a retro (`agent.retro.yml`). Claude reads the issue
thread, the card's history, each job's result and each agent's transcript,
then posts one **Retro** comment: what went wrong and the fix it suggests for
each finding (a check, a doc, a persona prompt, a setting).

- It only suggests. It changes no label, card, branch or PR. To act on a
  fix, open an issue for it and run it through plan and build as usual.
- One retro per run. A plan that asks you questions gets none, since that is
  the normal flow.
- It can't read the Actions log, so a job that died before its agent wrote
  anything shows up only as `failure`; the retro names the step to check.
- Elevated runs get no retro yet.

## Elevated runs (the WSL desk)

For a plan that needs Troy's own admin access (a new provider, an org setting,
his browser), add `agent:elevated` instead of `agent:build`. The run goes to
the one runner on his WSL desk, which runs as him and which GitHub lets only
`agent.elevated.yml` on main use.

1. The card goes to **Needs you** with "Queued for the WSL desk".
2. On WSL, run `elevated on` (setup in infra's runbook). It takes that one job
   and exits. Until then the job waits in GitHub's queue, which cancels it
   after 24 hours.
3. Claude carries out the plan with his access, gating each outside write on a
   named rollback. Repo changes come back as a draft PR from the App, as a
   build would. There is no review stage.

`needs:elevated` marks an issue an agent says needs the desk. It starts
nothing; add `agent:elevated` yourself.

**Desk-only repos (infra).** A repo the App must never reach passes
`runner: wsl` to `agent.plan.yml` and `agent.elevated.yml` (see
[infra's caller](https://github.com/gingur-root/infra/blob/main/.github/workflows/agents.yml)).
Every job then runs on the desk, so nothing happens until `elevated on`, and
Troy's own `gh` writes the comments, moves the card and opens the draft PR.
There is no `agent:build`: `agent:elevated` is the approval.

**Repo persona and skills.** A repo replaces any role file by committing the
same path under `.devkit/` (infra's `.devkit/agents/elevated.md`). A skill is
`skills/<name>/SKILL.md` with a `roles: plan, elevated` frontmatter line; a
repo adds one, or replaces devkit's, under `.devkit/skills/<name>/`.

## Measuring a prompt or skill change

Every skill and instruction line costs tokens on every run, so a change to a
role's instructions or skills should show it helps. scratch's `eval/` holds
fixed cases (a feature, a bug, a docs change, a refactor, and one with a
missing requirement where the plan should ask). `agent eval` runs each one
through plan, build, review and repair the way the pipeline does, but locally
on a fresh copy and with no GitHub writes, then scores it against a hidden
check the agents never see.

1. Run scratch's **Eval** workflow twice, from Actions or with:

   ```bash
   gh workflow run agents.eval.yml -R gingur-root/scratch -f devkitRef=main
   gh workflow run agents.eval.yml -R gingur-root/scratch -f devkitRef=<your-branch>
   ```

2. Paste both scorecards from the runs' summaries into the PR.

The scorecard has, per case: the plan's outcome, whether the hidden check
passes, the last review, whether the review passed a change the check fails,
repair rounds, tokens and minutes. A full run took about 11 minutes on
the first try, more when reviews ask for repairs. Runs go one at a time, and
a live pipeline run may wait behind one for a runner. Case format:
scratch's `eval/README.md`.

## Proving a devkit branch

Never point scratch's main caller at a branch: every other run on scratch
would run that branch too. Run the proof by hand from your own scratch branch
instead. scratch's main and its issue events stay on devkit main.

1. Branch scratch, and in `.github/workflows/agents.yml` change each
   `agent.*.yml@main` and `devkitRef: main` to your devkit branch. Push it.
   Don't open a PR.
2. Run one stage on a scratch issue:

   ```bash
   gh workflow run agents.yml -R gingur-root/scratch --ref <scratch-branch> \
     -f stage=plan -f issue=<n> -f executor=stub
   ```

   `stage` is `plan` or `build`. Leave out `executor` to run the real agents.

3. Delete the scratch branch when you are done.

The build still starts from scratch's main, so its PR holds only the agent's
change. Composite actions (`actions/*@main`) and `agent:elevated` always run
devkit main.

## Known limits

- **Re-run doesn't work.** Jobs only run on a run's first attempt, so the
  Actions "Re-run" button skips everything. Add the label again instead.
- **Editing the issue or the plan comment voids the plan.** `agent:build`
  refuses until you run `agent:plan` again. It says why in a comment and
  removes its label, so add it again once the plan is ready.
- **A workflow-file change on main blocks a build retry.** If main changed
  anything under `.github/workflows/` since the branch was made, the push to
  `agent/issue-<n>` is rejected (the App has no `workflows` permission). Close
  the PR and delete the branch, then add `agent:build` again.
- **A repair needs the branch as reviewed.** If anyone pushes to
  `agent/issue-<n>` while a repair runs, its push is rejected and the card
  stops in Needs you.
- **No `/revise` yet.** It passes the gate but no stage handles it; edit the
  issue and re-plan instead.
- **One run per card at a time.** A second label while one runs waits in the
  queue.
