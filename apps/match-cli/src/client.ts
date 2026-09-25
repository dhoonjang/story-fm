/**
 * 화면 없는 **클라이언트** — 브라우저의 실행기(`apps/web/lib/use-live-match.ts`)와 같은 일을
 * 로컬 서버에 대고 한다 (live-match.md §8).
 *
 * 서버의 확정 상태를 받아 같은 함수로 시계를 밀고, 체크포인트 간격마다 제출하고, 서버가 준
 * 상태를 이어받는다. 중계할 사건이 확정되면 거기서 멈추고 종료 코드로 알린다 — 그 자리에서
 * 정지점 턴(`match_stop`)을 여는 것은 부르는 쪽이다 (시뮬레이션 스킬의 `match.sh`).
 *
 *   SIM_HOST=http://localhost:3000 SIM_GAME=<id> tsx src/client.ts [--resume | --shootout]
 *
 * 종료 코드: 0 중계할 정지점 · 10 휴식(하프타임·연장 개시 — `--resume`으로 재개) ·
 * 20 종료 휘슬(마감 턴을 연다 — 승부차기가 남았으면 `--shootout`으로 한 발씩) · 1 오류
 */
import { LIVE_STEP, STOP_EVENT_TYPES, type MatchEvent } from "@story-fm/domain";
import {
  advanceLive,
  checkpointReason,
  liveDigest,
  liveFinished,
  type LiveMatch,
} from "@story-fm/sim";

const host = process.env.SIM_HOST ?? "http://localhost:3000";
const game = process.env.SIM_GAME;
if (!game) {
  console.error("SIM_GAME이 비었다");
  process.exit(1);
}
const resume = process.argv.includes("--resume");
const shootout = process.argv.includes("--shootout");

/** 한 번에 미는 틱 — 경기 시간 1분. 정지점을 그 분 안에서 잡는다 */
const STEP_TICKS = Math.round(60 / LIVE_STEP);

interface Snapshot {
  live: LiveMatch;
  verdict?: { ok: boolean; reason?: string };
  events?: MatchEvent[];
  shootout?: { message: string; done: boolean };
}

async function call(body: unknown | null): Promise<Snapshot> {
  const res = await fetch(`${host}/api/games/${game}/match/live`, {
    method: body ? "POST" : "GET",
    ...(body
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const json = (await res.json()) as Snapshot & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `경기 요청 실패 (${res.status})`);
  return json;
}

const minuteOf = (live: LiveMatch) =>
  `${live.ledger.minute}${live.ledger.added ? `+${live.ledger.added}` : ""}′`;
const scoreOf = (live: LiveMatch) => `${live.ledger.score.home}–${live.ledger.score.away}`;

async function main(): Promise<number> {
  if (shootout) {
    const kicked = await call({ kind: "shootout" });
    console.log(kicked.shootout?.message ?? "승부차기");
    return 20;
  }
  let live = (await call(null)).live;
  if (live.state.interval) {
    if (!resume) {
      console.log(`휴식 — ${minuteOf(live)} ${scoreOf(live)} · 재개하려면 --resume`);
      return 10;
    }
    live = (await call({ kind: "resume" })).live;
  }
  for (let guard = 0; guard < 400; guard++) {
    if (liveFinished(live)) {
      console.log(`종료 휘슬 — ${scoreOf(live)}`);
      return 20;
    }
    const { events } = advanceLive(live, STEP_TICKS);
    if (!checkpointReason(live, events)) continue;
    const snapshot = await call({
      kind: "checkpoint",
      checkpoint: {
        fromTick: live.committedTick,
        toTick: live.state.tick,
        digest: liveDigest(live.state, live.ledger),
      },
    });
    if (snapshot.verdict && !snapshot.verdict.ok)
      console.error(`체크포인트 반려 (${snapshot.verdict.reason}) — 서버 상태를 이어받는다`);
    live = snapshot.live;
    const confirmed = (snapshot.events ?? []).filter((e) => STOP_EVENT_TYPES.has(e.type));
    if (confirmed.length > 0) {
      console.log(
        `정지점 — ${minuteOf(live)} ${scoreOf(live)} · ${confirmed.map((e) => e.type).join(", ")}`,
      );
      return 0;
    }
  }
  throw new Error("경기가 끝나지 않았습니다");
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
