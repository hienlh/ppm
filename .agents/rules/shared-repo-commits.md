---
trigger: always_on
---

# Committing in a repository other task chats work in at the same time

In a spec run, several task chats edit the same repository at once (`../ppm-android` above all). The git index is shared by all of them.

- Commit only your task's files, and name them on the commit itself:

      git add <your files> && git commit -m "<message>" -- <your files>

- Never `git add -A`, `git add .`, `git commit -a`, or a commit without paths: they take other chats' half-done work into your commit.
- Never `git reset`, `git stash`, `git checkout -- <path>`, `git restore`, `git clean` or a branch switch: they throw away or hide other chats' uncommitted work.
- If `git status` shows files that are not yours, leave them alone. They belong to a task running beside you.

Why: on 2026-11-10 two commits made at the same moment left the index behind HEAD, with one task's new test file staged as deleted.
