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

Note whether this is a worktree — `resolve` puts work in one, and step 7 differs.
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

## 3. Conflicts first

Before anything is verified, the branch has to be sitting on top of current main.
Do this first on purpose: resolving a conflict changes the code, and code that
changed has to be re-tested — so a CI run started before this step is worthless.

```bash
git fetch origin
git merge origin/main
```

Merge, never rebase (AGENTS.md §5) — the branch is shared with the PR.

- **Clean** → go to §4.
- **Conflicted** → resolve them. Read both sides and the design doc that governs
  the behavior; a conflict is two intents meeting, not two texts. `git commit`
  the merge with the conflicting paths named, and say in the report which files
  conflicted and how you settled each.
- **The two sides genuinely disagree about behavior** — main changed the rule
  this branch is also changing, and only one can be right — **stop and ask the
  user.** That is a design call, not a merge step.

Then push, so CI runs against what will actually land:

```bash
git push origin HEAD
```

## 4. Wait for CI — this is the gate

`.github/workflows/ci.yml` runs `typecheck`, `lint`, the full `pnpm test` and
`pnpm e2e` on this branch. **That run is the gate; do not re-run the suites
locally to duplicate it** (AGENTS.md §5).

```bash
gh pr checks --watch --fail-fast
```

The push in §3 starts a fresh run — make sure the checks you are reading belong
to the commit you just pushed, not the one before it:

```bash
gh pr view --json headRefOid,statusCheckRollup
```

- **All green** → go to §5.
- **A check is red** → open it, fix it here, push, and watch again.
  `gh run view <id> --log-failed` gives the failing output; for a red e2e,
  download the `playwright-report` artifact rather than guessing.
- **Red in a file this branch never touched** → pre-existing. Report it with the
  output and ask whether to land anyway; do not decide that alone.
- **No checks at all** → the workflow did not trigger. Say so and stop; merging
  unverified is the one thing this step exists to prevent.

Reproducing a CI failure locally is fine and expected — that is the case where
running `pnpm test` or `pnpm e2e` on this machine earns its minutes.

## 5. Write the squash message

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

## 6. Merge

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

If the merge is blocked here, main moved while §4 was watching CI. Go back to §3,
merge it in, and let CI run again — a conflict resolved after a green run is code
nothing verified.

## 7. Return to main and tear down

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

## 8. Confirm

```bash
git log --oneline -3
gh issue view <n> --json state,url
orca worktree list --json   # worktree path is gone
```

Report: the squashed commit on main, that main is current, that the worktree is
gone, and that the issue closed. If the issue is still open, `Closes #<n>` was
missing — close it with a comment pointing at the commit.
