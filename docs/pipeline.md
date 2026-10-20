# Using the agent pipeline

How to take an issue from idea to merged PR with the agents. Only Troy can
start a stage: every job checks the actor, so labels or comments from anyone
else do nothing. The one exception is the pipeline App. It may add
`agent:plan` (the board loop below, and the dashboard). It may add
`agent:build` only to hand off a plan right after Troy
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
token can't read another private repo. The agents can also read every other
enrolled repo with `GH_TOKEN`, a read-only token minted for each run
(`actions/agent.token`); the pack still carries the target repo. A repo is
enrolled when infra lists it `enrolled`, which installs the App on it. infra
keeps its own caller, which runs the same plan and build workflows.

## The flow

| Step               | You do                                                                                                                                                                              | The pipeline does                                                                                                                    | Board card       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 1. File            | Open an issue: what you want and how you'd know it's done. Add `ready-for-agent` to put it on the board.                                                                            | The board adds the card.                                                                                                             | Ask              |
| 2. Plan            | Nothing: the board loop starts it. To jump the queue, add `agent:plan` or comment `/plan`.                                                                                          | Writes one plan comment, removes the label. The plan opens with **What**: the intent behind the ask, related work and what to defer. | Planning         |
| 3. Answer          | Read the plan. If it asks questions, edit the issue to answer them, then `agent:plan` again.                                                                                        | Rewrites the same plan comment.                                                                                                      | Needs you        |
| 4. Approve / build | When the plan says **ready for `agent:build`**, add `agent:build`. That label is the approval. Or press **Continue** on the dashboard: the plan then hands off to the build itself. | Builds on `agent/issue-<n>`, opens a draft PR, comments a link, removes the label.                                                   | Building → Ready |
| 5. Review / merge  | If the review passed, merge the PR, or have a project thread merge it. Otherwise answer its findings.                                                                               | Claude reviews and replans; Codex repairs. Spec changes wait for approval; repairs and stale reruns share a 10-round cap.            | Ready → Done     |

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

- **👀:** the webhook receiver, right after it dispatches a plan or build
  run. It has the comment ID, which the dispatch can't carry. For an
  event the receiver didn't dispatch (infra's caller, a manual dispatch), the
  start job adds it. A board-loop tick gets none.
- **The end state:** publish, once the run's last stage is done. When a run
  dies before it publishes, the start job's failure step or the board loop's
  stalled path sets `-1`.
- The writer is the App.
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
touches a card in **Needs you**, **Ready** or **Done**. `--dry-run` prints the decisions without acting.

The central caller runs `agent.loop.yml` when Troy adds `ready-for-agent`. If the VPS is down for more than 24 hours, the loop's own job
expires in GitHub's queue and a card can sit until the repo's next event.

## Review and merge stage

The build run also reviews its own PR, so your approval stays the only thing
you add. Claude (Opus 5.5) reviews the exact commit the build pushed, checking
Correctness, Spec and Standards, and posts the result as a PR review. At the
same time `toolchain.verify` runs the repo's own checks (format, lint,
typecheck, test, build) on that same commit, so an enrolled repo needs every
script it runs.

When the approved plan has `agent` criteria, a separate Codex `verify` role
runs beside review and CI on the same candidate. It checks only those IDs and
returns one evidence entry per ID. No `agent` criteria means no verifier job
or model call: green CI counts as verified. The controller reads `plan.checks`
from the approved contract, never from the candidate's proposed criteria.

Ready needs review pass, green CI and `verified` with passing evidence for
every `agent` ID, all on the same candidate. A failed criterion creates a
blocking `V-<ID>` finding on axis Spec, sent through replan and repair like
`CI`. Its stable ID lets a later passing round resolve its thread.
Missing verifier output, a missing evidence entry, `not-verified`, or an
inconclusive result stops at **Needs you** and names the criterion IDs.
Stale verifier results rerun on the current head within the round cap, then
stop at **Needs you**. The loop log records `verify: verified`, the verifier's
other outcome or stopped stage, or `verify: skipped` when no job is needed.

