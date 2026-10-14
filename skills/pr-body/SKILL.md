---
name: pr-body
description: Close the build's summary with the merge danger the merge policy reads.
roles: build
---

<!-- Adapted from mattpocock/skills pr (49dd158), Merge Danger section only, for unattended builds (devkit#43). -->

# PR body

Your `summary` opens the pull request. Within its 150 words, end it with one
line:

`Merge danger: <one-way | two-way> door, blast radius <one word>.`

- **Two-way door:** cheap to roll back with a revert. **One-way door:** a
  revert doesn't undo it: deleted data, a migration, a published release, a
  changed external contract, a sent message.
- **Blast radius:** who or what breaks if the change is wrong, in one word:
  `none`, `local`, `repo`, `consumers`, `production`.

Base both on what the diff actually touches, not on the issue's wording.
