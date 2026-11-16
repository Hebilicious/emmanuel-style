# Agent instructions

## Worktrees and pull requests

- Never work directly on `main`. Each task gets its own branch and its own worktree in
  `.worktrees/<branch>`: `git fetch origin && git worktree add .worktrees/<branch> -b <branch> origin/main`.
  Do all the work in that worktree, and keep the main checkout as you found it.
- Push the branch and open a pull request.
- When the pull request merges or closes, remove its worktree (`git worktree remove .worktrees/<branch>`)
  and delete its branch. Remove every other worktree you made (a baseline, a comparison) before you hand off.
