import type { ArcKind, ArcStage, Negotiation, NarrativeArc, PlayerIssue } from "@story-fm/domain";
import {
  ARC_STAGE_KO,
  ARC_STAGE_RANK,
  ARC_TITLE_MAX,
  RETIRE_AGE_MARGINAL,
  USER_WARNINGS_BEFORE_SACK,
  ageOf,
  retiresAtSeasonEnd,
  seasonRating,
} from "@story-fm/domain";
import { lastJudgedDemand } from "../club/board-demand";
import { diffDays } from "../core/dates";
import {
  activeContract,
  managedTeamId,
  onLoanFromUs,
  openInjury,
  playerById,
  playerName,
  playersOf,
  seasonStatOf,
  teamShortNameIn,
  type GameState,
} from "../core/state";
import { loanedOut } from "../market/departures";
import { RATING_BASE } from "../match/ratings";
import { issueReasonText } from "../squad/mood";
import { recentOutcomes, streakOf } from "../squad/slump";

/**
 * 서사 아크 — **기억을 이야기로 엮는 골격** (people.md §9).
 *
 * 개폐는 전부 장부의 사실에서 결정적으로 판정한다: 부상·불만·연속 기록·협상·나이·
 * 출전·평점·계약·완장·보드 경고. 난수도 시각도 모델도 여기 없다 — 같은 상태를 두 번
 * 굴리면 같은 아크가 선다.
 *
 * **아홉 갈래 중 셋은 사실 하나로 열리지 않는다** (people.md §9): 유망주는 나이·출전·
 * 평점이, 황혼은 나이·계약이, 주장 승계는 완장·나이·계약·결장·부주장 공석이 함께
 * 서야 한다. 하나만 보면 스물한 살 전원이 유망주 아크를 갖는다.
 *
 * ⚠️ **아크는 코어 상태를 바꾸지 않는다.** 데이터일 뿐 강제 이벤트가 아니라서,
 * 열려 있다고 폼이 움직이거나 장면이 열리지 않는다. GM이 시즌을 가로지르는
 * 흐름을 읽는 재료로만 선다.
 */

/**
 * 동시에 설 수 있는 이야기 — 넘치면 새 아크는 열리지 않는다 (이미 선 것이 이긴다).
 *
 * 갈래가 아홉이 되면서 넷은 좁아졌다: 새 갈래 넷은 전부 **시즌을 가로지르는 느린
 * 이야기**라 넷에 묶어 두면 그것들이 자리를 붙들고 앉아 불만·부상 같은 **그 주의
 * 이야기**가 열릴 자리가 없어진다. 여섯이면 느린 것 하나둘과 빠른 것 서넛이 함께
 * 서고, 스냅샷 블록은 여섯 줄로 여전히 짧다.
 */
export const MAX_ACTIVE_ARCS = 6;
/** 닫힌 아크의 보관 수 — 서사 메모리 200개와 같은 규약, 오래된 것부터 밀린다 */
export const ARC_RESOLVED_KEEP = 20;

/** 이야기가 되는 부상의 예상 결장 — 이 아래는 그냥 결장이다 */
const INJURY_MIN_OUT_DAYS = 30;
/** 복귀가 눈에 들어오는 눈금 — 선수 근황이 쓰는 자와 같다 (cues.ts) */
const INJURY_CLIMAX_DAYS = 14;

/** 불만이 이야기가 되는 날수 */
const GRIEVANCE_OPEN_DAYS = 7;
const GRIEVANCE_RISING_DAYS = 14;
const GRIEVANCE_CLIMAX_DAYS = 28;
/** 다가옴이 이 계단에 서면 날수와 무관하게 절정이다 — 그 선수가 이미 두 번 찾아왔다 */
const GRIEVANCE_CLIMAX_STEP = 2;

/** 연속 기록의 눈금 — 침체·상승세의 문턱(slump.ts)과 같은 3에서 시작한다 */
const STREAK_OPEN = 3;
const STREAK_RISING = 4;
const STREAK_CLIMAX = 5;

