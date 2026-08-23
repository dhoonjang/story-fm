import type { MatchRecord } from "@story-fm/domain";
import { cupLegMatchId } from "@story-fm/domain";
import { addDays, buildSeasonCalendar } from "./calendar";
import { cupCatalog } from "../data/cup-catalog";
import { domesticCupsOfCountry } from "../data/domestic-cup-catalog";
import { topLeagueOfCountry } from "../data/league-catalog";
import { SUPER_CUP_CATALOG, type SuperCupEntry } from "../data/super-cup-catalog";
import { needsShootout, resolveExtraTime, settledTieWinner } from "./extra-time";
import { payPrize } from "./prize";
import { resolveShootout } from "./shootout";
import { pushNarrative, teamNameIn, type GameState } from "../core/state";

/**
 * 슈퍼컵 — 지난 시즌의 우승자가 프리시즌에 여는 한 경기.
 *
 * 라운드가 없으므로 진행형 상태 기계도 없다. 시즌 편성이 경기 하나를 만들어 두고
 * (`buildSuperCupMatches`), 그 경기가 끝나면 여기서 승부를 가려 트로피와 상금을
 * 낸다(`advanceSuperCups`). 국내 컵·대항전의 `advance*`와 같은 자리에서 불린다.
 *
 * 대진은 카탈로그가 아니라 **지난 시즌의 사실**에서 온다 — 리그 최종 순위·국내 컵
 * 우승·대항전 우승. 그래서 시즌 전환이 그 셋을 지우기 **전에** 읽어 넘겨야 한다
 * (`SuperCupSource` — season.ts의 `applyTransition`).
 */

/** 개막 토요일에서 며칠 앞인가 — 국내는 두 주 앞 수요일, 유럽은 개막 주 수요일 */
const DOMESTIC_DAYS_BEFORE_OPENER = -10;
const EUROPEAN_DAYS_BEFORE_OPENER = -3;

/**
 * 두 슈퍼컵이 **다른 수요일**에 서는 이유: 한 클럽이 둘 다 나올 수 있다 (UCL
 * 우승팀이 자기 리그 우승팀이기도 한 흔한 경우). 같은 날에 두면 그 클럽의 경기
 * 하나가 영영 소화되지 않고 시즌이 넘어가지 않는다.
 *
 * 수요일인 이유는 친선이 토요일에만 서기 때문이다 (season.md §2) — 앞뒤로 사흘씩
 * 남고, 개막 주 수요일과 금요일 밤 개막전 사이도 48시간이 채워진다.
 */
const SUPER_CUP_KICKOFF = "19:45";

/** 한 경기뿐이라 단계는 언제나 결승, 대진도 하나다 */
const SUPER_CUP_PAIR = 0;

/**
 * 지난 시즌이 남긴 우승자 — 대진의 원본.
 *
 * 리그는 **최종 순위표 전체**를 받는다. 우승팀이 컵도 가져간 시즌엔 준우승팀이
 * 상대이기 때문이다(실제 커뮤니티 실드·DFL-슈퍼컵 규정).
 */
export interface SuperCupSource {
  /** 리그 최종 순위 — `leagueId` → 1위부터 나열한 팀 id */
  leagueTables: Record<string, string[]>;
  /** 국내 컵 우승 — `cupId` → 팀 id */
  domesticChampions: Record<string, string>;
  /** 대항전 우승 — `cupId` → 팀 id */
  euroChampions: Record<string, string>;
}

/** 이 슈퍼컵이 서는 날 — 개막 토요일에서 거꾸로 센다 */
export function superCupDate(season: number, kind: SuperCupEntry["kind"]): string {
  // `calendar.start`는 금요일 밤 개막전이고, 그 다음 날이 개막 토요일이다
  const openerSaturday = addDays(buildSeasonCalendar(season).start, 1);
  return addDays(
    openerSaturday,
    kind === "european" ? EUROPEAN_DAYS_BEFORE_OPENER : DOMESTIC_DAYS_BEFORE_OPENER,
  );
}

/** 한 대회의 대진 — 두 자리가 다 차지 않으면 그 슈퍼컵은 그해 서지 않는다 */
function pairingOf(cup: SuperCupEntry, source: SuperCupSource): [string, string] | null {
  if (cup.kind === "european") {
    /**
     * **대항전 카탈로그의 위 두 대회** 우승자가 만난다 — UCL 우승 vs UEL 우승이다.
     * id를 박아 두지 않는 이유: 대회 이름이 바뀌어도 "1군과 2군 대회의 우승자"라는
     * 규정은 그대로다.
     */
    const [first, second] = cupCatalog();
    if (!first || !second) return null;
    const home = source.euroChampions[first.id];
    const away = source.euroChampions[second.id];
    return home && away && home !== away ? [home, away] : null;
  }

  const country = cup.country;
  if (country === undefined) return null;
  const leagueId = topLeagueOfCountry(country);
  const majorCup = domesticCupsOfCountry(country)[0];
  if (!leagueId || !majorCup) return null;
  const ranked = source.leagueTables[leagueId] ?? [];
  const champion = ranked[0];
  const cupWinner = source.domesticChampions[majorCup.id];
  if (!champion || !cupWinner) return null;
  // 더블을 한 시즌엔 리그 준우승팀이 상대다 (실제 규정)
  const challenger = cupWinner === champion ? ranked[1] : cupWinner;
  return challenger ? [champion, challenger] : null;
}

