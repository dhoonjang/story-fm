import { managedNegotiationOverview } from "../negotiation/overview";
import { addDays } from "@story-fm/engine";
import { offerSeat, offerTerms } from "../story/employment-context";
import { vacancyRows, managerSeatLines } from "./workflows/story/employment-context";
import { playerName } from "@story-fm/engine";
import {
  type GameState,
  type ChatTurn,
  teamName,
  type CoachCue,
  factSpeakerOf,
  managedTeamId,
  nextMatchFor,
  isFriendly,
  subLimitsOf,
  canReachExtraTime,
  buildOpponentReport,
  ABSENT_REASON_KO,
  opponentFactFavours,
  opponentFactText,
  pendingManagerInterviews,
  openManagerOffers,
  dayOfWeek,
  formatClock,
  clockOf,
  describeWindowState,
  careerTotalsOf,
  ourYouthCandidates,
  youthCandidateFog,
  youthIntakeDeadline,
  awardReachesManager,
  awardLine,
  recordBreaksOf,
  recordBreakLine,
  onSummerBreak,
  userPlayers,
  openCallUp,
  internationalBreaksOf,
  callUpsOfBreak,
  squadLevelOf,
  isAvailableFor,
  computeStandings,
  tacticsOf,
  financeOf,
  openInjury,
  activeSuspension,
  suspensionScopeName,
  isInjured,
  injuryHistoryOf,
  coachCues,
  describeNextFixture,
  squadReturnOf,
  squadFamiliarity,
  weeklyWagesOf,
  describeBoardRequests,
  type ScenePoint,
  isPeaceTurn,
  historyStart,
} from "@story-fm/engine";
import { buildGmReference } from "./workflows/common/context";
import {
  type SceneScan,
  keepsSceneLine,
  afterSceneLine,
  scenePointOf,
  parseSceneHeader,
  historyEnd,
  buildOperatorMessage,
} from "../common/context";
import { buildMatchBrief, armbandLine } from "../match/context";
import {
  type MatchRecord,
  type TickEvent,
  slotOfTime,
  tacticsBrief,
  formatMoney,
  josa,
  ageOf,
  naturalPositionOf,
  mediaFactText,
  type CallUpReturnState,
  type GamePlayer,
  capsOf,
  internationalGoalsOf,
  associationName,
  diffDays,
  injuryHistoryText,
  fatigueBand,
  fatigueOf,
  familiarityLabel,
  type LorebookInjection,
  lorebookText,
  interviewFactText,
} from "@story-fm/domain";

/** 경기 다이제스트가 "방금 있었던 일"로 치는 기간 (일) */
const MATCH_DIGEST_DAYS = 3;

/** 계약 만료 임박 경고 창 (일) */
const EXPIRING_ALERT_DAYS = 180;

/**
 * 요약 블록 — **레퍼런스 뒤·이력 앞**의 세 번째 시스템 블록 (agents.md §5·§5-1).
 *
 * 압축된 세이브에만 선다. 레퍼런스에 섞지 않는 이유는 자리에 있다: 여기 따로 세우면
 * 압축이 일어난 턴에만 그 뒤가 무효가 되고, 압축은 드물다.
 */
export function buildGmDigest(state: GameState): string | null {
  const digest = state.historyDigest;
  if (!digest) return null;
  // 무엇의 요약인지는 시스템 프롬프트의 「입력」이 말한다 — 블록은 날짜와 두 칸뿐이다.
  // 열린 일이 없으면 지난 일 한 칸이다
  return [
    `<summary at="${digest.at}">`,
    `지난 일: ${digest.text}`,
    ...(digest.open ? [`열린 일: ${digest.open}`] : []),
    ...(digest.candidates?.length
      ? [
          `<character_candidates>`,
          ...digest.candidates.map(({ name, description }) => `- ${name}: ${description}`),
          `</character_candidates>`,
        ]
      : []),
    `</summary>`,
  ].join("\n");
}

/** 유저의 자연어를 모델이 읽는 감독 화자 형식으로 감싼다. */
export function buildManagerMessage(state: GameState, message: string): string {
  return `@${state.manager.name}: ${message}`;
}

/**
 * 경기 캐시 레퍼런스 — 경기 내내 변하지 않는 것만 담는다. 구단·감독은 평시와 같은
 * 두 블록이다.
 * ⚠️ 스코어·시계처럼 매 턴 바뀌는 것은 여기 두면 캐시 프리픽스가 매 턴 깨진다 —
 * 휘발 채널(`buildLedgerNote`)로 내려간다.
 */
export function buildMatchReference(state: GameState): string {
  return [buildGmReference(state), buildMatchBrief(state)]
    .filter((block): block is string => block !== null && block.length > 0)
    .join("\n\n");
}

const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];

/** 그 경기의 채팅 턴 — 경기 턴의 표식(`matchId`)으로 가른다 */
function turnsOfMatch(state: GameState, match: MatchRecord): ChatTurn[] {
  return state.chat.filter((t) => t.inMatch === true && t.matchId === match.id);
}

/**
 * 그라운드를 떠난 우리 선수 — 퇴장·부상·교체. 장부의 사건 목록(`result.events`)이
 * 원본이고, 사건이 남지 않은 경기(간이 시뮬로 치른 경기)는 그 턴의 카드·부상 기록·교체
 * 명령 입력으로 떨어진다. 없으면 줄을 세우지 않는다.
 */
function departedLine(
  state: GameState,
  match: MatchRecord,
  turns: readonly ChatTurn[],
  ours: "home" | "away",
  nameOf: (id: string) => string,
): string | null {
  const isOurs = (id: string) =>
    state.players.find((p) => p.id === id)?.teamId === state.userTeamId;
  const mark = (label: string, id: string, minute?: number) =>
    `${label} ${nameOf(id)}${minute !== undefined ? `(${minute}′)` : ""}`;
  const parts: string[] = [];
  const events = match.result?.events;
  if (events) {
    for (const e of events) {
      if (e.team !== ours) continue;
      const who = e.actors[0];
      if (!who) continue;
      if (e.type === "red_card") parts.push(mark("퇴장", who, e.minute));
      else if (e.type === "injury") parts.push(mark("부상", who, e.minute));
      else if (e.type === "substitution") parts.push(mark("교체 아웃", who, e.minute));
    }
  } else {
    for (const t of turns) {
      for (const card of t.cards ?? []) {
        if (card.ours && card.kind !== "yellow") parts.push(mark("퇴장", card.player, card.minute));
      }
      for (const call of t.toolCalls) {
        const input = call.input as { out?: unknown } | undefined;
        if (call.name === "substitute" && typeof input?.out === "string") {
          parts.push(mark("교체 아웃", input.out));
        }
      }
    }
    for (const injury of state.injuries) {
      if (
        injury.cause === "match" &&
        injury.occurredOn === match.date &&
        isOurs(injury.gamePlayerId)
      ) {
        parts.push(mark("부상", injury.gamePlayerId));
      }
    }
  }
  return parts.length > 0 ? `- 나간 사람: ${parts.join(" · ")}` : null;
}

/**
 * 경기 → 평시 다리 — 직전 경기의 결과·득점·최고 평점에 라커룸의 결과와 그라운드를
 * 떠난 사람을 코어가 장부에서 뽑는다 (평시 GM은 중계 이력을 보지 않는다 — agents.md §5).
 * 직전 한 경기만 — 그 이상은 get_league의 몫.
 */
