import { z } from "zod";
import type { MatchEvent, ShootoutKick, ShootoutOutcome, ShotOrigin } from "@story-fm/domain";
import { ATTRIBUTE_AXES, packetTagText, subCauseText } from "@story-fm/domain";
import {
  ATTR_STEP_MAX,
  ATTR_STEP_MIN,
  MATCH_ATTR_CAP,
  MATCH_FAMILIARITY_MAX,
  MATCH_FAMILIARITY_MIN,
  MOOD_BATCH,
  MOOD_NOTE_MAX,
  RATING_BAND,
  RATING_MAX,
  RATING_MIN,
  applyMoodNotes,
  settleMatchRating,
  type GameState,
  type MatchRatingBrief,
} from "@story-fm/engine";
import type { GameToolSpec } from "@story-fm/llm";
import { agingDeclineLine } from "./aging-line";
import { inputError, toToolSchema } from "./tool-schema";

/**
 * 매치 캐스터 — 경기 장면의 GM. 사건은 코어가 xg로 이미 확정하고
 * 캐스터는 그것을 중계·연출·대화로 옮긴다 — **결과를 바꿀 도구가 없다** (match.md).
 * 감독의 말은 앞 호출(지시 해석)이 이미 옮겼고 구간도 코어가 굴려 두었으므로,
 * 이 호출이 받는 것은 확정된 사건과 **그 턴에 갱신된 패킷**이다 (agents.md §3).
 * 경기가 끝난 턴에는 결산 도구 하나(`settle_match`)가 더 실린다 — 중계를 쓴 머리가
 * 그 경기의 평점을 매긴다 (agents.md §3 「종료 턴」).
 * 프롬프트는 코드처럼 버전 관리한다 (AGENTS.md 6-5).
 */
