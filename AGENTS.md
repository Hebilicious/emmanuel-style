# Agent instructions

emmanuel.style is a personal site in a pnpm monorepo. `packages/flamme` is the site (Flamme, Vize, Vue),
`packages/api` the Cloudflare Worker behind it (favourites and star counts), `packages/schema` the GraphQL schema the
two share, and `packages/astro` the previous build, kept as a reference. `packages/nuxt` is older still and not part of
the current work.

## Branches and pull requests

- Every issue or task gets its own branch from `main`, checked out in a new worktree under `.worktrees/`
  (`git worktree add .worktrees/<branch> -b <branch> main`), and all its work happens with that worktree as the working
  directory. Do not work directly on `main` unless the user explicitly directs the current session to.
- A session's files belong to its worktree, and the main checkout keeps the contents it had: scratch scripts, logs and
  screenshots go under `.artifacts/` in the task worktree, or into the commit when they are review evidence.
- A new worktree does not run until it has the vendored Flamme builds, which git ignores: copy
  `vendor/flamme/*/dist` from the main checkout (or rebuild them with `pnpm -r --filter "./vendor/flamme/*" build`),
  then `pnpm install --frozen-lockfile`.
- When spawning a subagent, state whether it shares the parent's branch and worktree or give it its own, and start it
  there; a subagent never infers this.
- Every change reaches `main` through a GitHub pull request, opened before the first handoff with
  `gh pr create --base main --head <branch>`. A task has exactly one pull request, or one stack of them. A pull request
  that closes an issue says `Closes #<number>` in its body.
- Every handoff message includes the clickable URL of the task's pull request, or of every pull request in its stack,
  each time, including handoffs after a review correction. Copy the URL from `gh pr view --json url` or `gh stack view`
  rather than retyping it.
- Every handoff also includes the URL of a dev server started from the task's worktree and serving the commit being
  handed off, each time: the Flamme site with `pnpm exec vite dev --port <port>` in `packages/flamme`, and the worker
  with `pnpm dev --port 8787` in `packages/api` when the change reads it. A server started from the main checkout or
  from another worktree does not count. Use port 4399 for the site unless another worktree holds it, then the next free
  one, and say which. Restart the servers after a rebase or any other history rewrite in the worktree: they reload the
  intermediate states the rewrite passes through and can keep an old one. Open it and check the change there before
  handing off; a handoff without it is incomplete.
- Restart the dev server after a file under `packages/flamme/src/pages` changes, by an edit or by the pre-commit hook's
  formatting: until Hebilicious/flamme#28 is fixed, such a change empties `.flamme/records/` and drops every route's
  loader. `ls .flamme/records` lists one module per page when the tree is whole.
- Use `gh stack` whenever the work splits into layers a reviewer can read one at a time, and always for a change too
  large for one pull request: one branch and pull request per layer, all in the task's worktree, submitted with
  `gh stack submit`. [.agents/skills/gh-stack/SKILL.md](.agents/skills/gh-stack/SKILL.md) covers the commands; it is
  upstream's skill from `github/gh-stack`, kept byte-identical and excluded from dprint.
- A human reviews every pull request before it merges. Merge only after the human accepts the handed-off work, or when
  their current message explicitly says to merge without review; a request for changes, approval of a plan, or an
  instruction given before the work exists is not acceptance.
- The author of a branch owns it until it merges: keep it rebased on `main`, resolve its conflicts and make its checks
  pass. Never skip or weaken a check to make it pass, and never push to, rebase or merge another session's branch. The
  repository has no CI, so the checks are run by hand before each handoff:
  - `pnpm --filter @emmanuel/flamme run typecheck`
  - `pnpm --filter @emmanuel/flamme exec vitest run`
  - `pnpm --filter @emmanuel/flamme run content:check`
  - `pnpm --filter @emmanuel/flamme run build`
  - `pnpm --filter @emmanuel/api test`
  - `dprint check` on the files the branch changes
- Once a pull request or stack merges, remove its worktree (`git worktree remove .worktrees/<branch>`) and bring the
  main checkout's `main` up to `origin/main`: `git -C <repository root> pull --ff-only origin main`. Pull only with
  `--ff-only`; when it refuses, stop and tell the user rather than resetting, stashing or merging.

Install the git hooks once per clone with `pnpm exec lefthook install`. The pre-commit hook formats the staged files
with dprint.