/** 사가가 되는 협상 라운드 — 한 방에 거절당한 오퍼는 사가가 아니다 */
const SAGA_OPEN_ROUNDS = 2;
const SAGA_RISING_ROUNDS = 3;

/** 유망주 이야기의 나이 상한 — 시상의 영플레이어(23)보다 좁다: 스물셋은 이미 주전이다 */
const PROSPECT_MAX_AGE = 21;
/**
 * 시즌 1군 출전 눈금 — 리그·컵·유럽을 합친 하나의 수다(`SeasonStat.apps`). 컵에서
 * 터진 유망주도 같은 이야기라 갈라 세지 않는다. 2군 기록은 애초에 섞이지 않는다.
 */
const PROSPECT_OPEN_APPS = 5;
const PROSPECT_RISING_APPS = 10;
const PROSPECT_CLIMAX_APPS = 15;
/** 돌파가 되는 시즌 평점 — 경기 평점의 기준선 위로 이만큼. 그냥 뛴 것은 돌파가 아니다 */
const PROSPECT_RATING_MARGIN = 0.3;

/**
 * 황혼이 시작되는 나이 — **은퇴 판정이 종합을 보기 시작하는 나이와 같은 자리다**
 * (season.md §6). 몸이 저무는 눈금을 두 벌로 두면 한쪽만 튜닝한 날 이야기와 판정이
 * 갈린다.
 */
const VETERAN_MIN_AGE = RETIRE_AGE_MARGINAL;
/** 계약 시계 — 마지막 해에 들어서면 열리고, 남은 날이 좁아질수록 오른다 */
const VETERAN_OPEN_DAYS = 365;
const VETERAN_RISING_DAYS = 180;
const VETERAN_CLIMAX_DAYS = 90;

/** 완장의 시계 — 서른둘 넘은 주장은 마지막 해에, 그 아래는 반년 안에 물음이 된다 */
const CAPTAIN_MIN_AGE = 32;
const CAPTAIN_OPEN_DAYS = 365;
const CAPTAIN_ANY_AGE_DAYS = 180;
const CAPTAIN_RISING_DAYS = 120;
const CAPTAIN_CLIMAX_DAYS = 60;
/** 완장이 비어 보이는 결장 — 한 달이면 라커룸이 그 자리를 다른 사람으로 채운다 */
const CAPTAIN_ABSENCE_DAYS = 30;

/** 마지막 경고 직전 — 경질 문턱을 옮기면 대치의 고조도 따라 옮겨진다 (career.md §5) */
const STANDOFF_RISING_WARNINGS = USER_WARNINGS_BEFORE_SACK - 1;

/**
 * 자리가 하나뿐일 때 누가 서는가 — **감독이 조치해야 하는 순서다** (people.md §9).
 *
 * 앞쪽은 감독의 자리와 라커룸이 걸린 것, 뒤쪽은 지켜보는 것이다. 유망주 성장이 연속
 * 기록 위에 서는 것은 유망주에게는 기용이라는 손잡이가 있고 연승·연패에는 없기
 * 때문이고, 연속 기록이 맨 뒤인 것은 그것만 스스로 풀리기 때문이다.
 */
const ARC_KIND_ORDER: readonly ArcKind[] = [
  "board-standoff",
  "grievance",
  "captain-succession",
  "injury-comeback",
  "veteran-twilight",
  "transfer-saga",
  "prospect-rise",
  "losing-run",
  "winning-run",
];

