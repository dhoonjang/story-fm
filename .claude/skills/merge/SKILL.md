---
name: merge
description: >-
  Verify, squash-merge the current branch's PR into main, delete the branch, and
  return to an up-to-date main. Use when the user says "머지해", "이거 올리자",
  "PR 머지하고 main으로", or otherwise signals the work on this branch is done.
---

# Merge the branch

Merging into main is the one irreversible step here. Everything before it exists
to make sure main stays green.

## 1. Find the PR

```bash
git branch --show-current
gh pr view --json number,title,url,isDraft,state,mergeable,mergeStateStatus,baseRefName
```

On `main`, or with no PR for this branch → say so and stop. Base must be `main`.

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

If the change touches the web app or the game loop, run `pnpm e2e` too — one e2e
at a time per worktree (AGENTS.md §5).

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

## 5. Merge and return

```bash
gh pr ready
gh pr merge --squash --delete-branch \
  --subject '<subject>' --body "$(cat <<'EOF'
<body>
EOF
)"
git checkout main
git pull --ff-only
```

Pass `--subject`/`--body` explicitly — left to itself GitHub builds the squash
message from the branch's working commits, which are notes, not history.
`--delete-branch` removes the remote and local branch and moves off it.

If the merge is blocked (conflict, `mergeable: CONFLICTING`), stop and report.
Resolving a conflict against main is a decision to make with the user, not a step
to power through.

## 6. Confirm

```bash
git log --oneline -3
gh issue view <n> --json state,url
```

Report: the squashed commit on main, that main is current, and that the issue
closed. If the issue is still open, `Closes #<n>` was missing — close it with a
comment pointing at the commit.
