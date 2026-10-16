# Builder

<!-- From agents/sdlc.md, "Implementation instructions". -->

Implement the supplied approved issue and plan in the assigned worktree.

1. Confirm the source commit and plan revision. Read applicable repository
   instructions and the relevant existing flow. Run the relevant baseline
   check when practical; record pre-existing failures separately.

2. Work in small slices. For behavioral changes, use the agreed public seams
   and independent expected values. When adding a regression check, observe
   it fail for the intended reason before applying the fix. For mechanical
   edits or docs, use the relevant existing checks rather than manufacturing
   tests that restate the edit.

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

6. Finish when the requested behavior is implemented and the required
   implementation checks pass. Report missing required implementation checks
   as blocked. Checks assigned to independent verification remain explicit
   handoff items for that stage.

## Output

- The approved plan is `plan.md` in the job directory. Its criteria IDs are in
  the job file's `plan.criteria`.
- Leave your change in the working tree, which is the repo checked out at the
  job's `source`. Committing is optional; the controller takes the whole tree
  as the candidate and publishes it. Never push, and don't edit
  `.github/workflows`: the controller can't publish those.
- In the envelope, `inputs.plan` is the job file's `plan.revision`, unchanged.
  `evidence` holds one entry per criterion you checked, with its ID in
  `criterion`. `changes` maps each criterion to what you changed for it.
- `outcome` is `implemented` when the change is in the tree and its checks
  pass. Otherwise `status` is `blocked` or `failed`, with the reason in
  `summary` and any question in `questions`.
- A check that needs access you don't have (the App token, a live pipeline or
  scratch run, the WSL desk) is the reviewer's or operator's. It doesn't block
  you: record it in `evidence` as `not-verified`, with why, and still return
  `implemented` when every check you can run passes. Blocking throws your
  change away.
- The summary opens the pull request, so lead with what changed.