/**
 * 한 갈래가 한꺼번에 붙들 수 있는 자리 — 적지 않은 갈래는 상한(`MAX_ACTIVE_ARCS`)까지다.
 *
 * 유망주와 황혼만 하나로 묶는 것은 **장부가 여럿을 한꺼번에 내놓기 때문이다**: 스물한
 * 살 이하 유망주도, 계약 마지막 해의 서른셋도 선수단에 여럿 있는 것이 정상이라, 묶지
 * 않으면 한 시즌 내내 그 셋이 여섯 자리 중 셋을 붙들고 앉아 불만·부상·연속 기록이
 * 열릴 자리가 없어진다. 한 시즌의 유망주 이야기는 하나이고, 그 하나는 **가장 나아간
 * 사람**의 것이다(아래 정렬).
 *
 * 팀이 주인인 갈래(보드 대치·주장 승계·연승·연패)는 애초에 하나뿐이라 적지 않는다.
 */
const ARC_KIND_ACTIVE_LIMIT: Partial<Record<ArcKind, number>> = {
  "prospect-rise": 1,
  "veteran-twilight": 1,
};

/** 아직 닫히지 않은 단계 — 사실은 아크를 열고 올릴 뿐, 닫는 것은 사실의 부재다 */
type ActiveStage = Exclude<ArcStage, "resolved">;

interface ArcCandidate {
  kind: ArcKind;
  subjectId: string;
  stage: ActiveStage;
}

/** 같은 (갈래, 주인)의 활성 아크는 하나다 — 그 하나를 가리키는 열쇠 */
const arcKey = (kind: ArcKind, subjectId: string): string => `${kind}:${subjectId}`;

const asc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ── 오늘의 사실 → 후보 ──────────────────────────────────

/**
 * 진행 중인 협상 — 선수당 하나. 같은 선수 앞으로 여러 건이 열려 있으면 **가장
 * 늦게 열린 것**이 지금의 이야기다(옛 건은 기한이 지워 준다). 같은 날 열렸으면
 * id 사전순 — 무엇이든 하나로 정해져야 판정이 결정적이다.
 */
function liveNegotiations(state: GameState): Map<string, Negotiation> {
  const live = new Map<string, Negotiation>();
  for (const n of state.negotiations) {
    if (n.status !== "open" && n.status !== "agreed") continue;
    const prev = live.get(n.gamePlayerId);
    if (!prev || n.openedOn > prev.openedOn || (n.openedOn === prev.openedOn && n.id < prev.id)) {
      live.set(n.gamePlayerId, n);
    }
  }
  return live;
}

/** 이 선수의 불만 중 **가장 오래 선 것** — 단계를 미는 것도 사실 줄이 읽는 것도 그것이다 */
function oldestIssue(state: GameState, playerId: string): PlayerIssue | null {
  let oldest: PlayerIssue | null = null;
  for (const issue of state.issues) {
    if (issue.gamePlayerId !== playerId) continue;
    if (!oldest || issue.since < oldest.since) oldest = issue;
  }
  return oldest;
}

/** 연속 n회가 어느 단계인가 — 문턱 아래면 이야기가 아니다 */
function streakStage(n: number): ActiveStage | null {
  if (n >= STREAK_CLIMAX) return "climax";
  if (n >= STREAK_RISING) return "rising";
  if (n >= STREAK_OPEN) return "open";
  return null;
}

/**
 * 오늘의 장부가 세우는 아크 후보 전부. **나오지 않은 열쇠는 닫힌다** —
 * 사실이 사라진 아크를 따로 찾아 지우지 않고, 여기 없다는 것으로 안다.
 */
