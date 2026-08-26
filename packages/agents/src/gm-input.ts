/**
 * GM 입력 빌더 — 구단·감독 블록(캐시층)·상태 스냅샷·경기 장부 노트·장면 헤더 파서·
 * 이번 턴 메시지와 대화 이력 창. 입력은 변경 빈도 순 3층이다 (docs/llm/agents.md).
 */
import {
  awardLine,
  ABSENT_REASON_KO,
  boardExpectation,
  buildOpponentReport,
  careerTotalsOf,
  characterEntry,
  characterEntryOf,
  clockOf,
  coachCues,
  describeActiveArcs,
  computeStandings,
  dayOfWeek,
  describeBuyBackRights,
  describeNegotiations,
  describeNextFixture,
  describeBoardRequests,
  describePendingApproach,
  pendingApproach,
  describePendingPress,
  pendingPress,
  describeWindowState,
  expiringContracts,
  financeOf,
  formatClock,
  headCoachOf,
  historyStart,
  isSuspended,
  leagueOfTeamIn,
  loanedOut,
  managedTeamId,
  MAX_EXPLOITS,
  onSummerBreak,
  openInjury,
  openManagerOffers,
  openPromises,
  pendingVerdicts,
  playerName,
  scoutingSummary,
  scoutReportLine,
  speakerCues,
  squadFamiliarity,
  squadLevelOf,
  squadReturnOf,
  subLimitsOf,
  tacticsOf,
  teamName,
  topNarrative,
  userPlayers,
  weeklyWagesOf,
  type ChatTurn,
  type CoachCue,
  type GameState,
  type ScenePoint,
} from "@story-fm/engine";
import {
  ageOf,
  boardExpectationLine,
  describeManagerSkills,
  describeReputation,
  diffDays,
  familiarityLabel,
  formatMoney,
  matchupText,
  normalizePacket,
  packetTagContext,
  packetTagText,
  personaRoleLabel,
  PROMISE_KIND_KO,
  slotOfTime,
  tacticsBrief,
  type CharacterEntry,
  type CharacterInjection,
  type ScoutReportCard,
} from "@story-fm/domain";

/** 경기 브리핑에 그대로 싣는 직전 평시 감독 발화 수 */
const MATCH_BRIEF_TURNS = 3;
/** 경기 다이제스트가 "방금 있었던 일"로 치는 기간 (일) */
const MATCH_DIGEST_DAYS = 3;
/** 계약 만료 임박 경고 창 (일) */
const EXPIRING_ALERT_DAYS = 180;

/**
 * 약속 기한 임박 경고 창 (일) — **계약보다 훨씬 짧다.**
 *
 * 계약 만료는 반년 전부터 손을 쓸 수 있는 일이지만 약속은 기한 그 주에 감독이
 * 할 수 있는 일(선발로 세운다·리스트에 올린다·재계약을 연다·완장을 채운다)이
 * 남아 있는 동안만 경고가 뜻을 갖는다. 한 달 전부터 매 턴 뜨면 그 줄은 배경음이
 * 되고, 정작 기한 전날의 줄이 묻힌다 (→ docs/data/people.md §5-2).
 */
const PROMISE_ALERT_DAYS = 7;

/**
 * 인물 카드 — 인물지를 모델이 읽는 형태로 (people.md §6).
 *
 * 예시 대사까지 실어야 모델이 톤을 흉내 내는 대신 그 사람으로 말한다. 무엇이 실리고
 * 무엇이 빠지는지는 **깊이**가 정하고, 그 판단은 코어(`characterEntry`)의 것이다 —
 * 여기서는 온 것을 문장으로 옮기기만 한다.
 *
 * ⚠️ **카드는 데이터다 — 지시문을 싣지 않는다** (prompts.md §5). 조회 포인터도
 * 실명 가드도 여기 없다: 규칙은 시스템 프롬프트가 한 번 갖고, 실명 인물의 사람됨은
 * 원형과 장부의 사실이 묶는다. 화자 태그는 여는 태그의 속성이다 — 태그와 이름이
 * 갈리는 동명이인에서 모델이 태그를 알 자리가 여기뿐이다.
 *
 * 블록은 영어 태그로 싼다 (prompts.md §5) — 읽는 것(꺾쇠)과 쓰는 것(@ 줄)이 갈린다.
 */
export function describePersona(entry: CharacterEntry): string {
  const label = personaRoleLabel(entry.role);
  return [
    `<character name="${entry.name}" tag="@${entry.characterId}:"${label ? ` role="${label}"` : ""}>`,
    `원형: ${entry.archetype}`,
    `성격: ${entry.traits.join(" · ")}`,
    ...(entry.motivation ? [`동기: ${entry.motivation}`] : []),
    ...(entry.speechStyle ? [`말투: ${entry.speechStyle.note}`] : []),
    ...(entry.speechStyle?.samples ?? []).map((s) => `  예) ${s}`),
    // 관계 초기값 — 원형에서 파생한 첫인상이다 (people.md §6). 그 뒤의 일은 기억이 갖는다
    ...(entry.relations ?? []).map(
      (r) =>
        `관계: ${r.name} — ${r.stance === "aligned" ? "결이 맞는다" : "결이 부딪힌다"} (먼저 보는 것: 나 ${r.ours} · 상대 ${r.theirs})`,
    ),
    // 감독이 아는 만큼만 그린다 — 소문으로만 아는 사람에게 속내를 주면 만난 적 없는
    // 사람의 목소리가 난다. 사실로 적는다: 카드의 지시문은 모델이 그 문장대로 쓴다
    ...(entry.depth === "rumour" ? [`감독과의 거리: 평판으로만 안다 — 말투도 속내도 모른다`] : []),
    // 기억은 **이번 턴에 세우는 카드에만** 온다 — 이력이 다시 그리는 카드
    // (`characterEntryOf`)는 기억 없이 오므로 이 줄이 서지 않는다. 압축이 더한 기억이
    // 지난 턴의 바이트를 바꾸지 않는 자리다 (people.md §6 · agents.md §5)
    ...(entry.memories?.length
      ? [`있었던 일:`, ...entry.memories.map((m) => `  ${m.date} — ${m.text}`)]
      : []),
    `</character>`,
  ].join("\n");
}

/**
 * 이번 장면의 인물들 — 캐릭터북이 고른 카드 묶음 (people.md §6).
 *
 * ⚠️ **여기 있는 것은 "이 사람이 누구인가"뿐이다.** 카드는 이력에 굳으므로 변하는
 * 값(폼·컨디션·부상·심경·계약)이 들어가면 3주 뒤 모델이 낡은 사실로 말한다. 지금의
 * 사실은 조회 도구가 갖고, **조회하고 답하라는 지시는 이 블록이 아니라 `GM_SYSTEM`의
 * 철칙과 그 도구의 설명이 갖는다** — 카드에는 사실만 선다 (prompts.md §5).
 */
export function describeCharacters(entries: readonly CharacterEntry[]): string | null {
  if (entries.length === 0) return null;
  return [`<characters>`, ...entries.map(describePersona), `</characters>`].join("\n");
}

/**
 * 맡은 구단 — 이름은 여는 태그의 속성이다 (`<character name>`과 같은 표기, prompts.md §5).
 * 무직이면 서지 않는다 — 옛 구단을 세우면 모델은 아직 그 구단의 감독인 것처럼 쓴다
 * (career.md §5.1). 경질·부임에 한 번 바뀌고 그 사이엔 바이트가 같다.
 */
export function describeClub(state: GameState): string | null {
  const teamId = managedTeamId(state);
  return teamId === null ? null : `<club name="${teamName(teamId)}" />`;
}