/**
 * 이번 시즌 슈퍼컵 경기 — 지난 시즌 우승자가 있는 대회만.
 *
 * 첫 시즌은 지난 시즌이 없으므로 `source`가 널이고 한 경기도 서지 않는다.
 * 명목상 홈은 리그 우승팀(유럽은 UCL 우승팀)이지만 **전 경기 중립**이라 홈 이점은
 * 없다 — 홈/원정은 장부의 자리일 뿐이다.
 */
export function buildSuperCupMatches(season: number, source: SuperCupSource | null): MatchRecord[] {
  if (!source) return [];
  const matches: MatchRecord[] = [];
  for (const cup of SUPER_CUP_CATALOG) {
    const pairing = pairingOf(cup, source);
    if (!pairing) continue;
    const [homeTeamId, awayTeamId] = pairing;
    matches.push({
      id: cupLegMatchId({
        cupId: cup.id,
        season,
        stage: "final",
        pair: SUPER_CUP_PAIR,
        leg: 1,
      }),
      season,
      competitionId: cup.id,
      stage: "final",
      round: 1,
      date: superCupDate(season, cup.kind),
      time: SUPER_CUP_KICKOFF,
      neutral: true,
      homeTeamId,
      awayTeamId,
      result: null,
    });
  }
  return matches;
}

/** 이번 시즌 이 슈퍼컵의 경기 — 안 열린 대회면 널 */
export function superCupMatch(state: GameState, cupId: string): MatchRecord | null {
  return state.matches.find((m) => m.season === state.season && m.competitionId === cupId) ?? null;
}

/** 이 슈퍼컵의 우승 팀 — 승부가 갈렸을 때만 (읽기만 한다) */
export function superCupChampion(state: GameState, cupId: string): string | null {
  const match = superCupMatch(state, cupId);
  return match ? settledTieWinner([match]) : null;
}

/**
 * 슈퍼컵 정산 — 매일 tick에서, 국내 컵·대항전과 같은 자리에서 불린다.
 *
 * 무승부면 연장 30분 → 승부차기다 (모든 결승과 같은 문). 트로피·상금·보고는
 * **상금이 실제로 나간 그 한 번**에만 낸다 — `payPrize`의 멱등 키가 곧 "이 시즌
 * 이 대회를 이미 결산했다"는 사실이라, 매일 부르는 이 함수가 같은 우승을 되풀이해
 * 보고하지 않는다.
 */
export function advanceSuperCups(state: GameState, digest: string[]): void {
  for (const cup of SUPER_CUP_CATALOG) {
    const match = superCupMatch(state, cup.id);
    if (!match?.result) continue;
    // 이미 갈린 경기는 다시 굴리지 않는다 — 이 함수는 남은 시즌 내내 매일 불린다
    if (settledTieWinner([match]) === null) {
      resolveExtraTime(state, match, `${cup.id}:${state.season}`);
      if (needsShootout(state, match)) resolveShootout(state, match);
    }
    const champion = settledTieWinner([match]);
    if (champion === null) continue;
    const runnerUp = match.homeTeamId === champion ? match.awayTeamId : match.homeTeamId;

    const settled = payPrize(
      state,
      { cup, teamId: champion, kind: "winner", what: "우승", amount: cup.prize.winner },
      digest,
    );
    payPrize(
      state,
      { cup, teamId: runnerUp, kind: "runner-up", what: "준우승", amount: cup.prize.runnerUp },
      digest,
    );
    if (!settled) continue;

    if (champion === state.userTeamId) {
      state.trophies.push({ season: state.season, competitionId: cup.id, teamId: champion });
      digest.push(`🏆 ${cup.name} 우승 — ${teamNameIn(state, runnerUp)}을 꺾었다`);
      pushNarrative(state, `${cup.name} 우승`, 4);
    } else if (runnerUp === state.userTeamId) {
      digest.push(`${cup.short} 준우승 — ${teamNameIn(state, champion)}에 졌다`);
      pushNarrative(state, `${cup.short} 준우승`, 3);
    } else {
      digest.push(`${cup.short} 우승: ${teamNameIn(state, champion)}`);
    }
  }
}