The controller posts one `COMMENT` review and one resolvable thread per finding.
Each thread starts with `<!-- devkit:finding <ID> -->`, followed by the ID,
blocking or advisory flag, axis, evidence and fix. Findings on added or context
lines in `candidate.patch` appear inline. Other findings on a changed file get
a file-level thread. A finding outside the patch gets a file-level thread on
the first changed file, with its real location in the body. Only an empty
patch leaves findings in the review body. Advisory findings allow an otherwise
clean review to pass.

Review, replan and repair jobs read `threads.json`, which holds App-authored marked
threads (open and resolved) and their operator or App replies. Comments from
other authors are excluded. The reviewer reuses an open finding's ID when it
still stands, omits fixed IDs, asks nothing and puts the recommended fix in
`fix`. The controller replies to continuing findings, resolves IDs no longer
raised as blocking, and creates threads only for new IDs. A finding that
becomes advisory gets a reply and is resolved. A finding whose ID matches only
a resolved thread gets a new thread.

- **Pass** (every axis passes, no blocking finding, no question, and CI green
  on the reviewed commit, with every `agent` criterion independently verified): the PR is marked ready for review and the card
  stays in **Ready**. Red CI adds a blocking `CI` finding to the review, which
  Codex then fixes like any other. The review comment
  on the issue says it's ready to merge.
- **Changes requested:** Claude (Opus 5.5, medium effort) replans before
  each repair. It replies on every unresolved thread, using its finding ID
  in `changes[].ref` and the answer in `response`. A missing reply stops at
  `validate`. Questions that accompany blocking findings become advisory
  `Q1`, `Q2`, … threads for the planner; a question-only review still stops.
  The planner reads the approved `plan.md`, its `checks.json`, the gated
  `review.json`, and `threads.json`. It writes a plan only to change the spec.
- **Spec unchanged:** the gate starts Codex's repair on the same PR. Codex
  sees the planner's replies, fixes the findings and pushes a new commit.
  Claude reviews the whole change again while CI and the verifier check the same commit.
  Each repair maps every finding in `changes[].ref`; disputes need evidence.
  After a successful push, each entry is posted on its open thread with the
  commit SHA. An incomplete map stops at `validate` before a push.
- **Spec changed:** any plan-text edit, or an added, removed or re-checked
  criterion, stops the round. The controller rewrites the plan comment,
  lists the changed criterion IDs (or says "plan text only"), posts the
  planner's summary and moves the card to **Needs you**. The planner cannot
  bypass this check. The loop keeps the plan revision you approved; repair
  refuses until it matches the current plan.
- **Planner stop:** needs-input, questions, or a non-complete result stops
  even when the spec is unchanged. Invalid results and missing thread
  replies stop at validation. The comment names the round, reason and open
  threads. A normal spec or planner stop does not trigger a retro; a failed
  planner job does.
- **Cap:** after 10 rounds, remaining blocking findings stop at **Needs you**.
  The comment says the loop has not converged, links every open thread and
  gives the latest planner summary as the agents' suggestion. Other stops
  (an inconclusive review, a question-only review or a failed repair) also
  name the round, link open threads and link the loop log.
- **Stale review:** the next round reviews the current PR head without a
  repair or a push. The card stays in **Building**, and the issue comment
  names the commit being re-reviewed and the next round. Reruns count toward
  the cap; a stale review at the cap stops at **Needs you**. A stale review
  never posts a PR review or changes the PR's ready state.

After a spec stop, reply `/approve` or press Continue to approve the new plan.
The run skips Build and re-reviews the current head of the same PR in the
stopped round, now under the new plan. The round count and original base carry
over; the next repair round runs replan → gate → repair as usual. This extra
review avoids repairing findings judged against the old plan. Close the PR
first to rebuild from scratch.

The PR has one loop-log comment, updated after each replan, repair and review. It
shows the round and cap, failure count, candidate short SHA, CI result,
review outcome, open blocking IDs, planner summary and repair hypotheses. It
also records the approved plan revision and original build base. Only loop
comments authored by the pipeline App or the operator count for approval or
resume. Its hidden
`<!-- devkit:loop-state {json} -->` line keeps state between jobs. Round 0
reviews the build; rounds 1 through 10 review repairs or rerun stale reviews.
Each round runs through `agent.round.yml`; non-rerun rounds 1–10 run
replan → gate → repair → push → review + CI + criteria → verdict.

