# story-fm

> A next-generation football manager game built around an LLM core.
> The player is an **AI manager** who directs the team in natural language, the
> core simulates the match, and every moment is brought to life by AI-generated
> **narrative**.

This file is the single source for the project's **vision and development
conventions**; both AI agents and human contributors work from it. `CLAUDE.md`
points here. **How the game actually behaves lives in
[docs/](./docs/README.md)** — start with [overview.md](./docs/overview.md).

---

## 1. Vision

Traditional football managers are games of sliders and probability tables.
story-fm turns that into a **game of language**: you direct the team by talking,
players and owners and journalists react as characters with their own motives,
and the story — dressing-room conflict, a prospect's arc, a rivalry that festers
— matters more than the scoreline.

### Design principles

1. **Language is the interface.** The UI supports it; it does not replace it.
2. **Explainable outcomes.** Every ruling and every beat must answer "why did
   that happen". Avoid black-box randomness.
3. **Emergent story, exact ledger.** The LLM invents the telling; the core keeps
   state, rules and numbers deterministic.
4. **Quality first, cost second.** Design calls without waste (caching, context
   hygiene), but never let cost cutting degrade the experience.

## 2. The game in one paragraph

**The whole game is one chat.** The user plays the manager and the GM (an LLM)
plays the world. State changes travel exactly one path — skill (tool call) → Zod
validation → deterministic transition — and **match results are decided by the
core's xG-interval simulator**; the LLM only commentates, stages and adjudicates.
A season starts on July 1 and runs preseason → league/cup/European competition →
season rollover → next season. Data has two layers: catalog (immutable seed) and
save (mutable state), model v6.

## 3. Stack

- **Language** — TypeScript, strict, full stack
- **Runtime** — Next.js (App Router) + Node.js
- **Packages** — pnpm monorepo workspaces
- **LLM** — multi-provider, configured **per agent**. `config/llm.yml` is the
  single source for providers and model IDs (→ [docs/llm/models.md](./docs/llm/models.md))
- **Validation** — Zod, enforcing structured LLM I/O
- **Test** — Vitest + Playwright · **Lint** — ESLint + Prettier

### Layout

```
docs/              # design spec — how the game works today (README.md is the map)
  data/            #   what exists — players, teams, competitions, people, saves
  simulation/      #   what happens — match, season, transfer, finance, career
  llm/             #   how it speaks — models, agents, prompts
apps/
  web/             # Next.js — chat UI · office views · API · /admin
packages/
  domain/          # domain models + Zod schemas (player, tactics, records, fixtures, personas)
  sim/             # match sim core — strength packet · xG-interval sim · matchups · stamina
  engine/          # game engine — each folder is a domain:
                   #   core/(state, save, tick, dates) world/(catalog, generation, wages)
                   #   competition/(calendar, league, cup, europe) match/(match flow, quick sim)
                   #   squad/(form, morale, injury, training, scouting) market/(transfers, negotiation)
                   #   club/(finance, press) skills/(manager instructions) views/(screens, queries)
                   #   data/(catalog, seed)
  agents/          # GM orchestrator · commentary · summary writers · mock GM
  llm/             # provider-neutral GameLLM + Anthropic/Gemini/OpenAI adapters
```

## 4. Architecture

- **The core rules and keeps the books; the LLM tells the story.** State
  transitions, formulas and validation are deterministic pure functions, tested
  without an LLM. The core decides match results, and the manager's instructions
  reach those results only through the strength packet
  (→ [docs/simulation/match.md](./docs/simulation/match.md)).
- **Structured output first.** Never make the LLM emit free text for the code to
  parse — force tool calls with Zod schemas, and keep free text for prose humans
  read.
- **Event sourcing.** A match is an event log; narrative, replay and debugging
  all derive from it.
- **Personas are data.** Character and memory live in prompts and state, not in
  code.

## 5. Conventions

### Code

- `strict: true`. No `any` (use `unknown` plus narrowing when unavoidable).
- Functional and immutable by default; isolate side effects at the boundary
  (API/IO).
- Domain types live in `packages/domain`; other packages import from there.
- kebab-case files and directories, PascalCase types and components, camelCase
  values and functions.
- Give numbers and formulas names — balance tuning should only need to read that
  one function.
- Comments state constraints the code cannot show. History and justification
  belong in docs.

### Commits

- Conventional Commits (`feat:` `fix:` `refactor:` `docs:` `test:` `chore:`).
- One concern per PR — PRs are squash-merged, so one PR is one commit on main and
  the PR title is that commit's subject. **Prompt changes go in their own PR.**
- Commit and push only when the user asks. When a unit of work is done, commit to
  **the branch already checked out** and `git push origin HEAD` — never switch
  branches to commit.
- Name the paths you add. `git add -A` / `.` sweeps up another agent's
  half-finished edits. For the same reason: no rebase, no stash, no branch
  switching.

### Tests

- Test the sim core **without an LLM** — fixed seed, deterministic.
- Test LLM-dependent logic with mocks, or at the schema-validation level.
- New features ship with tests. Never hide a failing test; report it as it is.

