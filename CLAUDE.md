# CLAUDE.md

Vision, architecture and development conventions all live in
**[AGENTS.md](./AGENTS.md)**. Follow that document first.

@AGENTS.md

---

## Working here with Claude Code

- **Language** — talk to the user in Korean; comments and explanations too. Code
  identifiers stay as they are.
- **Core vs LLM boundary** — the sim core is deterministic pure functions; the
  LLM injects judgment and narrative only. Never mix the two (AGENTS.md §4, §6).
- **Adding an LLM call** — Zod validation, caching and an agent entry in
  `config/llm.yml`. Never hard-code a model ID (docs/llm/models.md).
- **Claude API details** (model IDs, pricing, caching, tool use) — check the
  `claude-api` skill or the current reference, never memory.
- **Commit / push** — only when the user asks. Commit to the branch already
  checked out and `git push origin HEAD`; name the paths you add, and never
  rebase, stash or switch branches (AGENTS.md §5).
- **CI is the gate** — while working, run `pnpm typecheck` / `pnpm lint` and
  `pnpm test <path>` for the file you just wrote. The full `pnpm test` and
  `pnpm e2e` run in GitHub Actions on the PR; do not spend minutes on them
  locally unless the user asks or CI failed (AGENTS.md §5).
- **Ask when unsure** — anything that moves game balance or the core loop.

## Commands

```bash
pnpm install          # Node 26 — see .nvmrc
pnpm test <path>      # the one suite you just touched — the local test loop
pnpm typecheck        # tsc --noEmit (TS 6.x — 7 breaks typescript-eslint)
pnpm lint             # ESLint
pnpm test / pnpm e2e  # full suites — CI runs these; locally only on request
pnpm dev              # web app dev server (LLM_MODE=mock needs no API key)
pnpm match --dry      # match CLI prototype: prints the strength packet only
```

> `LLM_MODE=mock|real` — unset falls back to `real` when `config/llm.yml` has a
> GM provider key. **[docs/](./docs/README.md) is the single source for game
> design — when behavior changes, update the docs before the code.**
