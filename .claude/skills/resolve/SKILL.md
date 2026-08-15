---
name: resolve
description: >-
  Pick the most urgent smallest open issue on dhoonjang/story-fm, branch off
  fresh main, open a draft PR, and start working on it. Use when the user says
  "다음 작업 시작해", "이슈 하나 잡고 시작해", "할 일 잡아줘", or asks what to work
  on next and wants it started rather than listed.
---

# Resolve the next issue

## 0. The worktree must be clean

```bash
git status --short
```

Anything uncommitted belongs to work in flight. Stop and ask — do not stash, do
not commit it into a new branch.

## 1. Pick the issue

```bash
gh issue list --state open --limit 100 --json number,title,labels,assignees,url
```

Choose by this order, no judgment applied:

1. **Priority** — `priority/xhigh`, else `high`, else `mid`, else `low`.
2. **Size** within that tier — `size/s`, else `size/m`, else `size/l`.
3. **Oldest issue number** within that cell.

Skip an issue if it has an assignee, or if `gh pr list --state open --search
'<number>'` shows a PR already pointing at it — someone is on it.

An issue missing a `priority/` or `size/` label is not a candidate. If unlabeled
issues exist, say so at the end so they can be triaged, but do not pick one.

Nothing selectable → say so and stop. Do not invent work.

State the pick and why it won (`priority/high` + `size/s`, oldest of two) before
moving on.

## 2. Branch off fresh main

```bash
git checkout main
git pull --ff-only
git checkout -b <type>/<kebab-slug>
```

`<type>` is the Conventional-Commit type from the issue title (`feat` `fix`
`refactor` `docs` `test` `chore`); `<kebab-slug>` is a short English slug of the
subject — `fix/red-card-reaches-result`. This matches the branches already in the
history.

## 3. Docs first, then the PR

Read the issue body and the design docs it points at (`docs/` is the single
source — AGENTS.md §7). If the task changes behavior, **update `docs/` to
describe the new behavior and commit that** — the convention is docs before code,
and it also gives the branch the commit GitHub needs to open a PR.

```bash
git commit -m "docs(<scope>): <무엇이 달라지는가>" -- docs/<changed>.md
git push -u origin HEAD
gh pr create --draft --base main \
  --title '<issue title>' \
  --body "$(cat <<'EOF'
Closes #<n>

## 무엇을

<이슈가 요구하는 것 한두 줄.>

## 계획

- [ ] <단계>
EOF
)"
```

`Closes #<n>` is what closes the issue on merge — do not omit it.

If the task genuinely touches no docs (a pure refactor, a chore), make the first
real code commit instead and open the PR after it. Never anchor the branch with
an empty placeholder commit.

Then claim the issue so a later `resolve` skips it:

```bash
gh issue edit <n> --add-assignee @me
```

## 4. Work

Follow the normal conventions: deterministic core, tests alongside, named paths
when you `git add`.

The PR is squash-merged, so **the PR title and body become the commit message on
main** — keep the title a valid Conventional Commit subject and keep the body
accurate as the work lands. Individual commits on the branch are working notes;
they disappear at merge.

Update the checklist as steps land. Leave the PR **draft**; `merge` is what marks
it ready and lands it.

## Report

Issue number and title, why it was picked, branch name, draft PR URL. Then get on
with the work.
