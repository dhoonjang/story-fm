---
name: game-version
description: >-
  Decide whether a change moves `config/game-version.yml` and by which digit,
  then move it. Use before committing anything that changes what the model
  reads — prompts, tool specs, snapshot builders, `config/llm.yml` — and when
  the user says "버전 올려", "게임 버전", "이거 버전 올려야 해?", or asks why two
  logs from different days disagree.
---

# Game version — the version of what the model reads

`config/game-version.yml` carries one line, and **every traced LLM call records
it** (docs/llm/models.md §5-2). Its whole job is to answer one question when a
log from months ago is opened: did that answer come from the same prompts, the
same tools and the same models as today? If yes, a difference between two
responses is the model's variance. If no, it is ours.

So the question is never "did files change". It is:

> **Would the model see something different than it saw before this commit?**

A version that never moves makes every old log unreadable. A version that moves
on every commit is noise. Both failures cost the same thing — the ability to
compare.

## The three digits

| Digit     | What changed                                           | Then old logs are…                                          |
| --------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| **major** | The **shape** of what the model reads, or who reads it | not comparable — the pipeline itself is different           |
| **minor** | The **content** inside the same shape                  | comparable, but a rule/tool/model is not the same one       |
| **patch** | The **values or wording** the model sees, same rules   | comparable; differences in phrasing or numbers are expected |

**major** — an agent is added or removed; a turn's call graph changes (a new
call in the chain, or one folded away); the context layering is rearranged
(fixed / reference / history — AGENTS.md §6-3); the tool catalog is restructured
rather than edited; the output grammar changes.

**minor** — a rule is added to or deleted from a system prompt; a tool is added,
removed, renamed, or its input schema changes; a new field lands in the state
snapshot or a reference card; the history window or compaction threshold moves;
`config/llm.yml` changes a model, `thinking_level`, `max_tokens`, or
`operator_channel`.

**patch** — prompt wording is tightened without changing what it asks for; a
number's format, unit, or rounding in the snapshot changes; a list's sort order
changes; a core formula moves and the snapshot's numbers move with it.

When one change spans two digits, take the **higher** one — and only once.

## Deciding

1. `git diff --stat` — which paths moved.
2. Any of them in the map below? If none, **stop: the version does not move.**
3. For those that did: does the model's input actually come out different?
   A rename, a type-only refactor, or a reordering that produces identical bytes
   moves nothing. When unsure, look at the produced string, not the diff.
4. Pick the digit by the table above. One PR moves the version **once**, by the
   highest digit its changes earned — this repo squash-merges, so one PR is one
   commit on main.
5. Edit the `version:` line in `config/game-version.yml` and include it in the
   same commit as the change. A version bump committed separately points at a
   code state that never existed.

## Where model input comes from

| Path                                                                                                                                                           | What of it reaches the model                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/agents/src/*-prompt.ts`, `gm.ts`                                                                                                                     | system prompts (`GM_SYSTEM`, `MATCH_GM_SYSTEM`, …)                      |
| `packages/agents/src/gm-input.ts`                                                                                                                              | reference cards · state snapshot · this turn's message · history window |
| `packages/agents/src/gm-tools.ts`, `skill-descriptions.ts`, `tool-schema.ts`                                                                                   | tool names, descriptions, input schemas                                 |
| `packages/agents/src/match-gm.ts`, `*-orders.ts`, `finalize-match.ts`, `training-rater.ts`, `negotiation-gm.ts`, `onboarding-judge.ts`, `history-compactor.ts` | each agent's prompt and its tools                                       |
| `packages/agents/src/output-agents.ts`                                                                                                                         | which calls answer with an output schema instead of tools               |
| `config/llm.yml`                                                                                                                                               | model id, thinking level, max tokens, operator channel                  |
| `packages/engine/src/views/**`                                                                                                                                 | the values the snapshot and cards are built from                        |
| `packages/engine/src/club/press.ts`, `approach.ts`                                                                                                             | legend blocks inside the snapshot                                       |
| `packages/engine/src/core/turn-facts.ts`, `history-window.ts`                                                                                                  | the ledger lines and how much history is carried                        |
| `packages/engine/src/commands/**` (`brief.ts`)                                                                                                                 | what a tool call answers back to the model                              |
| `packages/domain/src/manager.ts`, `tactics.ts`                                                                                                                 | the band→word tables the prompt speaks in                               |

`packages/agents/harness/prompt-regression.harness.ts` renders the real input —
run it (`pnpm balance prompt-regression`) when you cannot tell from the diff
whether the produced text moved.

## What never moves it

Screens and CSS · tests · `docs/` · save migrations that no prompt reads ·
balance harnesses · build config · anything under `apps/web/components` or
`app/styles`. The sim core moves it **only** when its numbers reach the
snapshot — a change to match internals that the model never reads does not.

## Reading logs by version

```bash
pnpm log --calls --version 1.2          # every call made on 1.2.x
pnpm log --calls --version 1.2 --agent gm --failed
```

The version sits in each call's record (`gameVersion`), in every line of
`calls.jsonl`, and in the trace popup's call header. When two logs disagree,
**compare their versions before comparing their content.**