function matchDigest(state: GameState): string | null {
  const played = state.matches
    .filter(
      (m) =>
        m.result !== null &&
        (m.homeTeamId === state.userTeamId || m.awayTeamId === state.userTeamId),
    )
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  if (!played?.result) return null;
  if (dayGap(played.date, state.date) > MATCH_DIGEST_DAYS) return null;

  const ours = played.homeTeamId === state.userTeamId;
  const opponent = teamName(ours ? played.awayTeamId : played.homeTeamId);
  const us = ours ? played.result.homeGoals : played.result.awayGoals;
  const them = ours ? played.result.awayGoals : played.result.homeGoals;
  const verdict = us > them ? "승" : us === them ? "무" : "패";
  const nameOf = (pid: string) => state.players.find((p) => p.id === pid)?.name ?? pid;
  const scorers = played.result.scorers
    .map((tag, i) => {
      const minute = played.result?.goalMinutes[i];
      return `${minute !== undefined ? `${minute}′ ` : ""}${nameOf(tag.split(":")[1] ?? tag)}`;
    })
    .join(", ");
  const best = Object.entries(played.result.ratings ?? {})
    .filter(([pid]) => state.players.find((p) => p.id === pid)?.teamId === state.userTeamId)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_RATED_SHOWN)
    .map(([pid, r]) => `${nameOf(pid)} ${r.toFixed(1)}`)
    .join(", ");
  const turns = turnsOfMatch(state, played);
  return [
    `${played.date} ${ours ? "홈" : "원정"} vs ${opponent} ${us}-${them} ${verdict}`,
    scorers ? `- 득점: ${scorers}` : null,
    best ? `- 최고 평점: ${best}` : null,
    departedLine(state, played, turns, ours ? "home" : "away", nameOf),
  ]
    .filter(Boolean)
    .join("\n");
}

/** 두 날짜 사이의 일수 */
function dayGap(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000,
  );
}

/** 이번 턴 직전에 코어가 흘려 보낸 시간 — 손잡이로 넘겼을 때만 실린다 */
export interface TimePassed {
  from: string;
  stopped: string;
  /**
   * 그 사이 벌어진 일 — 코어가 낸 **사건 배열 그대로**다 (overview.md §2).
   *
   * ⚠️ 프롬프트에는 **문장만** 간다. 꼬리표(`kind`)는 화면의 어휘라
   * (`injury`·`board` 같은 영문 enum) 데이터 블록에 새면 모델이 그 낱말로 쓴다.
   */
  events: TickEvent[];
}

/**
 * 상태 스냅샷 — 매 턴 새로 주입되는 휘발성 블록 (role:"system" 오퍼레이터 채널).
 * phase 같은 내부 enum은 넣지 않는다 — 라우팅용 값이지 모델이 읽을 정보가 아니다.
 */
/**
 * 상태 노트가 프롬프트에 싣는 꼬리 길이.
 *
 * 전부 실으면 매 턴 같은 목록이 길게 반복돼 캐시 뒤가 무거워지고, 정작 이번 턴에
 * 달라진 것이 묻힌다 — 모델이 읽을 만큼만 남기고 나머지는 화면이 보여 준다.
 */
const TOP_RATED_SHOWN = 2;

const TRAINING_SHOWN = 3;

/** 훈련 해석기가 읽는 예정 훈련 수 — 주간 일정을 통째로 보고 겹침을 판단한다 */
const TRAINING_SCHEDULE_SHOWN = 20;

/**
 * 예정된 훈련 줄 — 스냅샷의 요약(`TRAINING_SHOWN`)과 훈련 해석기의 `<schedule>`이
 * **같은 함수를 읽는다.** 두 벌이면 화면이 말하는 일정과 해석기가 읽는 일정이 갈린다.
 */
export function upcomingTrainingLines(state: GameState, limit = TRAINING_SHOWN): string[] {
  return state.schedule
    .filter((e) => e.type === "training" && e.status === "scheduled" && e.date >= state.date)
    .slice(0, limit)
    .map((e) => {
      const s = state.trainingSessions.find((x) => x.id === e.refId);
      return `${e.date.slice(5)} ${slotOfTime(e.time) === "am" ? "오전" : "오후"} ${s?.label ?? "훈련"}`;
    });
}

/** 훈련 해석기의 `<schedule>` 본문 — 없으면 빈 문자열 */
export function buildTrainingSchedule(state: GameState): string {
  return upcomingTrainingLines(state, TRAINING_SCHEDULE_SHOWN)
    .map((line) => `- ${line}`)
    .join("\n");
}

const EXPIRING_SHOWN = 3;

const AT_RISK_SHOWN = 3;

/** 과부하로 이름을 적는 인원 — 위험 줄과 같은 폭 */
const OVERLOADED_SHOWN = 3;

/**
 * 스냅샷 안의 한 덩어리 (prompts.md §5-1 · agents.md §6).
 *
 * 한 턴에 열댓 덩어리가 쌓이는 블록이라 레이블 줄로는 경계가 서지 않는다. 규칙은
 * 둘이다 — **내용이 없으면 태그도 서지 않고**, 여는 태그가 이름을 대므로 **같은
 * 말을 하는 레이블 줄을 안에 다시 적지 않는다**.
 */
function block(tag: string, body: string | null, attrs = ""): string | null {
  if (body === null || body.trim().length === 0) return null;
  return `<${tag}${attrs}>\n${body}\n</${tag}>`;
}

/** 여러 줄을 한 덩어리로 — null과 빈 줄은 걷는다 */
/** 열린 감독직 면접 — 조회와 같은 사실 문장으로 (prompts.md §5-1) */
function interviewBlocks(state: GameState): (string | null)[] {
  return pendingManagerInterviews(state).map((interview) =>
    block(
      "interview",
      lines(
        `${interview.date} ${teamName(interview.teamId)} 감독직 면접`,
        ...interview.facts.map((fact) => `- ${interviewFactText(fact)}`),
      ),
      ` id="${interview.id}"`,
    ),
  );
}

function lines(...items: (string | null)[]): string {
  return items.filter((x): x is string => x !== null && x !== "").join("\n");
}

function coachBlocks(state: GameState, cues: readonly CoachCue[]): (string | null)[] {
  const byName = new Map<string, string[]>();
  for (const cue of cues) {
    const name = factSpeakerOf(state, cue.by === "coach" ? "training" : "coach_eye").name;
    byName.set(name, [...(byName.get(name) ?? []), `- ${cue.fact}`]);
  }
  return [...byName].map(([name, facts]) => block("coach", facts.join("\n"), ` name="${name}"`));
}

/**
 * **다음 경기의 교체 한도 한 줄** — 감독이 경기 계획을 세우는 자리다.
 *
 * `<opponent>`가 아니라 `<now>`에 서는 이유가 시간이다: 상대 분석은 전날에야 서는데
 * 감독은 사흘 전에 "후반에 전부 바꾼다"를 말한다. 코어가 이미 아는 숫자를 주지 않으면
 * GM이 불가능한 계획에 동의해 놓고 킥오프에서 번복한다.
 *
 * 숫자의 원본은 장부의 `subLimitsOf` 하나다 — 프롬프트에 5/3을 적어 두면 친선(9인)과
 * 연장(6인/4회)이 갈린 날 여기만 옛 규칙에 남는다 (AGENTS.md §5 · match.md §5).
 *
 * ⚠️ 데이터 블록이라 사실만 싣는다 — 규약도 지시문도 없다 (prompts.md §5-3).
 */
