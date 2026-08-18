import { ageOf } from "@story-fm/domain";
import type { GamePlayer } from "@story-fm/domain";
import { diffDays } from "../competition/calendar";
import { formLabel, RATING_BASELINE, type FormLabel } from "./form";
import { settlingOf } from "./settling";
import {
  activeContract,
  activeSuspension,
  assignmentFor,
  openInjury,
  playerById,
  playersOf,
  seasonStatOf,
  type GameState,
} from "../core/state";

/**
 * 선수의 **지금 심경 한 줄** — 무엇에 마음이 가 있는지.
 *
 * 결정적 순수 파생이다(LLM 아님). 감독이 명단에서 숫자만 보고 "왜 이렇지?"를 묻지
 * 않게 하는 게 목적이라, 상태 테이블에서 **가장 말이 되는 이유 하나**를 골라 쓰고
 * 곁들일 사정이 있으면 한 조각만 붙인다. 문장은 언제나 한 문장이다.
 *
 * ⚠️ **몸은 몸의 말로, 마음은 마음의 말로 쓴다.**
 *
 * 예전엔 `condition` 하나에서 감정까지 읽었다("몸이 무겁고 **표정도 어둡다**").
 * 그런데 그 축은 경기가 한 판에 30~50을 가져가는 **몸의 예산**이라, 경기 다음 날은
 * 누구나 바닥이다 — 이긴 다음 날에도 선수단 전원이 침울한 것으로 보였고, 승리가
 * 얹는 +4는 그 낙폭에 묻혔다. 지친 것과 풀이 죽은 것은 다른 사실이다.
 *
 * 그래서 지금은 마음의 근거를 마음 쪽에서 읽는다 — **직전 경기의 결과와 그
 * 선수의 평점**, 불만, 정착, 출전 기회, 폼. 체력은 감정어 없이 **사실로만**
 * 곁들인다("다리가 무겁다").
 *
 * 우선순위는 "감독이 지금 조치해야 하는 순서"다 — 못 뛰는 사유(부상·정지)가 먼저,
 * 그다음 직전 경기의 여운, 마음(불만·정착), 출전 기회, 폼, 마지막이 몸이다.
 */

/** 경기의 여운이 남아 있는 기간 — 이 안이면 심경이 그 경기에 매여 있다 */
const AFTERGLOW_DAYS = 3;

/**
 * 폼이 말하는 것 — **대역은 `formLabel`이 갖는다.** 문턱을 숫자로 옮겨 적으면
 * 한쪽만 옮겨졌을 때 이 가지가 소리 없이 죽는다. "평소"는 말할 거리가 아니라 null이다.
 */
const FORM_MOOD: Record<FormLabel, string | null> = {
  절정: "경기력이 절정이라 무엇을 해도 되는 시기다",
  상승세: "최근 경기력이 물올라 자신감이 붙었다",
  평소: null,
  침체: "최근 경기력이 가라앉아 스스로도 답답해한다",
  바닥: "경기력이 바닥이라 스스로도 어쩔 줄 모른다",
};

interface LastMatch {
  outcome: "win" | "draw" | "loss";
  /** 그 경기에서 받은 평점 (없으면 기록이 안 남은 경기) */
  rating: number | null;
  days: number;
}

/**
 * 그 선수가 마지막으로 뛴 우리 경기 — **평점이 남은 경기만** 본다.
 *
 * 평점은 유저 팀 경기에만 기록되므로(`MATCH.result.ratings`) 이 함수는 곧
 * "감독이 지켜본 경기"를 고르는 셈이다. 타 팀 경기의 여운까지 흉내 내지 않는다.
 */
