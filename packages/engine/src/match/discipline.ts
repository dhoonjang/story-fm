import { YELLOWS_PER_SUSPENSION } from "@story-fm/domain";
import { playerById, seasonYellowsOf, type GameState } from "../core/state";

/** 한 장의 카드가 장부에 남긴 것 — 발부한 정지, 물린 정지, 감독에게 갈 한 줄 */
export type CardRuling = {
  /** 감독에게 알릴 한 줄 — 정지가 걸렸을 때만. `issued`와 짝이다 */
  note: string | null;
  /** 이 카드가 발부한 정지 id */
  issued: string | null;
  /** 이 카드가 물린 정지 id — 두 번째 경고가 앞선 누적 정지를 지울 때 (match.md §5) */
  revoked: string | null;
};

const NOTHING: CardRuling = { note: null, issued: null, revoked: null };

/** 누적 경고 정지는 경기당 한 건 — 두 번째 경고가 이 id로 되찾아 물린다 */
const yellowsSuspensionId = (playerId: string, matchId: string) => `sus-${playerId}-${matchId}`;

const matchYellowsOf = (state: GameState, playerId: string, matchId: string) =>
  state.bookings.filter(
    (b) => b.gamePlayerId === playerId && b.matchId === matchId && b.card === "yellow",
  ).length;

/**
 * 카드 → 장부 — **두 시뮬레이터가 같은 문을 쓴다.**
 *
 * 예전엔 이 로직이 `match-flow.ts` 안에만 있었다. 유저 경기는 경고를 세어 정지를
 * 걸었지만 간이 시뮬(타 팀 경기)은 카드 자체를 만들지 않아서, **누적 경고 정지가
 * 우리 팀에만 걸렸다.** 리그 전체가 같은 규칙 아래 있어야 "다음 경기 경고 조심"이
 * 상대에게도 성립한다.
 *
 * 두 번째 경고는 `yellow_card` 한 줄 + `red_card` 한 줄로 들어온다. **한 사건에
 * 정지는 하나** — 그 경기의 경고 두 장은 누적에서 빠지고(`seasonYellowsOf`), 첫 장이
 * 이미 걸어 둔 누적 정지가 있으면 그것을 물린다 (match.md §5).
 */
export function recordCard(
  state: GameState,
  input: {
    playerId: string;
    matchId: string;
    card: "yellow" | "red";
    minute: number;
  },
): CardRuling {
  const player = playerById(state, input.playerId);
  if (!player) return NOTHING;
  const yellowsBefore = matchYellowsOf(state, input.playerId, input.matchId);
  state.bookings.push({
    gamePlayerId: input.playerId,
    matchId: input.matchId,
    season: state.season,
    card: input.card,
    minute: input.minute,
  });

  if (input.card === "yellow") {
    // 두 번째 경고 — 곧 올 `red_card` 한 건이 이 사건의 정지다. 누적은 세지 않는다
    if (yellowsBefore > 0) {
      const revoked = yellowsSuspensionId(input.playerId, input.matchId);
      const at = state.suspensions.findIndex((s) => s.id === revoked);
      if (at < 0) return NOTHING;
      state.suspensions.splice(at, 1);
      return { note: null, issued: null, revoked };
    }
    // 방금 넣은 장까지 세고 나서 눈금을 본다 (5·10·15장에서 걸린다)
    const total = seasonYellowsOf(state, input.playerId, state.season);
    if (total === 0 || total % YELLOWS_PER_SUSPENSION !== 0) return NOTHING;
    const issued = yellowsSuspensionId(input.playerId, input.matchId);
    state.suspensions.push({
      id: issued,
      gamePlayerId: input.playerId,
      cause: "yellows",
      issuedOn: state.date,
      lengthMatches: 1,
      served: 0,
      status: "active",
    });
    return {
      note: `${player.name} 경고 누적 ${total}회 — 다음 경기 출장 정지`,
      issued,
      revoked: null,
    };
  }

  const issued = `sus-${input.playerId}-${input.matchId}-red`;
  state.suspensions.push({
    id: issued,
    gamePlayerId: input.playerId,
    cause: "red",
    issuedOn: state.date,
    lengthMatches: 1,
    served: 0,
    status: "active",
  });
  // 경고 두 장을 받고 나가는 퇴장인지 장부가 안다 — 감독은 왜 한 경기인지 읽을 수 있어야 한다
  const how = yellowsBefore >= 2 ? "경고 2회 퇴장" : "퇴장";
  return { note: `${player.name} ${how} — 다음 경기 출장 정지`, issued, revoked: null };
}
