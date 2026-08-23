import type { GamePlayer, PitchClaim, PitchClaimKind } from "@story-fm/domain";
import { PITCH_CLAIM_KO, ageOf } from "@story-fm/domain";
import { euroCompetitionOf } from "../competition/europe";
import { countryOfTeam, isClubTeam } from "../data/team-catalog";
import { computeStandings } from "../competition/season";
import { contractYearsLeft, playerById, playersOf, teamName, type GameState } from "../core/state";
import { betterAtPosition } from "../squad/depth";

/**
 * 설득 검증 — 감독의 논거를 **상태와 대조해** 인정/기각한다.
 *
 * 여기가 "설득으로 불가능을 넘는다"와 "말만 잘하면 된다" 사이의 경계선이다.
 * 각 주장은 코어가 확인할 수 있는 사실 하나에 걸려 있고, 확인되면 점수를,
 * 어긋나면 **감점**을 준다 — 선수는 거짓말을 알아챈다.
 *
 * 결정적이다. 같은 상태·같은 주장이면 언제나 같은 판정이 나온다.
 */

export interface ClaimVerdict {
  kind: PitchClaimKind;
  /** 사실로 확인됐는가 */
  verified: boolean;
  /** 확률 점수 기여 — 거짓이면 음수 */
  score: number;
  /** 왜 인정됐는지 / 왜 기각됐는지 (감독에게 그대로 보인다) */
  why: string;
  /**
   * 이 협상에서 **이미 한 이야기인가** — 여유(`latitude`)를 여는 것은 새 논거뿐이다.
   *
   * 예전엔 그 사실을 `why` 뒤에 `"(이미 한 이야기다)"`로 붙이고 다시 그 문장을
   * 읽어 셌다. 문구를 고치는 순간 반복이 전부 새 논거가 되어 여유가 무한정 열렸다.
   */
  repeated: boolean;
  note?: string;
}

/**
 * **논거의 무게는 코어가 정하지 않는다.**
 *
 * "이 선수에게 고향 복귀가 얼마나 큰가"는 표로 답할 수 있는 질문이 아니다.
 * 서른아홉에 마지막 우승을 노리는 선수와 스물셋의 유망주에게 같은 말이 같은
 * 무게일 리 없다. 그래서 코어는 **사실 여부만** 가리고, 무게는 선수·에이전트를
 * 연기하는 LLM이 판정한다.
 *
 * 코어가 쥐는 것은 두 가지뿐이다.
 * ① **거짓의 대가** — 남용 방지라 결정적이어야 한다. 확인 안 되는 주장을
 *    갖다 붙이면 확률이 깎인다.
 * ② **판정 여유(latitude)** — 확인된 논거 하나당 LLM이 확률선 아래로 내려가
 *    수락할 수 있는 폭. "가능한 판정"의 경계를 넓히는 허가지, 판정 자체가 아니다.
 */
const LIE_PENALTY = 1.4;

/**
 * 확인된 논거 하나가 여는 판정 여유(%p) — **수락 하한이 이만큼 내려간다.**
 *
 * `respondOffer`의 하한(`MIN_ACCEPT_PROBABILITY` 5%)에서 빠지는 값이라 여기가
 * 12인 동안은 논거 하나로 하한이 0이 된다. 그래도 눈금이어야 하는 이유는 감독이
 * 보는 숫자이기 때문이다 — 걸리는 데가 없는 `+12%p`는 대조할 수 없는 장식이다.
 */
export const LATITUDE_PER_CLAIM = 12;

/** 한 구단에 있었던 구간 — `[from, to)` (원장이 모르는 시작은 `EPOCH`) */
interface Spell {
  teamId: string;
  from: string;
  to: string;
}

/** 원장 이전은 알 수 없다 — 첫 이적 전의 소속은 여기서부터 센다 */
const EPOCH = "0000-01-01";

/**
 * 이 선수의 소속 구간 — **TRANSFER 원장에서 파생한다.**
 *
 * 이적 하나가 앞 구간을 닫고 다음 구간을 연다. 원장에 없는 선수(시드 그대로인
 * 선수)는 지금 소속 하나가 전부다. 클럽이 아닌 자리(무소속)는 빼고 돌려준다 —
 * 무소속을 한 구단으로 세면 방출을 거친 둘이 "함께 뛴 사이"가 된다.
 */