function nextSubLimitLine(state: GameState): string | null {
  const managed = managedTeamId(state);
  if (managed === null) return null;
  const next = nextMatchFor(state.matches, managed, state.date);
  if (!next) return null;
  const friendly = isFriendly(next);
  const regulation = subLimitsOf("first_half", friendly);
  const line = `교체 한도: ${regulation.maxSubs}명 · 기회 ${regulation.maxSubWindows}회`;
  // 연장이 붙을 수 있는 대진에서만 그 한 장을 말한다 — 리그전에 붙이면 없는 카드다
  if (!canReachExtraTime(state, next)) return line;
  const extra = subLimitsOf("extra_first", friendly);
  return `${line} (연장에 들면 ${extra.maxSubs}명 · ${extra.maxSubWindows}회)`;
}

/**
 * 경기 전 상대 분석이 스냅샷에 서는 창 (일) — **전날과 당일뿐이다.**
 *
 * 감독이 라인업과 6축을 정하는 자리라 그날만 값이 있다. 사흘 전부터 매 턴 실으면
 * 캐시 밖 층을 상대 명단이 통째로 먹는다 (→ docs/common/llm/agents.md §6).
 */
const OPPONENT_BRIEF_DAYS = 1;

/**
 * 경기 전날·당일의 상대 분석 — **코어의 리포트를 그대로 옮긴다**
 * (→ docs/match/match.md §1.8). 지점의 수를 여기서 다시 자르지 않는다.
 *
 * ⚠️ 데이터 블록이라 사실만 싣는다 — 지시문도 도구 이름도 없다 (prompts.md §5-3).
 */
function opponentBlock(state: GameState): string | null {
  const report = buildOpponentReport(state, { withinDays: OPPONENT_BRIEF_DAYS });
  if (!report) return null;
  const venue = report.venue === "home" ? "홈" : report.venue === "away" ? "원정" : "중립";
  const guessed = report.expectedXI.filter((p) => !p.carried).length;
  return block(
    "opponent",
    lines(
      `${report.date} ${report.time} ${report.label} · ${venue} vs ${report.opponent.name}` +
        `${report.inDays === 0 ? " (오늘)" : " (내일)"}`,
      `예상 XI: ${report.expectedXI.map((p) => `${p.name}(${p.position})`).join(" · ")}`,
      report.basis === null
        ? "예상의 근거: 상대의 직전 경기가 없다 — 배치에서 세운 추정이다"
        : `예상의 근거: 상대의 직전 경기(${report.basis.date} ${report.basis.label}) 선발` +
            `${guessed > 0 ? ` · ${guessed}명은 추정으로 메웠다` : ""}`,
      report.absent.length === 0
        ? "상대 결장: 없다"
        : `상대 결장: ${report.absent
            .map((a) => `${a.name} ${ABSENT_REASON_KO[a.reason]}(${a.note})`)
            .join(" · ")}`,
      `상대 전술: ${tacticsBrief(report.shape)}`,
      report.facts.length === 0
        ? "대진의 사실: 없다"
        : lines(
            "대진의 사실:",
            ...report.facts.map((fact) => {
              const favours = opponentFactFavours(fact);
              return `- [${favours === null ? "중립" : favours ? "우리" : "상대"}] ${opponentFactText(fact)}`;
            }),
          ),
    ),
  );
}

/** 시간이 흘렀다 — 손잡이로 넘긴 턴에만 붙는 덩어리. 재직·무직 스냅샷이 같이 쓴다 */
function timePassedLine(state: GameState, passed?: TimePassed | null): string | null {
  if (!passed || (passed.events.length === 0 && passed.from === state.date)) return null;
  return lines(
    `${passed.from} → ${state.date} (${passed.stopped}) — 장면은 ${state.date}에서 연다.`,
    passed.events.length > 0
      ? passed.events.map((e) => `- ${e.text}`).join("\n")
      : `그 사이 특별한 일은 없었다.`,
  );
}

function managerContractLine(state: GameState): string | null {
  const contract = state.manager.contract;
  if (!contract) return null;
  return `감독 계약: 연봉 ${formatMoney(contract.salary)} · ${contract.until}까지`;
}

/**
 * **무직의 스냅샷** — 맡은 팀이 없다 (career.md §5.1).
 *
 * 재직 중에 실리는 것(전술·재정·선수단·훈련·협상)은 전부 **옛 구단의 것**이라,
 * 그대로 실으면 모델은 아직 그 구단의 감독인 것처럼 장면을 쓴다. 무직에게 필요한
 * 것은 셋뿐이다 — 왜 무직인가, 무엇이 걸려 있는가, 그 사이 무슨 일이 있었는가.
 */

function buildUnemployedNote(state: GameState, passed?: TimePassed | null): string {
  const card = state.dismissal;
  const offers = openManagerOffers(state);
  const vacancies = state.managerVacancies;
  return [
    `<snapshot>`,
    block(
      "now",
      lines(
        `${state.date} (${DOW_KO[dayOfWeek(state.date)]}) ${formatClock(clockOf(state))} · 시즌 ${state.season} · ${describeWindowState(state)}`,
        // 팀의 도구가 막힌다는 말은 싣지 않는다 — 코어가 부르는 자리에서 막는다 (prompts.md §5-3)
        `감독 ${josa(state.manager.name, "은/는")} 무직이다 — 맡은 팀이 없다.`,
        card
          ? `${card.kind === "expired" ? "계약 만료" : card.kind === "resigned" ? "사임" : card.kind === "moved" ? "이직" : "경질"}: ${card.on} ${teamName(card.teamId)}${
              card.position !== undefined ? ` — 당시 ${card.position}위` : ""
            }`
          : null,
      ),
    ),

    ...interviewBlocks(state),
    // 제안이 없는 것도 무직에겐 사실이다 — 기다리는 중인지 고를 자리가 있는지가 갈린다
    block(
      "job_offers",
      offers.length > 0
        ? offers.map((o) => `- ${o.id} · ${offerSeat(o)} · ${offerTerms(o)}`).join("\n")
        : `받은 제안 없음.`,
    ),
    block("vacancies", vacancies.length > 0 ? lines(...vacancyRows(state)) : null),
    /**
     * 무직에게도 신문은 온다 — **벤치가 비었다는 소식이 지금 가장 큰 사실이다**
     * (people.md §4-1). 공석 명부는 두드릴 문의 목록이고, 이쪽은 그 문이 왜 열렸나다.
     */
    block("time_passed", timePassedLine(state, passed)),
    `</snapshot>`,
  ]
    .filter((x): x is string => x !== null)
    .join("\n");
}

/**
 * 이번 오프시즌의 우리 팀 은퇴 사실을 state.retired에서 읽는다.
 * 은퇴 선수는 state.players에 없으므로 명부의 이름·나이·구단을 사용한다.
 */
function retirementFacts(state: GameState): string[] {
  return state.retired
    .filter((r) => r.teamId === state.userTeamId && r.on === state.calendar.preseasonStart)
    .map((r) => {
      // 우리 팀에서의 기록 — 통산 접기는 한 곳이다(`careerTotalsOf`). 여기서 다시
      // 합하면 화면·선수 카드가 내는 수와 은퇴 줄의 수가 언젠가 갈린다
      const ours = careerTotalsOf(state, r.gamePlayerId, state.userTeamId);
      return `은퇴: ${r.name} ${ageOf(r.birthdate, r.on)}세 · 우리 팀에서 ${ours.apps}경기 ${ours.goals}골`;
    });
}

/**
 * **아직 답하지 않은 유스 후보** — 이번 여름의 인테이크 (season.md §6).
 *
 * 물음표도 평가어도 없는 장부 줄이다. 인테이크 데이를 어떤 자리로 열지, 누구를 아깝다고
 * 말할지는 GM이 정한다.
 *
 * ⚠️ **후보에게는 안개가 낀다** (player.md §9). 계약서에 사인하기
 * 전이라 훈련장에서 본 것이 전부이고, 그래서 종합도 성장 가능성도 참값이 아니라 관측값으로
 * 선다. 코어는 참값으로 계산하고 여기 서는 것은 감독이 그렇게 알고 있는 값이다.
 */