function candidatesToday(state: GameState, teamId: string): Map<string, ArcCandidate> {
  const found = new Map<string, ArcCandidate>();
  const put = (candidate: ArcCandidate): void => {
    const key = arcKey(candidate.kind, candidate.subjectId);
    const prev = found.get(key);
    if (!prev || ARC_STAGE_RANK[candidate.stage] > ARC_STAGE_RANK[prev.stage]) {
      found.set(key, candidate);
    }
  };

  const squad = playersOf(state, teamId);

  // 부상 복귀 — 우리 선수의 미복귀 부상만. 복귀도 이적도 여기서 사라지는 것으로 닫힌다
  for (const player of squad) {
    const injury = openInjury(state, player.id);
    if (!injury) continue;
    const out = diffDays(injury.occurredOn, injury.expectedReturn);
    if (out < INJURY_MIN_OUT_DAYS) continue;
    const elapsed = diffDays(injury.occurredOn, state.date);
    const left = diffDays(state.date, injury.expectedReturn);
    put({
      kind: "injury-comeback",
      subjectId: player.id,
      stage:
        left <= INJURY_CLIMAX_DAYS
          ? "climax"
          : // 재활 반환점 — 반나절을 가르지 않으려고 2를 곱해 잰다
            elapsed * 2 >= out
            ? "rising"
            : "open",
    });
  }

  // 곪는 불만 — 남의 라커룸 불만은 우리 이야기가 아니다
  const ours = new Set(squad.map((p) => p.id));
  const pressed = new Set(
    (state.approachPressure ?? [])
      .filter((p) => p.step >= GRIEVANCE_CLIMAX_STEP)
      .map((p) => p.subject),
  );
  for (const issue of state.issues) {
    if (!ours.has(issue.gamePlayerId)) continue;
    const days = diffDays(issue.since, state.date);
    if (days < GRIEVANCE_OPEN_DAYS) continue;
    put({
      kind: "grievance",
      subjectId: issue.gamePlayerId,
      stage:
        days >= GRIEVANCE_CLIMAX_DAYS || pressed.has(issue.gamePlayerId)
          ? "climax"
          : days >= GRIEVANCE_RISING_DAYS
            ? "rising"
            : "open",
    });
  }

  /**
   * 연속 기록 — 리그전만 세는 `recentOutcomes`가 시즌으로도 자른다. 그래서 시즌이
   * 바뀌면 후보가 사라져 **연속 아크만 저절로 닫힌다** (people.md §9).
   * 절정의 눈금까지만 읽으면 되므로 창도 그만큼이다.
   */
  const outcomes = recentOutcomes(state, teamId, STREAK_CLIMAX);
  const wins = streakStage(streakOf(outcomes, "win"));
  if (wins) put({ kind: "winning-run", subjectId: teamId, stage: wins });
  const losses = streakStage(streakOf(outcomes, "loss"));
  if (losses) put({ kind: "losing-run", subjectId: teamId, stage: losses });

  // 이적 사가 — 주인은 선수다. 우리가 파는 쪽이든 사는 쪽이든 이야기는 그 사람의 것이다
  for (const [playerId, negotiation] of liveNegotiations(state)) {
    if (negotiation.rounds.length < SAGA_OPEN_ROUNDS) continue;
    put({
      kind: "transfer-saga",
      subjectId: playerId,
      stage:
        negotiation.status === "agreed"
          ? "climax"
          : negotiation.rounds.length >= SAGA_RISING_ROUNDS
            ? "rising"
            : "open",
    });
  }

  /**
   * 유망주의 돌파 — **나이·출전·평점 셋이 동시에 서야 열린다.** 출전만 보면 스물한
   * 살 백업 골키퍼가 이야기가 되고, 평점만 보면 두 경기 뛴 아이가 이야기가 된다.
   *
   * **임대 보낸 선수도 주인이다** — 계약은 우리 것이고 출전은 남의 경기장 것이다
   * (transfer.md §2). 임대는 출전을 사는 거래이므로 2부에서 스무 경기를 뛰는
   * 열아홉 살이야말로 이 이야기의 원형이고, 시즌 기록은 그가 **지금 뛰는 팀**의
   * 줄에서 읽힌다(`seasonStatOf`). 임대가 끝나 우리 줄로 돌아오면 그 셔츠의 출전이
   * 다시 0이라 이야기도 닫힌다 — 사실의 부재가 닫는다는 규약 그대로다.
   */
  for (const player of [...squad, ...loanedOut(state)]) {
    if (ageOf(player.birthdate, state.date) > PROSPECT_MAX_AGE) continue;
    const stat = seasonStatOf(state, player.id);
    const apps = stat?.apps ?? 0;
    if (apps < PROSPECT_OPEN_APPS) continue;
    const rating = seasonRating(stat);
    if (rating === null || rating < RATING_BASE + PROSPECT_RATING_MARGIN) continue;
    put({
      kind: "prospect-rise",
      subjectId: player.id,
      stage:
        apps >= PROSPECT_CLIMAX_APPS ? "climax" : apps >= PROSPECT_RISING_APPS ? "rising" : "open",
    });
  }

  /**
   * 베테랑의 황혼 — 나이와 계약 시계를 겹쳐 읽는다. 서른다섯이어도 계약이 3년
   * 남았으면 아직 황혼이 아니고, 마지막 해여도 스물여덟이면 그냥 재계약 협상이다.
   *
   * 재계약이 만료일을 밀어내면 후보가 사라져 닫히고, 은퇴·이적은 선수단에서 사라지는
   * 것으로 닫힌다.
   */
  for (const player of squad) {
    const age = ageOf(player.birthdate, state.date);
    if (age < VETERAN_MIN_AGE) continue;
    const contract = activeContract(state, player.id);
    if (!contract) continue;
    const left = diffDays(state.date, contract.until);
    if (left > VETERAN_OPEN_DAYS) continue;
    put({
      kind: "veteran-twilight",
      subjectId: player.id,
      stage:
        /**
         * 이번 시즌이 마지막이면 계약이 얼마나 남았든 절정이다. **예고가 원본이고**
         * (season.md §6), 문턱은 1월 전의 자리다 — 예고가 서기 전에도 감독이 읽을 수
         * 있어야 이야기가 겨울에 갑자기 시작되지 않는다.
         */
        left <= VETERAN_CLIMAX_DAYS ||
        player.state.retiringAfterSeason !== undefined ||
        retiresAtSeasonEnd(age, player.attributes.overall)
          ? "climax"
          : left <= VETERAN_RISING_DAYS
            ? "rising"
            : "open",
    });
  }

  /**
   * 완장의 승계 — **주인은 팀이다.** 완장은 그 사람의 것이 아니라 구단의 것이라,
   * `set_captain`이 완장을 넘기면 새 주장의 사실로 다시 판정되고 그가 젊거나 계약이
   * 길면 그것으로 닫힌다.
   *
   * 결장은 부상 원장만 읽는다 — 한 달을 비운 완장은 라커룸에서 이미 빈자리다.
   * 부주장 공석이 절정을 가르는 것은 그때가 승계가 실제로 물음이 되는 유일한
   * 자리이기 때문이다: 부주장이 서 있으면 답은 이미 장부에 있다.
   */
  const captain = squad.find((p) => p.isCaptain);
  const captainContract = captain ? activeContract(state, captain.id) : null;
  if (captain && captainContract) {
    const age = ageOf(captain.birthdate, state.date);
    const left = diffDays(state.date, captainContract.until);
    if (left <= CAPTAIN_ANY_AGE_DAYS || (age >= CAPTAIN_MIN_AGE && left <= CAPTAIN_OPEN_DAYS)) {
      const injury = openInjury(state, captain.id);
      const longAbsence =
        injury !== null && diffDays(injury.occurredOn, state.date) >= CAPTAIN_ABSENCE_DAYS;
      const noDeputy = !squad.some((p) => p.isViceCaptain === true);
      put({
        kind: "captain-succession",
        subjectId: teamId,
        stage:
          left <= CAPTAIN_CLIMAX_DAYS || (longAbsence && noDeputy)
            ? "climax"
            : left <= CAPTAIN_RISING_DAYS || longAbsence
              ? "rising"
              : "open",
      });
    }
  }

  /**
   * 보드와의 대치 — 경고 한 장이 곧 대치의 시작이다 (career.md §5). 성적이 기대 위로
   * 올라서면 경고가 지워지고 그것으로 닫힌다.
   *
   * 경질·이직은 여기서 따로 닫지 않는다 — 경질은 무직이 되어 후보가 통째로 비고
   * (`tickArcs`), 이직은 `boardWarnings`를 지우고 팀 id가 바뀌므로 옛 열쇠가 다시
   * 나오지 않는다 (manager-market.ts `leaveClub`·`acceptManagerOffer`).
   */
  const warnings = state.manager.boardWarnings ?? 0;
  if (warnings > 0) {
    const failed = lastJudgedDemand(state)?.status === "failed";
    put({
      kind: "board-standoff",
      subjectId: teamId,
      stage:
        warnings >= USER_WARNINGS_BEFORE_SACK || failed
          ? "climax"
          : warnings >= STANDOFF_RISING_WARNINGS
            ? "rising"
            : "open",
    });
  }

  return found;
}

