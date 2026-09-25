import type { MatchEvent, ShootoutKick, ShootoutOutcome, ShotOrigin } from "@story-fm/domain";
import { eventCauseText, formatScore, subCauseText } from "@story-fm/domain";
import { BIG_CHANCE_XG } from "@story-fm/engine";

/**
 * 사건 대본 — 장부에 앉은 사건을 매치 GM이 읽는 문장으로 옮긴다 (agents.md §3).
 * 매치 GM의 이번 턴 층(`<events>`)과 판독기의 정지점 입력이 같은 대본을 싣는다.
 */
const EVENT_KO: Record<MatchEvent["type"], string> = {
  kickoff: "킥오프",
  goal: "골",
  /** 무득점의 갈래는 결과가 적는다 (`SHOT_OUTCOME_KO`) — 여기서 또 적으면 문장이 하나가 된다 */
  shot: "슛",
  save: "선방",
  chance: "찬스 무산",
  foul: "파울",
  yellow_card: "경고",
  red_card: "퇴장",
  substitution: "교체",
  injury: "부상",
  /** 벤치가 판을 옮겼다 — 팀 이름은 줄 머리가 이미 붙인다 (match.md §3.3) */
  tactical_shift: "전술 전환",
  half_time: "하프타임",
  extra_time_start: "연장 돌입",
  extra_half_time: "연장 하프타임",
  full_time: "경기 종료",
};

/** 슛이 **어디서 나왔나** — 죽은 공은 사건 타입이 아니라 슛의 성질이다 (match.md §4) */
const SHOT_ORIGIN_KO: Record<ShotOrigin, string> = {
  open: "",
  corner: "코너에서",
  free_kick: "프리킥에서",
  penalty: "페널티킥",
};

/** **슛이 어떻게 끝났나** — 장부가 슛마다 들고 있는 사실이다(`shotOutcome`) */
const SHOT_OUTCOME_KO: Record<NonNullable<MatchEvent["shotOutcome"]>, string> = {
  goal: "",
  saved: "골키퍼가 막았다",
  blocked: "수비 몸에 맞았다",
  off_target: "골문을 벗어났다",
};

const SHOOTOUT_OUTCOME_KO: Record<ShootoutOutcome, string> = {
  scored: "성공",
  saved: "골키퍼 선방",
  missed: "골문을 벗어났다",
};

/** 사건의 시각 — 추가시간은 `45+2′`로 (match.md §5) */
export function eventMinuteText(ev: Pick<MatchEvent, "minute" | "added">): string {
  return ev.added ? `${ev.minute}+${ev.added}′` : `${ev.minute}′`;
}

/**
 * 사건의 배우 표기. `actors` 순서는 사건 종류마다 다른 방향을 뜻하므로(골은
 * [득점자, 도움], 교체는 [아웃, 인] — match.md §4) 역할을 이름 옆에 적는다.
 */
function actorsNote(ev: MatchEvent, nameOf: (id: string) => string): string {
  const [first, second] = ev.actors.map(nameOf);
  if (!first) return "";
  if (ev.type === "goal") return second ? `득점 ${first} · 도움 ${second}` : `득점 ${first}`;
  if (ev.type === "substitution") return second ? `OUT ${first} · IN ${second}` : `OUT ${first}`;
  return ev.actors.map(nameOf).join(" → ");
}

/**
 * **슛의 성질** — 큰 기회였나, 그리고 어떻게 끝났나. 문턱은 경기 리포트가 타임라인에
 * 세우는 것과 **같은 상수**다(`BIG_CHANCE_XG`). xG 자체는 싣지 않는다.
 */
function shotNote(ev: MatchEvent): string {
  const marks = [
    ...((ev.xg ?? 0) >= BIG_CHANCE_XG ? ["큰 기회"] : []),
    ...(ev.shotOutcome ? [SHOT_OUTCOME_KO[ev.shotOutcome]] : []),
  ].filter((mark) => mark.length > 0);
  return marks.length > 0 ? ` — ${marks.join(", ")}` : "";
}