function youthCandidateFacts(state: GameState): string[] {
  const rows = ourYouthCandidates(state);
  if (rows.length === 0) return [];
  const lines = rows.map((row) => {
    const { overall, growth } = youthCandidateFog(state.seed, row.player);
    const age = ageOf(row.player.birthdate, state.date);
    return (
      `유스 후보: ${row.player.name} ${age}세 · ${naturalPositionOf(row.player).position} · ` +
      `종합 ~${overall} · 성장 가능성 ${growth.label} · ` +
      `주급 ${formatMoney(row.weeklyWage)}/주 · ${row.years}년` +
      (row.autoSign ? " · 답이 없으면 구단이 계약한다" : "")
    );
  });
  const auto = rows.filter((row) => row.autoSign).length;
  lines.push(
    `유스 인테이크 기한: ${youthIntakeDeadline(state)} (선수단 소집일) — ` +
      `그때까지 답이 없으면 위 ${auto}명이 계약하고 나머지는 돌아간다`,
  );
  return lines;
}

/**
 * 방금 끝난 시즌의 시상 중 **감독에게 가는 것** — 우리 리그의 상과 컵·대항전의 상
 * 전부다(`awardReachesManager` — season.md §6). 우리 선수든 남의 선수든 함께 싣고,
 * 어느 쪽인가는 팀 이름이 말한다.
 *
 * 거르는 문도 줄도 코어가 이미 갖고 있는 것을 쓴다(`awardReachesManager`·
 * `awardLine` — 시즌 리뷰의 다이제스트가 쓰는 그 문과 그 줄이다). 여기서 다시
 * 쓰면 같은 상이 다이제스트와 스냅샷에서 다른 문장으로, 또는 한쪽에만 선다.
 */
function awardFacts(state: GameState): string[] {
  return state.awards
    .filter((a) => a.season === state.season - 1 && awardReachesManager(state, a))
    .map((a) => awardLine(a));
}

/**
 * 방금 끝난 시즌이 세운 **구단 기록** — 시즌 리뷰가 다이제스트에 낸 그 카드다
 * (season.md §6 기록 경신). 다이제스트는 시즌이 넘어간 그 한 턴에만 서므로, 오프시즌
 * 내내 읽히는 이 자리에도 같은 사실이 서야 한다 — 시상과 같은 결이다.
 *
 * ⚠️ **판정도 줄도 코어의 것을 그대로 쓴다**(`recordBreaksOf`·`recordBreakLine`).
 * 견주는 대상은 **그 시즌 앞의 시즌들**인데 결산 스냅샷은 이미 남은 뒤라, 그 시즌을
 * 뺀 장부를 건넨다 — 그러지 않으면 자기 자신과 견줘 아무것도 경신이 아니게 된다.
 */
function recordFacts(state: GameState): string[] {
  const teamId = managedTeamId(state);
  if (teamId === null) return [];
  const last = state.season - 1;
  const snapshot = state.history.find((h) => h.season === last && h.teamId === teamId);
  const league = snapshot?.leagues.find((l) => l.rows.some((r) => r.teamId === teamId));
  if (!league) return [];
  const index = league.rows.findIndex((r) => r.teamId === teamId);
  const record = league.rows[index]?.record;
  if (record === undefined) return [];
  const before = { ...state, history: state.history.filter((h) => h.season < last) };
  return recordBreaksOf(before, teamId, {
    season: last,
    leagueId: league.leagueId,
    points: record.points,
    goalsFor: record.goalsFor,
    position: index + 1,
  }).map(recordBreakLine);
}

function offseasonFacts(state: GameState): string | null {
  if (!onSummerBreak(state.calendar, state.date)) return null;
  const facts = [
    ...recordFacts(state),
    ...retirementFacts(state),
    ...awardFacts(state),
    ...youthCandidateFacts(state),
  ];
  if (facts.length === 0) return null;
  return `지난 시즌이 닫히며 남은 것:\n${facts.map((f) => `- ${f}`).join("\n")}`;
}

function mediaBlock(state: GameState): string | null {
  const facts = state.media;
  if (facts.length === 0) return null;
  return facts.map((f) => `- ${f.date} · ${mediaFactText(f)}`).join("\n");
}

/**
 * 복귀 뒤 이 블록이 「방금 돌아왔다」로 치는 기간 (일) — 경기 다이제스트와 같은 결이다.
 * 그 며칠이 지나면 몸은 클럽의 사정이고, 남는 것은 선수 카드의 통산 줄이다.
 */
const CALL_UP_RETURN_DAYS = 3;

/**
 * 돌아온 몸 — 코드가 아니라 낱말로 (`CallUpReturnState`). 「지쳐서 돌아왔다」를
 * 어떻게 말할지는 GM이 쓴다.
 */
const CALL_UP_RETURN_KO: Record<CallUpReturnState, string> = {
  fit: "몸 이상 없음",
  tired: "피로 누적",
  injured: "부상",
};

/** 통산 A매치 조각 — 캡이 0이면 적지 않는다 (세계의 대다수가 그렇다) */
function capsPart(player: GamePlayer): string {
  const caps = capsOf(player.state);
  if (caps === 0) return "";
  const goals = internationalGoalsOf(player.state);
  return ` · 통산 ${caps}캡${goals > 0 ? ` ${goals}골` : ""}`;
}

/** 협회 한 칸 — 코드와 표기를 함께. 코드만 실으면 모델이 `KVX`를 읽고 말을 지어낸다 */
const associationPart = (code: string): string => `${associationName(code)}(${code})`;

/**
 * **A매치 휴식기 블록** — 우리 선수가 클럽을 떠나 있거나 방금 돌아온 동안만 선다
 * (→ docs/match/competition.md §5-1).
 *
 * 이 덩어리가 있는 이유는 하나다: **없으면 모델이 대표팀을 지어낸다.** 데뷔도
 * 캡 수도 프롬프트에 없으면 「드디어 첫 대표팀 데뷔」가 서른 살 주전에게 붙는다
 * (agents.md §6).
 *
 * ⚠️ 물음표도 권고도 없는 장부 줄이다 — 「로테이션을 고려하시죠」는 이 자리의 것이
 * 아니다. 근거가 되는 사실을 짚고 그 사실로 무슨 말을 할지는 GM이 쓴다
 * (overview.md §1 철칙 4).
 */
