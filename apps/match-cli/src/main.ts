/**
 * 경기 세로 관통 프로토타입 — 전력 분석 패킷(코어) → 매치 캐스터 LLM 진행 →
 * 장부 검증(코어)의 한 사이클을 실제로 돌려본다 (match.md).
 *
 *   pnpm match --dry          패킷·장부만 출력 (LLM 호출 없음)
 *   pnpm match --turns 3      진행 턴 수 제한 (기본 8)
 *   pnpm match --note "..."   감독의 경기 전 지시
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  GamePlayerSchema,
  TacticsSpecSchema,
  type MatchEvent,
  type StrengthPacket,
} from "@story-fm/domain";
import {
  matchupText,
  naturalPositionOf,
  packetTagContext,
  packetTagText,
  subCauseText,
} from "@story-fm/domain";
import {
  accumulateFatigue,
  applyEvents,
  buildStrengthPacket,
  createLedger,
  describeLedger,
  makeRng,
  mergeSubstitutions,
  planAiSubstitution,
  simulateSegment,
  type MatchLedgerState,
} from "@story-fm/sim";
import { agentConfig, createGameLLM, type TurnHistory, type TurnUsage } from "@story-fm/llm";
import { MATCH_CASTER_SYSTEM, buildContinueMessage, buildSegmentMessage } from "@story-fm/agents";

/**
 * 킥오프 턴 유저 메시지 — 패킷 + 감독의 사전 지시. **이 프로토타입만 읽는다.**
 * 웹은 패킷을 사람이 읽는 줄로 요약해 싣고(`buildLedgerNote`), JSON을 통째로 붓는
 * 것은 한 사이클을 눈으로 훑는 여기뿐이다 (prompts.md §5).
 */
function buildKickoffMessage(packet: StrengthPacket, managerNote?: string): string {
  const note = managerNote ? `\n\n[감독의 경기 전 지시]\n${managerNote}` : "";
  return (
    `아래 전력 분석 패킷을 근거로 경기를 시작하라. 킥오프부터 첫 정지점까지 진행한다.` +
    `\n\n[전력 분석 패킷]\n${JSON.stringify(packet, null, 2)}${note}`
  );
}

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
console.log(`${packet.home.teamName}(홈) vs ${packet.away.teamName}`);
const tagCtx = packetTagContext(packet);
for (const m of packet.matchups) console.log(`  · ${matchupText(m)}`);
for (const k of packet.keyPoints) console.log(`  ★ ${packetTagText(k, tagCtx)}`);
console.log(`  기대 득점 ${packet.guide.expectedGoals.home} : ${packet.guide.expectedGoals.away}`);

if (dry) {
  console.log("\n(--dry: LLM 호출 없이 종료)");
  process.exit(0);
}

// ---- ② 경기 장부 + 구간 시뮬레이터 ----
// 결과는 코어가 xg로 굴린다. LLM은 그 사건을 중계할 뿐이다 (match.md §2).
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
let segmentIndex = 0;
const matchFatigue: Record<string, number> = {};
/** 구간 시뮬의 연속 시계 — 장부의 정수 분이 잘라 버린 소수 자리를 다음 구간에 잇는다 */
let matchClock: number | undefined;

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
    clock: matchClock,
    rng,
  });
  matchClock = plan.clock;
  const aiSubs = planAiSubstitution("away", squads.away, ledger, plan, rng);
  // 끼우는 순서는 엔진과 한 벌이다 (sim/segment.ts) — 부상 교체만 사건 뒤에 선다
  const events: MatchEvent[] = mergeSubstitutions(plan.events, aiSubs);
  const result = applyEvents(ledger, events);
  if (!result.ok) return { note: `[진행 실패] ${result.errors.join(" / ")}`, stop: plan.stop };
  ledger = result.state;
  segmentIndex += 1;
  accumulateFatigue(matchFatigue, plan.fatigue);
  return {
    note: buildSegmentMessage(events, plan.stop, nameOf, (side) =>
      side === "home" ? names.home : names.away,
    ),
    stop: plan.stop,
  };
}

// ---- ③ 매치 캐스터 LLM 진행 루프 ----
const llm = createGameLLM(agentConfig("match-caster"));
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
    system: MATCH_CASTER_SYSTEM,
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
  const reasons = [
    ...(e.subCause ? [subCauseText(e.subCause)] : []),
    ...e.causes.map((t) => packetTagText(t, tagCtx)),
  ];
  const causes = reasons.length > 0 ? `  ⟵ ${reasons.join(", ")}` : "";
  console.log(`  ${String(e.minute).padStart(3)}′ ${e.type}${team}${actors}${causes}`);
}
console.log(
  `\n총 usage — in ${totalUsage.inputTokens} / out ${totalUsage.outputTokens} / cache-read ${totalUsage.cacheReadTokens} / cache-write ${totalUsage.cacheWriteTokens}`,
);
if (!finished) {
  console.log(`(턴 제한 ${maxTurns}회로 중단 — --turns를 늘리면 끝까지 진행)`);
}