export const MATCH_CASTER_SYSTEM = `당신은 스토리 기반 풋볼 매니저의 경기 중계자다. 코어가 굴린 경기를 중계하고 벤치의 대화를 연출한다. 경기의 결과를 바꿀 도구는 없다.

# 입력
매 턴 이런 블록이 이 순서로 온다.
- <club name> — 구단. <manager name tag> — 감독의 이름·화자 태그·배경. <characters> — 벤치에 앉은 수석코치의 카드. <pre_match> — 경기 전 감독이 한 말.
- 이력 — 이 경기의 지난 중계 턴들.
- @감독이름: — 이번 턴 감독의 말.
- <segment> — 코어가 확정한 사건 목록. <stop> — 구간이 멈춘 이유. <segment>가 오지 않은 턴이 킥오프 턴이다.
- <core_replies> — 이번 턴의 지시가 판에 걸렸는지.
- <ledger> — 구간이 굴러간 뒤의 스코어·시각·국면·온필드와 벤치·교체 횟수. <standing> — 우리 전술과 개인 지시. <packet> — 기대 득점과 상성의 근거. <targets> — 노릴 수 있는 곳. 장부가 유일한 진실이다 — 스코어는 계산하지 않고 읽는다.
- <settlement> — 경기가 끝난 턴에만 온다. 출전 선수의 기준 평점 표 — 결산 도구의 입력이다.

# 사건
일어난 일은 이미 정해져 있다. 사건 목록을 빠뜨리지 않고, 더하지 않고 생생한 중계로 옮긴다. 사건 사이의 흐름·분위기·관중·벤치의 반응은 당신의 재량이고, 그 여백이 이야기다.
- 사건에 붙은 근거(전력 분석 인용)는 중계의 근거로 살린다. 전력 우위는 경향이지 결과가 아니다 — 약팀이 앞서고 있으면 그대로 중계한다.
- 감독이 방금 내린 지시는 이미 판에 올라 있다 — 걸린 지시도 걸리지 않은 지시도 그대로 중계의 근거다. 이번 구간의 결과는 지시로 바뀌지 않는다. "지시대로 곧바로 골이 터졌다"는 없다.
- (사건 없음)이면 짧게 흐름만 전한다. (진행 없음)이면 공이 멈춘 그 자리의 대화와 분위기만 쓴다 — 시간은 한 순간도 흐르지 않았고 슛도 찬스도 없다.
- 킥오프 턴은 경기장·대진·선발을 훑고 첫 휘슬까지만 쓴다. 이력에 경기 전 대화가 있으면 그 목소리에서 이어 연다.

# 한 턴
- 한 턴은 구간 하나, 한 호흡이다. 구간이 골·퇴장·부상으로 끝났으면 그 장면이 정점이고 거기서 끝낸다. 하프타임은 라커룸 장면 하나, 경기 종료는 결산 도구를 부른 뒤 쓰는 마무리 중계다.
- 정지점은 감독의 차례다. 감독의 대사·판단·지시는 유저가 쓴다. 수석코치의 짧은 관찰이나 벤치의 반응으로 장면을 닫고 감독에게 넘긴다.
- 감독이 선수를 부르기만 했으면 그 선수를 데려오는 데까지가 당신 몫이고, 선수의 대답까지만 쓴다. 팀 토크와 면담의 말과 강도는 감독이 고른다.
- 감독은 수석코치·벤치 선수와 대화한다. 그라운드 위 선수에게 한 말은 연출로만 닿는다.
- 수석코치의 조언은 판세와 장부를 근거로 하고, 전술 지시의 대가를 필요하면 짚는다. 카드가 있는 화자는 그 카드의 성격·말투로 말한다.
- 실제 축구의 리듬이다 — 사건 하나를 몇 줄로 늘리지 않는다. 분량은 4~10줄.

# 출력 문법
장면은 @로 연다 — 꺾쇠로 온 것은 읽는 것이고, 시각 줄은 코어가 붙인다.
- @중계: 중계. 역할 태그는 중계뿐이다.
- @이름: 사람의 말 — 수석코치도 카드의 이름으로, 선수는 한글 이름으로 부른다. 장부의 id는 이름 옆의 것을 쓴다.
- @: 화자 없는 내레이션. *별표 하나*로 감싼 것이 행동·연출이다.
- 같은 화자가 이어 말하면 태그를 다시 적지 않는다.

# 말
한국어. 국내 축구 중계의 관용 표현을, 하이라이트 위주로 리듬감 있게.
화자는 게임 내부의 수치를 입에 담지 않는다 — 능력치·전력 점수·소화율·확률. "pace 88" 대신 "리그 최고 수준의 스피드", "소화율 68%" 대신 "지시가 아직 덜 붙었습니다".

<example>
@중계: 왼쪽에서 올라온 크로스, 골키퍼가 주먹으로 걷어냅니다.
세컨드볼은 중원으로. 다시 우리 쪽 빌드업입니다.
@: *벤치의 코치가 터치라인 쪽으로 한 걸음 나온다.*
@레오 카스텔라노: 감독님, 오른쪽 풀백 다리가 무겁습니다. 한 번 더 뚫리면 위험합니다.
</example>`;

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

/**
 * 진행이 없는 턴의 대본 — **대화 턴과 킥오프 턴을 입력에서 가른다.**
 *
 * 대화만 건 턴은 구간을 굴리지 않아 사건 목록도 패킷도 없었고, 그래서 킥오프 턴과
 * 겉모습이 같았다. 프롬프트의 "첫 턴"과 "시간이 흐르지 않은 턴"이 같은 입력을 두고
 * 갈리면서 캐스터는 지나가지도 않은 12분과 있지도 않은 슛을 중계했다. 이 블록이
 * 오면 대화 턴이고, 아예 오지 않으면 첫 턴이다.
 */
export function buildNoSegmentMessage(minute: number): string {
  return [
    "<segment>",
    `- (진행 없음 — 감독이 말만 건 턴이다. 공은 ${minute}′에 멈춰 있다)`,
    "</segment>",
    "<stop>시간이 흐르지 않았다</stop>",
  ].join("\n");
}

/**
 * 경기 결산 — **종료 턴의 캐스터가 첫 왕복에 부르는 도구** (agents.md §3 「종료 턴」).
 *
 * 코어가 `finalizeMatch`로 앵커를 박아 둔 뒤이고, 캐스터는 중계 본문·하프타임
 * 팀토크·외침을 이미 컨텍스트에 쥔 채 앵커 ±RATING_BAND 안에서 다시 매긴다. 실패하면
 * 앵커가 그대로 남으므로 경기는 언제나 완결된다. 무엇을 매기고 어디까지 벗어날 수
 * 있는지는 도구 설명이 갖는다 — 폭·인원·노화 문장은 전부 코어 상수에서 읽는다
 * (prompts.md §5-2).
 */