function internationalFacts(state: GameState): string | null {
  const players = userPlayers(state);
  const sections: string[] = [];

  // ── 지금 소집 중 — 그 열흘이 감독의 이번 주다
  const out = players.flatMap((player) => {
    const callUp = openCallUp(state, player.id);
    return callUp === null ? [] : [{ player, callUp }];
  });
  const openBreak = out[0]?.callUp.breakKey;
  if (openBreak !== undefined) {
    const window = internationalBreaksOf(state.season).find((w) => w.key === openBreak);
    const head =
      window === undefined
        ? "대표팀 소집 중"
        : `${window.label} — ${window.to} 복귀 (${Math.max(0, diffDays(state.date, window.to))}일 남음)`;
    sections.push(
      [
        head,
        ...out.map(
          ({ player, callUp }) =>
            `- ${player.name} ${associationPart(callUp.country)} 소집${callUp.debut === true ? " · 첫 소집" : ""}${capsPart(player)}`,
        ),
      ].join("\n"),
    );
  }

  // ── 여름 대회를 뛰고 아직 안 온 선수 — 프리시즌의 훈련장이 비어 있는 이유다
  const late = players.filter((p) => {
    const summer = p.state.summerReturn;
    return summer !== undefined && state.date < summer && openCallUp(state, p.id) === null;
  });
  if (late.length > 0) {
    sections.push(
      late
        .map(
          (p) =>
            `- ${p.name} 여름 대회로 아직 합류 전 — ${p.state.summerReturn} 합류${capsPart(p)}`,
        )
        .join("\n"),
    );
  }

  // ── 방금 돌아온 창 — 무엇을 하고 어떤 몸으로 왔나
  const closed = internationalBreaksOf(state.season).find(
    (w) => w.to <= state.date && diffDays(w.to, state.date) <= CALL_UP_RETURN_DAYS,
  );
  if (closed !== undefined) {
    const byId = new Map(players.map((p) => [p.id, p] as const));
    const back = callUpsOfBreak(state, closed.key).flatMap((c) => {
      const player = c.returnedOn === null ? undefined : byId.get(c.gamePlayerId);
      if (player === undefined) return [];
      // 첫 소집이어도 그 창에서 못 뛰었으면 데뷔가 아니다 — `debut`은 소집 시점의 캡이 0이었다는 표식이다
      const debut = c.debut === true && c.apps > 0 ? " · 대표팀 데뷔" : "";
      const played = c.apps > 0 ? `${c.apps}경기 ${c.goals}골` : "출전 없음";
      const body = c.returnState === undefined ? "" : ` · ${CALL_UP_RETURN_KO[c.returnState]}`;
      return [
        `- ${player.name} ${associationPart(c.country)} ${played}${debut}${body}${capsPart(player)}`,
      ];
    });
    if (back.length > 0) {
      sections.push([`${closed.label} 복귀 (${closed.to})`, ...back].join("\n"));
    }
  }

  if (sections.length === 0) return null;
  /**
   * **지금 부릴 수 있는 1군이 몇인가** — 감독이 그 주에 실제로 겪는 사실이다.
   * 코어의 문을 그대로 읽는다(`isAvailableFor`): 부상·정지·소집이 한 자리에서
   * 갈리고, **정지는 다음 경기의 대회로 묻는다** (match.md §6).
   */
  const nextCompetition =
    nextMatchFor(state.matches, state.userTeamId, state.date)?.competitionId ?? null;
  const firstTeam = players.filter((p) => squadLevelOf(p) === "first");
  sections.push(
    `지금 부릴 수 있는 1군 ${firstTeam.filter((p) => isAvailableFor(state, p, nextCompetition)).length}/${firstTeam.length}명`,
  );
  return sections.join("\n");
}