function spellsOf(state: GameState, player: GamePlayer): Spell[] {
  const moves = state.transfers
    .filter((t) => t.gamePlayerId === player.id)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const spells: Spell[] = [];
  let since = EPOCH;
  // 원장의 양끝은 비어 있을 수 있다 (유스 등록·은퇴) — 모르는 구간은 접는다
  let at: string | null = moves.length > 0 ? moves[0]!.fromTeamId : player.teamId;
  for (const move of moves) {
    if (at !== null) spells.push({ teamId: at, from: since, to: move.date });
    since = move.date;
    at = move.toTeamId;
  }
  if (at !== null) spells.push({ teamId: at, from: since, to: state.date });
  return spells.filter((spell) => isClubTeam(spell.teamId) && spell.from < spell.to);
}

/**
 * 같은 팀에서 **함께 뛴 적이 있는가** — 소속 구간이 겹쳐야 사실이다.
 *
 * 클럽 이름만 대조하면 십 년 차이로 같은 구단을 거친 둘이 동료가 된다. 겹침은
 * 엄격하게 본다 — 한쪽이 떠난 날 다른 쪽이 온 것은 함께 뛴 것이 아니다
 * (transfer.md §4).
 */
function sharedClubWith(state: GameState, player: GamePlayer): string | null {
  const theirs = spellsOf(state, player);
  if (theirs.length === 0) return null;
  for (const mate of playersOf(state, state.userTeamId)) {
    if (mate.id === player.id) continue;
    for (const ours of spellsOf(state, mate)) {
      const overlap = theirs.find(
        (spell) => spell.teamId === ours.teamId && spell.from < ours.to && ours.from < spell.to,
      );
      if (overlap) return overlap.teamId;
    }
  }
  return null;
}

/** 라커룸의 동포 — 홈그로운 협회가 같은 선수 */
function compatriotIn(state: GameState, player: GamePlayer): GamePlayer | null {
  if (player.homegrownCountry === undefined) return null;
  return (
    playersOf(state, state.userTeamId).find(
      (p) => p.homegrownCountry === player.homegrownCountry,
    ) ?? null
  );
}

function verifyOne(
  state: GameState,
  player: GamePlayer,
  kind: PitchClaimKind,
): {
  verified: boolean;
  why: string;
} {
  const us = state.userTeamId;
  switch (kind) {
    case "european_football": {
      const cup = euroCompetitionOf(state.euroEntrants, us);
      return cup
        ? { verified: true, why: `우리는 올 시즌 ${cup}에 나간다` }
        : { verified: false, why: "우리는 올 시즌 대항전에 나가지 않는다 — 선수가 확인한다" };
    }
    case "starting_role": {
      const blocked = betterAtPosition(state, state.userTeamId, player);
      return blocked === 0
        ? { verified: true, why: "그 자리에 그보다 나은 선수가 없다 — 주전 약속이 사실이다" }
        : {
            verified: false,
            why: `그 자리에 이미 더 나은 선수가 ${blocked}명 있다 — 주전 약속을 믿지 않는다`,
          };
    }
    case "project_lead": {
      const squad = playersOf(state, us)
        .map((p) => p.attributes.overall)
        .sort((a, b) => b - a);
      const third = squad[2] ?? 0;
      return player.attributes.overall >= third
        ? { verified: true, why: "우리 스쿼드 최상위권 전력이다 — 팀의 중심이 될 수 있다" }
        : { verified: false, why: "우리 스쿼드에 이미 그보다 나은 선수들이 있다" };
    }
    case "homecoming": {
      const ourCountry = countryOfTeam(us);
      return player.homegrownCountry === ourCountry
        ? { verified: true, why: `${ourCountry}에서 자란 선수다 — 돌아오는 것이다` }
        : { verified: false, why: "그가 자란 곳이 아니다" };
    }
    case "reunion": {
      const club = sharedClubWith(state, player);
      return club
        ? { verified: true, why: `${teamName(club)}에서 우리 선수와 함께 뛴 적이 있다` }
        : { verified: false, why: "우리 선수단과 함께한 이력이 없다" };
    }
    case "compatriot": {
      const mate = compatriotIn(state, player);
      return mate
        ? { verified: true, why: `라커룸에 ${mate.name}이(가) 있다` }
        : { verified: false, why: "라커룸에 그의 나라 사람이 없다" };
    }
    case "trophy_push": {
      const rank = computeStandings(state).findIndex((r) => r.teamId === us) + 1;
      const contending = rank > 0 && rank <= 4;
      const inEurope = euroCompetitionOf(state.euroEntrants, us) !== null;
      return contending || inEurope
        ? {
            verified: true,
            why: contending
              ? `리그 ${rank}위 — 우승을 다투는 위치다`
              : "대항전에서 트로피를 노린다",
          }
        : { verified: false, why: "지금 우리가 다투는 트로피가 없다" };
    }
    case "manager_reputation": {
      const rep = state.manager.reputation;
      const fame = (rep.media + rep.board + rep.squad) / 3;
      return fame >= 60
        ? { verified: true, why: `감독 명성 ${Math.round(fame)} — 이름값이 통한다` }
        : { verified: false, why: `감독 명성 ${Math.round(fame)} — 아직 이름만으로는 부족하다` };
    }
    case "last_chance": {
      const age = ageOf(player.birthdate, state.date);
      const left = contractYearsLeft(state, player.id);
      return age >= 33 || left <= 1
        ? {
            verified: true,
            why: age >= 33 ? `${age}세 — 다음 기회가 있을지 모른다` : "계약이 1년 남았다",
          }
        : { verified: false, why: "아직 시간이 많은 선수다 — 조급할 이유가 없다" };
    }
    case "other":
      return { verified: false, why: "코어가 확인할 수 없는 이야기다 — 서사로만 남는다" };
  }
}