export const SETTLE_MATCH_TOOL = "settle_match";

export const SETTLE_MATCH_DESCRIPTION = `출전한 선수 전원의 경기 결산을 한 번에 제출한다 — 평점과 한 줄 근거, 전술 적응도, 능력치, 심경.
- 기록(골·도움·슛·선방·카드)은 이미 기준 평점에 반영돼 있다. 더할 것은 기록에 안 남는 것이다 — 지배력, 위기 관리, 실점 장면에서의 책임, 교체 투입 후의 영향, 짧게 뛰고도 흐름을 바꾼 순간.
- 출전 시간을 감안한다. 15분 뛴 교체 선수를 90분 뛴 선수와 같은 잣대로 재지 않는다. 자리를 감안한다. 수비수의 무실점과 공격수의 무득점은 같은 무게가 아니다. 팀 결과에 휩쓸리지 않는다.
- rating — ${RATING_MIN}~${RATING_MAX}, 기준 평점에서 ±${RATING_BAND}를 넘지 않는다. note는 한 문장 40자 안팎 — "무난했다" 같은 빈 말 대신 그 경기의 사실을 적는다.
- drill — 이 경기로 전술 적응도가 얼마나 올랐는가, ${MATCH_FAMILIARITY_MIN}~${MATCH_FAMILIARITY_MAX}. 빠뜨린 선수는 변화가 없는 것으로 본다.
- attribute · attributeStep — 이 경기로 한 축이 움직인 선수만, 0~${MATCH_ATTR_CAP}명, 각 한 축 +${ATTR_STEP_MAX} 또는 −${-ATTR_STEP_MIN}. ${agingDeclineLine()}
- moods — 그 경기가 남긴 심경 한 문장(60자 안팎), ${MOOD_BATCH}명까지. 불만이 걸린 선수는 그 사실을 문장에 담고 acknowledgesIssue를 true로 적는다. 수치(평점·체력·퍼센트)는 문장에 적지 않는다.
- 선수 id는 표의 것을 그대로 돌려준다. 두 번째 제출은 반영되지 않는다.`;

/**
 * 스키마가 받아들이는 폭 — 코어 밴드(`RATING_MIN`~`RATING_MAX`,
 * `MATCH_FAMILIARITY_MIN`~`MATCH_FAMILIARITY_MAX`)보다 넓게 열어 둔다.
 * 벗어난 값은 파싱을 깨뜨리는 대신 코어가 자르므로(`settleMatchRating`),
 * 한 선수의 과한 숫자 하나로 경기 결산 전체가 버려지지 않는다.
 */
const ACCEPTED_RATING_MAX = 20;
const ACCEPTED_DRILL_BOUND = 20;

/** 한 번에 매기는 인원 상한 — 한 경기 명단(선발 + 벤치)보다 넉넉하다 */
const MAX_RATED_PLAYERS = 30;

/** 근거 한 줄의 길이 상한 — 설명은 40자 안팎을 요구하고, 여기는 그 여유다 */
const NOTE_MAX = 200;

const RatingEntrySchema = z.object({
  playerId: z.string().min(1).describe("<settlement> 표의 id 그대로"),
  rating: z
    .number()
    .min(0)
    .max(ACCEPTED_RATING_MAX)
    .describe(`${RATING_MIN}~${RATING_MAX}, 소수 첫째 자리. 기준 평점 ±${RATING_BAND} 안`),
  drill: z
    .number()
    .min(-ACCEPTED_DRILL_BOUND)
    .max(ACCEPTED_DRILL_BOUND)
    .optional()
    .describe(`전술 적응도 변화 — ${MATCH_FAMILIARITY_MIN}~${MATCH_FAMILIARITY_MAX}`),
  attribute: z
    .enum(ATTRIBUTE_AXES)
    .nullish()
    .describe(`움직일 능력치 축 (${MATCH_ATTR_CAP}명까지)`),
  attributeStep: z
    .number()
    .min(ATTR_STEP_MIN)
    .max(ATTR_STEP_MAX)
    .nullish()
    .describe(`그 축의 방향 — ${ATTR_STEP_MAX} 또는 ${ATTR_STEP_MIN}`),
  note: z.string().max(NOTE_MAX).optional().describe("한 문장 근거 (40자 안팎)"),
});
const MoodEntrySchema = z.object({
  playerId: z.string().min(1).describe("<settlement> 표의 id 그대로"),
  text: z.string().min(1).max(MOOD_NOTE_MAX).describe("그 선수의 심경 한 문장 (60자 안팎)"),
  /** 그 문장이 불만을 담았는가 — 코어는 낱말을 세지 않는다 (people.md §5) */
  acknowledgesIssue: z.boolean().optional().describe("그 문장이 이 선수의 불만을 담았는가"),
});
const SettleInputSchema = z.object({
  ratings: z.array(RatingEntrySchema).min(1).max(MAX_RATED_PLAYERS),
  moods: z.array(MoodEntrySchema).max(MOOD_BATCH).optional(),
});

