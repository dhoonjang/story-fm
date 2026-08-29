import type { MatchEvent, ShootoutKick, ShootoutOutcome, ShotOrigin } from "@story-fm/domain";
import { packetTagText, subCauseText } from "@story-fm/domain";

/**
 * 구간 대본 — 코어가 확정한 사건을 매치 GM이 읽는 문장으로 옮긴다 (agents.md §3).
 * 매치 GM의 도구 결과와 손잡이 턴의 이번 턴 층이 같은 대본을 싣는다.
 */
const EVENT_KO: Record<MatchEvent["type"], string> = {
  kickoff: "킥오프",
  goal: "골",
  shot: "슛(무득점)",
  save: "선방",
  chance: "찬스 무산",
  foul: "파울",
  yellow_card: "경고",
  red_card: "퇴장",
  substitution: "교체",
  injury: "부상",
  /** 벤치가 판을 옮겼다 — 팀 이름은 줄 머리가 이미 붙인다 (match.md §2) */
  tactical_shift: "전술 전환",
  half_time: "하프타임",
  extra_time_start: "연장 돌입",
  extra_half_time: "연장 하프타임",
  full_time: "경기 종료",
};

/**
 * 슛이 **어디서 나왔나** — 죽은 공은 사건 타입이 아니라 슛의 성질이다
 * (match.md §1.4). 이 한 마디가 없으면 캐스터는 90분 내내 죽은 공을 볼 수 없다.
 */
const SHOT_ORIGIN_KO: Record<ShotOrigin, string> = {
  open: "",
  corner: "코너에서",
  free_kick: "프리킥에서",
  penalty: "페널티킥",
};

const STOP_KO: Record<string, string> = {
  goal: "골이 터져 흐름이 끊겼다",
  red_card: "퇴장으로 경기가 멈췄다",
  injury: "부상으로 경기가 멈췄다",
  half_time: "전반이 끝났다 — 라커룸 장면",
  extra_time_start: "90분이 승부를 못 가렸다 — 연장으로 간다",
  extra_half_time: "연장 전반이 끝났다",
  full_time: "경기가 끝났다 — 마무리 중계",
  flow: "특별한 사건 없이 시간이 흘렀다",
  shootout_start: "120분이 승부를 못 가렸다 — 승부차기로 간다",
  shootout_kick: "승부차기 한 발이 끝났다 — 다음 키커가 준비한다",
  /** 진행 정지점이 아니라 승부차기의 끝 — 승부가 갈린 자리다 (`shootoutSettled`) */
  shootout_done: "승부차기가 끝났다 — 승부가 갈렸다",
};

const SHOOTOUT_OUTCOME_KO: Record<ShootoutOutcome, string> = {
  scored: "성공",
  saved: "골키퍼 선방",
  missed: "골문을 벗어났다",
};

/**
 * 사건의 배우 표기. `actors` 순서는 사건 종류마다 다른 방향을 뜻하므로(골은
 * [득점자, 도움], 교체는 [아웃, 인] — match.md §4) 순서에 뜻을 맡기지 않고
 * 역할을 이름 옆에 적는다.
 */
function actorsNote(ev: MatchEvent, nameOf: (id: string) => string): string {
  const [first, second] = ev.actors.map(nameOf);
  if (!first) return "";
  // 죽은 공 골의 도움은 그 공을 올린 키커다 — 추첨이 아니라 사실이다 (match.md §1.4)
  if (ev.type === "goal") return second ? `득점 ${first} · 도움 ${second}` : `득점 ${first}`;
  if (ev.type === "substitution") return second ? `OUT ${first} · IN ${second}` : `OUT ${first}`;
  return ev.actors.map(nameOf).join(" → ");
}

/** 구간 대본 → 캐스터 입력. 선수는 이름으로 준다 — id를 주면 중계에 id가 흘러나온다. */
export function buildSegmentMessage(
  events: MatchEvent[],
  stop: string,
  nameOf: (id: string) => string,
  sideName: (side: "home" | "away") => string,
): string {
  const lines = events.map((ev) => {
    const who = actorsNote(ev, nameOf);
    const team = ev.team ? `${sideName(ev.team)} ` : "";
    /** 교체의 갈래는 `subCause`가, 골의 근거는 패킷 태그가 갖는다 (match.md §4) */
    const reasons = [
      ...(ev.subCause ? [subCauseText(ev.subCause)] : []),
      ...ev.causes.map((tag) => packetTagText(tag)),
    ];
    const cause = reasons.length > 0 ? ` · 근거: ${reasons.join(" / ")}` : "";
    const detail = ev.detail ? ` · ${ev.detail}` : "";
    const origin = ev.shotOrigin ? SHOT_ORIGIN_KO[ev.shotOrigin] : "";
    const from = origin ? `${origin} ` : "";
    return `- ${ev.minute}′ ${team}${from}${EVENT_KO[ev.type]}${who ? `: ${who}` : ""}${cause}${detail}`;
  });
  return [
    "<segment>",
    lines.length > 0 ? lines.join("\n") : "- (사건 없음)",
    "</segment>",
    `<stop>${STOP_KO[stop] ?? stop}</stop>`,
  ].join("\n");
}

/**
 * 승부차기 한 발의 대본 — 선수는 이름으로 준다(id를 주면 중계에 id가 샌다).
 *
 * 킥을 굴리는 것은 코어이고 이 함수가 하는 일은 **확정된 한 발을 문장으로 옮기는
 * 것**뿐이다 — 다른 정지점과 같은 분업이다 (match.md §2). 킥의 성공 확률은 싣지
 * 않는다: 화자가 입에 담지 않는 게임 내부 수치다.
 *
 * 아직 한 발도 굴리지 않은 턴(`kick`이 `null`)은 감독이 **키커 순서를 정할
 * 자리**이므로 대본이 그 사실을 밝힌다.
 */
export function buildShootoutMessage(
  kick: ShootoutKick | null,
  tally: { home: number; away: number },
  done: boolean,
  nameOf: (id: string) => string,
  sideName: (side: "home" | "away") => string,
): string {
  const tallyLine = `합계 ${sideName("home")} ${tally.home} : ${tally.away} ${sideName("away")}`;
  const lines = kick
    ? [
        `- ${kick.round}번째 키커 · ${sideName(kick.team)} ${nameOf(kick.taker)}` +
          (kick.keeper ? ` ↔ 골키퍼 ${nameOf(kick.keeper)}` : "") +
          ` · ${SHOOTOUT_OUTCOME_KO[kick.outcome]} · ${tallyLine}`,
      ]
    : ["- (이번 턴에 찬 발은 없다 — 감독이 키커 순서를 정할 자리다)", `- ${tallyLine}`];
  const stop = done ? "shootout_done" : kick ? "shootout_kick" : "shootout_start";
  return [
    "<segment>",
    lines.join("\n"),
    "</segment>",
    `<stop>${STOP_KO[stop] ?? stop}</stop>`,
  ].join("\n");
}