function lastMatchOf(state: GameState, playerId: string): LastMatch | null {
  const rated = state.matches
    .filter((m) => m.result?.ratings?.[playerId] !== undefined && m.date <= state.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const match = rated[0];
  if (!match?.result) return null;
  const home = match.homeTeamId === state.userTeamId;
  const ours = home ? match.result.homeGoals : match.result.awayGoals;
  const theirs = home ? match.result.awayGoals : match.result.homeGoals;
  return {
    outcome: ours > theirs ? "win" : ours === theirs ? "draw" : "loss",
    rating: match.result.ratings?.[playerId] ?? null,
    days: diffDays(match.date, state.date),
  };
}

/**
 * 경기의 여운 한 마디 — **팀의 결과와 자기 경기가 따로 논다.**
 * 이긴 경기에서 부진한 선수와 진 경기에서 제 몫을 한 선수는 마음이 다르다.
 */
function afterglow(last: LastMatch): string {
  const day = last.days === 0 ? "오늘" : last.days === 1 ? "어제" : `${last.days}일 전`;
  // 평점이 없으면 팀 결과만 말한다
  if (last.rating === null) {
    return last.outcome === "win"
      ? `${day} 승리의 여운이 남아 있다`
      : last.outcome === "draw"
        ? `${day} 무승부가 아쉽다`
        : `${day} 패배가 마음에 남아 있다`;
  }
  const good = last.rating >= RATING_BASELINE + 0.6;
  const poor = last.rating <= RATING_BASELINE - 0.6;
  if (last.outcome === "win") {
    if (good) return `${day} 이긴 경기에서 제 몫을 해내 어깨가 올라가 있다`;
    if (poor) return `${day} 팀은 이겼지만 자기 경기가 마음에 걸린다`;
    return `${day} 승리로 팀 분위기가 좋다`;
  }
  if (last.outcome === "draw") {
    if (good) return `${day} 비겼지만 자기 경기는 나쁘지 않았다`;
    if (poor) return `${day} 무승부에 자기 몫도 못했다는 생각이다`;
    return `${day} 무승부가 아쉽다`;
  }
  if (good) return `${day} 패배에도 자기 몫은 해냈다는 얼굴이다`;
  if (poor) return `${day} 패배가 자기 탓 같아 말이 없다`;
  return `${day} 패배가 마음에 남아 있다`;
}

/**
 * **감독이 읽는 심경 한 줄** — 코어 앵커 위에 결산이 다시 쓴 문장이 있으면 그것.
 *
 * 화면과 조회 도구는 전부 이 함수를 부른다(`describeMood`를 직접 부르지 않는다).
 * 앵커만으로도 게임은 완결되므로 결산이 실패해도 빈 줄이 남지 않는다.
 */
export function moodOf(state: GameState, player: GamePlayer): string {
  const note = player.state.moodNote;
  if (!note) return describeMood(state, player);
  /**
   * **사실이 바뀌면 코어가 이긴다.** 다치거나 정지를 먹은 선수에게 지난주의
   * 결이 그대로 붙어 있으면 화면이 거짓말을 한다 — 그 둘은 다른 무엇보다 먼저
   * 말해야 하는 사실이라 앵커가 이미 문장 전체를 차지한다.
   */
  if (openInjury(state, player.id) || activeSuspension(state, player.id)) {
    return describeMood(state, player);
  }
  // 지난주의 결이 오늘의 심경인 척하지 않는다
  if (diffDays(note.on, state.date) > MOOD_NOTE_DAYS) return describeMood(state, player);
  return note.text;
}

/** 다시 쓴 문장이 살아 있는 기간 — 지나면 앵커로 돌아간다 */
export const MOOD_NOTE_DAYS = 10;

/** 코어 앵커 — 결산이 없어도 게임이 완결되는 문장 */
export function describeMood(state: GameState, player: GamePlayer): string {
  const parts: string[] = [];

  const injury = openInjury(state, player.id);
  const suspension = activeSuspension(state, player.id);
  const issue = state.issues.find((i) => i.gamePlayerId === player.id);
  const assignment = assignmentFor(state, player.id);
  const stat = seasonStatOf(state, player.id);
  const contract = activeContract(state, player.id);
  const settling = settlingOf(state, player.id);
  const { form, condition } = player.state;

  // ── 못 뛰는 사유가 있으면 그게 전부다 ──
  if (injury) {
    const back = Math.max(0, diffDays(state.date, injury.expectedReturn));
    parts.push(
      back > 0
        ? `${injury.bodyPart} 부상으로 재활 중 — 복귀까지 약 ${back}일`
        : `${injury.bodyPart} 부상에서 막 복귀했다`,
    );
  } else if (suspension) {
    const left = suspension.lengthMatches - suspension.served;
    parts.push(`출장 정지 ${left}경기가 남아 몸이 근질거린다`);
  } else {
    /**
     * ── 직전 경기의 여운 ──
     * 방금 뛴 경기가 있으면 그것이 지금 마음을 가장 크게 차지한다. 불만보다
     * 앞에 두지는 않는다 — 불만은 감독이 손을 써야 하는 일이고 여운은 지나간다.
     */
    const last = lastMatchOf(state, player.id);
    const fresh = last !== null && last.days <= AFTERGLOW_DAYS;

    // ── 마음 ──
    if (issue) {
      parts.push(`${issue.note || "팀 상황"}에 불만이 쌓여 있다`);
    } else if (settling && !settling.done) {
      // 남은 날짜를 말하지 않는다 — 얼마나 걸릴지는 감독이 앞으로 뭘 하느냐에 달렸다
      parts.push(
        settling.matches === 0
          ? "아직 새 팀에서 겉돈다 — 그라운드를 밟아 본 적이 없다"
          : `새 팀에 녹아드는 중이다 (${Math.round(settling.progress * 100)}%)`,
      );
    } else if (fresh && last) {
      parts.push(afterglow(last));
    }

    /**
     * ── 출전 기회 ── 시즌이 굴러가는데 못 뛰고 있으면 그 자체가 동기 문제다.
     *
     * ⚠️ **개막 전에는 말하지 않는다.** 프리시즌엔 아무도 뛴 적이 없어서 이 줄이
     * 벤치 전원에게 걸렸다 — 7월의 선수단이 통째로 "아직 출전 기회를 기다리고
     * 있다"였다. 있으나 마나 한 `season >= 1`(시즌 번호는 늘 1 이상이다) 대신
     * 리그 개막일을 본다.
     */
    const apps = stat?.apps ?? 0;
    if (parts.length === 0 && apps === 0 && state.date >= state.calendar.start) {
      const role = assignment?.role;
      if (role === "bench") parts.push("아직 출전 기회를 기다리고 있다");
      else if (!role) parts.push("명단 밖이라 존재감을 보여줄 자리가 없다");
    }

    // ── 폼 ── 시기를 말한다 (대역은 `formLabel`이 갖는다)
    if (parts.length === 0) {
      const said = FORM_MOOD[formLabel(form)];
      if (said !== null) parts.push(said);
    }

    /**
     * ── 몸 ── **사실만 말한다.**
     * 경기 다음 날은 누구나 바닥이므로 여기서 감정을 읽으면 승패와 무관하게
     * 선수단 전원이 침울해진다. 여운이 남은 경기가 있으면 그쪽이 이미 마음을
     * 말했으니 몸은 곁들임으로만 붙는다.
     */
    if (condition <= 35) parts.push("다리가 무겁다");
    else if (condition >= 85 && parts.length === 0) parts.push("몸이 가볍다");
  }

  // ── 곁들임: 지금 조치하지 않으면 놓칠 사정 ──
  if (!injury && contract) {
    const left = diffDays(state.date, contract.until);
    if (left >= 0 && left <= 180) parts.push("계약이 반년 안에 끝난다");
  }
  if (player.isCaptain && parts.length < 2) parts.push("주장으로 라커룸을 이끈다");
  if (!injury && !suspension && ageOf(player.birthdate, state.date) <= 20 && parts.length < 2) {
    parts.push("아직 어리고 배울 게 많다");
  }

  if (parts.length === 0) parts.push("특별한 기복 없이 지내고 있다");
  return `${parts.slice(0, 2).join(", ")}.`;
}

// ── 결산 — 맥락을 읽고 다시 쓰는 자리 ────────────────────

/**
 * 한 번에 다시 쓰는 인원의 상한 — **싼 티어라도 43명을 매번 태우지는 않는다.**
 * 그 구간에 실제로 무슨 일이 있었던 선수만 고르므로 대개 이 수를 채우지 않는다.
 */
export const MOOD_BATCH = 8;

export interface MoodTarget {
  playerId: string;
  name: string;
  /** 코어가 낸 앵커 — 모델은 이걸 다시 쓴다 */
  anchor: string;
  /** 왜 이 선수가 대상인가 — 모델이 읽는 맥락 */
  facts: string[];
  /** 불만이 걸려 있는가 — 코어가 문장을 검사할 때 쓴다 */
  hasIssue: boolean;
}

export interface MoodBrief {
  from: string;
  to: string;
  targets: MoodTarget[];
}

/**
 * **그 구간에 무슨 일이 있었던 선수**를 골라 브리프를 만든다.
 *
 * 못 뛰는 선수(부상·정지)는 넣지 않는다 — 앵커가 이미 정확하고, 그 사실은 다른
 * 무엇보다 먼저 말해야 해서 다시 쓸 여지가 없다. 나머지는 경기에 뛰었거나,
 * 불만이 있거나, 정착 중이거나, 폼이 양 끝에 가 있는 선수다.
 *
 * @returns 대상이 없으면 null — 그럼 결산을 부르지 않는다
 */
export function buildMoodBrief(state: GameState, from: string, to: string): MoodBrief | null {
  const targets: Array<MoodTarget & { weight: number }> = [];
  for (const player of playersOf(state, state.userTeamId)) {
    if (openInjury(state, player.id) || activeSuspension(state, player.id)) continue;
    const facts: string[] = [];
    let weight = 0;

    const last = lastMatchOf(state, player.id);
    if (last && last.days <= AFTERGLOW_DAYS) {
      const outcome = last.outcome === "win" ? "승" : last.outcome === "draw" ? "무" : "패";
      facts.push(
        `${last.days === 0 ? "오늘" : `${last.days}일 전`} 경기 ${outcome}` +
          (last.rating === null ? "" : ` · 평점 ${last.rating.toFixed(1)}`),
      );
      weight += 3;
    }
    const issue = state.issues.find((i) => i.gamePlayerId === player.id);
    if (issue) {
      facts.push(`불만: ${issue.note || "팀 상황"} (${issue.since}부터)`);
      weight += 4;
    }
    const settling = settlingOf(state, player.id);
    if (settling && !settling.done) {
      facts.push(`새 팀 정착 ${Math.round(settling.progress * 100)}%`);
      weight += 2;
    }
    const { form, condition } = player.state;
    const label = formLabel(form);
    if (label === "절정" || label === "바닥") {
      facts.push(`폼 ${label}`);
      weight += 2;
    }
    if (facts.length === 0) continue;

    facts.push(`체력 ${Math.round(condition)}`);
    if (player.isCaptain) facts.push("주장");
    targets.push({
      playerId: player.id,
      name: player.name,
      anchor: describeMood(state, player),
      facts,
      hasIssue: issue !== undefined,
      weight,
    });
  }
  if (targets.length === 0) return null;
  targets.sort((a, b) => b.weight - a.weight);
  return {
    from,
    to,
    targets: targets.slice(0, MOOD_BATCH).map((t) => ({
      playerId: t.playerId,
      name: t.name,
      anchor: t.anchor,
      facts: t.facts,
      hasIssue: t.hasIssue,
    })),
  };
}

/**
 * 결산 결과를 장부에 적는다 — **사실은 코어가 잡고 결만 받는다.**
 *
 * 버려지는 문장은 앵커를 남긴다(빈 줄이 되지 않는다). 거르는 조건은 셋이다:
 * ① 대상이 아닌 선수 ② 한 문장이 아니거나 너무 긴 문장 ③ **불만이 걸린 선수인데
 * 그 사실이 문장에 없는 것** — 감독이 손을 써야 하는 일이 결에 묻히면 안 된다.
 *
 * @returns 실제로 반영된 수
 */
export function applyMoodNotes(
  state: GameState,
  brief: MoodBrief,
  notes: Array<{ playerId: string; text: string }>,
): number {
  const byId = new Map(brief.targets.map((t) => [t.playerId, t] as const));
  let applied = 0;
  for (const note of notes) {
    const target = byId.get(note.playerId);
    if (!target) continue;
    const text = note.text.trim();
    if (text.length === 0 || text.length > 120) continue;
    // 한 문장 — 마침표가 문장 중간에 여러 번 나오면 여러 문장이다
    if ((text.match(/[.!?]/gu) ?? []).length > 1) continue;
    if (target.hasIssue && !text.includes("불만")) continue;
    const player = playerById(state, note.playerId);
    if (!player) continue;
    player.state.moodNote = { text: text.endsWith(".") ? text : `${text}.`, on: state.date };
    applied += 1;
  }
  return applied;
}