/**
 * 감독 — 이름과 화자 태그는 속성, 배경은 본문. 세이브당 고정인 것만이다.
 *
 * **데이터만 싣는다** (prompts.md §5). 선수 이름이 스냅샷에 있다는 것, 선수 인자는
 * 이름으로 받는다는 것, 감독을 대신 연기하지 않는다는 것은 전부 시스템 프롬프트가
 * 한 번 갖는 규칙이라 여기 다시 적지 않는다 (prompts.md §5-3).
 * ⚠️ 감독의 능력·평판은 여기 없다 — 경기마다 평판이 움직이고 능력도 자라므로
 * 여기 있으면 경기 한 번에 이 블록과 그 뒤가 통째로 무효가 된다. 매 턴
 * 층(`buildGmStateNote`)이 구간 어휘로 싣는다.
 */
export function describeManager(
  manager: Pick<GameState["manager"], "name" | "background">,
): string {
  return [
    `<manager name="${manager.name}" tag="@${manager.name}:">`,
    `배경: ${manager.background}`,
    `</manager>`,
  ].join("\n");
}

/**
 * 레퍼런스 층 — 캐시되는 시스템 블록. 구단과 감독, 세이브당 고정인 것만 (agents.md §5).
 * 세 에이전트(평시 GM · 중계 · 교섭)가 같은 두 블록을 읽는다.
 *
 * ⚠️ **인물 카드는 여기 없다.** 코치·구단주·기자 다섯 장은 회견도 협상도 없는 턴에
 * 한 번도 쓰이지 않는데 매 턴 읽혔다. 그렇다고 조건부로 넣었다 뺐다 하면 더 나쁘다 —
 * 프리픽스가 바뀌는 턴마다 이 블록과 그 뒤 이력이 통째로 무효가 된다. 카드는 캐릭터북이
 * 골라 **이번 턴 층**에 싣고 다음 턴부터 이력의 일부가 된다 (people.md §6).
 * ⚠️ 선수의 이름도 id도 여기 두지 않는다 — 명단은 영입·매각·2군 승격·주장 변경마다
 * 바뀌고, 한 줄이 달라지면 이 블록과 그 뒤의 이력이 통째로 무효가 된다. 이름은 매 턴
 * 층(`buildGmStateNote`)의 「선수단」 줄이 싣는다.
 */
export function buildGmReference(state: GameState): string {
  return [describeClub(state), describeManager(state.manager)]
    .filter((block): block is string => block !== null)
    .join("\n\n");
}

/**
 * 요약 블록 — **레퍼런스 뒤·이력 앞**의 세 번째 시스템 블록 (agents.md §5·§5-1).
 *
 * 압축된 세이브에만 선다. 레퍼런스에 섞지 않는 이유는 자리에 있다: 여기 따로 세우면
 * 압축이 일어난 턴에만 그 뒤가 무효가 되고, 압축은 드물다.
 */
export function buildGmDigest(state: GameState): string | null {
  const digest = state.historyDigest;
  if (!digest) return null;
  // 무엇의 요약인지는 시스템 프롬프트의 「입력」이 말한다 — 블록은 날짜와 본문뿐이다
  return [`<summary at="${digest.at}">`, digest.text, `</summary>`].join("\n");
}

/** 유저의 자연어를 모델이 읽는 감독 화자 형식으로 감싼다. */
export function buildManagerMessage(state: GameState, message: string): string {
  return `@${state.manager.name}: ${message}`;
}

/**
 * 화면 조작 — 감독의 발화가 아니다. **모델의 출력 문법 밖 봉투로 싣는다**
 * (`<operator>시간 진행 — 하루</operator>`). `@:`는 GM이 내레이션을 쓰는 채널이라 거기 담으면
 * 감독의 화면 조작이 모델 자신의 문법으로 이력에 서고, 인물이 그 손잡이를 아는
 * 것으로 읽힌다 (docs/llm/prompts.md §1).
 */
export function buildOperatorMessage(message: string): string {
  return `<operator>${message}</operator>`;
}

/**
 * 경기 캐시 레퍼런스 — 경기 내내 변하지 않는 것만 담는다. 구단·감독은 평시와 같은
 * 두 블록이다.
 * ⚠️ 패킷은 매 구간 갱신되므로 여기 두면 캐시 프리픽스가 매 턴 깨진다 —
 * 휘발 채널(`buildLedgerNote`)로 내려간다.
 */
export function buildMatchReference(state: GameState): string {
  return [
    buildGmReference(state),
    // 벤치에서 감독 옆에 서 있는 사람이다 — 경기 중 조언도 같은 사람의 말투여야 한다.
    // 경기 내내 같은 한 사람이라 여기서는 캐릭터북을 거치지 않고 상주한다
    describeCharacters([characterEntry(headCoachOf(state), "full")]),
    buildMatchBrief(state),
  ]
    .filter((block): block is string => block !== null && block.length > 0)
    .join("\n\n");
}

/**
 * 평시 → 경기 다리 — 직전 평시 턴의 감독 발화를 **그대로** 싣는다
 * (중계는 평시 이력을 보지 않고, 요약은 말투·의도를 가장 먼저 지운다).
 */
export function buildMatchBrief(state: GameState): string {
  const said = state.chat
    .filter((t) => t.inMatch !== true && t.role === "user")
    .slice(-MATCH_BRIEF_TURNS)
    .map((t) => `- "${t.text}"`);
  if (said.length === 0) return "";
  return [`<pre_match>`, ...said, `</pre_match>`].join("\n");
}

const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];

/**
 * 경기 → 평시 다리 — 직전 경기의 결과·득점·최고 평점을 코어가 장부에서 뽑는다
 * (평시 GM은 중계 이력을 보지 않는다). 직전 한 경기만 — 그 이상은 get_league의 몫.
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
      const minute = played.result?.goalMinutes?.[i];
      return `${minute !== undefined ? `${minute}′ ` : ""}${nameOf(tag.split(":")[1] ?? tag)}`;
    })
    .join(", ");
  const best = Object.entries(played.result.ratings ?? {})
    .filter(([pid]) => state.players.find((p) => p.id === pid)?.teamId === state.userTeamId)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_RATED_SHOWN)
    .map(([pid, r]) => `${nameOf(pid)} ${r.toFixed(1)}`)
    .join(", ");
  return [
    `${played.date} ${ours ? "홈" : "원정"} vs ${opponent} ${us}-${them} ${verdict}`,
    scorers ? `- 득점: ${scorers}` : null,
    best ? `- 최고 평점: ${best}` : null,
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
  digest: string[];
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
const EXPIRING_SHOWN = 3;
const PROMISE_SHOWN = 3;
const RECENT_NARRATIVE = 4;

/**
 * 최근 사건 — 최신 4건이 아니라 **salience×recency 가중 상위 4건**이다 (people.md §9).
 * 고르는 눈금은 코어의 것(`topNarrative`)이고, 여기서는 줄로 옮기기만 한다.
 */
function recentNarrativeLines(state: GameState): string[] {
  return topNarrative(state, RECENT_NARRATIVE).map((n) => `${n.date} ${n.text}`);
}

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
function lines(...items: (string | null)[]): string {
  return items.filter((x): x is string => x !== null && x !== "").join("\n");
}

/**
 * 수석코치가 먼저 짚는 사실 — **이름이 태그의 속성으로 선다.** 안쪽 줄에 `이름:`을
 * 적으면 모델의 발화 문법(`@이름:`)과 한 글자 차이라, 코어가 낸 사실 줄이 코치가
 * 이미 한 말처럼 읽힌다 (prompts.md §5-1과 같은 이유로 회견·다가옴도 속성을 쓴다).
 */
