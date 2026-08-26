import type { GamePlayer, Medical, MedicalConcern, Negotiation } from "@story-fm/domain";
import { ageOf, isPlayerDeal } from "@story-fm/domain";
import { addDays, diffDays } from "../competition/calendar";
import { windowOpenForTeam } from "./market";
import { pronenessValue, raiseProneness } from "../squad/injury";
import { makeRng } from "../core/rng";
import { openInjury, playerById, teamNameIn, pushNarrative, type GameState } from "../core/state";

/**
 * 메디컬 — **합의와 계약 사이의 하루.**
 *
 * `accept_deal`은 합의만 만든다 — 확정은 **검진 결과가 나온 날**에만 일어난다.
 *
 * 코어가 정하는 것은 둘뿐이다: 검진일과 **소견이 붙는가**. 소견이 붙었을 때
 * 무엇을 할지는 감독이 정하고(강행·철회·값 재협상), 소견의 무게를 말로 옮기는
 * 것은 GM의 몫이다.
 */

/** 검진에 걸리는 날 — 합의 다음 날부터 이틀 안 (실제 메디컬도 하루 이틀이다) */
const MEDICAL_DAYS_MIN = 1;
const MEDICAL_DAYS_MAX = 2;
/** 소견이 붙은 뒤 감독이 결정할 시간 — 강행·철회·재협상을 고를 최소한의 여유 */
const MEDICAL_DECISION_DAYS = 3;

/** 아무 이력 없는 스물다섯 살이 소견을 받을 확률 */
const FLAG_BASE = 0.05;
/** 성향이 소견에 실리는 폭 — 유리몸(2.2)은 철인(0.55)의 네 배로 걸린다 */
const FLAG_BY_PRONENESS = 0.06;
/** 서른 넘은 몸은 검진에서 더 많은 것이 보인다 */
const FLAG_BY_AGE_30 = 0.05;
const FLAG_BY_AGE_33 = 0.12;
/**
 * **부상 중인 선수는 거의 반드시 소견을 받는다.** 지금 다쳐 있는 선수를 사면서
 * 검진이 조용히 지나가면 검진이 하는 일이 없다. 그래도 1이 아닌 이유는 "회복
 * 막바지라 문제없다"는 결과도 실제로 있기 때문이다.
 */
const FLAG_WHILE_INJURED = 0.8;
/** 아무리 나빠도 이 위로는 안 간다 — 검진은 형벌이 아니다 */
const FLAG_CEILING = 0.75;

/**
 * 소견을 무시하고 데려온 대가 — **성향이 오른다.**
 *
 * 검진이 본 것이 사실이었다는 뜻이다. 강행이 공짜면 소견은 읽고 넘기는 문장이
 * 되고, 그러면 검진을 둔 의미가 없다. `moderate` 상승은 실제 중간 부상 한 번과
 * 같은 무게다 (injury.ts의 `RISE`).
 */
const OVERRIDE_SEVERITY = "moderate" as const;

/**
 * 팀을 옮기는 딜만 검진한다 — 재계약은 병원에 갈 일이 없고, 해지는 데려갈 구단이
 * 아직 없다 (`isPlayerDeal`).
 *
 * **사전 계약도 지난다** (transfer.md §1-4) — 확정하는 날 옮기는 것은 계약뿐이고
 * 몸을 보는 것은 반년 뒤 합류하는 날의 일이다. 지금의 소견은 그날의 몸이 아니다.
 */
export function needsMedical(negotiation: Negotiation): boolean {
  return !isPlayerDeal(negotiation.kind) && negotiation.precontract !== true;
}

/** 이 딜에서 선수를 데려가는 쪽 (소견을 받고 결정하는 주체) */
export function receivingTeamOf(state: GameState, negotiation: Negotiation): string {
  return negotiation.kind === "sell" || negotiation.kind === "loan_out"
    ? (negotiation.counterpartTeamId ?? state.userTeamId)
    : state.userTeamId;
}

/** 감독의 구단이 데려가는 딜인가 — 소견 앞에서 결정하는 사람이 감독인가 */
export function isIncomingDeal(negotiation: Negotiation): boolean {
  return negotiation.kind === "buy" || negotiation.kind === "loan";
}

/**
 * 검진 일정을 잡는다 — `accept_deal`이 합의 직후 부른다.
 *
 * 날짜는 협상 시드로 결정적이다: 같은 합의를 다시 열어도 검진일이 흔들리지 않는다.
 */
