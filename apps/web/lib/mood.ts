import { milestonePhrase, PLAYER_ARCHETYPE_LABEL, SQUAD_STATUS_KO } from "@story-fm/domain";
import type { MilestoneCode } from "@story-fm/domain";
import type { MoodFact, MoodRead } from "@story-fm/engine";

/**
 * **심경 한 줄을 쓰는 자리.** 코어는 사실 카드만 내고 문장은 여기서 만든다
 * (docs/overview.md §1 철칙 4 · docs/data/people.md §5).
 *
 * 결산(mood-rater)이 다시 쓴 줄이 있으면 그것이 이긴다 — 맥락을 읽은 문장이라
 * 규칙이 만든 문장보다 언제나 낫다. 없을 때만 카드를 옮겨 적는다.
 */

/** 며칠 전인가 — 사람이 세는 말로 */
function dayWord(days: number): string {
  return days === 0 ? "오늘" : days === 1 ? "어제" : `${days}일 전`;
}

/**
 * 그 경기가 세운 기록 한 마디 — 코어가 주는 것은 코드와 눈금뿐이라
 * (`milestoneTitle`) 문장은 여기서 만든다. 넷이 서로 다르게 읽혀야 한다:
 * 데뷔전은 실감이 없고, 첫 골은 오래 기다린 것이고, 문턱은 쌓아 온 것이고,
 * 해트트릭은 그날 하루의 일이다.
 */
function milestoneSentence(day: string, m: { code: MilestoneCode; value: number }): string {
  // 무엇을 세웠는지의 말은 코어가 갖는다 — 여기서 만드는 것은 그 뒤의 문장이다
  const what = milestonePhrase(m.code, m.value);
  switch (m.code) {
    case "debut":
      return `${day} 데뷔전을 치렀다`;
    case "first-goal":
      return `${day} 이 구단에서의 첫 골을 넣었다`;
    case "apps":
      return `${day} ${what}를 채웠다`;
    case "goals":
      return `${day} ${what}을 채웠다`;
    case "hat-trick":
      return `${day} ${what}을 기록했다`;
  }
}

/** 기록 뒤에 붙는 한 마디 — 같은 데뷔전도 이긴 날과 진 날이 다르다 */
const MILESTONE_OUTCOME_TAIL: Record<"win" | "draw" | "loss", string> = {
  win: "이긴 날이라 더 오래 남는다",
  draw: "팀은 비겼다",
  loss: "팀이 진 날이라 마음껏 웃지 못한다",
};

/**
 * 경기의 여운 — **팀의 결과와 자기 경기가 따로 논다.**
 * 이긴 경기에서 부진한 선수와 진 경기에서 제 몫을 한 선수는 마음이 다르다.
 */
function afterglowSentence(fact: Extract<MoodFact, { cause: "afterglow" }>): string {
  const day = dayWord(fact.days);
  /**
   * 기록이 있으면 **그것이 먼저다.** 데뷔전을 치른 열여덟에게 그날의 마음은 팀의
   * 승패보다 자기 기록이고, 평점은 그 앞에서 할 말이 못 된다. 승패는 뒤에 한
   * 마디로만 붙는다 (people.md §5 — 새 카드가 아니라 여운의 일부다).
   */
  if (fact.milestone) {
    return `${milestoneSentence(day, fact.milestone)} — ${MILESTONE_OUTCOME_TAIL[fact.outcome]}`;
  }
  // 평점이 없으면(기록이 안 남은 경기) 팀 결과만 말한다
  if (fact.rating === null) {
    return fact.outcome === "win"
      ? `${day} 승리의 여운이 남아 있다`
      : fact.outcome === "draw"
        ? `${day} 무승부가 아쉽다`
        : `${day} 패배가 마음에 남아 있다`;
  }
  if (fact.outcome === "win") {
    if (fact.own === "good") return `${day} 이긴 경기에서 제 몫을 해내 어깨가 올라가 있다`;
    if (fact.own === "poor") return `${day} 팀은 이겼지만 자기 경기가 마음에 걸린다`;
    return `${day} 승리로 팀 분위기가 좋다`;
  }
  if (fact.outcome === "draw") {
    if (fact.own === "good") return `${day} 비겼지만 자기 경기는 나쁘지 않았다`;
    if (fact.own === "poor") return `${day} 무승부에 자기 몫도 못했다는 생각이다`;
    return `${day} 무승부가 아쉽다`;
  }
  if (fact.own === "good") return `${day} 패배에도 자기 몫은 해냈다는 얼굴이다`;
  if (fact.own === "poor") return `${day} 패배가 자기 탓 같아 말이 없다`;
  return `${day} 패배가 마음에 남아 있다`;
}