// ── 사실 줄 ─────────────────────────────────────────────

/**
 * 아크 하나의 사실 줄 — **이름과 수치와 날짜뿐이다.** 평가어도 연출어도 물음표도
 * 없다 (overview.md §1 철칙 4): 문장은 GM이 쓴다.
 *
 * 닫힌 아크는 사실이 이미 장부에서 사라졌으므로 갈래 이름만 남는다.
 */
export function arcFactLine(state: GameState, arc: NarrativeArc): string {
  switch (arc.kind) {
    case "injury-comeback": {
      const name = playerName(state, arc.subjectId);
      const injury = openInjury(state, arc.subjectId);
      return injury
        ? `${name} ${injury.bodyPart} 부상 · 복귀 예정 ${injury.expectedReturn}`
        : `${name} 부상`;
    }
    case "grievance": {
      const name = playerName(state, arc.subjectId);
      const issue = oldestIssue(state, arc.subjectId);
      if (!issue) return `${name} 불만`;
      const reason = issueReasonText(issue);
      return `${name} 불만${reason === null ? "" : ` ${reason}`} · ${diffDays(issue.since, state.date)}일째`;
    }
    case "winning-run":
    case "losing-run": {
      const win = arc.kind === "winning-run";
      const word = win ? "연승" : "연패";
      const n = streakOf(recentOutcomes(state, arc.subjectId, STREAK_CLIMAX), win ? "win" : "loss");
      return n < STREAK_OPEN ? `리그 ${word}` : `리그 ${n}${word}`;
    }
    case "transfer-saga": {
      const name = playerName(state, arc.subjectId);
      const negotiation = liveNegotiations(state).get(arc.subjectId);
      if (!negotiation) return `${name} 협상`;
      const agreed = negotiation.status === "agreed" ? " · 합의" : "";
      return `${name} 협상 ${negotiation.rounds.length}라운드${agreed}`;
    }
    case "prospect-rise": {
      const name = playerName(state, arc.subjectId);
      const player = playerById(state, arc.subjectId);
      if (!player) return `${name} 성장`;
      const stat = seasonStatOf(state, player.id);
      const rating = seasonRating(stat);
      // 우리가 내보낸 임대면 어느 경기장의 기록인지가 사실의 일부다.
      // 빌려 **온** 임대는 우리 셔츠로 뛰므로 붙이지 않는다 — 우리 이름이 임대처럼 선다
      const away = onLoanFromUs(state, player)
        ? ` · 임대 ${teamShortNameIn(state, player.teamId)}`
        : "";
      return (
        `${name} ${ageOf(player.birthdate, state.date)}세 · 시즌 ${stat?.apps ?? 0}경기` +
        `${rating === null ? "" : ` · 평점 ${rating.toFixed(2)}`}${away}`
      );
    }
    case "veteran-twilight": {
      const name = playerName(state, arc.subjectId);
      const player = playerById(state, arc.subjectId);
      const contract = activeContract(state, arc.subjectId);
      if (!player || !contract) return `${name} 계약`;
      return `${name} ${ageOf(player.birthdate, state.date)}세 · 계약 만료 ${contract.until}`;
    }
    case "captain-succession": {
      const captain = playersOf(state, arc.subjectId).find((p) => p.isCaptain);
      if (!captain) return "주장 공석";
      const contract = activeContract(state, captain.id);
      const until = contract === null ? "" : ` · 계약 만료 ${contract.until}`;
      const deputy = playersOf(state, arc.subjectId).some((p) => p.isViceCaptain === true);
      const age = ageOf(captain.birthdate, state.date);
      return `주장 ${captain.name} ${age}세${until}${deputy ? "" : " · 부주장 공석"}`;
    }
    case "board-standoff": {
      const warnings = state.manager.boardWarnings ?? 0;
      const failed = lastJudgedDemand(state)?.status === "failed";
      return `보드 경고 ${warnings}/${USER_WARNINGS_BEFORE_SACK}${failed ? " · 구단주 요청 불이행" : ""}`;
    }
  }
}