export function scheduleMedical(state: GameState, negotiation: Negotiation): Medical {
  const rng = makeRng(state.seed, `medical-date:${negotiation.id}`);
  const days = MEDICAL_DAYS_MIN + Math.floor(rng() * (MEDICAL_DAYS_MAX - MEDICAL_DAYS_MIN + 1));
  /**
   * **마감일에 잡힌 딜은 그날 검진한다.** 창이 닫힌 뒤로 날짜를 미루면 감독이
   * 아무것도 못 하는 채로 딜이 사라진다 — 실제 마감일에도 검진은 밤을 새워서라도
   * 그날 끝난다. 날짜를 여기서 잘라야 `expiresOn`이 창 밖으로 늘어나지 않는다.
   */
  // **창은 등록을 받는 쪽의 것이다** — 매각·임대 송출이면 사는 구단의 협회 창이라
  // 우리 창이 닫힌 뒤에도 그쪽 마감일까지는 검진을 잡을 수 있다 (transfer.md §3)
  const window = windowOpenForTeam(state, receivingTeamOf(state, negotiation));
  let onDate = addDays(state.date, days);
  if (window && onDate > window.closesOn) onDate = state.date;
  const medical: Medical = { onDate, status: "scheduled" };
  negotiation.medical = medical;
  /**
   * **검진이 기한 안에 끝나야 한다.** 협상 유효기간이 검진일보다 먼저 오면
   * 딜이 병원 대기 중에 사라진다 — 감독이 할 수 있는 일이 없는 소멸이다.
   */
  if (negotiation.expiresOn < medical.onDate) negotiation.expiresOn = medical.onDate;
  return medical;
}

/** 소견이 붙을 확률 — 결정적 입력(성향·부상·나이)에서만 나온다 */
export function flagChance(state: GameState, player: GamePlayer): number {
  const age = ageOf(player.birthdate, state.date);
  const injured = openInjury(state, player.id) !== null;
  const chance =
    FLAG_BASE +
    pronenessValue(player) * FLAG_BY_PRONENESS +
    (age >= 33 ? FLAG_BY_AGE_33 : age >= 30 ? FLAG_BY_AGE_30 : 0) +
    (injured ? FLAG_WHILE_INJURED : 0);
  return Math.min(FLAG_CEILING, chance);
}

/**
 * 소견 카드 — **그 선수의 이력에서 나온다.**
 *
 * 검진이 지어낸 부위를 말하면 감독이 대조할 수 있는 것이 없어 소견이 난수로
 * 읽힌다. 마지막으로 다친 자리가 있으면 그 자리를, 없으면 지금 아픈 곳을 짚는다.
 *
 * 카드는 **코드와 수치**뿐이다 — 문장은 `medicalConcernText`가 만든다. 소견을
 * 세이브에 문장으로 적어 두면 문구를 고친 뒤에도 지난 딜의 소견은 옛 말로 남고,
 * 무엇보다 재호가를 그 문장의 첫머리로 가르던 자리가 함께 깨진다
 * (→ docs/simulation/transfer.md §5).
 */
function concernOf(state: GameState, player: GamePlayer): MedicalConcern {
  const open = openInjury(state, player.id);
  if (open) {
    const left = Math.max(0, diffDays(state.date, open.expectedReturn));
    return { code: "open-injury", bodyPart: open.bodyPart, days: left };
  }
  const past = state.injuries
    .filter((i) => i.gamePlayerId === player.id && i.returnedOn !== null)
    .sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1))[0];
  if (past) return { code: "past-injury", bodyPart: past.bodyPart };
  const age = ageOf(player.birthdate, state.date);
  if (age >= 30) return { code: "age-load", value: age };
  return { code: "muscle-balance" };
}

/** 소견 한 줄 — 브리핑·화면·GM이 같은 함수를 부른다 (카드 → 문장) */
export function medicalConcernText(concern: MedicalConcern): string {
  switch (concern.code) {
    case "open-injury":
      return `${concern.bodyPart ?? "부상 부위"} 부상이 아직 낫지 않았습니다 — 복귀까지 약 ${concern.days ?? 0}일`;
    case "past-injury":
      return `${concern.bodyPart ?? "같은 자리"}에 예전 부상의 흔적이 남아 있습니다 — 같은 자리가 다시 갈 수 있습니다`;
    case "age-load":
      return "누적 피로가 나이에 비해 큽니다 — 연간 소화 경기 수를 관리해야 합니다";
    case "muscle-balance":
      return "근육 밸런스가 고르지 않습니다 — 초반 몇 주는 관리가 필요합니다";
  }
}

/**
 * 검진 소견의 한 줄 — **카드가 먼저, 옛 문장은 폴백이다.**
 * 보여 주는 자리에만 쓴다(game-state.md §6): 갈래를 가르는 자리는 `origin`이 판정한다.
 */
export function medicalNoteText(medical: Medical): string {
  if (medical.concern) return medicalConcernText(medical.concern);
  return medical.note ?? "이상 소견";
}

