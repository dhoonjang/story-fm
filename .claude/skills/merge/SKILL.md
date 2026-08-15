---
name: merge
description: >-
  Verify, squash-merge the current branch's PR into main, delete the branch, tear
  down the worktree it was in, and return to an up-to-date main. Use when the user
  says "머지해", "이거 올리자", "PR 머지하고 main으로", or otherwise signals the
  work on this branch is done.
---

# Merge the branch

Merging into main is the one irreversible step here. Everything before it exists
to make sure main stays green.

## 1. Find the PR

```bash
pwd
git branch --show-current
gh pr view --json number,title,url,isDraft,state,mergeable,mergeStateStatus,baseRefName
```

On `main`, or with no PR for this branch → say so and stop. Base must be `main`.

Note whether this is a worktree — `resolve` puts work in one, and step 5 differs.
`git rev-parse --git-common-dir` pointing outside the current directory means yes;
`orca worktree current --json` names it.

## 2. Everything committed and pushed

```bash
git status --short
git log --oneline origin/$(git branch --show-current)..HEAD
```

Uncommitted changes: show them and ask what belongs in this PR. Never sweep them
in with `git add -A` — name the paths (AGENTS.md §5). Unpushed commits: push
them.

## 3. Verify — this is the gate

There is no CI on this repo. These three are the only thing standing between a
mistake and main.

```bash
pnpm typecheck
pnpm test
pnpm lint
```

If the change touches the web app or the game loop, run `pnpm e2e` too — this is
the one place it runs (AGENTS.md §5). One e2e at a time **across all worktrees**:
port 3399 and `/tmp/story-fm-e2e` are shared, so if another worktree is mid-run,
either wait or pass `E2E_SLOT=1`–`9`.

**Any failure stops the merge.** Report the actual output and fix it, or hand it
back. A failure that names no file you touched is pre-existing — report it and
ask whether to land anyway; do not decide that alone.

## 4. Write the squash message

The PR is squash-merged, so the PR title and body **are** the commit that lands
on main. This is the last chance to get that commit right.

- Title: one Conventional Commit subject covering the whole PR, in Korean, no
  trailing period. If the branch did several unrelated things, that is a sign the
  PR should have been two.
- Body: what changed and why, `Closes #<n>` kept at the top.

```bash
gh pr edit <n> --title '<subject>' --body "$(cat <<'EOF'
<body>
EOF
)"
```

## 5. Merge

```bash
gh pr ready
gh pr merge --squash \
  --subject '<subject>' --body "$(cat <<'EOF'
<body>
EOF
)"
```

Pass `--subject`/`--body` explicitly — left to itself GitHub builds the squash
message from the branch's working commits, which are notes, not history.

If the merge is blocked (conflict, `mergeable: CONFLICTING`), stop and report.
Resolving a conflict against main is a decision to make with the user, not a step
to power through.

## 6. Return to main and tear down

**In a worktree** (the `resolve` path) — `git checkout main` cannot work here,
main is checked out in the primary repo. Update that repo in place, leave the
worktree, then remove it:

```bash
git push origin --delete <branch>
git -C <primary-repo-path> checkout main   # already there; harmless
git -C <primary-repo-path> pull --ff-only
```

`git rev-parse --git-common-dir` gives `<primary-repo-path>/.git`. Then
`ExitWorktree({ action: "keep" })` to put the session back where it started, and
only once you are outside it:

```bash
orca worktree rm --worktree path:<worktree-path> --json
```

Removing the worktree deletes the local branch with it. **Verify the worktree is
clean before removing** — `git status --short` and `git log origin/main..HEAD`
must both be empty. Anything left there dies with the directory; if something is
uncommitted, stop and ask instead.

**Not in a worktree** — the plain path:

```bash
git checkout main
git pull --ff-only
git push origin --delete <branch>
git branch -d <branch>
```

## 7. Confirm

```bash
git log --oneline -3
gh issue view <n> --json state,url
orca worktree list --json   # worktree path is gone
```

Report: the squashed commit on main, that main is current, that the worktree is
gone, and that the issue closed. If the issue is still open, `Closes #<n>` was
missing — close it with a comment pointing at the commit.