/** 사건 한 줄 — `<events>`의 한 줄이자 판독기가 읽는 그 줄이다 */
export function eventLine(
  ev: MatchEvent,
  nameOf: (id: string) => string,
  sideName: (side: "home" | "away") => string,
  /** 이 사건 뒤의 스코어 — 골 줄에만 붙는다 */
  score: { home: number; away: number },
): string {
  const who = actorsNote(ev, nameOf);
  const team = ev.team ? `${sideName(ev.team)} ` : "";
  /** 교체의 갈래는 `subCause`가, 사건의 근거는 원인 코드가 갖는다 (match.md §4) */
  const reasons = [
    ...(ev.subCause ? [subCauseText(ev.subCause)] : []),
    ...ev.causes.map((cause) => eventCauseText(cause, nameOf)),
  ];
  const cause = reasons.length > 0 ? ` · 근거: ${reasons.join(" / ")}` : "";
  const detail = ev.detail ? ` · ${ev.detail}` : "";
  const origin = ev.shotOrigin ? SHOT_ORIGIN_KO[ev.shotOrigin] : "";
  const from = origin ? `${origin} ` : "";
  const mark =
    ev.type === "goal"
      ? ` (${sideName("home")} ${formatScore(score.home, score.away)} ${sideName("away")})`
      : shotNote(ev);
  return `- ${eventMinuteText(ev)} ${team}${from}${EVENT_KO[ev.type]}${mark}${who ? `: ${who}` : ""}${cause}${detail}`;
}

/**
 * `<events>` — 지난 턴 뒤 장부에 앉은 사건. 선수는 이름으로 준다 — id를 주면 중계에 id가
 * 흘러나온다. 골 줄은 **그 골이 들어간 뒤의** 스코어를 두 이름과 함께 단다.
 */
export function buildEventsBlock(
  events: readonly MatchEvent[],
  nameOf: (id: string) => string,
  sideName: (side: "home" | "away") => string,
  /** 이 사건들이 시작되기 전의 스코어 */
  scoreBefore: { home: number; away: number },
): string {
  const score = { ...scoreBefore };
  const lines = events
    .filter((ev) => ev.type !== "kickoff")
    .map((ev) => {
      if (ev.type === "goal" && ev.team) score[ev.team] += 1;
      return eventLine(ev, nameOf, sideName, score);
    });
  return ["<events>", lines.length > 0 ? lines.join("\n") : "- (사건 없음)", "</events>"].join(
    "\n",
  );
}

/** 사건 목록이 시작되기 전의 스코어 — 지금 장부에서 그 사건들의 골만큼 되감는다 */
export function scoreBeforeEvents(
  now: { home: number; away: number },
  events: readonly MatchEvent[],
): { home: number; away: number } {
  const score = { ...now };
  for (const ev of events) if (ev.type === "goal" && ev.team) score[ev.team] -= 1;
  return score;
}

/**
 * 승부차기 한 발의 대본 — 킥을 굴리는 것은 코어이고 여기서 하는 일은 **확정된 한 발을
 * 문장으로 옮기는 것**뿐이다. 성공 확률은 싣지 않는다. 아직 한 발도 굴리지 않은
 * 자리(`kick`이 `null`)는 감독이 키커 순서를 정할 자리다.
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
    : ["- (아직 찬 발이 없다 — 감독이 키커 순서를 정할 자리다)", `- ${tallyLine}`];
  const state = done
    ? "승부차기가 끝났다 — 승부가 갈렸다"
    : kick
      ? "다음 키커가 준비한다"
      : "120분이 승부를 못 가렸다 — 승부차기로 간다";
  return ["<shootout>", lines.join("\n"), `- ${state}`, "</shootout>"].join("\n");
}
