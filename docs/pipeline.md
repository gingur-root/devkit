# Using the agent pipeline

How to take an issue from idea to merged PR with the agents. Only Troy can
start a stage: every job checks the actor, so labels or comments from anyone
else do nothing. The one exception is the pipeline App. It may add
`agent:plan` (the board loop below, and the dashboard). It may add
`agent:build` or `agent:elevated` only to hand off a plan right after Troy
pressed **Continue** on the dashboard, and the stage checks that Continue
before it starts ([board.md](board.md#how-a-continue-becomes-a-build)).

A repo needs no workflow of its own (devkit#118). The org webhook tells the
dashboard's receiver about every label and comment, and the receiver applies
the same rule as the admission gate to the event's sender
(`bin/webhooks/pipeline.ts`). For a stage it starts, it dispatches the one
central caller,
[`gingur-root/pipeline`'s `agents.yml`](https://github.com/gingur-root/pipeline/blob/main/.github/workflows/agents.yml),
with the repo, the issue and the sender. Its jobs read the target repo's code
from a pack the App-token job makes (`actions/repo.pack`), since their own
token can't read another private repo. A repo is enrolled when infra lists it
`enrolled`, which installs the App on it. infra is the exception: the App must
never reach it, so it keeps its own caller on the WSL desk.

## The flow

| Step               | You do                                                                                                                                                                              | The pipeline does                                                                                      | Board card       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------- |
| 1. File            | Open an issue: what you want and how you'd know it's done. Add `ready-for-agent` to put it on the board.                                                                            | The board adds the card.                                                                               | Ask              |
| 2. Plan            | Nothing: the board loop starts it. To jump the queue, add `agent:plan` or comment `/plan`.                                                                                          | Writes one plan comment, removes the label.                                                            | Planning         |
| 3. Answer          | Read the plan. If it asks questions, edit the issue to answer them, then `agent:plan` again.                                                                                        | Rewrites the same plan comment.                                                                        | Needs you        |
| 4. Approve / build | When the plan says **ready for `agent:build`**, add `agent:build`. That label is the approval. Or press **Continue** on the dashboard: the plan then hands off to the build itself. | Builds on `agent/issue-<n>`, opens a draft PR, comments a link, removes the label.                     | Building → Ready |
| 5. Review / merge  | If the review passed, merge the PR, or have a project thread merge it. Otherwise answer its findings.                                                                               | In the same run, Claude reviews the PR; Codex fixes findings, up to 2 rounds; then ready or Needs you. | Ready → Done     |

Anything that stops a run (a failed check, a missing result, a push error, a
cancelled run or a lost runner) posts **"… stopped at `<stage>`"** on the
stage's comment and moves the card to **Needs you**. When the agent's CLI said
why it stopped, the comment names the class (`rate_limit` with its reset time,
`overloaded`, `server_error`, `timeout` or `unknown`). Fix the cause, then add
the label again. Every comment that leaves a card in **Needs you** or
**Ready** mentions @gingur, so the notification arrives then.

Every plan proposes a **Priority** for the card (devkit#115): `P0` broken or
blocked now, `P1` next, `P2` soon, `P3` someday. Publishing the plan sets the
board's Priority field only when the card has none, so a re-plan never
overrides a priority you or a groom set. Change it on the board to override.
The dashboard sorts each column by Priority, then by most recently updated;
cards with no priority come last.

## Receipts

Each run reacts on the event that started it (devkit#148), so the issue shows
that an agent picked it up and how the run ended. A `/plan` or `/approve`
run reacts on that comment. A label or a manual dispatch reacts on the issue.

| Reaction      | Meaning                                                 |
| ------------- | ------------------------------------------------------- |
| 👀 `eyes`     | Picked up, working                                      |
| 🚀 `rocket`   | Done: the plan or the PR is ready, or a triage filed    |
| 😕 `confused` | The run ended with a question for you, in **Needs you** |
| 👎 `-1`       | A job failed                                            |

Who writes them (`bin/agent/reactions.ts`):

- **👀:** the webhook receiver, right after it dispatches a plan, build or
  elevated run. It has the comment ID, which the dispatch can't carry. For an
  event the receiver didn't dispatch (infra's caller, a manual dispatch), the
  start job adds it. A board-loop tick gets none.
- **The end state:** publish, once the run's last stage is done. When a run
  dies before it publishes, the start job's failure step or the board loop's
  stalled path sets `-1`.
- The writer is the App. On the WSL desk with no App token, it's Troy's own
  `gh`, so the reactions show as his there.
- The end step swaps only the writer's own 👀 for one end reaction, and
  removes its older ones on that target. Your reactions stay.
- Reactions are best effort: a failed one logs a warning and never fails the
  run.

## The board loop

`pnpm agent loop` (`bin/agent/loop.ts`, devkit#47) keeps cards moving with no
polling. It runs as the last job of every plan and build run, however the run
ended, and when Troy adds `ready-for-agent`. Each tick on a repo:

1. If the run left its card in its own column (**Planning** for a plan,
   **Building** for a build: it was cancelled, or died before it published),
   it says where it stopped and moves the card to **Needs you**. A plan that
   handed off to its build leaves the card in Building, which the plan's
   tick leaves alone.
2. If no card in the repo is planning, it adds `agent:plan` to the oldest open
   `ready-for-agent` card in **Ask**, but only if Troy added that label.

Each decision, including what it skipped, goes in the job summary. It never
touches a card in **Needs you**, **Ready** or **Done**, and never runs on the
WSL desk. `--dry-run` prints the decisions without acting.

The central caller runs `agent.loop.yml` when Troy adds `ready-for-agent`. If the VPS is down for more than 24 hours, the loop's own job
expires in GitHub's queue and a card can sit until the repo's next event.

## Review and merge stage

The build run also reviews its own PR, so your approval stays the only thing
you add. Claude (Opus 5.5) reviews the exact commit the build pushed, checking
Correctness, Spec and Standards, and posts the result as a PR review. At the
same time `toolchain.verify` runs the repo's own checks (format, lint,
typecheck, test, build) on that same commit, so an enrolled repo needs every
script it runs.

The controller posts one `COMMENT` review. Findings on added or context lines
in `candidate.patch` appear inline, prefixed with their ID, blocking or
advisory flag, and axis. Findings outside the diff stay in the review body.
Advisory findings allow an otherwise clean review to pass.

- **Pass** (every axis passes, no blocking finding, no question, and CI green
  on the reviewed commit): the PR is marked ready for review and the card
  stays in **Ready**. Red CI adds a blocking `CI` finding to the review, which
  Codex then fixes like any other. The review comment
  on the issue says it's ready to merge.
- **Changes requested, nothing to ask you:** Codex fixes the findings and
  pushes a new commit to the same PR, then Claude reviews the whole change
  again. The card stays in **Building** meanwhile, and the issue gets a
  **Repair** comment with what Codex changed. This repeats up to 2 rounds
  (`REPAIR_ROUNDS` in `bin/agent/constants.ts`). A repair must map every
  supplied finding ID in `changes[].ref`. A dispute needs non-empty
  `evidence`; an incomplete map stops at `validate` before a push.
- **Anything else** (a question for you, an inconclusive review, findings left
  after 2 rounds, or a repair that changed nothing): the review comment says
  the PR needs your call, lists open blocking IDs, and links the PR's loop
  log. The card moves to **Needs you**. A stale candidate also stops here,
  without posting a PR review or marking the PR ready.

The PR has one loop-log comment, updated after each repair and review. It
shows the round and cap, failure count, candidate short SHA, CI result,
review outcome, open blocking IDs, and the repair's hypotheses. Its hidden
`<!-- devkit:loop-state {json} -->` line keeps state between jobs. Round 0
reviews the build; rounds 1 and 2 review repairs.

For a direct controller call, set the repair cap with
`pnpm agent publish --in <job-dir> --out <output-dir> --round <r> --rounds <n>`.
Pass the same cap to each publish in the run. Without `--rounds`, the cap is
`REPAIR_ROUNDS` (2). The current workflow schedules only two repair jobs;
a larger CLI cap does not add jobs. Ten rounds and stale reruns need the
separate workflow change.

The pipeline never merges. Merging is yours, or a Claude project thread's under
the project's merge policy. The board moves the card to **Done** when the PR
merges.

## Retros

When a plan or build run fails, or a review leaves the card in **Needs you**,
the same run ends with a retro (`agent.retro.yml`). Claude reads the issue
thread, the card's history, each job's result and each agent's transcript,
and lists what went wrong with the fix for each finding (a check, a doc, a
persona prompt, a setting). Every finding then goes through plan, so a fix
lands instead of sitting in a comment (devkit#115):

1. The retro files all its findings as one new issue, labelled `retro`, and
   adds `agent:plan`. The run's issue gets a comment linking it.
2. The planner triages each finding: a new issue, a note on an open issue
   that already covers it, or dropped with a reason. For each new issue it
   says whether to plan it now or leave it in the backlog, and whether it
   needs the WSL desk.
3. Approve the plan as usual (`/approve`, or **Continue**). Instead of a
   build, the run files the new issues (with `agent:plan` or
   `needs:elevated` as the plan said, and a link back to the retro), comments
   on linked issues, and closes
   the retro issue. No PR.

- A retro with no findings (an outage, a rate limit) only comments, as does
  a retro on a run of a retro issue, so retros can't loop.
- One retro per run. A plan that asks you questions gets none, since that is
  the normal flow.
- It can't read the Actions log, so a job that died before its agent wrote
  anything shows up only as `failure`; the retro names the step to check.
- Elevated runs get no retro yet.
- A stub proof run that reaches a retro files a real retro issue, which starts
  a real plan. Close it if you don't want that.

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
   named rollback. Publish runs on the desk too: his git login pushes the
   commit, and the App comments and opens the draft PR. There is no review stage.

A plan that edits `.github/workflows` runs elevated: the App has no
`workflows` permission, so only the desk can push those files.

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

Never point the pipeline repo's main caller at a branch: every run would run
that branch too. Run the proof by hand from your own pipeline branch instead,
on a scratch issue.

1. Branch gingur-root/pipeline, and in `.github/workflows/agents.yml` change
   each `agent.*.yml@main` and `devkitRef: main` to your devkit branch. Push it.
   Don't open a PR.
2. Run one stage on a scratch issue:

   ```bash
   gh workflow run agents.yml -R gingur-root/pipeline --ref <pipeline-branch> \
     -f stage=plan -f repo=scratch -f issue=<n> -f executor=stub
   ```

   `stage` is `plan` or `build`. Leave out `executor` to run the real agents.

3. Delete the pipeline branch when you are done.

A dispatched build starts from scratch's main, so its PR holds only the
agent's change. Composite actions (`actions/*@main`) always run devkit main:
to prove a change to one, pin it to your branch in the workflows for the
proof, then pin it back.

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
  issue and re-plan instead, or press **Request changes** on the dashboard,
  which hands the note to the planner.
- **A missed delivery starts nothing.** GitHub doesn't retry a webhook it
  couldn't deliver (the box was down, or the receiver failed). Add the label
  again, or redeliver it from the org webhook's Recent Deliveries. The
  receiver remembers delivery IDs, so a redelivery that already ran starts
  nothing. A delivery whose handler failed is forgotten, and its dispatch may
  still have gone through, so check the issue's runs before redelivering it.
- **One run per card at a time.** A second label while one runs waits in the
  queue.