export interface MedicalOutcome {
  negotiation: Negotiation;
  player: GamePlayer;
  passed: boolean;
  /** 소견 카드 — 통과했으면 없다 */
  concern: MedicalConcern | null;
}

/**
 * 오늘 검진일이 된 딜들의 결과를 낸다 — tick이 매일 부른다.
 *
 * **결과만 낸다.** 통과한 딜을 계약으로 옮기는 것은 협상 쪽 실행 함수의 일이라
 * (`negotiation.ts`의 `acceptDeal`) 여기서 부르지 않는다 — 코어 두 곳이 서로를
 * 부르면 순환이 되고, 무엇보다 "검진 결과"와 "장부 이동"은 다른 사건이다.
 */
export function resolveMedicals(state: GameState): MedicalOutcome[] {
  const out: MedicalOutcome[] = [];
  for (const negotiation of state.negotiations) {
    const medical = negotiation.medical;
    if (!medical || medical.status !== "scheduled") continue;
    if (negotiation.status !== "agreed") continue;
    if (state.date < medical.onDate) continue;
    const player = playerById(state, negotiation.gamePlayerId);
    if (!player) continue;
    out.push(resolveMedical(state, negotiation, player));
  }
  return out;
}

/**
 * 한 건의 검진 결과를 낸다 — 판정은 협상 시드에 묶여 **결정적**이다.
 * 같은 세이브를 다시 열어도 같은 소견이 나오고, 다시 굴려 뒤집을 수 없다.
 */
export function resolveMedical(
  state: GameState,
  negotiation: Negotiation,
  player: GamePlayer,
): MedicalOutcome {
  const medical = negotiation.medical ?? scheduleMedical(state, negotiation);
  const rng = makeRng(state.seed, `medical:${negotiation.id}`);
  const flagged = rng() < flagChance(state, player);
  if (flagged) {
    medical.status = "flagged";
    medical.concern = concernOf(state, player);
    /**
     * **소견은 판단거리라서 판단할 시간이 있어야 한다.**
     *
     * `scheduleMedical`은 검진일까지만 기한을 늘려 둔다. 소견이 검진일에 붙으면
     * 그날이 곧 마지막 날이라, 강행·철회·재협상 중 무엇도 고르지 못한 채 다음
     * tick의 `expireNegotiations`가 협상을 지웠다 — 감독이 할 수 있는 일이 없는
     * 소멸이다. 파는 쪽은 더 눈에 띈다: 사는 구단이 깎아 다시 부른 값에 답할
     * 차례가 왔는데 답할 날이 없다.
     *
     * 창이 닫힌 뒤로 넘어갈 수도 있지만 그래도 낫다 — 그때는 계약이 막히는
     * 이유를 화면이 말해 주고(`이적시장이 닫혀 있어…`) 철회는 여전히 고를 수 있다.
     */
    const decideBy = addDays(state.date, MEDICAL_DECISION_DAYS);
    if (negotiation.expiresOn < decideBy) negotiation.expiresOn = decideBy;
  } else {
    medical.status = "passed";
  }
  return {
    negotiation,
    player,
    passed: !flagged,
    concern: flagged ? (medical.concern ?? null) : null,
  };
}

/**
 * 소견을 무시하고 강행한다 — `accept_deal`이 두 번째로 불릴 때.
 * 대가는 성향이다: 검진이 본 것이 사실이었다는 뜻으로 남는다.
 */
export function overrideMedical(state: GameState, negotiation: Negotiation): void {
  const medical = negotiation.medical;
  if (!medical || medical.status !== "flagged") return;
  medical.overridden = true;
  const player = playerById(state, negotiation.gamePlayerId);
  if (!player) return;
  raiseProneness(player, OVERRIDE_SEVERITY);
  pushNarrative(
    state,
    `${player.name} 메디컬 소견을 안고 영입 강행 — ${medicalNoteText(medical)}`,
    4,
  );
}

/** 검진 결과 한 줄 — 브리핑·상태 스냅샷이 같은 문장을 쓴다 */
export function describeMedical(state: GameState, negotiation: Negotiation): string | null {
  const medical = negotiation.medical;
  if (!medical) return null;
  const player = playerById(state, negotiation.gamePlayerId);
  const who = player?.name ?? negotiation.gamePlayerId;
  const where = isIncomingDeal(negotiation)
    ? "우리 메디컬"
    : `${teamNameIn(state, receivingTeamOf(state, negotiation))} 메디컬`;
  if (medical.status === "scheduled") return `${who} ${where} ${medical.onDate} 예정`;
  if (medical.status === "passed") return `${who} ${where} 통과`;
  return `${who} ${where} 소견 — ${medicalNoteText(medical)}`;
}
