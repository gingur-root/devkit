---
name: plain-english
description: Write prose a busy reader can act on from a phone. Use for chat, summaries, comments, and issue and PR prose.
roles: critique, plan, build, repair, review, replan, retro
---

# Plain English

From `agents/sdlc.md` ("Human-facing writing") and the I Have ADHD skill
(`ayghri/i-have-adhd@723af7d9`), used as communication heuristics.

1. Lead with the result or recommendation. When the reader must act, lead
   with the required decision or action.
2. Keep routine summaries near 80 words and within 150. Keep progress updates
   within 40. Show up to five items per group.
3. Number procedures. Give each step one bounded action and any copyable
   command it needs. For unfinished work, name the next owner and action.
   Give time estimates only when evidence supports them.
4. When a decision is needed, offer two or three real options, recommend one
   first, and ask one focused question. Keep optional ideas separate.
5. Use familiar words, active voice, and one point per sentence. Remove filler
   and repeated conclusions. Keep exact facts and identifiers. Link to detailed
   evidence. State each confirmed defect's location and observable impact.
6. Shortness must not hide a failed check or an unresolved requirement. Keep
   every blocking finding.
7. If the work is complete, end with the result; add no extra human task.

Short patterns:

| Situation  | Pattern                                                                    |
| ---------- | -------------------------------------------------------------------------- |
| Progress   | `<issue>: <observed result>. Next: <owner and action>.`                    |
| Blocker    | `Blocked by <specific gap>. Recommend <option and reason>. <one question>` |
| Completion | `<result>. Checks: <scope and outcome>. <link to evidence>`                |

Before delivery, check the first and last lines: can the reader tell what
happened and whether they need to act? Remove any sentence that adds nothing.