/** 무엇에 불만인가 — 옛 세이브는 사유 대신 문장을 들고 있다 */
function grievanceSubject(fact: Extract<MoodFact, { cause: "grievance" }>): string {
  switch (fact.reason) {
    case "minutes":
      return "출전 기회";
    case "losing-run":
      return fact.count === null ? "연패" : `${fact.count}연패`;
    case "early-return":
      return "휴가를 반납한 소집";
    case "demotion":
      return "2군 강등";
    case "listed":
      return "이적 리스트에 오른 것";
    case "blocked-move":
      return "감독이 막은 이적";
    case "contract":
      return "재계약 이야기가 없는 것";
    case "out-of-position":
      return fact.count === null ? "자리 밖 기용" : `${fact.count}경기 이어진 자리 밖 기용`;
    case "promise":
      // 감독 자신이 세운 원인이라 출전 부족과 다른 말이 된다 (people.md §5·§5-2).
      // 어느 갈래의 약속이었는지는 카드가 들지 않는다 — 장부의 일이다
      return "감독이 지키지 않은 약속";
    default:
      return fact.note ?? "팀 상황";
  }
}

/**
 * 출전 불만은 **지위가 잰다** (people.md §5·§5-2) — "출전 기회에 불만"만 적으면
 * 백업의 침묵과 핵심의 불만이 한 줄로 읽힌다. 코어가 그 불만을 세운 지위와 창의
 * 수치를 함께 실어 줄 때만 그것으로 쓴다 (다른 사유·옛 카드에는 없다).
 */
function minutesSentence(fact: Extract<MoodFact, { cause: "grievance" }>): string | null {
  const { status, starts, played } = fact;
  if (status === undefined || starts === undefined || played === undefined) return null;
  const seat = SQUAD_STATUS_KO[status];
  return starts === 0
    ? `${seat}인데 최근 ${played}경기에서 한 번도 선발로 서지 못했다`
    : `${seat}인데 최근 ${played}경기 중 ${starts}경기만 선발이다`;
}

/**
 * 폼이 말하는 것 — **대역은 코어의 `formLabel`이 갖는다.** "평소"는 말할 거리가
 * 아니라 카드가 서지 않으므로 여기에도 오지 않는다.
 */
const FORM_SENTENCE: Record<Extract<MoodFact, { cause: "form" }>["label"], string> = {
  절정: "경기력이 절정이라 무엇을 해도 되는 시기다",
  상승세: "최근 경기력이 물올라 자신감이 붙었다",
  평소: "특별한 기복 없이 지내고 있다",
  침체: "최근 경기력이 가라앉아 스스로도 답답해한다",
  바닥: "경기력이 바닥이라 스스로도 어쩔 줄 모른다",
};