function coachBlock(state: GameState, cues: readonly CoachCue[]): string | null {
  if (cues.length === 0) return null;
  return block(
    "coach",
    cues.map((c) => `- ${c.fact}`).join("\n"),
    ` name="${headCoachOf(state).name}"`,
  );
}

/**
 * 경기 전 상대 분석이 스냅샷에 서는 창 (일) — **전날과 당일뿐이다.**
 *
 * 감독이 라인업과 6축을 정하는 자리라 그날만 값이 있다. 사흘 전부터 매 턴 실으면
 * 캐시 밖 층을 상대 명단이 통째로 먹는다 (→ docs/llm/agents.md §6).
 */
const OPPONENT_BRIEF_DAYS = 1;

/**
 * 경기 전날·당일의 상대 분석 — **코어의 리포트를 그대로 옮긴다**
 * (→ docs/simulation/match.md §1.8). 지점의 수를 여기서 다시 자르지 않는다:
 * 몇 개가 보이는지는 감독의 **분석**이 이미 정한 값이고, 블록이 또 자르면
 * 손잡이가 둘이 된다.
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
      report.notes.length === 0
        ? "읽어 낸 지점: 없다"
        : lines(
            "읽어 낸 지점:",
            ...report.notes.map(
              (tag) =>
                `- [${tag.favours === report.ourSide ? "우리" : tag.favours === null ? "중립" : "상대"}] ` +
                packetTagText(tag, report.tagContext),
            ),
          ),
    ),
  );
}

/**
 * 회견·찾아온 사람 — **id가 태그의 속성으로 선다.** 답할 자리라 모델이 그 id를
 * 스킬 인자로 되돌려 주어야 하고, 여는 태그가 이름을 대므로 안쪽 첫 줄은 맥락부터
 * 시작한다 (prompts.md §5-1).
 */
function pressBlock(state: GameState): string | null {
  const open = pendingPress(state);
  return open ? block("press", describePendingPress(state), ` id="${open.id}"`) : null;
}

function approachBlock(state: GameState): string | null {
  const open = pendingApproach(state);
  return open ? block("approach", describePendingApproach(state), ` id="${open.id}"`) : null;
}

/** 시간이 흘렀다 — 손잡이로 넘긴 턴에만 붙는 덩어리. 재직·무직 스냅샷이 같이 쓴다 */
function timePassedLine(state: GameState, passed?: TimePassed | null): string | null {
  if (!passed || (passed.digest.length === 0 && passed.from === state.date)) return null;
  return lines(
    `${passed.from} → ${state.date} (${passed.stopped}) — 장면은 ${state.date}에서 연다.`,
    passed.digest.length > 0
      ? passed.digest.map((d) => `- ${d}`).join("\n")
      : `그 사이 특별한 일은 없었다.`,
  );
}

/**
 * **감독 자신의 계약 한 줄** — 연봉과 만료일, 그리고 보드가 만료 90일 전에 내린
 * 판정 (career.md §5.4).
 *
 * 재계약 제안은 10일 뒤 사라지는 답할 자리라 스냅샷에 서야 한다 — 화면에만 있으면
 * 모델은 감독이 무엇을 두고 답하는지 모른 채 장면을 쓴다.
 *
 * 잔여일은 만료일에서 나오는 파생값이라 싣지 않는다.
 */
function managerContractLine(state: GameState): string | null {
  const contract = state.manager.contract;
  if (!contract) return null;
  const base = `감독 계약: 연봉 ${formatMoney(contract.salary)} · ${contract.until}까지`;
  const renewal = openManagerOffers(state).find((o) => o.via === "renewal");
  if (renewal) {
    return (
      `${base}\n보드의 재계약 제안 (accept_manager_offer로 수락한다 — 감독이 받겠다고 할 때만.` +
      ` 수락 전 counter_manager_offer로 한 차례 조건을 되부를 수 있다):` +
      ` ${renewal.id} · 연봉 ${formatMoney(renewal.salary ?? 0)}·${renewal.years ?? "-"}년` +
      `·이적 예산 약속 ${formatMoney(renewal.budgetPledge ?? 0)}` +
      `${renewal.counteredOn ? " · 흥정은 끝났다 — 수락 여부만 남았다" : ""} · ${renewal.expiresOn}까지`
    );
  }
  if (contract.renewalOffered === false) {
    return `${base} · 보드는 재계약하지 않기로 했다 — 만료일에 자리를 잃는다`;
  }
  return base;
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
  const vacancies = state.managerVacancies ?? [];
  const recent = recentNarrativeLines(state);
  return [
    `<snapshot>`,
    block(
      "now",
      lines(
        `${state.date} (${DOW_KO[dayOfWeek(state.date)]}) ${formatClock(clockOf(state))} · 시즌 ${state.season} · ${describeWindowState(state)}`,
        // 팀의 도구가 막힌다는 말은 싣지 않는다 — 코어가 부르는 자리에서 막는다 (prompts.md §5-3)
        `감독 ${state.manager.name}은(는) 무직이다 — 맡은 팀이 없다.`,
        card
          ? `${card.kind === "expired" ? "계약 만료" : "경질"}: ${card.on} ${teamName(card.teamId)}${
              card.expectation && card.position
                ? ` — 기대 ${card.expectation}(${card.target}위)에 최종 ${card.position}위`
                : card.reason
                  ? ` — ${card.reason}`
                  : ""
            }`
          : null,
      ),
    ),
    block("manager", `평판: ${describeReputation(state.manager.reputation)}`),
    // 제안이 없는 것도 무직에겐 사실이다 — 기다리는 중인지 고를 자리가 있는지가 갈린다
    block(
      "job_offers",
      offers.length > 0
        ? offers
            .map(
              (o) =>
                `- ${o.id} · ${teamName(o.teamId)} (${o.tier}티어) · 기대 ${o.expectation}(${o.target}위)${
                  o.position ? ` · 현재 ${o.position}위` : ""
                }${o.salary ? ` · 연봉 ${formatMoney(o.salary)}·${o.years ?? "-"}년·이적 예산 약속 ${formatMoney(o.budgetPledge ?? 0)}` : ""}${
                  o.counteredOn ? " · 흥정은 끝났다 — 수락 여부만 남았다" : ""
                } · ${o.expiresOn}까지`,
            )
            .join("\n")
        : `받은 제안 없음.`,
    ),
    block(
      "vacancies",
      vacancies.length > 0
        ? lines(
            `경질 뒤 14일 안:`,
            ...vacancies.map(
              (v) =>
                `- ${teamName(v.teamId)}${v.position ? ` · 현재 ${v.position}위` : ""} · ${v.on} 공석`,
            ),
          )
        : null,
    ),
    block("time_passed", timePassedLine(state, passed)),
    block("recent", recent.length > 0 ? recent.map((r) => `- ${r}`).join("\n") : null),
    `</snapshot>`,
  ]
    .filter((x): x is string => x !== null)
    .join("\n");
}

/**
 * 우리 팀 은퇴 — **이번 오프시즌의 명부 줄**만이다 (season.md §6). 전환이 은퇴를 다음
 * 시즌 프리시즌 시작일로 남기므로 날짜가 그 하루와 같은 줄이 방금 끝난 시즌의 은퇴다.
 *
 * ⚠️ **원장(`TRANSFER`)이 아니라 명부(`state.retired`)를 읽는다.** 은퇴하면 선수는
 * `state.players`에서 빠져 원장 줄의 id로는 이름도 나이도 되찾지 못한다 — 명부가
 * 서기 전에는 이 블록이 아무 줄도 내지 못했다.
 */