export function buildGmStateNote(state: GameState, passed?: TimePassed | null): string {
  if (managedTeamId(state) === null) return buildUnemployedNote(state, passed);
  const standings = computeStandings(state);
  const rank = standings.findIndex((r) => r.teamId === state.userTeamId) + 1;
  // 0경기 순위는 싣지 않는다 — 정렬 순서일 뿐인데 모델이 구단의 처지로 읽는다
  const played = standings.find((r) => r.teamId === state.userTeamId)?.played ?? 0;
  const tac = tacticsOf(state, state.userTeamId).spec;
  const finance = financeOf(state, state.userTeamId);
  const players = userPlayers(state);

  const injured = players
    .map((p) => {
      const inj = openInjury(state, p.id);
      return inj ? `${p.name} ${inj.bodyPart}~${inj.expectedReturn}` : null;
    })
    .filter((x): x is string => x !== null);
  /**
   * **정지는 어느 대회의 것인지까지 싣는다** (match.md §6) — 컵 정지 선수는 다음
   * 리그 경기에 서므로, 대회 없는 이름은 GM에게 잘못된 결장자를 준다.
   */
  const suspended = players
    .map((p) => {
      const ban = activeSuspension(state, p.id);
      return ban === null
        ? null
        : `${p.name} ${suspensionScopeName(ban)} ${ban.lengthMatches - ban.served}경기`;
    })
    .filter((x): x is string => x !== null);
  /**
   * **다치기 전에 서는 줄** (player.md §5.3) — 부상 줄은 이미 쓰러진 뒤의 사실이라,
   * 이것이 없으면 수석코치가 "쉬게 하시죠"라고 말할 근거가 어디에도 없다.
   * 지금 뛸 수 있는 **1군**만 센다 — 다친 선수의 이력은 감독이 손쓸 일이 아니고,
   * 2군의 몸은 이번 주 라인업의 사정이 아니다 (수석코치의 눈도 같은 문이다).
   *
   * ⚠️ **등급이 아니라 이력이 간다.** 「위험 높음」은 코어의 판단이고, 이 줄이 하는
   * 일은 모델이 판단할 **재료**를 주는 것이다 — 두 시즌의 건수·결장 일수·최근 부상을
   * 주면 「최근에 돌아온 주전」과 「늘 삐끗하는 백업」을 모델이 갈라 말한다. 코어가
   * 셋을 한 낱말로 접으면 그 갈림이 프롬프트에 닿지 못한다 (overview.md §1 철칙 4).
   */
  const atRisk = players
    .filter((p) => squadLevelOf(p) === "first" && !isInjured(state, p.id))
    .flatMap((p) => {
      const line = injuryHistoryText(injuryHistoryOf(state, p.id));
      return line === null ? [] : [`${p.name} — ${line}`];
    });
  /**
   * **시즌이 몸에 쌓아 둔 것** (player.md §5.5) — 위험 줄과 **다른 줄인 이유는 감독이
   * 쥐는 손잡이가 다르기 때문이다.** 위험은 이번 경기의 라인업으로 답하고 과부하는
   * 몇 주의 로테이션·개인 휴식으로 답한다. 한 줄로 접으면 GM이 "오늘 빼시죠"만
   * 말하게 되고, 잔고는 그것으로 빠지지 않는다.
   */
  const overloaded = players
    .filter(
      (p) =>
        squadLevelOf(p) === "first" &&
        !isInjured(state, p.id) &&
        fatigueBand(fatigueOf(p.state)) === "overloaded",
    )
    .map((p) => p.name);

  const training = upcomingTrainingLines(state);
  const trainingCount = state.schedule.filter(
    (e) => e.type === "training" && e.status === "scheduled" && e.date >= state.date,
  ).length;

  const alerts = [
    // 판정 대기 협상이 맨 앞 — 답은 다음 턴 입력에 실리므로 여기서 세우지 않으면 잊힌다
    suspended.length > 0 ? `정지 ${suspended.length} (${suspended.join(", ")})` : null,
    /**
     * 만료 임박 계약 — 재계약 서사의 씨앗. 놓치면 자유계약으로 떠난다.
     *
     * **이미 다른 구단과 사전 계약을 맺은 선수는 이 줄에서 빠진다**
     * (→ docs/common/season.md §6). 그는 재계약을 열 수 있는 사람이 아니라
     * 떠나기로 한 사람이라, 같은 줄에 세우면 GM이 매 턴 감독에게 없는 손잡이를
     * 권한다. 아래 별도의 줄이 그 사실을 든다.
     */
    (() => {
      const ours = new Set(players.map((p) => p.id));
      const expiring = state.contracts
        .filter(
          (c) =>
            c.status === "active" &&
            ours.has(c.gamePlayerId) &&
            diffDays(state.date, c.until) <= EXPIRING_ALERT_DAYS,
        )
        .sort((a, b) => (a.until < b.until ? -1 : a.until > b.until ? 1 : 0));
      return expiring.length > 0
        ? `계약 만료 임박 ${expiring.length} (${expiring
            .slice(0, EXPIRING_SHOWN)
            .map((c) => `${playerName(state, c.gamePlayerId)}~${c.until}`)
            .join(", ")}${expiring.length > EXPIRING_SHOWN ? " …" : ""})`
        : null;
    })(),
  ].filter((x): x is string => x !== null);

  /**
   * **몸의 사실 — 의료진의 것이다** (people.md §3 화자 표). 주의 줄에 뭉쳐 있던
   * 셋이 화자를 얻어 나온 자리다. 사실은 한 글자도 달라지지 않는다: 달라지는 것은
   * 이 사실이 프롬프트에서 누구의 것으로 서는가뿐이다.
   */
  const medical = [
    injured.length > 0 ? `부상 ${injured.length} (${injured.join(", ")})` : null,
    atRisk.length > 0
      ? `부상 이력 ${atRisk.length} (${atRisk.slice(0, AT_RISK_SHOWN).join(" / ")}${
          atRisk.length > AT_RISK_SHOWN ? " …" : ""
        })`
      : null,
    overloaded.length > 0
      ? `과부하 ${overloaded.length} (${overloaded.slice(0, OVERLOADED_SHOWN).join(", ")}${
          overloaded.length > OVERLOADED_SHOWN ? " …" : ""
        })`
      : null,
  ].filter((x): x is string => x !== null);

  // 스카우팅 진행과 도착한 보고서는 **같은 사람의 것이다** — 덩어리 둘의 이름이 하나다

  const coach = coachCues(state);
  const offseason = offseasonFacts(state);
  const international = internationalFacts(state);
  const edits = state.pendingEdits ?? [];
  const news = state.pendingNews ?? [];

  return [
    `<snapshot>`,
    block(
      "now",
      lines(
        `${state.date} (${DOW_KO[dayOfWeek(state.date)]}) ${formatClock(clockOf(state))} · 시즌 ${state.season}${
          played > 0 && rank > 0 ? ` · 리그 ${rank}위` : ""
        } · ${describeWindowState(state)}`,
        describeNextFixture(state),
        nextSubLimitLine(state),
        // 부임 직후엔 선수단이 여름 휴가 중 — 소집일을 밝혀야 빈 훈련장을 지어내지 않는다
        state.date < squadReturnOf(state.calendar)
          ? `선수단 여름 휴가 중 — ${squadReturnOf(state.calendar)} 소집`
          : trainingCount > 0
            ? `예정 훈련 ${trainingCount}건: ${training.join(" / ")}${trainingCount > training.length ? " …" : ""}`
            : `예정 훈련 없음 — 기본 훈련까지 비워진 상태다`,
      ),
    ),
    block(
      "club",
      lines(
        // 6축 슬라이더는 싣지 않는다 — 화자가 입에 담지 않는 수치이고 `get_squad`가
        // 배치와 함께 낸다. 모양과 적응도는 코치의 말에 그대로 실린다
        `전술: ${tac.formation} · 선발 평균 적응 ${familiarityLabel(squadFamiliarity(state, state.userTeamId))}`,
        `재정: 잔고 ${formatMoney(finance.balance)} · 주급 ${formatMoney(weeklyWagesOf(state, state.userTeamId))}/주`,
        /**
         * 완장 — **선수단 명단 위에 자기 줄로 선다.** 이름 뒤의 괄호로 붙이면 스물다섯
         * 이름 한가운데에 묻혀 GM이 축구 상식의 주장을 라커룸에 세운다 (agents.md §6).
         */
        armbandLine(state),
        /**
         * 선수단 — **이름 명단이다. 이름뿐이다.** "누가 우리 팀인가"는 매 장면의 전제라
         * 입력에 없으면 GM이 없는 선수를 세우고, 명단은 승격·만료마다 바뀌어 캐시 층에
         * 둘 수도 없다. 그래서 캐시가 걸리지 않는 이 층이 이름을 진다.
         *
         * 능력치·컨디션·계약·배치는 따라오지 않는다 — 그것까지 실으면 이 층의 절반을
         * 먹고, 그 값은 조회가 이미 낸다 (agents.md §5·§7 · prompts.md §5-2).
         * ⚠️ 도구 이름을 적지 않는다 — 데이터 블록에는 사실만 (prompts.md §5-3).
         */
        (() => {
          // 구분자는 쉼표가 아니라 가운뎃점이다 — 한국어 성명에 공백이 들어가서
          // 쉼표로 이으면 어디서 한 사람이 끝나는지가 흐려진다
          const named = (level: "first" | "reserve") =>
            players.filter((p) => squadLevelOf(p) === level).map((p) => p.name);
          const first = named("first");
          const reserve = named("reserve");
          return lines(
            `선수단 ${players.length}명`,
            first.length > 0 ? `- 1군 ${first.length}: ${first.join(" · ")}` : null,
            reserve.length > 0 ? `- 2군 ${reserve.length}: ${reserve.join(" · ")}` : null,
          );
        })(),
      ),
    ),
    block(
      "manager",
      lines(
        state.manager.name,
        // 감독 자신의 계약 — 연봉·만료일과 보드의 재계약 판정 (career.md §5.4)
        managerContractLine(state),
        ...managerSeatLines(state),
      ),
    ),
    // 한 줄에 하나 — 이어 붙이면 일곱 항목이 가운뎃점 사이에 묻힌다
    block("alerts", alerts.join("\n")),
    block(
      "negotiations",
      JSON.stringify({
        ours: managedNegotiationOverview(state),
        world: state.negotiations
          .filter(
            (n) =>
              n.signed &&
              n.signed.on >= addDays(state.date, -7) &&
              n.buyerId !== state.userTeamId &&
              n.sellerId !== state.userTeamId,
          )
          .slice(-12)
          .map((n) => ({
            player: playerName(state, n.playerId),
            buyer: n.buyerId,
            seller: n.sellerId,
            status: n.status,
            signedOn: n.signed?.on,
          })),
      }),
    ),
    // 부상·부상 이력·과부하 — 의무실을 맡은 사람의 것. 자리가 비면 수석코치가 선다
    block("medical", medical.join("\n"), ` name="${factSpeakerOf(state, "medical").name}"`),
    ...coachBlocks(state, coach),
    opponentBlock(state),
    block("last_match", matchDigest(state)),
    block("time_passed", timePassedLine(state, passed)),
    block("offseason", offseason),
    block("international", international),
    ...interviewBlocks(state),
    // 파견 중인 스카우트 — 도착한 보고서(<scout_reports>)와 같은 사람의 덩어리다
    // 선수 근황 — 선수단 중 **사실이 붙는** 셋이다.
    // 코어는 경기와 훈련의 사실만 낸다 — 누가 말할지, 무슨 말을 할지는 GM의 몫
    /**
     * 경기 뒤 들어온 소식 — 재정과 같은 라운드의 다른 경기·대진.
     *
     * 알림(대회 말풍선)에는 싣지 않는 갈래다(화면이 이미 갖고 있다). 그래도 모델은
     * 알아야 한다 — 순위가 뒤집힌 걸 모른 채 다음 장면을 쓰면 세계가 감독의 경기
     * 하나로 멈춘 것처럼 읽힌다. 읽기만 하고 비우지 않는다 (`takeNews`는 gm.ts).
     */
    block("news", news.map((n) => `- ${n}`).join("\n")),

    // 채팅 턴 없는 화면 조작(전술판·명단·역할) — 이미 반영된 사실이라 모델은 반응만 한다
    block("edits", edits.map((e) => `- ${e.text}`).join("\n")),
    block("media", mediaBlock(state)),
    /**
     * 감독이 보드에 건 요청 — 답을 기다리는 것·공사 중인 구장 (finance.md §9.3). 답이
     * 도착한 날은 `<time_passed>`가 나른다.
     */
    block("board", describeBoardRequests(state)),
    /**
     * 시작 사건 — 부임 첫 몇 주의 실마리. **개폐가 코어의 것**이라 여기
     * 실리는 것은 아직 열린 줄뿐이다: 감독이 그 실마리에 걸린 일을 하면 다음 턴에
     * 빠지고, 아무도 손대지 않은 것만 기한까지 선다 (career.md §1).
     */
    `</snapshot>`,
  ]
    .filter((x): x is string => x !== null)
    .join("\n");
}

