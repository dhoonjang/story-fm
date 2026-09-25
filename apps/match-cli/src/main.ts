/**
 * 화면 없는 실시간 경기 — **같은 함수가 끝까지 굴린다** (live-match.md §8.4).
 *
 *   pnpm match                 픽스처의 두 팀으로 90분을 굴리고 통계를 찍는다
 *   pnpm match --seed 7        다른 시드
 *   pnpm match --games 5       여러 경기 — 팀당 평균이 함께 선다
 *   pnpm match --events        사건 목록까지 찍는다
 *   pnpm match --dry           설정만 찍고 굴리지 않는다
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  GamePlayerSchema,
  TacticsSpecSchema,
  eventCausesText,
  freshPlayerState,
  naturalPositionOf,
  subCauseText,
  type LiveSlot,
  type MatchEvent,
} from "@story-fm/domain";
import {
  createLedger,
  createLiveMatch,
  describeLedger,
  liveDigest,
  matchFatigueOf,
  playLiveToEnd,
  possessionOf,
  sideStatLine,
  type LiveMatch,
  type LiveSetup,
} from "@story-fm/sim";

// ---- 인자 파싱 ----
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dry = argv.includes("--dry");
const showEvents = argv.includes("--events");
const seed = Number(flag("seed") ?? 42);
const games = Math.max(1, Number(flag("games") ?? 1));

// ---- 픽스처 ----
const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * 픽스처의 선수는 정체성·능력·폼·체력만 든다 — 세이브가 드는 장부(스쿼드 층·완장·
 * 성장 이월·누적 피로 …)는 여기서 기준값으로 채운다. 실시간 경기가 읽는 것은 능력과 몸이다.
 */
const FixturePlayerSchema = z
  .object({
    state: z.object({ form: z.number(), condition: z.number() }).passthrough(),
  })
  .passthrough()
  .transform((raw) =>
    GamePlayerSchema.parse({
      squadLevel: "first",
      isViceCaptain: false,
      growthCarry: {},
      ...raw,
      state: freshPlayerState({ form: raw.state.form, condition: raw.state.condition }),
    }),
  );
const SideSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  players: z.array(FixturePlayerSchema),
  /** 선발 11 (선수 id) — 나머지는 벤치 */
  startingIds: z.array(z.string()).length(11),
  tactics: TacticsSpecSchema,
  managerTactics: z.number(),
});
type Side = z.infer<typeof SideSchema>;
const FixtureSchema = z.object({ home: SideSchema, away: SideSchema });
const fixture = FixtureSchema.parse(
  JSON.parse(readFileSync(path.join(here, "../fixtures/teams.json"), "utf8")),
);
const names = { home: fixture.home.teamName, away: fixture.away.teamName };
const byId = new Map([...fixture.home.players, ...fixture.away.players].map((p) => [p.id, p]));
const nameOf = (id: string) => byId.get(id)?.name ?? id;

/** 픽스처 → 자리 (배치 포지션은 주 포지션으로 근사, 적응도는 기준선) */
function slotsOf(side: Side): LiveSlot[] {
  return side.startingIds.flatMap((id) => {
    const player = byId.get(id);
    if (!player) return [];
    const natural = naturalPositionOf(player);
    return [
      {
        playerId: id,
        position: natural.position,
        proficiency: natural.proficiency,
        familiarity: 60,
      },
    ];
  });
}

function setupOf(matchSeed: number, matchId: string): LiveSetup {
  const players = Object.fromEntries([...byId.values()].map((p) => [p.id, p]));
  const sideSetup = (side: Side) => ({
    teamId: side.teamId,
    ai: true,
    managerTactics: side.managerTactics,
    kickoffTactics: side.tactics,
    derbyHeat: 0,
  });
  return {
    seed: matchSeed,
    matchId,
    friendly: false,
    extraTime: null,
    sides: { home: sideSetup(fixture.home), away: sideSetup(fixture.away) },
    players,
    proneness: Object.fromEntries([...byId.keys()].map((id) => [id, 1])),
  };
}

function benchOf(side: Side): string[] {
  return side.players.filter((p) => !side.startingIds.includes(p.id)).map((p) => p.id);
}