export interface PitchOutcome {
  verdicts: ClaimVerdict[];
  /** 확률 점수 — **거짓의 대가만** 들어간다. 인정된 논거는 확률을 직접 올리지 않는다 */
  score: number;
  /** 인정된 주장의 종류 (협상에 누적해 중복 계산을 막는다) */
  verified: PitchClaimKind[];
  /**
   * 판정 여유(%p) — LLM이 확률선 아래로 얼마나 내려가 수락할 수 있는가.
   * 확률을 올리는 게 아니라 **판정의 폭을 넓힌다**. 무게는 LLM이 정한다.
   */
  latitude: number;
}

/**
 * 논거 대조 — 코어는 **사실만 가린다.**
 *
 * 인정된 논거는 확률을 직접 올리지 않는다. 대신 `latitude`를 열어, 확률이 낮아도
 * LLM(선수·에이전트)이 "그래도 간다"고 판정할 수 있게 한다. 상한이 없어서
 * 충분히 쌓이면 어떤 확률도 넘는다 — 그게 "설득력 있는 서사면 불가능한 이적도
 * 가능하다"의 실제 형태다.
 *
 * @param already 이 협상에서 이미 인정된 주장 — 같은 말을 반복해도 다시 쳐주지 않는다
 */
export function evaluatePitch(
  state: GameState,
  playerId: string,
  claims: readonly PitchClaim[],
  already: readonly PitchClaimKind[] = [],
): PitchOutcome {
  const player = playerById(state, playerId);
  if (!player) return { verdicts: [], score: 0, verified: [], latitude: 0 };

  const seen = new Set<PitchClaimKind>(already);
  const verdicts: ClaimVerdict[] = [];
  for (const claim of claims) {
    const { verified, why } = verifyOne(state, player, claim.kind);
    const repeated = seen.has(claim.kind);
    seen.add(claim.kind);
    verdicts.push({
      kind: claim.kind,
      verified,
      // 인정된 논거는 확률에 0 — 무게는 LLM이 정한다.
      // 거짓만 코어가 결정적으로 벌한다 (남용 방지)
      score: verified || claim.kind === "other" ? 0 : -LIE_PENALTY,
      why: repeated && verified ? `${why} (이미 한 이야기다)` : why,
      repeated,
      ...(claim.note === undefined ? {} : { note: claim.note }),
    });
  }
  // 이번에 **새로** 확인된 논거만 여유를 연다 (같은 말의 반복은 설득이 아니다)
  const fresh = verdicts.filter((v) => v.verified && !v.repeated);
  return {
    verdicts,
    score: verdicts.reduce((sum, v) => sum + v.score, 0),
    verified: verdicts.filter((v) => v.verified).map((v) => v.kind),
    latitude: fresh.length * LATITUDE_PER_CLAIM,
  };
}

/**
 * 이 협상이 지금까지 쌓은 판정 여유 — 인정된 논거 수에 비례한다.
 * 오퍼를 판정할 때(`respondOffer`) 확률선을 이만큼 내려 준다.
 */
export function latitudeOf(pitched: readonly PitchClaimKind[] | undefined): number {
  return (pitched?.length ?? 0) * LATITUDE_PER_CLAIM;
}

/** 확률 근거에 넣을 한 줄 */
export function claimLabel(kind: PitchClaimKind): string {
  return `설득 — ${PITCH_CLAIM_KO[kind]}`;
}