**The gate is CI, not your machine.** `.github/workflows/ci.yml` runs
`typecheck` · `lint` · `pnpm test` · `pnpm e2e`, and its verdict is what
`/merge` waits on. **It does not run while the PR is a draft** — a branch still
being worked on burns runner minutes nobody reads. `/merge` marks the PR ready,
and that is what starts the run it then watches.

**The suite does not fit one runner.** `pnpm test` is ~84 runner-minutes of CPU
and `ubuntu-latest` has two cores, so the test gate is four jobs —
`unit + api (i/4)`, each running `--shard=i/4 --maxWorkers=100%`. All four must
be green; a shard is not a sample. Vitest assigns files to shards by hashing
their path, so a new test file reshuffles the split, and **one file is never
split across shards** — the slowest file is the floor for its shard, and today
that is `finance.test.ts` at 17.5 minutes on the runner. More shards will not
move that floor; only a cheaper test will. Nothing is excluded from the gate:
making it faster means making a test cheaper, not moving it out of CI.

- **While working** — `pnpm typecheck` and `pnpm lint`, plus `pnpm test <path>`
  for the file you just wrote. That is the whole local loop.
- **Do not run the full `pnpm test` or `pnpm e2e` locally.** Both cost minutes
  the CI runner is already paying, and the suite you would run is the one CI
  runs. Run them locally only when the user asks, or when CI has failed and you
  need to reproduce the failure to fix it.
- `pnpm e2e` uses port 3399, `.next-e2e` and `/tmp/story-fm-e2e`. Run **one e2e
  at a time per worktree** — a second concurrent run attaches to the first
  server through `reuseExistingServer` and the two trample each other.
  (`E2E_SLOT=1`–`9` splits port, build output and save directory together if a
  parallel run is genuinely needed.)

### Working alongside others

- Ports 3000 and 3311 belong to the user's dev servers. Never kill them.
- Isolate verification saves with `STORY_FM_DATA_DIR=<tmp>`; never touch
  `apps/web/.data`.
- A pre-existing failure that does not name a file you touched is not yours to
  fix — report it as-is.

### Docs

- When the plan or architecture changes, **update `docs/` before the code**.
- Docs describe **the present only** — no decision logs, no change history. Git
  does that.

## 6. LLM integration rules (most important)

1. **Never hard-code a model ID.** `config/llm.yml` owns provider and model per
   agent; `packages/llm` adapters absorb provider differences
   (→ [docs/llm/models.md](./docs/llm/models.md)).
2. **Validate structured output with Zod** and retry on failure. A parse failure
   never reaches game state.
3. **Context hygiene** — stack input in three layers by change frequency (fixed /
   reference / history) to keep the cache prefix intact. Never interpolate dates
   or IDs into the fixed layer.
4. **Determinism boundary** — the ledger is deterministic, the telling is
   emergent. Emergent output never becomes game state unvalidated, and an LLM
   ruling always stays within **core anchor ± bound**.
5. **Prompts are code** — separate files or constants so versions and diffs stay
   traceable. ⚠️ **Edit by deleting first.** When the behavior is wrong, delete
   the line that causes it before adding an instruction. Keep the rules; drop
   reasons, analogies and redundant examples — the model reads explanations and
   writes like them.
6. **Cache** identical calls, prompt cache included.
7. **Guardrails** — validate that LLM output cannot break game rules (impossible
   tactics, players who do not exist).

> Never answer Claude API details (model IDs, pricing, caching, tool use) from
> memory — check the current reference (the `claude-api` skill in Claude Code).

## 7. Doc map

**[docs/](./docs/README.md) is the single source for what the game does** — each
folder is a layer. Read the design doc for the domain you are touching before you
start, and do not blur the boundary between the deterministic core and the
non-deterministic LLM.

| Folder | What | Docs |
| --- | --- | --- |
| — | Overall structure · the path of one turn · the game loop | [overview.md](./docs/overview.md) |
| `data/` | What exists | [game-state](./docs/data/game-state.md) · [player](./docs/data/player.md) · [team](./docs/data/team.md) · [competition](./docs/data/competition.md) · [people](./docs/data/people.md) · [sources](./docs/data/sources.md) |
| `simulation/` | What happens | [match](./docs/simulation/match.md) · [season](./docs/simulation/season.md) · [transfer](./docs/simulation/transfer.md) · [finance](./docs/simulation/finance.md) · [career](./docs/simulation/career.md) |
| `llm/` | How it speaks | [models](./docs/llm/models.md) · [agents](./docs/llm/agents.md) · [prompts](./docs/llm/prompts.md) |

## Status

🚧 **Playable prototype (data model v6, SAVE_VERSION 6).** Onboarding → chat
instructions → match → season rollover → multi-season runs end to end. What is
built and what is not is listed in [overview.md](./docs/overview.md) §7.

- **Save compatibility** — new tables load as empty arrays and new fields are
  optional; not bumping the save version is the default. If a structural change
  requires wiping `.data`, ask the user first.