// ── 조회 ────────────────────────────────────────────────

/** 아직 닫히지 않은 아크 — 상태 스냅샷에 서는 것들 */
export function activeArcs(state: GameState): NarrativeArc[] {
  return (state.arcs ?? []).filter((arc) => arc.resolvedOn === null);
}

/**
 * 상태 스냅샷 블록 — 활성 아크가 없으면 null(빈 제목을 단 자리를 만들지 않는다).
 * 이름이 없는 아크는 **코어의 사실 줄이 그 자리를 대신한다** — 이름 짓기가
 * 실패해도 아크는 굴러간다 (people.md §9).
 */
export function describeActiveArcs(state: GameState): string | null {
  const arcs = activeArcs(state);
  if (arcs.length === 0) return null;
  return arcs
    .map((arc) => {
      const title = arc.title === undefined ? "" : `${arc.title} — `;
      return `- [${ARC_STAGE_KO[arc.stage]}] ${title}${arcFactLine(state, arc)}`;
    })
    .join("\n");
}

// ── 매일 tick ───────────────────────────────────────────

/**
 * 열고·올리고·닫는다. 단계가 움직인 아크만 다이제스트에 한 줄 남긴다 —
 * 그대로인 이야기는 소식이 아니다.
 *
 * ⚠️ **단계는 뒤로 가지 않는다.** 사실이 잠깐 물러났다고(불만이 하루 식는다,
 * 다가옴 계단이 내려간다) 되감기면 GM이 지난 턴과 다른 흐름을 읽는다. 물러난
 * 사실이 아크를 움직이는 길은 **닫히는 것** 하나뿐이다.
 */
