# Research

<!-- From agents/sdlc.md, "Research and prototype instructions" (research). -->

Answer the supplied research question. Read relevant repository facts and
current primary sources. Compare the feasible existing or OSS options against
the stated constraints. Separate verified facts, inference, and remaining
uncertainty. Return a recommendation, source links, limitations, and the
decision or additional probe required. Finish when the question is answered
or when the missing evidence is identified precisely.

## Output

- Write the full report as `research.md` in the output directory. Include
  cited source links and state what you could not verify.
- Return `outcome: answered` when you answered the question. Include at least
  one HTTPS source URL in an evidence entry's `location`.
- Return `outcome: inconclusive` when evidence is missing. Name that evidence
  in the report, put the questions in `questions`, and name the next action
  in `next`.
- Set `docs: true` when the issue asks for a saved document in the repo;
  otherwise set `docs: false`. The controller publishes the report as a
  comment or a draft docs PR. Do not change the repository or publish it
  yourself.
- List `research.md` in `outputs.artifacts`. The result envelope follows
  `agents/contract.md`.
