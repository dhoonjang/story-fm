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
 * 경기의 여운 — **팀의 결과와 자기 경기가 따로 논다.**
 * 이긴 경기에서 부진한 선수와 진 경기에서 제 몫을 한 선수는 마음이 다르다.
 */
function afterglowSentence(fact: Extract<MoodFact, { cause: "afterglow" }>): string {
  const day = dayWord(fact.days);
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
    default:
      return fact.note ?? "팀 상황";
  }
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
    case "grievance":
      return `${grievanceSubject(fact)}에 불만이 쌓여 있다`;
    case "demotion":
      return fact.days === 0 ? "오늘 2군으로 내려갔다" : `2군에 내려간 지 ${fact.days}일째다`;
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
    case "departure":
      // 라커룸 전체가 같은 사실을 든다 — 누가 그와 가까웠는지는 아직 아무도 모른다
      return `${dayWord(fact.days)} ${fact.name} 계약 해지 소식에 라커룸이 뒤숭숭하다`;
    case "contract-ending":
      return "계약이 반년 안에 끝난다";
    case "captain":
      return "주장으로 라커룸을 이끈다";
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
