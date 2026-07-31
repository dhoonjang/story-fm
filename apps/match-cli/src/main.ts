/**
 * 경기 세로 관통 프로토타입 — 전력 분석 패킷(코어) → 매치 티어 LLM 진행 →
 * 장부 검증(코어)의 한 사이클을 실제로 돌려본다 (match-sim.md).
 *
 *   pnpm match --dry          패킷·장부만 출력 (LLM 호출 없음)
 *   pnpm match --turns 3      진행 턴 수 제한 (기본 8)
 *   pnpm match --note "..."   감독의 경기 전 지시
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { GamePlayerSchema, TacticsSpecSchema, type MatchEvent } from "@story-fm/domain";
import { naturalPositionOf } from "@story-fm/domain";
import {
  applyEvents,
  buildStrengthPacket,
  createLedger,
  describeLedger,
  type MatchLedgerState,
} from "@story-fm/sim";
import { createGameLLM, TIERS, type TurnHistory, type TurnUsage } from "@story-fm/llm";
import {
  GM_SYSTEM,
  MATCH_CASTER_SYSTEM,
  buildContinueMessage,
  buildKickoffMessage,
  makeLogMatchEventsTool,
  resolveSystemPrompts,
} from "@story-fm/agents";

// ---- 인자 파싱 (프로토타입 수준) ----
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dry = argv.includes("--dry");
const maxTurns = Number(flag("turns") ?? 8);
const managerNote = flag("note") ?? "측면을 적극적으로 쓰고, 전방 압박은 무리하지 마.";

// ---- 픽스처 로드 ----
const here = path.dirname(fileURLToPath(import.meta.url));
const SideSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  players: z.array(GamePlayerSchema),
  /** 선발 11 (선수 id) — 나머지는 벤치 */
  startingIds: z.array(z.string()).length(11),
  tactics: TacticsSpecSchema,
  managerTactics: z.number(),
});
const FixtureSchema = z.object({ home: SideSchema, away: SideSchema });

/** 픽스처 → 패킷 입력 (배치 포지션은 주 포지션으로 근사) */
function toSideInput(side: z.infer<typeof SideSchema>) {
  const byId = new Map(side.players.map((p) => [p.id, p] as const));
  const slot = (id: string) => {
    const player = byId.get(id);
    if (!player) return null;
    const pos = naturalPositionOf(player);
    return { player, position: pos.position, proficiency: pos.proficiency };
  };
  const starters = side.startingIds.flatMap((id) => {
    const s = slot(id);
    return s ? [s] : [];
  });
  const bench = side.players
    .filter((p) => !side.startingIds.includes(p.id))
    .flatMap((p) => {
      const s = slot(p.id);
      return s ? [s] : [];
    });
  return {
    teamId: side.teamId,
    teamName: side.teamName,
    starters,
    bench,
    tactics: side.tactics,
    managerTactics: side.managerTactics,
  };
}
const fixture = FixtureSchema.parse(
  JSON.parse(readFileSync(path.join(here, "../fixtures/teams.json"), "utf8")),
);

const names = { home: fixture.home.teamName, away: fixture.away.teamName };

// ---- ① 전력 분석 (코어, 결정적) ----
const packet = buildStrengthPacket(toSideInput(fixture.home), toSideInput(fixture.away));

console.log("═══ 전력 분석 패킷 ═══");
console.log(packet.summary);
for (const m of packet.matchups) console.log(`  · ${m.why}`);
for (const k of packet.keyPoints) console.log(`  ★ ${k}`);
console.log(
  `  기대 득점 ${packet.guide.expectedGoals.home} : ${packet.guide.expectedGoals.away} · 업셋 확률 ${Math.round(packet.guide.upsetChance * 100)}%`,
);

if (dry) {
  console.log("\n(--dry: LLM 호출 없이 종료)");
  process.exit(0);
}

// ---- ② 경기 장부 + log_match_events 도구 ----
const ledgerSide = (side: z.infer<typeof SideSchema>) => ({
  onPitch: [...side.startingIds],
  bench: side.players.filter((p) => !side.startingIds.includes(p.id)).map((p) => p.id),
});
let ledger: MatchLedgerState = createLedger(ledgerSide(fixture.home), ledgerSide(fixture.away));
const tool = makeLogMatchEventsTool((events: MatchEvent[]) => {
  const result = applyEvents(ledger, events);
  if (!result.ok) return { ok: false, message: result.errors.join("\n") };
  ledger = result.state;
  return {
    ok: true,
    message: `기록 완료 — ${names.home} ${ledger.score.home} : ${ledger.score.away} ${names.away}, ${ledger.minute}′ (${ledger.phase})`,
  };
});

// ---- ③ 매치 티어 LLM 진행 루프 ----
const llm = createGameLLM(TIERS.match);
const matchSystem = resolveSystemPrompts({
  gm: GM_SYSTEM,
  match: MATCH_CASTER_SYSTEM,
}).prompts.match;
const totalUsage: TurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

let history: TurnHistory = [];
let userMessage = buildKickoffMessage(packet, managerNote);

for (let turn = 1; turn <= maxTurns && ledger.phase !== "finished"; turn++) {
  console.log(`\n═══ 진행 턴 ${turn} ═══`);
  const result = await llm.runTurn({
    system: matchSystem,
    history,
    user: userMessage,
    tools: [tool],
  });
  history = result.history;
  for (const key of Object.keys(totalUsage) as Array<keyof TurnUsage>) {
    totalUsage[key] += result.usage[key];
  }

  console.log(result.text);
  console.log(`\n— ${describeLedger(ledger, names).split("\n")[0]}`);
  console.log(
    `  (usage: in ${result.usage.inputTokens} / out ${result.usage.outputTokens} / cache-read ${result.usage.cacheReadTokens} / tool calls ${result.toolCallCount})`,
  );

  // 프로토타입은 비대화형 — 항상 "계속". 대화형 개입은 다음 단계.
  userMessage = buildContinueMessage(describeLedger(ledger, names), "좋아, 계속 진행해.");
}

// ---- ④ 결과 ----
console.log("\n═══ 경기 결과 ═══");
console.log(describeLedger(ledger, names));
console.log("\n이벤트 로그:");
for (const e of ledger.events) {
  const team = e.team ? ` [${e.team}]` : "";
  const actors = e.actors.length > 0 ? ` ${e.actors.join(" → ")}` : "";
  const causes = e.causes.length > 0 ? `  ⟵ ${e.causes.join(", ")}` : "";
  console.log(`  ${String(e.minute).padStart(3)}′ ${e.type}${team}${actors}${causes}`);
}
console.log(
  `\n총 usage — in ${totalUsage.inputTokens} / out ${totalUsage.outputTokens} / cache-read ${totalUsage.cacheReadTokens} / cache-write ${totalUsage.cacheWriteTokens}`,
);
if (ledger.phase !== "finished") {
  console.log(`(턴 제한 ${maxTurns}회로 중단 — --turns를 늘리면 끝까지 진행)`);
}