function retirementFacts(state: GameState): string[] {
  return (state.retired ?? [])
    .filter((r) => r.teamId === state.userTeamId && r.on === state.calendar.preseasonStart)
    .map((r) => {
      // 우리 팀에서의 기록 — 통산 접기는 한 곳이다(`careerTotalsOf`). 여기서 다시
      // 합하면 화면·선수 카드가 내는 수와 은퇴 줄의 수가 언젠가 갈린다
      const ours = careerTotalsOf(state, r.gamePlayerId, state.userTeamId);
      return `은퇴: ${r.name} ${ageOf(r.birthdate, r.on)}세 · 우리 팀에서 ${ours.apps}경기 ${ours.goals}골`;
    });
}

/**
 * 방금 끝난 시즌의 시상 중 **우리 리그**의 것 — 우리 선수든 남의 선수든 함께
 * 싣고, 어느 쪽인가는 팀 이름이 말한다.
 *
 * 줄은 코어가 이미 갖고 있는 것을 쓴다(`awardLine` — 시즌 리뷰의 다이제스트가 쓰는
 * 그 줄이다). 여기서 다시 쓰면 같은 상이 다이제스트와 스냅샷에 다른 문장으로 선다.
 */
function awardFacts(state: GameState): string[] {
  const ourLeague = leagueOfTeamIn(state, state.userTeamId);
  return (state.awards ?? [])
    .filter((a) => a.season === state.season - 1 && a.leagueId === ourLeague)
    .map((a) => awardLine(a));
}

/**
 * 오프시즌 사실 블록 — **선수단 소집 전에만** 선다 (season.md §6 오프시즌).
 * 소집일이 지나면 사라진다: 오프시즌의 자리는 오프시즌에 있다.
 *
 * 전환은 `season++` 뒤 다음 시즌 7월 1일로 건너뛰므로, 여기 서는 시상은 지금
 * 시즌이 아니라 **방금 끝난 시즌**(`state.season - 1`)의 것이다.
 *
 * ⚠️ 물음표도 평가어도 없는 장부 줄이다 — 회견의 `PressFact`와 같은 결이다
 * (people.md §4). 코어는 사실만 낸다: 은퇴식을 어떻게 열지, 상을 누가 어떤 말로
 * 전할지는 GM의 몫이다. 사실이 하나도 없으면 블록을 세우지 않는다.
 */
function offseasonFacts(state: GameState): string | null {
  if (!onSummerBreak(state.calendar, state.date)) return null;
  const facts = [...retirementFacts(state), ...awardFacts(state)];
  if (facts.length === 0) return null;
  return `지난 시즌이 닫히며 남은 것 — 자리를 어떻게 열지, 누가 무슨 말을 하는지는 네가 정한다:\n${facts
    .map((f) => `- ${f}`)
    .join("\n")}`;
}