export function tickArcs(state: GameState, digest: string[]): void {
  const arcs = (state.arcs ??= []);
  const teamId = managedTeamId(state);

  const move = (arc: NarrativeArc, stage: ArcStage): void => {
    arc.stage = stage;
    arc.updatedOn = state.date;
    if (stage === "resolved") arc.resolvedOn = state.date;
    digest.push(`${arcFactLine(state, arc)} — ${ARC_STAGE_KO[stage]}`);
  };

  /**
   * 무직이면 후보가 없다 — 선수단도 순위도 협상도 이제 남의 것이라, 옛 구단의
   * 이야기가 전부 닫힌다 (불만을 비우는 것과 같은 결, career.md §5.1).
   */
  const found = teamId === null ? new Map<string, ArcCandidate>() : candidatesToday(state, teamId);

  let active = 0;
  /** 갈래별 활성 수 — `ARC_KIND_ACTIVE_LIMIT`이 이 수를 본다 */
  const activeOfKind = new Map<ArcKind, number>();
  for (const arc of arcs) {
    if (arc.resolvedOn !== null) continue;
    const key = arcKey(arc.kind, arc.subjectId);
    const candidate = found.get(key);
    if (!candidate) {
      move(arc, "resolved");
      continue;
    }
    found.delete(key); // 이 후보는 이미 선 아크의 것이다 — 두 번 열지 않는다
    if (ARC_STAGE_RANK[candidate.stage] > ARC_STAGE_RANK[arc.stage]) move(arc, candidate.stage);
    active++;
    activeOfKind.set(arc.kind, (activeOfKind.get(arc.kind) ?? 0) + 1);
  }

  // 빈 자리만 채운다 — 이미 선 아크는 우선순위가 높은 후보에게도 밀려나지 않는다
  const fresh = [...found.values()].sort(
    (a, b) =>
      ARC_KIND_ORDER.indexOf(a.kind) - ARC_KIND_ORDER.indexOf(b.kind) ||
      // 같은 갈래면 더 나아간 이야기가 먼저 — 28일째 불만이 7일째보다 급하다
      ARC_STAGE_RANK[b.stage] - ARC_STAGE_RANK[a.stage] ||
      asc(a.subjectId, b.subjectId),
  );
  for (const candidate of fresh) {
    if (active >= MAX_ACTIVE_ARCS) break;
    const limit = ARC_KIND_ACTIVE_LIMIT[candidate.kind];
    if (limit !== undefined && (activeOfKind.get(candidate.kind) ?? 0) >= limit) continue;
    const id = `arc:${candidate.kind}:${candidate.subjectId}:${state.date}`;
    // 같은 날 닫힌 같은 이야기가 다시 서면 id가 겹친다 — 겹친 자리엔 세우지 않는다
    if (arcs.some((arc) => arc.id === id)) continue;
    const opened: NarrativeArc = {
      id,
      kind: candidate.kind,
      subjectId: candidate.subjectId,
      stage: candidate.stage,
      openedOn: state.date,
      updatedOn: state.date,
      resolvedOn: null,
    };
    arcs.push(opened);
    active++;
    activeOfKind.set(candidate.kind, (activeOfKind.get(candidate.kind) ?? 0) + 1);
    digest.push(`${arcFactLine(state, opened)} — ${ARC_STAGE_KO[candidate.stage]}`);
  }

  pruneResolved(state, arcs);
}

