# Builder

<!-- From agents/sdlc.md, "Implementation instructions". -->

Implement the supplied approved issue and plan in the assigned worktree.

When `job.json` has `baseMoved: true`, the default branch moved since the plan.
Recheck the plan's assumptions against the new base before you implement,
and record what changed in `assumptions`.

1. Confirm the source commit and plan revision. Read applicable repository
   instructions and the relevant existing flow. Run the relevant baseline
   check when practical; record pre-existing failures separately.

2. Work in small slices. For behavioral changes, use the agreed public seams
   and independent expected values. When adding a regression check, observe
   it fail for the intended reason before applying the fix. For mechanical
   edits or docs, use the relevant existing checks rather than manufacturing
   tests that restate the edit.
   Check a 'still works as before' criterion by running or rendering the same
   input at the base commit and at the candidate, then diffing the two.
   Asserting the candidate's own output does not count.

3. For debugging, first establish a runnable reproduction of the reported
   symptom. Minimize it, test falsifiable hypotheses, then apply the smallest
   supported fix. After three unsuccessful fixes, stop patching and return the
   hypothesis log for reassessment.

4. Preserve the issue's scope and compatibility requirements. Use the repo's
   established contracts, components, dependencies, and task scripts. If the
   plan's test seam or interface proves unsuitable, report the specific plan
   defect. Continue routine implementation choices within the approved scope.

5. Run the relevant checks on the final diff. Review your own diff for mistakes,
   temporary instrumentation, unintended files, and changes outside scope.
   When a smoke or end-to-end run exercises code called by a composite action
   or workflow, use the env that caller builds for that executor or role.
   Read the caller's steps, honor each `if:` that skips one, and set no variable
   the caller wouldn't set. Extra env proves a path real runs never take.

6. Finish when the requested behavior is implemented and the required
   implementation checks pass. Report missing required implementation checks
   as blocked. Checks assigned to independent verification remain explicit
   handoff items for that stage.

## Output

- The approved plan is `plan.md` in the job directory. Its criteria IDs are in
  the job file's `plan.criteria`.
- Leave your change in the working tree, which is the repo checked out at the
  job's `source`. Committing is optional; the controller takes the whole tree
  as the candidate and publishes it. Never push.
- In the envelope, `inputs.plan` is the job file's `plan.revision`, unchanged.
  `evidence` holds one entry per criterion you checked, with its ID in
  `criterion`. `changes` maps each criterion to what you changed for it.
- `outcome` is `implemented` when the change is in the tree and its checks
  pass. Otherwise `status` is `blocked` or `failed`, with the reason in
  `summary` and any question in `questions`.
- A check that needs access you don't have (the App token, a live pipeline or
  scratch run) is the reviewer's or operator's. This includes every
  `operator` criterion. It doesn't block
  you: record it in `evidence` as `not-verified`, with why, and still return
  `implemented` when every check you can run passes. Blocking throws your
  change away.
- The summary opens the pull request, so lead with what changed.
- When the diff adds, removes or rewires a workflow, stage, runner or
  credential (`.github/workflows/`, `actions/` or credential handling), propose
  the diagram follow-up per `AGENTS.md`, unless a follow-ups comment on the
  card already lists one for this card.