/** 카드 한 장 → 한 마디 */
function sentenceOf(fact: MoodFact): string {
  switch (fact.cause) {
    case "injury":
      return fact.daysToReturn > 0
        ? `${fact.bodyPart} 부상으로 재활 중 — 복귀까지 약 ${fact.daysToReturn}일`
        : `${fact.bodyPart} 부상에서 막 복귀했다`;
    case "suspension":
      return `출장 정지 ${fact.matchesLeft}경기가 남아 몸이 근질거린다`;
    case "retiring":
      /**
       * 사유마다 다른 마음이다 — 나이로 그만두는 것과 뛰지 못해 그만두는 것은
       * 라커룸에서 같은 말이 아니다 (season.md §6).
       */
      return fact.reason === "idle"
        ? "이번 시즌 뒤 그만둔다 — 마지막 해에 그라운드를 밟지 못했다"
        : fact.reason === "decline"
          ? "이번 시즌 뒤 그만둔다 — 몸이 예전 같지 않다는 걸 스스로 안다"
          : "이번 시즌이 마지막이다 — 은퇴를 밝혔다";
    case "grievance": {
      // 누구의 불만인가를 함께 말한다 — 같은 사유라도 사람이 다르면 감독이 할 일이 다르다
      const who = PLAYER_ARCHETYPE_LABEL[fact.archetype];
      const minutes = fact.reason === "minutes" ? minutesSentence(fact) : null;
      return minutes
        ? `${minutes} (${who})`
        : `${grievanceSubject(fact)}에 불만이 쌓여 있다 (${who})`;
    }
    case "demotion": {
      /**
       * 문턱은 사람마다 다르고 추첨이 없다 — 그래서 **감독이 날짜를 셀 수 있다**
       * (people.md §5). 남은 날을 약속하는 것이 아니라 그의 한계를 적는 것이다.
       */
      const who = `${PLAYER_ARCHETYPE_LABEL[fact.archetype]} — ${fact.patienceDays}일까지 참는다`;
      return fact.days === 0
        ? `오늘 2군으로 내려갔다 (${who})`
        : `2군에 내려간 지 ${fact.days}일째다 (${who})`;
    }
    case "settling":
      // 남은 날짜를 말하지 않는다 — 얼마나 걸릴지는 감독이 앞으로 뭘 하느냐에 달렸다
      return fact.matches === 0
        ? "아직 새 팀에서 겉돈다 — 그라운드를 밟아 본 적이 없다"
        : `새 팀에 녹아드는 중이다 (${fact.percent}%)`;
    case "afterglow":
      return afterglowSentence(fact);
    case "no-minutes":
      return fact.place === "bench"
        ? "아직 출전 기회를 기다리고 있다"
        : "명단 밖이라 존재감을 보여줄 자리가 없다";
    case "form":
      return FORM_SENTENCE[fact.label];
    case "condition":
      // 몸은 몸의 말로 — 여기서 감정을 읽으면 경기 다음 날 선수단 전원이 침울해진다
      return fact.level === "heavy" ? "다리가 무겁다" : "몸이 가볍다";
    case "sharpness":
      // 체력과 다른 축이다 — 잘 쉬었는데도 90분의 리듬이 몸에 없는 상태다
      return fact.band === "blunt"
        ? "오래 못 뛰어 경기 감각이 굳었다"
        : "경기 감각이 아직 덜 올라왔다";
    case "departure":
      // 라커룸 전체가 같은 사실을 든다 — 누가 그와 가까웠는지는 아직 아무도 모른다
      return `${dayWord(fact.days)} ${fact.name} 계약 해지 소식에 라커룸이 뒤숭숭하다`;
    case "contract-ending":
      return "계약이 반년 안에 끝난다";
    case "leader":
      // 완장 둘과 리더 그룹 — 서열은 감독이 채운 완장과 코어가 낸 순위 둘 다에서 온다
      return fact.role === "captain"
        ? "주장으로 라커룸을 이끈다"
        : fact.role === "vice"
          ? "부주장으로 주장 옆에 선다"
          : "라커룸에서 목소리가 서는 축이다";
    case "young":
      return "아직 어리고 배울 게 많다";
    case "steady":
      return "특별한 기복 없이 지내고 있다";
  }
}

/** 심경 한 줄 — 결산이 다시 쓴 문장이 있으면 그것, 없으면 카드를 옮겨 적는다 */
export function moodSentence(mood: MoodRead): string {
  if (mood.note !== null) return mood.note;
  if (mood.facts.length === 0) return "특별한 기복 없이 지내고 있다.";
  return `${mood.facts.map(sentenceOf).join(", ")}.`;
}