export function buildGmStateNote(
  state: GameState,
  passed?: TimePassed | null,
  /** 이번 턴에 카드로 서는 보고서 — 카드가 프롬프트에 못 가므로 값은 여기로 온다 */
  arrivedReports: readonly ScoutReportCard[] = [],
  /**
   * 장면보다 먼저 교섭 상대가 낸 답 (agents.md §4-1) — GM은 판정하지 않고 **전한다**.
   * 판정이 이미 끝났으므로 아래 `pendingVerdicts`에는 그 협상이 서지 않는다.
   */
  counterpartyReplies: readonly string[] = [],
): string {
  // 무직이면 실을 것이 다른 것들이다 (career.md §5.1)
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
  const suspended = players.filter((p) => isSuspended(state, p.id)).map((p) => p.name);
  const unhappy = state.issues.map((i) => playerName(state, i.gamePlayerId));

  const training = state.schedule
    .filter((e) => e.type === "training" && e.status === "scheduled" && e.date >= state.date)
    .slice(0, TRAINING_SHOWN)
    .map((e) => {
      const s = state.trainingSessions.find((x) => x.id === e.refId);
      return `${e.date.slice(5)} ${slotOfTime(e.time) === "am" ? "오전" : "오후"} ${s?.label ?? "훈련"}`;
    });
  const trainingCount = state.schedule.filter(
    (e) => e.type === "training" && e.status === "scheduled" && e.date >= state.date,
  ).length;

  const alerts = [
    // 상대가 방금 낸 답이 맨 앞 — 이 줄이 없으면 GM은 협상이 움직인 줄 모른다
    ...counterpartyReplies.map((line) => `📨 ${line}`),
    // 판정 대기 협상이 그다음 — 답은 다음 턴 입력에 실리므로 여기서 세우지 않으면 잊힌다
    ...pendingVerdicts(state).map((v) => `❗ ${v.label} (${v.negotiation.id})`),
    injured.length > 0 ? `부상 ${injured.length} (${injured.join(", ")})` : null,
    suspended.length > 0 ? `정지 ${suspended.length} (${suspended.join(", ")})` : null,
    unhappy.length > 0 ? `불만 ${unhappy.length} (${unhappy.join(", ")})` : null,
    ...scoutingSummary(state),
    // 만료 임박 계약 — 재계약 서사의 씨앗. 놓치면 자유계약으로 떠난다
    (() => {
      const expiring = expiringContracts(state, EXPIRING_ALERT_DAYS);
      return expiring.length > 0
        ? `계약 만료 임박 ${expiring.length} (${expiring
            .slice(0, EXPIRING_SHOWN)
            .map((row) => `${row.player.name}~${row.contract.until}`)
            .join(", ")}${expiring.length > EXPIRING_SHOWN ? " …" : ""})`
        : null;
    })(),
    /**
     * 기한이 다가온 약속 — **감독이 아직 지킬 수 있는 동안만** 선다 (people.md §5-2).
     * 판정은 기한 하루뿐이라, 이 줄이 없으면 감독이 자기가 한 말을 잊은 채 그날을
     * 지나치고 사기 −8과 불만 하나를 받는다.
     */
    (() => {
      const due = openPromises(state)
        .filter((p) => diffDays(state.date, p.dueOn) <= PROMISE_ALERT_DAYS)
        .sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0));
      return due.length > 0
        ? `약속 기한 임박 ${due.length} (${due
            .slice(0, PROMISE_SHOWN)
            .map(
              (p) => `${playerName(state, p.gamePlayerId)} ${PROMISE_KIND_KO[p.kind]}~${p.dueOn}`,
            )
            .join(", ")}${due.length > PROMISE_SHOWN ? " …" : ""})`
        : null;
    })(),
  ].filter((x): x is string => x !== null);

  const cues = speakerCues(state);
  const coach = coachCues(state);
  const offseason = offseasonFacts(state);
  const negotiations = describeNegotiations(state);
  const recent = recentNarrativeLines(state);
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
        `재정: 잔고 ${formatMoney(finance.balance)} · 주급 ${formatMoney(weeklyWagesOf(state, state.userTeamId))}/주 · 이적예산 ${formatMoney(finance.transferBudget)}`,
        /**
         * 선수단 — **이름 명단이다. 이름뿐이다.** "누가 우리 팀인가"는 매 장면의 전제라
         * 입력에 없으면 GM이 없는 선수를 세우고, 명단은 영입·승격마다 바뀌어 캐시 층에
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
            players
              .filter((p) => squadLevelOf(p) === level)
              .map(
                (p) =>
                  `${p.name}${p.isCaptain ? "(주장)" : p.isViceCaptain === true ? "(부주장)" : ""}`,
              );
          const first = named("first");
          const reserve = named("reserve");
          /**
           * 임대 보낸 선수는 **합계에 들지 않고 따로 선다.** 1군 + 2군이 곧 오늘
           * 부릴 수 있는 인원이라, 합계에 넣으면 GM이 남의 경기장에 있는 사람을
           * 오늘의 선택지로 센다. 계약은 우리 것이므로 명단에서 지우지도 않는다
           * (transfer.md §2 · season.md §2 임대).
           *
           * ⚠️ 여기도 **이름뿐이다** — 어느 구단에 가 있는지도, 그 구단에서의
           * 기록도 싣지 않는다. 그건 코치 카드와 조회의 몫이다.
           */
          const loaned = loanedOut(state).map((p) => p.name);
          return lines(
            `선수단 ${players.length}명`,
            first.length > 0 ? `- 1군 ${first.length}: ${first.join(" · ")}` : null,
            reserve.length > 0 ? `- 2군 ${reserve.length}: ${reserve.join(" · ")}` : null,
            loaned.length > 0 ? `- 임대 ${loaned.length}: ${loaned.join(" · ")}` : null,
          );
        })(),
      ),
    ),
    block(
      "manager",
      lines(
        // 감독의 능력·평판은 캐시 밖이다 — 평판은 경기마다 움직이고 능력도 자란다.
        // 레퍼런스(감독 프로필)엔 이름·배경만 남는다
        `${state.manager.name}: ${describeManagerSkills(state.manager.attributes)}`,
        `평판: ${describeReputation(state.manager.reputation)}`,
        /**
         * 보드가 이번 시즌 이 구단에 건 기대 (career.md §5). 시즌에 한 번 바뀌는 값이지만
         * 캐시 층에 두면 롤오버 한 번에 레퍼런스와 그 뒤 이력이 통째로 무효가 된다.
         *
         * 경고 수(`boardWarnings`)는 따라오지 않는다 — 압박을 세는 눈금은 `get_career`의
         * 몫이고, 여기 필요한 것은 그 눈금이 무엇을 재는지다.
         */
        (() => {
          const be = boardExpectation(state, state.userTeamId);
          return boardExpectationLine(be.code, be.target);
        })(),
        // 감독 자신의 계약 — 재계약 제안은 **답할 자리**라 스냅샷에 서야 한다 (career.md §5.4)
        managerContractLine(state),
      ),
    ),
    // 한 줄에 하나 — 이어 붙이면 일곱 항목이 가운뎃점 사이에 묻힌다
    block("alerts", alerts.join("\n")),
    // 선수 근황 — 선수단 중 **사실이 붙는** 셋이다.
    // 코어는 사실만 낸다(speakerCues) — 누가 말할지, 무슨 말을 할지는 GM의 몫
    block("cues", cues.map((c) => `- ${c.name} ${c.fact}`).join("\n")),
    /**
     * 수석코치가 먼저 짚는 사실 — **원형이 고른다** (people.md §7-1). 근황과 같은
     * 결이되 고르는 눈이 다르다: 분석가는 상대의 표를, 조련사는 다리를 먼저 본다.
     * 여기도 사실뿐이고(`coachCues`) 그 사실로 무슨 말을 할지는 GM이 쓴다.
     * 무직이면 코어가 빈손을 내므로 이 덩어리는 서지 않는다.
     */
    coachBlock(state, coach),
    /**
     * 경기 전날·당일의 상대 분석 — 감독이 라인업과 6축을 정하는 자리다.
     * 조회 도구·다음 경기 카드와 **같은 리포트**를 읽는다 (match.md §1.8).
     */
    opponentBlock(state),
    block("last_match", matchDigest(state)),
    // 오프시즌 — 은퇴와 시상. 소집 전에만 서고, 없으면 한 줄도 쓰지 않는다
    block("offseason", offseason),
    // 그 사이 벌어진 일 — 손잡이로 시간을 넘긴 턴에만. 없으면 모델이 넘긴 구간의
    // 일(부상·오퍼)을 모른 채 장면을 쓴다
    block("time_passed", timePassedLine(state, passed)),
    /**
     * 도착한 스카우트 보고서 — **이번 턴에 화면 카드로 서는 그것들이다.**
     *
     * 카드는 모델이 장면을 쓴 뒤에 붙어 프롬프트에 가지 않는다. 그래서 값이 여기
     * 없으면 모델은 카드 옆에서 금액을 지어내고, 한 화면이 두 말을 한다
     * (agents.md §6). 줄은 카드와 같은 함수에서 나온다 — `scoutReportLine`.
     */
    block(
      "scout_reports",
      arrivedReports.map((c) => `- ${scoutReportLine(state, c.playerId) ?? c.name}`).join("\n"),
    ),
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
    // 답을 기다리는 기자회견 — 이 덩어리가 없으면 모델은 회견이 열린 사실 자체를 모른다
    pressBlock(state),
    // 감독을 찾아온 사람 — 세계가 먼저 연 자리다 (people.md §8). 회견과 함께 서지 않는다
    approachBlock(state),
    /**
     * 감독이 보드에 건 요청 — 답을 기다리는 것·공사 중인 구장·열려 있는 주급 상향
     * (finance.md §9.6). 답이 도착한 날은 `<time_passed>`가 나른다.
     */
    block("board", describeBoardRequests(state)),
    // 협상은 있을 때만 — 매 턴 정가로 읽히는 블록이다
    block("negotiations", negotiations.startsWith("진행 중인 협상 없음") ? null : negotiations),
    // 쓸 수 있는 되사기 권리 — 이 덩어리가 없으면 모델은 그 자리가 있는 줄도 모른다
    block("buybacks", describeBuyBackRights(state)),
    // 활성 서사 아크 — 닫힐 때까지 매 턴 실려 GM이 시즌을 가로지르는 흐름을 잃지 않는다
    // (people.md §9). 개폐도 사실 줄도 코어의 것이다
    block("arcs", describeActiveArcs(state)),
    block("recent", recent.map((r) => `- ${r}`).join("\n")),
    `</snapshot>`,
  ]
    .filter((x): x is string => x !== null)
    .join("\n");
}

/**
 * 경기 장부 + 현재 판세 — 매 턴 갱신되는 휘발성 블록. 패킷도 여기(캐시 밖)에
 * 담되 JSON을 통째로 붓지 않고 읽는 쪽이 실제로 쓰는 것만 요약한다.
 *
 * 읽는 쪽이 둘이라 `withPacket`이 세 갈래다.
 * - `true` — 중계가 판을 읽는 턴. 판세와 공략 표적을 함께 싣는다.
 * - `false` — 킥오프·대화만 건 턴. 아직 아무 일도 일어나지 않았는데 판세를 쥐여 주면
 *   첫 마디부터 우열을 읊는다. 그때 필요한 것은 대진과 선발뿐이다.
 * - 생략 — 지시 해석기. 감독의 말을 갈래로 나누는 데 기대 득점·상성·소화율은 쓰이지
 *   않는다. 명단·6축·공략 표적만 읽는다 (`exploits`는 그 표적의 id로만 채워진다).
 */
