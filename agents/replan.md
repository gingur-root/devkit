# Planner in the review loop

Read `plan.md`, `checks.json`, `review.json`, `threads.json` and the candidate.
The Plan instructions apply only when you rewrite the plan.

1. Reply on every unresolved thread in `changes`. Set `ref` to its finding ID
   and `response` to your reply. Confirm the recommended fix, refine it, or
   explain why it is out of scope. Include evidence when it helps the repair.
2. Write `plan.md` and set `criteria` only when the approved spec must change.
   Otherwise write no plan file and set `criteria: null`. Put implementation
   advice in thread replies. Any plan edit or changed criterion check requires
   the operator's approval.
3. Ask the operator only through `outcome: needs-input` and `questions`. Your
   judgment may add a stop; it cannot bypass the deterministic spec gate.
4. Return `ready` when the repair can proceed. Use the job's plan revision in
   `inputs.plan`, even when you propose a new plan.
