---
name: test-first
description: Write the failing test first for behavior changes, and prove each test can fail.
roles: build
---

<!-- Adapted from mattpocock/skills tdd (49dd158) and superpowers test-driven-development (7.0.0) for unattended builds: no seam confirmation with a user (devkit#43). -->

# Test first

For a behavior change or a bug fix:

1. **Seam.** Test at the public boundary the plan names: the command, function
   or interface a caller uses. Never test private helpers or internals. If the
   plan names no seam, pick the narrowest public one and record it in
   `assumptions`.
2. **Red.** Write one failing test for one behavior. Run it and see it fail
   for the reason you expect, not from a typo or a missing import.
3. **Green.** Write only enough code to pass it. Run it again.
4. Repeat one slice at a time. Don't write all the tests first.

A test worth keeping:

- Takes its expected values from the issue, the plan or a worked example,
  never by recomputing them the way the code does.
- Fails when the behavior breaks. Confirm it once by removing the guard or
  reverting the fix, then restore it.
- Survives a refactor that keeps behavior.

Skip new tests for docs, config literals and mechanical edits; run the
existing checks instead. Report each red and green run in `evidence`.