export function buildLedgerNote(state: GameState, options: { withPacket?: boolean } = {}): string {
  const pending = state.pendingMatch;
  const ledger = pending?.ledger;
  if (!ledger || !pending) return "";
  const packet =
    options.withPacket === true && pending.packet ? normalizePacket(pending.packet) : null;
  /** 태그가 이름을 대는 자리 — 표적 목록은 패킷이 없는 턴에도 선다 */
  const tagCtx = pending.packet ? packetTagContext(normalizePacket(pending.packet)) : undefined;
  /** 표적 목록은 판세와 갈린다 — 해석기는 수치 없이 이 목록만 읽는다 */
  const targets =
    options.withPacket === false
      ? []
      : pending.packet
        ? normalizePacket(pending.packet).targets
        : [];
  // 온필드 명단에 개인 전력(패킷의 effective)을 붙인다 — 존 평균만으론 "누가 안 도는가"가 안 보인다
  const effective = new Map(
    [...(packet?.home.lineup ?? []), ...(packet?.away.lineup ?? [])].map((p) => [p.id, p] as const),
  );
  /** 킥오프 턴엔 자리만 — 전력 수치는 패킷과 함께 다음 턴에 온다 */
  const position = new Map(
    [...(pending.packet?.home.lineup ?? []), ...(pending.packet?.away.lineup ?? [])].map(
      (p) => [p.id, p.position] as const,
    ),
  );
  const withNames = (ids: readonly string[] | undefined): string =>
    (ids ?? [])
      .map((id) => {
        const p = effective.get(id);
        if (p) return `${id}(${playerName(state, id)} ${p.position} ${p.effective})`;
        const at = position.get(id);
        return at ? `${id}(${playerName(state, id)} ${at})` : `${id}(${playerName(state, id)})`;
      })
      .join(", ");
  const packetLines = packet
    ? [
        ``,
        `<packet>`,
        // 판세를 읽는 것은 모델의 일이다 — 코어는 이름·수치·상성 근거만 싣는다
        `${packet.home.teamName}(홈) vs ${packet.away.teamName} — 기대 득점 ${packet.guide.expectedGoals.home} : ${packet.guide.expectedGoals.away}`,
        packet.matchups.map((m) => matchupText(m)).join(" / "),
        ...packet.keyPoints.map((k) => `· ${packetTagText(k, tagCtx)}`),
        `홈 전술 소화: ${Math.round(packet.home.tactical.uptake * 100)}%${
          packet.home.tactical.notes.length > 0
            ? ` — ${packet.home.tactical.notes.map((n) => packetTagText(n, tagCtx)).join(" / ")}`
            : ""
        }`,
        `어웨이 전술 소화: ${Math.round(packet.away.tactical.uptake * 100)}%${
          packet.away.tactical.notes.length > 0
            ? ` — ${packet.away.tactical.notes.map((n) => packetTagText(n, tagCtx)).join(" / ")}`
            : ""
        }`,
        `</packet>`,
      ]
    : [];
  // 공략 후보 — 노릴 수 있는 지점은 이 목록이 전부다 (없는 지점은 코어가 반려)
  const targetLines =
    targets.length > 0
      ? [
          // max — 동시에 노릴 수 있는 수. 읽는 법은 중계·해석 프롬프트의 「입력」이 갖는다
          `<targets max="${MAX_EXPLOITS}">`,
          ...targets.map((t) => `  ${t.id} — ${packetTagText(t.tag, tagCtx)}`),
          pending.exploits && pending.exploits.length > 0
            ? `지금 노리는 중: ${pending.exploits.join(", ")}`
            : `지금 노리는 곳 없음`,
          `</targets>`,
        ]
      : [];
  /**
   * **지금 내가 무엇을 걸어 뒀는가** — 경기 중에는 평시 스냅샷(6축이 적힌 줄)이
   * 실리지 않아 여기가 유일한 자리다. 없으면 "압박 올려"에 지금 값이 지어내진다.
   */
  const ourTactics = tacticsOf(state, state.userTeamId).spec;
  const assignments = tacticsOf(state, state.userTeamId).assignments.filter(
    (a) => a.role === "starting" && (a.directive || a.instruction || a.roleId),
  );
  const standingLines = [
    ``,
    `<standing>`,
    `전술 ${ourTactics.formation} · 멘탈${ourTactics.mentality} 라인${ourTactics.defensiveLine} ` +
      `압박${ourTactics.pressing} 템포${ourTactics.tempo} 폭${ourTactics.width} 패스${ourTactics.passStyle}`,
    pending.regionalPlans && pending.regionalPlans.length > 0
      ? `지역 전술: ${pending.regionalPlans
          .map((r) => `${r.band}/${r.lane} ${r.intent} "${r.note}"`)
          .join(" · ")} (동시에 2곳까지 — 셋째를 걸면 가장 오래된 것이 밀린다)`
      : `지역 전술: 없음`,
    assignments.length > 0
      ? `개인 지시·역할: ${assignments
          .map(
            (a) =>
              `${playerName(state, a.playerId)}(${a.position}` +
              `${a.roleId ? ` ${a.roleId}` : ""}` +
              `${a.directive ? ` [${a.directive.kind}]` : ""}` +
              `${a.instruction && !a.directive ? ` "말로만: ${a.instruction}"` : ""})`,
          )
          .join(", ")}`
      : `개인 지시·역할: 없음`,
    `</standing>`,
  ];
  // 사건은 싣지 않는다 — 코어가 이미 굴린 구간은 <segment>로 따로
  // 실린다. 이 블록은 그 구간이 끝난 자리의 장부다 (agents.md §3)
  /**
   * 교체 한도는 **국면이 정한다** — 연장은 6인/4회다 (match.md §5). 5/3으로 박아
   * 두면 연장에 들어간 모델이 아직 남은 카드를 없는 것으로 읽는다. 장부 검증과
   * AI 판단이 보는 것과 같은 함수다.
   */
  const subLimits = subLimitsOf(ledger.phase);
  return [
    `<ledger>`,
    `스코어 ${ledger.score.home}:${ledger.score.away} · ${ledger.minute}′ · ${ledger.phase}`,
    `홈 온필드: ${withNames(ledger.home.onPitch)}`,
    `홈 벤치: ${withNames(ledger.home.bench)} (교체 ${ledger.home.subsUsed}/${subLimits.maxSubs}, 기회 ${ledger.home.subWindows}/${subLimits.maxSubWindows})`,
    `어웨이 온필드: ${withNames(ledger.away.onPitch)}`,
    `어웨이 벤치: ${withNames(ledger.away.bench)} (교체 ${ledger.away.subsUsed}/${subLimits.maxSubs}, 기회 ${ledger.away.subWindows}/${subLimits.maxSubWindows})`,
    ledger.sentOff.length > 0 ? `퇴장: ${withNames(ledger.sentOff)}` : "",
    `</ledger>`,
    ...standingLines,
    ...packetLines,
    ...targetLines,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 장면 헤더 — 모델이 첫 줄에 적는 시점. 시계를 움직이는 유일한 입구다.
 * 일상 `[2026-07-13 오후]` · 경기 `[67']`. 형식이 어긋나면 시간이 멈춘다(로그로 드러낸다).
 * ⚠️ 날짜만 필수 — 시:분을 필수로 좁히면 `[2026-07-20 월요일 오전]`을 못 잡아
 * 시계가 며칠씩 멈춘다.
 */
const SCENE_HEADER_RE = new RegExp(
  [
    /^\[\s*(\d{4}-\d{2}-\d{2})/, // 날짜 — 이것만 필수
    /(?:\s*[,·]?\s*\(?\s*[월화수목금토일](?:요일)?\s*\)?)?/, // 요일 (수) · 월요일
    /(?:\s*[,·]?\s*(AM|PM|오전|오후|아침|점심|저녁|밤|새벽))?/, // 시간대
    /(?:\s*(\d{1,2}):(\d{2}))?/, // 시각
    /\s*\]/,
  ]
    .map((r) => r.source)
    .join(""),
  "i",
);
const MATCH_HEADER_RE = /^\[\s*(\d{1,3})\s*['′분]?\s*\]/;

/** 시간대만 적힌 헤더의 기본 시각 — 하루 안에서 되감기지 않을 만큼만 민다 */
const PART_OF_DAY: Record<string, string> = {
  새벽: "06:00",
  아침: "08:00",
  오전: "09:00",
  am: "09:00",
  점심: "12:30",
  오후: "14:00",
  pm: "14:00",
  저녁: "19:00",
  밤: "21:00",
};

/**
 * `AM 9:30` · `PM 7:05` · `14:30` → "HH:MM" (24시간). 읽을 수 없으면 null.
 *
 * ⚠️ **시간대가 붙었는지가 12시간제인지를 가른다.** 시간대 없는 `14:30`까지 12로
 * 접으면 `02:30`이 되어 시각이 오전으로 뒤집히고, 코어가 되감기를 막으므로 그 턴의
 * 시계가 통째로 멎는다. 그래서 시간대가 없으면 적힌 값이 곧 24시간 값이다 —
 * `오전 12:05`는 자정 00:05, 시간대 없는 `12:05`는 정오 12:05.
 */
function toClock(meridiem: string | undefined, hour: string, minute: string): string | null {
  const h = Number(hour);
  if (h > 23 || Number(minute) > 59) return null;
  const h24 = meridiem ? (h % 12) + (/^(PM|오후|저녁|밤)$/i.test(meridiem) ? 12 : 0) : h;
  return `${String(h24).padStart(2, "0")}:${minute}`;
}

/** 헤더가 가리키는 시각 — 시:분이 있으면 그것, 없으면(또는 읽을 수 없으면) 시간대의 기본값 */
function clockFromHeader(meridiem: string | undefined, hour?: string, minute?: string): string {
  const clock = hour && minute ? toClock(meridiem, hour, minute) : null;
  return clock ?? PART_OF_DAY[(meridiem ?? "").toLowerCase()] ?? "09:00";
}

/** 위생이 지금까지 본 것 — 직전에 살린 헤더는 무엇이었나, 장면이 열렸나 */
interface SceneScan {
  /** 마지막으로 살아남은 시점 헤더의 값 — 아직 하나도 없으면 null */
  lastHeader: string | null;
  /** 첫 `@` 줄이 지나갔다 — 그 뒤의 태그 없는 줄은 이어쓰기다 */
  sceneOpen: boolean;
}

/** 헤더 값 비교용 — 안쪽 공백의 차이는 같은 시각이다 */
function headerKey(line: string): string {
  return line.trim().replace(/\s+/gu, " ");
}

/**
 * 장면에 설 수 있는 줄인가 — 시점 헤더(**직전 것과 값이 다른 것**), `@`로 시작하는
 * 화자·내레이션, 빈 줄(문단 간격), 그리고 **장면이 선 뒤의 이어쓰기 줄**(prompts.md §1).
 *
 * ⚠️ 이어쓰기가 되는 것은 첫 `@` 줄 **뒤**부터다 — 그 앞의 태그 없는 줄은 도구
 * 앞에 흘린 작업 로그라, 살리면 "…확인하겠습니다"가 코치의 대사로 붙는다.
 * 헤더 꼴(`[`)은 이어쓰기보다 헤더 규칙이 앞선다.
 *
 * ⚠️ **뒤 헤더를 일괄로 걷지 않는다.** 도구 반복이 다시 찍는 헤더는 값이 같고, 한 턴
 * 안에서 오전 훈련 뒤 오후 면담을 여는 헤더는 값이 다르다 — 값 비교만이 소음과 전환을
 * 가른다. 일괄로 걷으면 그 전환이 화면에서 통째로 사라진다.
 */
function keepsSceneLine(line: string, scan: SceneScan): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith("@")) return true;
  if (trimmed.startsWith("[")) return headerKey(trimmed) !== scan.lastHeader;
  return scan.sceneOpen;
}

/** 판정을 마친 줄이 다음 판정에 남기는 것 */
function afterSceneLine(line: string, scan: SceneScan): void {
  const trimmed = line.trim();
  if (trimmed.startsWith("[")) scan.lastHeader = headerKey(trimmed);
  if (trimmed.startsWith("@")) scan.sceneOpen = true;
}

/**
 * 장면 위생 — **도구 앞에 흘린 작업 서술과 값이 같은 반복 헤더를 걷어낸다.**
 *
 * 도구를 부르는 턴에서 모델은 반복마다 "…확인하겠습니다" 한 줄과 헤더를 새로
 * 찍는다(프롬프트로 몇 번을 눌러도 남는 습성이다). 그 줄들은 장면이 아니라
 * 작업 로그인데 화면에는 코치의 말과 나란히 선다. 걷는 것은 **장면이 서기 전**의
 * 태그 없는 줄까지다 — 그 뒤의 것은 이어쓰기라 살린다.
 *
 * **시각이 달라진 헤더는 남는다** — 그것은 소음이 아니라 장면 전환이고, 화면이
 * 그 자리에서 시각 표시로 세운다(`cutStamps`).
 *
 * ⚠️ **@ 줄이 하나도 없으면 손대지 않는다** — 규약을 통째로 어긴 응답까지
 * 지우면 빈 턴이 되어 무슨 일이 있었는지조차 사라진다.
 */
export function sanitizeSceneText(text: string): string {
  const lines = text.split("\n");
  if (!lines.some((line) => line.trim().startsWith("@"))) return text;
  const scan: SceneScan = { lastHeader: null, sceneOpen: false };
  const kept: string[] = [];
  for (const line of lines) {
    if (!keepsSceneLine(line, scan)) continue;
    afterSceneLine(line, scan);
    kept.push(line);
  }
  // 걷어낸 자리에 남은 빈 줄이 겹치지 않게 (문단 간격은 하나면 족하다)
  return kept
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * 스트리밍에도 같은 위생을 건다 — 걸러진 줄이 화면에 잠깐 떴다 사라지면
 * 그것대로 눈에 띈다. 줄의 **첫 글자**와 여기까지 지나온 것(`SceneScan`)만 보면
 * 판정되므로, 지연되는 것은 줄 앞머리뿐이고 그다음 델타는 그대로 흘러간다.
 *
 * ⚠️ **헤더만은 값을 봐야 판정된다** — 같은 시각이면 소음, 달라졌으면 전환이다.
 * 그래서 `[`로 여는 줄은 닫는 대괄호(또는 줄 끝)까지 기다린다. 32자 안의 줄이라
 * 지연은 눈에 띄지 않고, 화면도 닫히지 않은 `[` 줄은 어차피 한 프레임 미룬다.
 */
export function filterSceneStream(emit: (delta: string) => void): (delta: string) => void {
  let pending = ""; // 아직 판정하지 못한 줄 앞머리 (공백뿐이거나 헤더가 안 닫힌 상태)
  let keeping: boolean | null = null; // 이 줄을 내보내는가 — null이면 판정 전
  const scan: SceneScan = { lastHeader: null, sceneOpen: false };

  const startLine = () => {
    pending = "";
    keeping = null;
  };
  /** 미뤄 둔 줄을 지금 있는 것만으로 판정한다 — 헤더가 닫혔거나 줄이 끝났을 때 */
  const decide = () => {
    if (keeping !== null || pending.trim().length === 0) return;
    keeping = keepsSceneLine(pending, scan);
    afterSceneLine(pending, scan);
    if (keeping) emit(pending);
    pending = "";
  };
  const feedLine = (chunk: string) => {
    if (keeping === false) return;
    if (keeping === true) {
      emit(chunk);
      return;
    }
    pending += chunk;
    // 헤더는 값이 다 와야 소음인지 전환인지 갈린다 — 닫는 대괄호까지 보류
    if (pending.trim().startsWith("[") && !pending.includes("]")) return;
    decide();
  };

  return (delta: string) => {
    const parts = delta.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) {
        // 닫히지 않은 채 줄이 끝난 헤더도 여기서 판정된다
        decide();
        // 줄바꿈은 살아남은 줄에만 붙인다 — 걸러진 줄은 자리도 남기지 않는다
        if (keeping !== false) emit("\n");
        startLine();
      }
      if (part.length > 0) feedLine(part);
    });
  };
}

