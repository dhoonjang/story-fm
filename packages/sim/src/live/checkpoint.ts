import type { LiveMatchState } from "@story-fm/domain";
import type { MatchLedgerState } from "../match-ledger";
import { hashChannel } from "../rng";

/**
 * 체크포인트 digest — 클라이언트가 굴린 결과와 서버의 재실행이 같은가 (live-match.md §8.1).
 *
 * 말의 위치·속도·행동·부하·체력, 공, 시계, 장부의 사건 수·스코어·명단을 결정적 순서로
 * 직렬화해 해시한다. 부동소수점을 그대로 문자열로 넣으므로 마지막 비트까지 같아야 통과한다 —
 * 그것이 이 검증의 뜻이다.
 */
export function liveDigest(state: LiveMatchState, ledger: MatchLedgerState): string {
  const parts: string[] = [
    String(state.tick),
    String(state.seconds),
    state.phase,
    state.possession,
    String(state.possessionSince),
    String(state.half.stoppages),
    String(state.half.added),
    `${state.ball.x}|${state.ball.y}|${state.ball.z}|${state.ball.owner ?? ""}|${
      state.ball.flight
        ? `${state.ball.flight.kind}:${state.ball.flight.from}:${state.ball.flight.travelled}`
        : ""
    }`,
    state.restart ? `${state.restart.kind}:${state.restart.side}:${state.restart.untilTick}` : "",
    String(state.interval),
  ];
  const players = [...state.players].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const p of players) {
    parts.push(
      `${p.id}|${p.side}|${p.x}|${p.y}|${p.vx}|${p.vy}|${p.action}|${p.decideAt}|${p.readyAt}|${p.condition}|${p.fuel}|${p.load.distance}|${p.load.highSpeed}|${p.load.sprint}|${p.load.sprints}`,
    );
  }
  parts.push(
    `${ledger.score.home}:${ledger.score.away}|${ledger.events.length}|${ledger.minute}|${ledger.phase}|${ledger.home.onPitch.join(",")}|${ledger.away.onPitch.join(",")}|${ledger.sentOff.join(",")}`,
  );
  // 문자열이 길어 32비트 해시 하나로는 충돌 여지가 있다 — 두 조각으로 나눠 해시해 붙인다
  const text = parts.join("\n");
  const half = Math.floor(text.length / 2);
  return `${hashChannel(text).toString(16)}-${hashChannel(text.slice(half) + text.slice(0, half)).toString(16)}-${hashChannel(text.length + text).toString(16)}`;
}
