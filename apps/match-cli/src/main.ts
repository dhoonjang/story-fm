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
  planAiSubstitution,
  simulateSegment,
  type MatchLedgerState,
} from "@story-fm/sim";
import { createGameLLM, TIERS, type TurnHistory, type TurnUsage } from "@story-fm/llm";
import {
  GM_SYSTEM,
  MATCH_CASTER_SYSTEM,
  buildContinueMessage,
  buildKickoffMessage,
  buildSegmentMessage,
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

// ---- ② 경기 장부 + 구간 시뮬레이터 ----
// 결과는 코어가 xg로 굴린다. LLM은 그 사건을 중계할 뿐이다 (match-sim.md §2).
const ledgerSide = (side: z.infer<typeof SideSchema>) => ({
  onPitch: [...side.startingIds],
  bench: side.players.filter((p) => !side.startingIds.includes(p.id)).map((p) => p.id),
});
let ledger: MatchLedgerState = createLedger(ledgerSide(fixture.home), ledgerSide(fixture.away));
const byId = new Map([...fixture.home.players, ...fixture.away.players].map((p) => [p.id, p]));
const nameOf = (id: string) => byId.get(id)?.name ?? id;
const squadOf = (side: z.infer<typeof SideSchema>, s: { onPitch: string[]; bench: string[] }) => ({
  onPitch: s.onPitch.map((id) => byId.get(id)!).filter(Boolean),
  bench: s.bench.map((id) => byId.get(id)!).filter(Boolean),
});
const seed = Number(flag("seed") ?? 42);
/** mulberry32 — 엔진의 `makeRng`와 같은 알고리즘 (CLI는 엔진에 의존하지 않는다) */
function makeRng(base: number, channel: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < channel.length; i++) {
    h ^= channel.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = (base ^ (h >>> 0)) >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let segmentIndex = 0;
const matchFatigue: Record<string, number> = {};

/** 다음 정지점까지 굴려 장부에 반영하고, 캐스터에게 줄 대본을 돌려준다 */
function runSegment(): { note: string; stop: string } {
  const rng = makeRng(seed, `cli-segment:${segmentIndex}`);
  const squads = {
    home: squadOf(fixture.home, ledger.home),
    away: squadOf(fixture.away, ledger.away),
  };
  const plan = simulateSegment({
    packet,
    ledger,
    squads,
    tactics: { home: fixture.home.tactics, away: fixture.away.tactics },
    rng,
  });
  const aiSub = planAiSubstitution("away", squads.away, ledger, plan, rng);
  const events: MatchEvent[] = aiSub ? [aiSub, ...plan.events] : plan.events;
  const result = applyEvents(ledger, events);
  if (!result.ok) return { note: `[진행 실패] ${result.errors.join(" / ")}`, stop: plan.stop };
  ledger = result.state;
  segmentIndex += 1;
  for (const [id, add] of Object.entries(plan.fatigue)) {
    matchFatigue[id] = Math.min(100, (matchFatigue[id] ?? 0) + add);
  }
  return {
    note: buildSegmentMessage(events, plan.stop, nameOf, (side) =>
      side === "home" ? names.home : names.away,
    ),
    stop: plan.stop,
  };
}

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
let finished = false;

for (let turn = 1; turn <= maxTurns && !finished; turn++) {
  console.log(`\n═══ 진행 턴 ${turn} ═══`);
  // 코어가 먼저 구간을 굴린다 — 사건이 확정된 뒤에 캐스터가 중계한다
  const segment = runSegment();
  finished = segment.stop === "full_time";
  const userMessage =
    turn === 1
      ? `${buildKickoffMessage(packet, managerNote)}\n\n${segment.note}`
      : `${buildContinueMessage(describeLedger(ledger, names), "좋아, 계속 진행해.")}\n\n${segment.note}`;
  const result = await llm.runTurn({
    system: matchSystem,
    history,
    user: userMessage,
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
if (!finished) {
  console.log(`(턴 제한 ${maxTurns}회로 중단 — --turns를 늘리면 끝까지 진행)`);
}