export interface ParsedScene {
  /** 헤더를 걷어낸 본문 */
  body: string;
  /**
   * 읽어낸 원문 헤더 줄 — 없으면 null. ⚠️ 저장할 때 본문에 되붙여야 한다 —
   * 떼면 화면(scene-stamp)의 시각이 스트리밍이 끝나는 순간 사라진다.
   */
  header: string | null;
  point: ScenePoint | null;
  /** 경기 헤더의 목표 분 */
  minute: number | null;
}

/** 한 줄이 가리키는 시점 — 평시의 시점 헤더가 아니면 null (경기 분 헤더도 아니다) */
function scenePointOf(line: string): ScenePoint | null {
  const scene = SCENE_HEADER_RE.exec(line.trim());
  if (!scene) return null;
  // 시각을 빼먹었으면 시간대의 기본 시각, 그것도 없으면 그 날의 시작
  return { date: scene[1] ?? "", clock: clockFromHeader(scene[2], scene[3], scene[4]) };
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

/** 첫 줄의 헤더를 떼어 시점을 읽는다. 헤더가 없으면 시간은 흐르지 않는다. */
export function parseSceneHeader(text: string): ParsedScene {
  const lines = text.split("\n");
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstIndex < 0) return { body: text, header: null, point: null, minute: null };
  const first = (lines[firstIndex] ?? "").trim();

  const point = scenePointOf(first);
  if (point) {
    const rest = [...lines.slice(0, firstIndex), ...lines.slice(firstIndex + 1)];
    return { body: rest.join("\n").trim(), header: first, point, minute: null };
  }
  const match = MATCH_HEADER_RE.exec(first);
  if (match) {
    const rest = [...lines.slice(0, firstIndex), ...lines.slice(firstIndex + 1)];
    return { body: rest.join("\n").trim(), header: first, point: null, minute: Number(match[1]) };
  }
  return { body: text, header: null, point: null, minute: null };
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
  minute: number,
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
      emit(`${matchHeader(minute)}\n`);
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
 * 평시와 경기의 이력을 가른다 — 섞이면 토큰만이 아니라 맥락이 오염된다
 * (경기 중 이력의 이적 이야기를 중계가 끌어온다). 두 국면은
 * buildMatchBrief·matchDigest가 잇는다.
 */
function relevantTurns(state: GameState): typeof state.chat {
  const inMatch = inMatchNow(state);
  const here = state.pendingMatch?.matchId;
  return state.chat.filter((t) =>
    inMatch
      ? // 경기 중 — 이 경기의 턴만. 다른 경기의 중계도 남의 이야기다
        t.inMatch === true && (here === undefined || t.matchId === undefined || t.matchId === here)
      : t.inMatch !== true,
  );
}

/**
 * 이력이 끝나는 자리 — 뒤에서부터 **모델 턴이 나올 때까지가 이번 턴의 입력**이다.
 *
 * 한 턴은 채팅에 하나가 아니라 여럿을 남긴다(전술판 조작이 오퍼레이터 턴으로 먼저
 * 서고 감독 발화가 그 뒤에 선다). 저장이 성공한 채팅은 언제나 모델 턴으로 끝나므로
 * (실패한 턴은 저장되지 않는다) 꼬리의 비-모델 턴이 곧 이번 턴에 밀어 넣은 입력이고,
 * 그것들은 이번 호출의 발화 블록이 이미 싣는다.
 *
 * ⚠️ 한 줄만 빼면 두 자리에서 틀린다 — 조작이 이력과 발화 블록에 두 번 실리고,
 * 킥오프처럼 이번 턴 발화가 경기 이력으로 갈린 턴에서는 뺄 줄이 이 목록에 애초에
 * 없어 직전 평시 발화가 대신 잘려 나간다.
 */
function historyEnd(chat: GameState["chat"]): number {
  for (let i = chat.length - 1; i >= 0; i -= 1) if (chat[i]?.role === "model") return i + 1;
  return 0;
}

/**
 * 이력 창 **안에** 서 있는 카드 — 캐릭터북이 「이미 실렸다」를 판단하는 근거다.
 *
 * 창 밖으로 밀려난 기록은 여기 오지 않으므로 그 인물은 그 순간 다시 주입 대상이
 * 된다 — 만료 규칙을 따로 두지 않는 이유다 (people.md §6).
 */
export function injectedCharacters(state: GameState): CharacterInjection[] {
  return windowOf(state).turns.flatMap((turn) => turn.characters ?? []);
}

/**
 * 이번 턴의 주입을 **입력으로 밀어 넣은 그 턴에** 기록한다.
 *
 * 카드는 감독 발화와 같은 층에 실리므로 이력에서도 그 자리에 다시 서야 한다.
 * 모델 턴에 붙이면 카드가 답변 뒤로 가 순서가 뒤집힌다. ⚠️ 기록만 남긴다 —
 * 카드 텍스트를 저장하면 채팅 화면에 프롬프트가 새고 이력이 그때의 문장으로 굳는다.
 *
 * 기억 줄 수도 함께 적는다 — 기억은 이 턴 층에만 서므로(§6), 그 뒤에 늘어난 것을
 * 재주입으로 나르려면 캐릭터북이 **그때 실린 수**를 알아야 한다.
 */
export function recordCharacterInjection(
  state: GameState,
  entries: readonly CharacterEntry[],
): void {
  if (entries.length === 0) return;
  const turn = state.chat[state.chat.length - 1];
  // 이번 턴에 밀어 넣은 입력이 꼬리다 (`historyEnd`) — 모델 턴이면 저장이 끝난
  // 이력이라 붙일 자리가 아니다
  if (!turn || turn.role === "model") return;
  turn.characters = entries.map((e) => ({
    characterId: e.characterId,
    depth: e.depth,
    memories: e.memories?.length ?? 0,
  }));
}

/**
 * 이력 창 — 어디서부터 어디까지가 이번 호출의 이력인가. **평시의 시작점은 코어가
 * 정한다** (`historyStart` → agents.md §5-1: 글자 상한 안에 드는 가장 앞의 6턴 경계).
 * 코어가 고르는 평시 턴(`peaceTurns`)과 `relevantTurns`의 평시 갈래가 같은 필터
 * (`inMatch !== true`)라 접힌 지점의 인덱스가 이 목록에 그대로 맞는다.
 */
function windowOf(state: GameState): { turns: GameState["chat"] } {
  const chat = relevantTurns(state);
  const upto = historyEnd(chat);
  // 경기 이력은 접히지 않는다 — 경기마다 리셋돼 자라지 않는다 (agents.md §5-1).
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
  cards: readonly CharacterEntry[],
): string {
  return [
    describeCharacters(cards),
    // 오퍼레이터 지시도 같은 유저 메시지 안이다 — 갈리는 건 **내용의 형식**이다.
    // 감독 발화인지 조작인지를 본문이 밝힌다
    ...turns.map((turn) =>
      turn.role === "operator"
        ? buildOperatorMessage(turn.text)
        : buildManagerMessage(state, turn.text),
    ),
  ]
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
export function buildGmTurnMessage(state: GameState, cards: readonly CharacterEntry[]): string {
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
            entriesOf(
              state,
              group.flatMap((turn) => turn.characters ?? []),
            ),
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
function entriesOf(state: GameState, injected: readonly CharacterInjection[]): CharacterEntry[] {
  return injected
    .map((record) => characterEntryOf(state, record.characterId, record.depth))
    .filter((entry): entry is CharacterEntry => entry !== null);
}