function playMatch(matchSeed: number, matchId: string): LiveMatch {
  const setup = setupOf(matchSeed, matchId);
  const ledger = createLedger(
    { onPitch: [...fixture.home.startingIds], bench: benchOf(fixture.home) },
    { onPitch: [...fixture.away.startingIds], bench: benchOf(fixture.away) },
  );
  const match = createLiveMatch(
    setup,
    ledger,
    { home: slotsOf(fixture.home), away: slotsOf(fixture.away) },
    { home: fixture.home.tactics, away: fixture.away.tactics },
    { points: [], sheet: [] },
  );
  // 하프타임은 감독이 재개하는 자리다 — 화면이 없으니 러너가 곧바로 푼다
  playLiveToEnd(match);
  return match;
}

function eventLine(e: MatchEvent): string {
  const team = e.team ? ` [${e.team}]` : "";
  const actors = e.actors.length > 0 ? ` ${e.actors.map(nameOf).join(" → ")}` : "";
  const reasons = [
    ...(e.subCause ? [subCauseText(e.subCause)] : []),
    ...(e.causes.length > 0 ? [eventCausesText(e.causes, nameOf)] : []),
  ];
  const causes = reasons.length > 0 ? `  ⟵ ${reasons.join(", ")}` : "";
  const at = e.added ? `${e.minute}+${e.added}` : String(e.minute);
  return `  ${at.padStart(5)}′ ${e.type}${team}${actors}${causes}`;
}

console.log(`═══ ${names.home}(홈) vs ${names.away} · 시드 ${seed} · ${games}경기 ═══`);
if (dry) {
  console.log("(--dry: 굴리지 않고 종료)");
  process.exit(0);
}

const totals: Record<
  "home" | "away",
  { goals: number; shots: number; xg: number; passes: number; distance: number }
> = {
  home: { goals: 0, shots: 0, xg: 0, passes: 0, distance: 0 },
  away: { goals: 0, shots: 0, xg: 0, passes: 0, distance: 0 },
};
for (let i = 0; i < games; i++) {
  const match = playMatch(seed + i, `cli-${seed + i}`);
  const possession = possessionOf(match);
  console.log(`\n── 경기 ${i + 1} · ${describeLedger(match.ledger, names).split("\n")[0]}`);
  for (const side of ["home", "away"] as const) {
    const s = sideStatLine(match.ledger, side);
    totals[side].goals += match.ledger.score[side];
    totals[side].shots += s.shots;
    totals[side].xg += s.xg;
    totals[side].passes += s.passes;
    totals[side].distance += s.distance;
    console.log(
      `  ${names[side].padEnd(12)} 점유 ${(possession[side] * 100).toFixed(0)}% · 슛 ${s.shots}(유효 ${s.shotsOnTarget}) · xG ${s.xg.toFixed(2)} (${(s.xg / Math.max(1, s.shots)).toFixed(2)}/슛) · ` +
        `패스 ${s.passesCompleted}/${s.passes} · 크로스 ${s.crosses} · 드리블 ${s.dribblesWon}/${s.dribbles} · 태클 ${s.tacklesWon}/${s.tackles} · 차단 ${s.interceptions} · 선방 ${s.saves} · 파울 ${s.fouls} · 코너 ${s.corners} · ${(s.distance / 11000).toFixed(1)}km/인`,
    );
  }
  const fatigue = matchFatigueOf(match);
  const drained = Object.values(fatigue);
  console.log(
    `  체력 소모 평균 ${(drained.reduce((a, b) => a + b, 0) / Math.max(1, drained.length)).toFixed(1)} · digest ${liveDigest(match.state, match.ledger)}`,
  );
  if (showEvents) for (const e of match.ledger.events) console.log(eventLine(e));
}
if (games > 1) {
  console.log(`\n═══ 팀당 평균 (${games}경기) ═══`);
  for (const side of ["home", "away"] as const) {
    const t = totals[side];
    console.log(
      `  ${names[side].padEnd(12)} 골 ${(t.goals / games).toFixed(2)} · 슛 ${(t.shots / games).toFixed(1)} · xG ${(t.xg / games).toFixed(2)} · 패스 ${(t.passes / games).toFixed(0)} · ${(t.distance / games / 11000).toFixed(1)}km/인`,
    );
  }
}