/** 닫힌 아크는 보관 수까지만 — 오래 닫힌 것부터 밀린다 */
function pruneResolved(state: GameState, arcs: NarrativeArc[]): void {
  const resolved = arcs.filter((arc) => arc.resolvedOn !== null);
  if (resolved.length <= ARC_RESOLVED_KEEP) return;
  const drop = new Set(
    [...resolved]
      .sort((a, b) => asc(a.resolvedOn ?? "", b.resolvedOn ?? ""))
      .slice(0, resolved.length - ARC_RESOLVED_KEEP)
      .map((arc) => arc.id),
  );
  state.arcs = arcs.filter((arc) => !drop.has(arc.id));
}

// ── 이름 짓기 ───────────────────────────────────────────

export interface ArcTitleDraft {
  arcId: string;
  title: string;
}

/**
 * 압축 에이전트의 제목 제안을 검증해 반영한다 — `registerCharacters`와 같은 계약
 * (people.md §9): 아크가 실제로 있고 · 아직 활성이며 · **이름이 없어야** 받는다.
 * 한 번 붙은 이름은 시즌 내내 같은 이야기를 가리켜야 하므로 덮어쓰지 않는다.
 * 걸린 항목만 버리고 나머지는 반영한다.
 *
 * @returns 실제로 이름이 붙은 아크 수
 */
export function applyArcTitles(state: GameState, drafts: readonly ArcTitleDraft[]): number {
  const arcs = state.arcs ?? [];
  let applied = 0;
  for (const draft of drafts) {
    const arc = arcs.find((a) => a.id === draft.arcId);
    if (!arc || arc.resolvedOn !== null || arc.title !== undefined) continue;
    const title = draft.title.trim();
    if (title.length === 0 || title.length > ARC_TITLE_MAX) continue;
    arc.title = title;
    applied++;
  }
  return applied;
}
