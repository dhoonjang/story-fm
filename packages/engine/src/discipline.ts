import { YELLOWS_PER_SUSPENSION } from "@story-fm/domain";
import { playerById, seasonYellowsOf, type GameState } from "./state";

/**
 * 카드 → 장부 — **두 시뮬레이터가 같은 문을 쓴다.**
 *
 * 예전엔 이 로직이 `match-flow.ts` 안에만 있었다. 유저 경기는 경고를 세어 정지를
 * 걸었지만 간이 시뮬(타 팀 경기)은 카드 자체를 만들지 않아서, **누적 경고 정지가
 * 우리 팀에만 걸렸다.** 리그 전체가 같은 규칙 아래 있어야 "다음 경기 경고 조심"이
 * 상대에게도 성립한다.
 *
 * @returns 감독에게 알릴 한 줄 (정지가 걸렸을 때만) — 아니면 null
 */
export function recordCard(
  state: GameState,
  input: {
    playerId: string;
    matchId: string;
    card: "yellow" | "red";
    minute: number;
  },
): string | null {
  const player = playerById(state, input.playerId);
  if (!player) return null;
  state.bookings.push({
    gamePlayerId: input.playerId,
    matchId: input.matchId,
    season: state.season,
    card: input.card,
    minute: input.minute,
  });

  if (input.card === "yellow") {
    // 방금 넣은 장까지 세고 나서 눈금을 본다 (5·10·15장에서 걸린다)
    const total = seasonYellowsOf(state, input.playerId, state.season);
    if (total === 0 || total % YELLOWS_PER_SUSPENSION !== 0) return null;
    state.suspensions.push({
      id: `sus-${input.playerId}-${input.matchId}`,
      gamePlayerId: input.playerId,
      cause: "yellows",
      issuedOn: state.date,
      lengthMatches: 1,
      served: 0,
      status: "active",
    });
    return `${player.name} 경고 누적 ${total}회 — 다음 경기 출장 정지`;
  }

  state.suspensions.push({
    id: `sus-${input.playerId}-${input.matchId}-red`,
    gamePlayerId: input.playerId,
    cause: "red",
    issuedOn: state.date,
    lengthMatches: 1,
    served: 0,
    status: "active",
  });
  return `${player.name} 퇴장 — 다음 경기 출장 정지`;
}