For a direct controller call, set the repair cap with
`pnpm agent publish --in <job-dir> --out <output-dir> --round <r> --rounds <n>`.
Pass the same cap to each publish in the run. Without `--rounds`, the cap is
`REPAIR_ROUNDS` (10). The build workflow's `rounds` input sets the cap for all
rounds in that run. The CLI accepts only integers from 0 to 10; 0 reviews the
build without repairs or reruns. Local eval keeps its separate cap of 2 repairs and runs without a planner.

The pipeline never merges. Merging is yours, or a Claude project thread's under
the project's merge policy. The board moves the card to **Done** when the PR
merges.

## Memory after a merge

When Troy or the pipeline App merges a PR, the webhook receiver starts
`agent.memory.yml`. The role reads the merge commit, changed files, trusted
PR text, the org and repo memory slice, and checks for evidence affected by
those files. It has no `GH_TOKEN`, web tools or Edit tool.

The controller validates all proposed paths and requires evidence for every
written entry before applying anything. It writes only `memory/_org/` and
`memory/<repo>/` in a pipeline checkout at the recorded `job.memory` commit.
It regenerates `MEMORY.md` and checks the changed evidence. A check failure
opens a draft with the check output; a passing check opens a ready PR.
Changes go to `memory/<repo>-<pr>` on `gingur-root/pipeline`, with a PR into
`main`. Nothing changes directly on `main`. No changes means no branch, PR
or comment.

A failed or cancelled run updates one `<!-- devkit:memory -->` comment on the
merged PR, naming the stopped job and linking its run. The merged card stays Done, and
a memory run gets no retro. Merges in `pipeline` and `infra` are skipped by
the receiver, so merging a memory PR cannot start another memory run.

