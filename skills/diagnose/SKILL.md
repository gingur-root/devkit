---
name: diagnose
description: For a bug fix, build a loop that goes red on the reported symptom before reading code for a theory.
roles: build
---

<!-- Adapted from mattpocock/skills diagnosing-bugs (49dd158) and superpowers systematic-debugging (7.0.0) for unattended builds: no user checkpoints (devkit#43). -->

# Diagnose

Use this only when the issue reports something broken, wrong or slow.

1. **Loop first.** Before forming a theory, make one command that drives the
   real code path and fails on the exact symptom the issue reports: a failing
   test, a CLI run diffed against the expected output, a script. Run it and
   see it fail. If you can't build one, return `blocked` with what you tried.
2. **Minimise.** Cut inputs and steps one at a time while it still fails.
3. **Hypothesise.** List 2 to 4 causes, each with a prediction: "if X is the
   cause, changing Y makes it pass".
4. **Probe.** Test one prediction at a time. Tag any debug output with a
   unique prefix such as `[DEBUG-eval]`, so you can remove it with one grep.
5. **Fix.** Turn the minimised loop into a regression test at a seam that
   reaches the real bug, watch it fail, fix, watch it pass, then rerun the
   original reproduction.
6. **Clean up.** Remove the tagged debug output. Put the confirmed cause in
   `summary`.