/** 모델이 보는 입력 — 위 Zod 한 벌에서 파생한다 (prompts.md §2) */
export const SETTLE_MATCH_INPUT = toToolSchema(SettleInputSchema);

/**
 * 결산 표 — 종료 턴의 이번 턴 층에 선다. 사건 목록은 싣지 않는다: 캐스터가 이미
 * 그 사건들을 중계했고, 그 중계가 이력에 있다.
 */
export function buildSettlementMessage(brief: MatchRatingBrief): string {
  const outcome = { win: "승", draw: "무", loss: "패" }[brief.outcome];
  const rows = brief.players.map((p) => {
    const line = [
      `${p.playerId} | ${p.name} | ${p.position}`,
      p.started ? "선발" : "교체",
      `${p.minutes}분`,
      `기준 평점 ${p.anchor.toFixed(1)}`,
      `${p.age ?? "?"}세 · 성장 여지 ${p.room ?? 0} · 전술적응 ${p.familiarity ?? 0}`,
    ];
    const did: string[] = [];
    if (p.goals > 0) did.push(`${p.goals}골`);
    if (p.assists > 0) did.push(`${p.assists}도움`);
    if (p.shots > 0) did.push(`슛${p.shots}`);
    if (p.saves > 0) did.push(`선방${p.saves}`);
    if (p.yellows > 0) did.push(`경고${p.yellows}`);
    if (p.reds > 0) did.push("퇴장");
    line.push(did.length > 0 ? did.join(" ") : "기록 없음");
    return `- ${line.join(" | ")}`;
  });
  return [
    "<settlement>",
    `최종 스코어: ${brief.scoreline} (우리 팀 ${outcome})`,
    "채점 대상 (id | 이름 | 자리 | 선발/교체 | 출전시간 | 기준 평점 | 나이·성장 여지·전술적응 | 기록)",
    ...rows,
    "</settlement>",
  ].join("\n");
}

/**
 * 결산 도구 — 평점·적응도·능력치는 `settleMatchRating`이 한 표식 아래 한 번만 받고,
 * 심경은 출전 선수로 좁혀 `applyMoodNotes`가 검사한다 (agents.md §4-3).
 */
export function makeSettleTool(
  state: GameState,
  brief: MatchRatingBrief,
  onApplied: (applied: number) => void,
): GameToolSpec {
  const allowed = new Set(brief.players.map((p) => p.playerId));
  return {
    name: SETTLE_MATCH_TOOL,
    description: SETTLE_MATCH_DESCRIPTION,
    inputSchema: SETTLE_MATCH_INPUT,
    handle(input: unknown) {
      const parsed = SettleInputSchema.safeParse(input);
      if (!parsed.success) return inputError(parsed.error);
      const { applied, skipped, already } = settleMatchRating(
        state,
        brief.matchId,
        parsed.data.ratings,
      );
      if (already) {
        // ok: false로 답하면 모델이 도구 루프를 한 바퀴 더 돈다
        return { ok: true, message: "이 경기의 결산은 이미 반영됐습니다 — 다시 제출하지 마세요" };
      }
      if (applied === 0) {
        return {
          ok: false,
          message: "반영된 평점이 없습니다 — <settlement> 표의 id를 그대로 쓰세요",
        };
      }
      const moods = applyMoodNotes(state, parsed.data.moods ?? [], allowed);
      onApplied(applied);
      return {
        ok: true,
        message: [
          `평점 ${applied}명 반영${skipped > 0 ? ` (${skipped}명은 대상이 아니라 무시)` : ""}`,
          ...(moods > 0 ? [`심경 ${moods}명`] : []),
        ].join(" · "),
      };
    },
  };
}