/**
 * 스트리밍에도 같은 위생을 건다 — 걸러진 줄이 화면에 잠깐 떴다 사라지면
 * 그것대로 눈에 띈다. 줄의 **앞머리**와 여기까지 지나온 것(`SceneScan`)만 보면
 * 판정되므로, 지연되는 것은 줄 앞머리뿐이고 그다음 델타는 그대로 흘러간다.
 *
 * ⚠️ **헤더는 값을, 꺾쇠는 닫는 부등호를 봐야 판정된다** — 같은 시각이면 소음,
 * 달라졌으면 전환이고, `<`로 연 줄은 태그인지 대사인지가 `>`에서 갈린다. 그래서 그
 * 두 줄만 닫는 글자(또는 줄 끝)까지 기다린다. 32자 안의 줄이라 지연은 눈에 띄지 않는다.
 *
 * ⚠️ **상태(`afterSceneLine`)는 줄이 끝난 뒤 줄 전체로 민다** — 앞머리로 밀면 한 줄에서
 * 여닫은 블록(`<b>강조</b>`)이 스트리밍에서만 열린 채 남아, 화면과 저장이 갈린다.
 */
function filterStream(emit: (delta: string) => void, scenes: boolean): (delta: string) => void {
  let line = ""; // 이 줄에 지금까지 온 것 전부 — 판정과 무관하게 쌓는다
  let sent = 0; // 그중 이미 내보낸 글자 수
  let keeping: boolean | null = null; // 이 줄을 내보내는가 — null이면 판정 전
  const scan: SceneScan = { lastHeader: null, sceneOpen: false, block: null, scenes };

  /** 앞머리만으로 판정할 수 있는가 — 못 하면 닫는 글자를 기다린다 */
  const ready = (): boolean => {
    const head = line.trimStart();
    if (head.startsWith("<") && !head.includes(">")) return false;
    if (scan.scenes && head.startsWith("[") && !head.includes("]")) return false;
    return true;
  };
  /** 판정이 났으면 아직 안 나간 만큼을 흘려보낸다 */
  const pump = (): void => {
    if (keeping === null && line.trim().length > 0 && ready()) keeping = keepsSceneLine(line, scan);
    if (keeping === true && sent < line.length) {
      emit(line.slice(sent));
      sent = line.length;
    }
  };
  const endLine = (): void => {
    // 닫히지 않은 채 줄이 끝난 헤더·꺾쇠도 여기서 판정된다
    if (keeping === null && line.trim().length > 0) keeping = keepsSceneLine(line, scan);
    if (keeping === true && sent < line.length) emit(line.slice(sent));
    afterSceneLine(line, scan);
    // 줄바꿈은 살아남은 줄에만 붙인다 — 걸러진 줄은 자리도 남기지 않는다
    if (keeping !== false) emit("\n");
    line = "";
    sent = 0;
    keeping = null;
  };

  return (delta: string) => {
    const parts = delta.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) endLine();
      if (part.length > 0) {
        line += part;
        pump();
      }
    });
  };
}

/** 평시 스트리밍 — 헤더·작업 로그·꺾쇠를 함께 걷는다 */
export function filterSceneStream(emit: (delta: string) => void): (delta: string) => void {
  return filterStream(emit, true);
}

/** 중계 스트리밍 — 꺾쇠 블록만 걷는다 (`sanitizeCasterText`와 같은 규칙) */
export function filterCasterStream(emit: (delta: string) => void): (delta: string) => void {
  return filterStream(emit, false);
}

/**
 * 턴이 **닿은 시각** — 시점 헤더가 여럿이면 마지막 것이다.
 *
 * 한 턴 안에서 시간이 흐르면 위생이 그 전환 헤더를 남기므로(prompts.md §1), 장면이
 * 실제로 도착한 곳은 마지막 헤더다. 시계를 첫 헤더로만 밀면 채팅은 오후를 세우는데
 * 상단 띠는 오전에 남아 **한 화면의 두 시계가 갈린다.**
 */
export function lastScenePoint(text: string): ScenePoint | null {
  let point: ScenePoint | null = null;
  for (const line of text.split("\n")) {
    const here = scenePointOf(line);
    if (here) point = here;
  }
  return point;
}

/** 경기 장면의 첫 줄 — 시계의 주인이 장부라 코어가 직접 쓴다 */
function matchHeader(minute: number): string {
  return `[${minute}']`;
}

/** 헤더 한 줄인가 — 대괄호로 열고 닫은 줄 하나 (`[43']` · `[2026-07-18 오후]`) */
const BRACKET_LINE_RE = /^\s*\[[^\]]*\]\s*$/u;

/**
 * **경기 장면의 시각은 장부가 붙인다** (agents.md §3 ④).
 *
 * 평시의 첫 줄 헤더는 시계를 옮기는 입구지만 경기의 시계 주인은 장부다. 캐스터가
 * 적은 분은 걷어내고 그 자리에 장부의 분을 세운다 — 대화만 한 턴에 `[12']`를 적어
 * 감독이 지나가지도 않은 12분 위에 다음 지시를 쌓던 자리다.
 */
export function stampMatchScene(text: string, minute: number): string {
  return `${matchHeader(minute)}\n${parseSceneHeader(text).body}`;
}

/**
 * 스트리밍에도 같은 주인 — **코어의 시각 줄이 먼저 나가고 모델의 첫 줄은 화면에
 * 닿기 전에 걷힌다.** 사후 교정만 하면 라이브 화면이 잠깐 다른 분을 보여 준다.
 *
 * 판정에 필요한 것은 첫 줄뿐이라 지연되는 것도 첫 줄뿐이다. 헤더일 수 없다고
 * 판정되는 순간(`[`로 열지 않았다) 그 자리에서 흘려보낸다.
 */
export function stampMatchStream(
  /** 장부의 분 — 함수면 **첫 델타가 나가는 순간**에 읽는다 (도구가 시계를 옮긴 뒤다) */
  minute: number | (() => number),
  emit: (delta: string) => void,
): (delta: string) => void {
  let opened = false;
  /** 아직 판정하지 못한 첫 줄. `null`이면 판정이 끝나 그대로 흘려보낸다 */
  let head: string | null = "";
  const flush = (rest: string): void => {
    head = null;
    if (rest.length > 0) emit(rest);
  };
  return (delta: string) => {
    if (!opened) {
      emit(`${matchHeader(typeof minute === "function" ? minute() : minute)}\n`);
      opened = true;
    }
    if (head === null) {
      emit(delta);
      return;
    }
    head += delta;
    for (;;) {
      const nl = head.indexOf("\n");
      if (nl < 0) {
        if (head.trim().length > 0 && !head.trimStart().startsWith("[")) flush(head);
        return;
      }
      const first = head.slice(0, nl);
      const rest = head.slice(nl + 1);
      // 코어가 이미 첫 줄을 세웠으므로 그 앞의 빈 줄은 자리도 남기지 않는다
      if (first.trim().length === 0) {
        head = rest;
        continue;
      }
      flush(BRACKET_LINE_RE.test(first) ? rest : `${first}\n${rest}`);
      return;
    }
  };
}