Activation needs the central caller's `memory` option and job, with
`devkitRef: main` (devkit#276). Merge the devkit implementation first, then
the caller update: until the caller lands, memory dispatch returns 422.
That follow-up also owns the first live run. The companion infra diagram is
tracked in devkit#277; infra's own memory caller is devkit#261.

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
   says whether to plan it now or leave it in the backlog.
3. Approve the plan as usual (`/approve`, or **Continue**). Instead of a
   build, the run files the new issues (with `agent:plan` if the plan said
   to plan it now, and a link back to the retro), comments
   on linked issues, and closes
   the retro issue. No PR.

- A retro with no findings (an outage, a rate limit) only comments, as does
  a retro on a run of a retro issue, so retros can't loop.
- One retro per run. A plan that asks you questions gets none, since that is
  the normal flow.
- It can't read the Actions log, so a job that died before its agent wrote
  anything shows up only as `failure`; the retro names the step to check.
- A stub proof run that reaches a retro files a real retro issue, which starts
  a real plan. Close it if you don't want that.

## Stories and follow-ups

Agents propose new issues in their result, and publish files them
(devkit#12).

- **Subtasks make a story.** A ready plan's `subtasks` become native
  sub-issues of the card, in **Ask**. Each one says `Part of #<card>.` The
  card is now a story: its plan comment lists the subtasks and does not hand
  off to a build, even after a **Continue**. Plan, approve and build each
  subtask on its own. A subtask's `issue.md` starts with the story's title and
  body, so its plan stays inside the story.
- **A story never builds.** `agent:build` on an issue with
  sub-issues is refused. The card goes to **Needs you** with "Build each
  subtask instead", and the label is removed. This includes stories made by
  hand.
- **Follow-ups.** Any stage except a retro may return `followups`. Each becomes
  a new issue in **Ask** with no label, so it starts nothing. Its body links
  back to the card, the stage and the run. A comment on the card lists them,
  and the stage comment says how many were filed.
- **The cap is 5 per stage.** A stage that proposes more files its first 5,
  and its comment says how many were dropped. Each review round counts as its
  own stage.
- **Retries never duplicate.** Each filed issue ends with a hidden marker
  (`<!-- devkit:subtask #<card> -->` or
  `<!-- devkit:followup #<card> <stage> -->`). A retry finds the earlier issue
  by its marker and exact title, links a subtask that never got linked, and
  files only what is missing. A subtask a re-plan renames is filed again under
  the new title; close the old one by hand.
- A retro's `followups` are its findings, which it files as one `retro` issue
  ([Retros](#retros)).

## Workflow-file changes

A plan that edits `.github/workflows` builds like any other: approve it with
`/approve` or **Continue**. The tokens that push an agent's commits (Publish
and each repair) ask for `workflows: write`, so the App pushes workflow files
like any file (infra#150). A branch workflow can't read the pipeline's
secrets: they live in the `agents` environment, which only `main` may use.

## Repo persona and skills

A repo replaces any role file by committing the
same path under `.devkit/` (e.g. `.devkit/agents/build.md`). A skill is
`skills/<name>/SKILL.md` with a `roles: plan, build` frontmatter line; a
repo adds one, or replaces devkit's, under `.devkit/skills/<name>/`.

## Running it from a desk session

The `pipeline` skill (`skills/pipeline/SKILL.md`) runs the
same stages from a Claude Code session, with Troy's `gh` user and one
subagent per stage. The issue is a file under `.devkit/issues/` that never
reaches main. The pipeline itself never loads that skill, since it has no
`roles:` line.

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

1. Branch gingur-root/pipeline as `proof/<name>` (only that name may use the
   `agents` environment, and only an org admin can create one), and in
   `.github/workflows/agents.yml` change
   each `agent.*.yml@main` and `devkitRef: main` to your devkit branch. Push it.
   Don't open a PR.
2. Run one stage on a scratch issue:

   ```bash
   gh workflow run agents.yml -R gingur-root/pipeline --ref <pipeline-branch> \
     -f stage=plan -f repo=scratch -f issue=<n> -f executor=stub -f fixture=<name>
   ```

   `stage` is `plan` or `build`. Leave out `executor` to run the real agents.
   `fixture` picks the stub's result (`bin/agent/constants.ts`
   `STUB_FIXTURES`): `ready` by default, `story` for a plan with two subtasks,
   `followups` for a build that proposes seven follow-ups, `changes` for a
   blocking F1 thread repaired and resolved in round 1, and `advisory` for a
   passing review with an advisory thread. For `changes`, check that the PR
   has one F1 thread, resolved after round 1, with the repair's reply.
   With `never`, check that ten replans and ten repairs run, then the cap
   comment lists open threads and the last planner summary in **Needs you**.
   With `spec`, round 1 stops before repair: the plan comment adds `A2` and
   the card moves to **Needs you**. Approve it, then dispatch the build again
   from the same proof branch with `fixture=spec`. Check that Build is skipped,
   round 1 re-reviews the same PR, round 2 replans and repairs, and the review
   passes. The loop log must retain the original base and continuing rounds.
   With `ready`, check that **Verify Criteria** runs and the card reaches **Ready**
   with `verify: verified` in the loop log. With `unverified`, round 0 must
   post blocking `V-A1`; round 1 repairs it, resolves that thread and reaches
   **Ready**, again with `verify: verified`. The verifier reuses the review's
   repo pack and sealed read token.
   If the proof caller has a fixed fixture list, add `spec` and `unverified` on that branch.
   To check failures, set `DEVKIT_STUB_FIXTURE` to `rate-limit`, `crash`, `timeout` or `missing` on the proof branch.

3. Delete the pipeline branch when you are done.

A dispatched build starts from scratch's main, so its PR holds only the
agent's change. Composite actions (`actions/*@main`) always run devkit main:
to prove a change to one, pin it to your branch in the workflows for the
proof, then pin it back.

## Known limits

- **Codex has no turn cap.** Its per-role timeout is its only run limit.
- **Re-run doesn't work.** Jobs only run on a run's first attempt, so the
  Actions "Re-run" button skips everything. Add the label again instead.
- **Editing the issue or the plan comment voids the plan.** `agent:build`
  refuses until you run `agent:plan` again. It says why in a comment and
  removes its label, so add it again once the plan is ready.
- **A plan written without the issue body is refused once the body becomes visible.**
  Run `agent:plan` again.
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