/**
 * 지금이 경기 중인가 — 이력을 가르는 기준이자 창을 가르는 기준이다.
 *
 * 킥오프 멘트 턴은 아직 **라커룸의 연장**이다 — 경기 이력이 비어 있고 첫 마디를
 * 여는 근거는 경기 전 대화(팀토크·브리핑)다. 그래서 그 한 턴만 평시로 읽는다.
 */
function inMatchNow(state: GameState): boolean {
  return state.phase === "match" && state.pendingMatch?.entered === true;
}

/**
 * 평시·경기의 이력을 가른다 — 섞이면 토큰만이 아니라 맥락이 오염된다 (agents.md §5).
 * 평시 → 경기는 buildMatchBrief·matchDigest가 잇는다. 평시 턴의 정의는 코어의 것이다
 * (`isPeaceTurn`).
 */
function relevantTurns(state: GameState): typeof state.chat {
  const inMatch = inMatchNow(state);
  const here = state.pendingMatch?.matchId;
  return state.chat.filter((t) =>
    inMatch
      ? // 경기 중 — 이 경기의 턴만. 다른 경기의 중계도 남의 이야기다
        t.inMatch === true && (here === undefined || t.matchId === undefined || t.matchId === here)
      : isPeaceTurn(t),
  );
}

/**
 * 이력 창 **안에** 서 있는 카드 — 인물 사전이 「이미 실렸다」를 판단하는 근거다.
 *
 * 창 밖으로 밀려난 기록은 여기 오지 않으므로 그 인물은 그 순간 다시 주입 대상이
 * 된다 — 만료 규칙을 따로 두지 않는 이유다 (people.md §6).
 */
export function injectedCharacters(state: GameState): LorebookInjection[] {
  return windowOf(state).turns.flatMap((turn) => turn.lorebook ?? []);
}

export function recordCharacterInjection(
  state: GameState,
  entries: readonly LorebookInjection[],
): void {
  const turn = state.chat[state.chat.length - 1];
  if (!turn || turn.role === "model" || entries.length === 0) return;
  turn.lorebook = entries.map((entry) => ({ ...entry, keywords: [...entry.keywords] }));
}

/**
 * 이력 창 — 어디서부터 어디까지가 이번 호출의 이력인가. **평시의 시작점은 코어가
 * 정한다** (`historyStart` → agents.md §5-1: 글자 상한 안에 드는 가장 앞의 6턴 경계).
 * 코어가 고르는 평시 턴(`peaceTurns`)과 `relevantTurns`의 평시 갈래가 같은 필터
 * (`isPeaceTurn`)라 접힌 지점의 인덱스가 이 목록에 그대로 맞는다.
 */
function windowOf(state: GameState): { turns: GameState["chat"] } {
  const chat = relevantTurns(state);
  const upto = historyEnd(chat);
  // 경기의 이력은 접히지 않는다 — 경기마다 갈려 자라지 않는다 (agents.md §5-1).
  // 접은 지점은 평시의 것이라 이 목록에 먹이면 엉뚱한 자리를 자른다
  const start = inMatchNow(state) ? 0 : historyStart(state);
  return { turns: chat.slice(start, upto) };
}

/**
 * 한 턴의 입력을 유저 메시지 하나로 — 인물 카드 → 화면 조작 → 감독 발화.
 *
 * 한 턴은 채팅에 여럿을 남기지만(조작이 먼저, 발화가 뒤 — `historyEnd`) 모델에는
 * 메시지 하나로 간다. **보낼 때도 이력에서 다시 그릴 때도 이 함수다** —
 * 이번 턴(`buildGmTurnMessage`)과 이력(`buildGmHistory`)이 다른 손으로 그리면 같은
 * 자리가 글자부터 갈려 캐시 프리픽스가 지난 발화 앞에서 끊기는데, 화면에는 아무
 * 증상이 없다 (agents.md §5 · prompts.md §5-1 원칙 12).
 *
 * 카드가 발화 앞이다 — 이력에 남는 것들 안의 순서라 캐시와 무관하고, 대본이 그렇듯
 * 등장인물이 대사보다 먼저다. 이력에 남지 않는 스냅샷은 이 메시지 밖, 그 뒤에 어댑터가
 * 붙인다 (models.md §3-3).
 */
export function renderTurnGroup(
  state: GameState,
  turns: ReadonlyArray<Pick<ChatTurn, "role" | "text">>,
  cards: readonly LorebookInjection[],
): string {
  return [
    // 오퍼레이터 지시도 같은 유저 메시지 안이다 — 갈리는 건 **내용의 형식**이다.
    // 감독 발화인지 조작인지를 본문이 밝힌다
    ...turns.map((turn) =>
      turn.role === "operator"
        ? buildOperatorMessage(turn.text)
        : buildManagerMessage(state, turn.text),
    ),
  ]
    .concat(lorebookText(cards) || [])
    .filter((block): block is string => block !== null)
    .join("\n\n");
}

/**
 * 이번 턴의 유저 메시지 — 이력이 끝난 자리(`historyEnd`)부터 꼬리까지가 이번 턴에
 * 밀어 넣은 입력이다. 카드는 아직 꼬리에 기록되기 전이라(`recordCharacterInjection`은
 * 턴이 끝난 뒤다) 고른 것을 그대로 받는다.
 *
 * ⚠️ 꼬리가 비어 있으면 빈 메시지다 — 부르는 쪽(`turn-runner`)이 이번 턴의 조작과
 * 발화를 채팅에 먼저 밀어 넣는 것이 이 함수의 전제이고, `historyEnd`·
 * `recordCharacterInjection`도 같은 전제 위에 선다.
 */
export function buildGmTurnMessage(state: GameState, cards: readonly LorebookInjection[]): string {
  const chat = relevantTurns(state);
  return renderTurnGroup(state, chat.slice(historyEnd(chat)), cards);
}

export function buildGmHistory(
  state: GameState,
): Array<{ role: "user" | "assistant"; content: string }> {
  return groupTurns(windowOf(state).turns).map((group) =>
    group[0]?.role === "model"
      ? { role: "assistant" as const, content: group.map((turn) => turn.text).join("\n\n") }
      : {
          role: "user" as const,
          // 그 턴에 실었던 카드를 같은 자리에 다시 붙인다 — 세이브에는 기록만 있고
          // 문장은 매번 여기서 만들어진다 (people.md §6)
          content: renderTurnGroup(
            state,
            group,
            group.flatMap((turn) => turn.lorebook ?? []),
          ),
        },
  );
}

/**
 * 연속된 비-모델 턴을 한 묶음으로 — 한 턴의 입력이 보낼 때 메시지 하나였으므로 이력에서도
 * 하나다. 모델 턴은 저마다 한 묶음이다.
 */
function groupTurns(turns: readonly ChatTurn[]): ChatTurn[][] {
  const groups: ChatTurn[][] = [];
  for (const turn of turns) {
    const last = groups[groups.length - 1];
    if (last && turn.role !== "model" && last[0]?.role !== "model") last.push(turn);
    else groups.push([turn]);
  }
  return groups;
}

/** 기록 → 인물지. 세계에서 사라진 이름은 조용히 빠진다 (방출된 선수) */
