import { z } from "zod";
import { DateString } from "./date-string";
import { BOARD_DEMAND_CAUSE_LABEL, boardDemandText, type BoardDemandCause } from "./board-demand";
import { formatMoney } from "./money";
import {
  ApproachChannelSchema,
  LEADER_ROLE_LABEL,
  LeaderRoleSchema,
  type ApproachChannel,
} from "./persona";
import {
  boardExpectationText,
  INTEREST_STAGE_KO,
  visionItemText,
  VISION_CODES,
  milestonePhrase,
  PLAYER_ISSUE_REASONS,
  PROMISE_KIND_KO,
  TRANSFER_REQUEST_REASON_KO,
  type BoardExpectationCode,
  type InterestStage,
  type MilestoneCode,
  type PlayerIssueReason,
  type PromiseKind,
  type TransferRequestReason,
  type VisionCode,
} from "./records";
import { SQUAD_STATUS_KO, type SquadStatus } from "./squad-rules";
import { TACTIC_AXIS_KEYS, type TacticAxisKey } from "./tactics";

/**
 * 기자회견 (PRESS_CONFERENCE) — 세계가 감독에게 **대답을 요구하는 자리**.
 *
 * 감독의 다른 손잡이(훈련·전술·이적)는 전부 감독이 먼저 손을 뻗는 것이지만,
 * 회견은 **세계가 먼저 부른다.** 그래서 게임에서 하는 일이 다르다: 감독이 아무것도
 * 하지 않아도 사건이 생기고, 답하지 않는 것조차 하나의 답이 된다.
 *
 * ## 왜 상태에 남기나
 *
 * 회견은 "열렸다 → 감독이 답했거나 거절했다"라는 **두 시점 사이에 걸쳐 있다.**
 * 채팅 한 턴 안에서 끝나지 않으므로(감독이 다음 날 답할 수도 있다) 진행 중인
 * 협상(`NEGOTIATION`)처럼 세이브가 들고 있어야 한다.
 */

/** 무엇이 이 회견을 불렀나 — 질문의 결이 여기서 갈린다 */
export const PressTriggerSchema = z.enum([
  /** 경기 뒤 — 매 경기 붙는다 (실제 리그의 의무 회견) */
  "match",
  /** 큰 이적 — 영입·매각 성사, 또는 핵심 선수를 향한 오퍼 */
  "transfer",
  /** 연패·부진 등 감독 자리가 흔들릴 때 */
  "pressure",
  /** 시즌 개막 전야 — 우리 첫 리그 경기 전날 */
  "opening",
  /** 더비 전야 — 더비 표의 대진 전날 */
  "derby",
  /** 마지막 홈경기 전야 — 은퇴 예고가 선 선수가 있을 때 (season.md §6) */
  "farewell",
  /**
   * **부임한 날** — 새 게임의 첫날과 이직·부임이 같은 문을 지난다 (career.md §5.1).
   * 앞 구단의 열린 회견은 부임이 이미 만료로 닫은 뒤라, 이 자리가 그것을 거절로
   * 읽지 않는다.
   */
  "appointment",
  /**
   * **그 시즌 우리 마지막 리그 경기 뒤** — 경기 뒤 회견이 갈린 것이다 (people.md §4).
   * 결과도 마일스톤도 평소처럼 서고, 그 위에 최종 순위와 보드 기대가 얹힌다.
   */
  "season-end",
]);
export type PressTrigger = z.infer<typeof PressTriggerSchema>;

/** 무엇에 대한 사실인가 — 기자가 그걸 어떻게 묻는지는 기자의 몫이다 */
export const PressFactKindSchema = z.enum([
  /** 방금 치른 경기의 결과 · 최근 폼 · 더비 전적 (`tags[0]`이 가른다) */
  "result",
  /** 최근 무승 */
  "winless",
  /** 폼이 바닥인 선수 */
  "slump",
  /** 라커룸에 불만이 쌓인 선수 */
  "unhappy",
  /** 영입 확정 */
  "arrival",
  /** 매각 확정 */
  "departure",
  /** 그 영입으로 자리가 겹치는 선수들 */
  "squeezed",
  /** 출전 기회 — 시즌 출전 수와 선발 수 (다가옴 · people.md §8) */
  "minutes",
  /** 2군에 내려간 채 흐른 날 */
  "demoted",
  /** 라커룸의 온도 — 1군 평균 폼 */
  "morale",
  /** 리그에서 지금 서 있는 자리와 보드가 건 자리 */
  "standing",
  /** 전야 회견의 대진 — 상대와 날짜 (개막·더비) */
  "fixture",
  /** 언론 유출 — 방치된 불만이 신문에 실렸다 (people.md §8 계단 4) */
  "leak",
  /** 이적 요청 — 에이전트가 대리로 들고 온다 (people.md §8 계단 5) */
  "transfer-request",
  /** 열린 보드 요청 — 구단주가 이 창에 건 조건 (career.md §5.2) */
  "board-demand",
  /** 계약 만료가 다가온다 — 남은 일수와 요구 주급 (다가옴 · people.md §8) */
  "contract-demand",
  /** 타 구단의 관심 — 최근 창에서 거절·만료된 오퍼 (다가옴 · people.md §8) */
  "interest",
  /**
   * **이적 루머** — 타 구단의 관심이 문의 이상으로 올랐다 (transfer.md §1-2).
   * `interest`와 재는 것이 다르다: 그쪽은 **끝난 오퍼**를 세고 이쪽은 **아직 오퍼가
   * 아닌 관심**을 센다.
   */
  "rumour",
  /** 방금 끝난 경기가 세운 기록 — 데뷔·첫 골·구단 통산 문턱·해트트릭 (match.md §6) */
  "milestone",
  /** 이번 시즌 뒤 은퇴 — 1월에 선 예고 (season.md §6) */
  "retirement",
  /** 그 시즌 마지막 홈경기 — 전야는 대진, 경기 뒤는 그가 뛰었는가 (season.md §6) */
  "farewell",
  /**
   * **상징 번호가 비었다** — 은퇴·이적으로 1·7·9·10·11 중 하나가 주인을 잃었고,
   * 원형이 그것을 원하는 선수가 있다 (player.md §1.1 · people.md §6·§7).
   * `about`이 원하는 선수, `name`이 앞서 그 번호를 달던 사람이다.
   */
  "number-open",
  /**
   * **번호를 물려받았다** — 계보가 있는 번호를 감독이 누군가에게 줬다.
   * `about`이 받은 선수, `name`이 앞서 달던 사람, `since`가 몇 시즌 만인가다.
   */
  "number-inherited",
  /**
   * **감독 통산의 문턱** — 경기·승이 눈금을 넘은 그 경기의 회견에 선다
   * (career.md §6). `tags[0]`이 `matches`인지 `wins`인지, `values.value`가 그 눈금이다.
   */
  "manager-milestone",
  /**
   * **감독 자신의 거취** — 계약 만료 90일 안의 회견마다 선다 (career.md §5.4).
   * `tags[0]`이 보드의 판정 코드, `values.days`가 만료까지 남은 일수다.
   */
  "manager-contract",
  /**
   * **감독이 사재를 구단에 넣었다** — 시즌 누적이 문턱을 넘은 자리 (career.md §5.4).
   * `tags[0]`이 등급 코드, `values`가 시즌 누계(`amount`)·구단 예산 약속 대비
   * 백분율(`percent`)·사재 보너스를 받은 인원(`players`)이다.
   */
  "manager-fund",
  /**
   * **벤치가 비었다** — 전임이 어떻게 물러났나(부임 회견), 또는 라이벌 구단의 경질.
   * `tags[0]`이 그 둘을 가른다.
   */
  "sacking",
  /**
   * **이 선수단의 중심** — 부임 회견이 짚는 1군 최고 자원 (people.md §4).
   * 감독이 처음 이름을 부를 수 있는 자리라 `about`이 걸린다.
   */
  "key-player",
  /**
   * **지난 시즌의 보드 평가** — 최종 순위·그 시즌의 기대와 갈래·달성 여부
   * (시즌 리뷰 면담 — career.md §5). `tags[0]`이 등급, `tags[1]`이 기대의 갈래다.
   */
  "season-verdict",
  /**
   * **클럽 비전 한 항목의 진행도** — 코드·목표·달성률·가중치 (career.md §5).
   * `tags[0]`이 항목 코드, `tags[1]`은 `style`일 때만 그 축이다.
   */
  "vision",
  /** 그 시즌 구단주 요청(§5.2)의 이행·불이행 건수 */
  "demands-kept",
  /** 새 시즌 이적 예산 — 구단주가 자리에서 밝히는 숫자다 */
  "budget",
  /**
   * **상대 감독의 말** — 이번 대진의 반대편 벤치가 마이크 앞에서 무슨 결로 말했나
   * (people.md §4). `tags[0]`이 결 코드(`RIVAL_VOICES`), `name`이 그 감독이자
   * 캐릭터북의 `characterId`, `refId`가 상대 구단이다.
   *
   * 카드가 드는 것은 **이름과 결 하나뿐이다** — 대사를 코어에 박으면 그 사람이
   * 시즌 내내 같은 말을 한다 (overview.md §1 철칙 4).
   */
  "rival-quote",
]);
/**
 * 회견의 재료 — **사실 한 줄.** 질문이 아니다.
 *
 * ⚠️ 코어가 질문 문장을 박아 두면 세 가지를 잃는다: ① 시즌 내내 같은 말이 반복되고
 * ② 화자의 성격이 문장에 닿지 못하며 ③ 맥락(더비인가, 감독이 어제 뭐라 했나)이
 * 반영되지 않는다. 코어가 지켜야 할 것은 **사실**이지 문장이 아니다 —
 * 무엇이 사실인지는 코어가 정하고, 그것을 어떻게 묻는지는 기자가 정한다
 * (→ docs/data/people.md §1).
 *
 * `about`이 있으면 **그 선수에 대한 사실**이다 — 감독의 답이 그 선수의 사기에
 * 직접 닿는다. 공개적으로 감쌀 수도, 공개적으로 자를 수도 있는 자리다.
 */
/**
 * 사실 카드가 드는 **수치** — 갈래(`kind`)마다 채우는 칸이 다르다.
 *
 * 한 줄의 한국어는 이 카드를 읽는 쪽이 만든다. 문장을 세이브에 적어 두면 문구를
 * 고쳐도 지난 회견은 옛 말로 남고, 기자의 성격도 그날의 맥락도 그 문장에 닿지
 * 못한다 (→ docs/data/people.md §4).
 */
export const PressFactDataSchema = z.object({
  /** 이 사실이 함께 가리키는 대상 — 상대 팀·자리가 겹치는 선수 (id) */
  refId: z.string().min(1).optional(),
  /** 그때의 이름 — 카탈로그가 이름을 고쳐도 그 줄이 말한 상대는 그 사람이다 */
  name: z.string().min(1).optional(),
  /** 라벨 붙은 수치 — `{ for: 1, against: 3 }` · `{ days: 32 }` · `{ rank: 14, target: 7 }` */
  values: z.record(z.string(), z.number()).optional(),
  /**
   * 갈래 안의 갈래 — **`tags[0]`이 그 갈래의 하위 코드다.** 한 `kind`가 여러 모양의
   * 사실을 담는 자리(경기 결과와 최근 폼, 영입 확정과 여름 최대 영입)를 그것으로
   * 가른다. 나머지 칸은 그 하위 코드가 정한다: 승/무/패 · 홈/원정 · 불만 사유 ·
   * 포지션 코드 · 폼 라벨.
   */
  tags: z.array(z.string().min(1)).optional(),
  /** 그 사실이 가리키는 날 — 보드 요청의 기한처럼 수치가 아닌 날짜 */
  date: DateString.optional(),
});
export type PressFactData = z.infer<typeof PressFactDataSchema>;

export const PressFactSchema = z.object({
  kind: PressFactKindSchema,
  /** 그 갈래의 수치 — 옛 세이브엔 없다(optional) */
  data: PressFactDataSchema.optional(),
  /** 옛 세이브가 들고 있는 사실 문장 — 새 카드는 적지 않는다 (`data`의 폴백) */
  text: z.string().min(1).optional(),
  /** 이 사실이 걸린 선수 (`GAME_PLAYER.id`) — 없으면 팀·감독에 대한 사실 */
  about: z.string().nullable(),
  /** 날 선 자리인가 — 답변의 파장(한도)을 키운다 */
  sharp: z.boolean(),
});
export type PressFact = z.infer<typeof PressFactSchema>;

/**
 * 자리의 끝 — 답했나(`answered`), 거절·방치했나(`declined`), 아니면 **자리 자체가
 * 사라졌나**(`expired`). 만료는 감독의 선택이 아니라 세계의 사정이라 대가가 없다:
 * 이직하면 앞 구단의 열린 회견이 여기로 닫힌다 (people.md §4 · career.md §5.1).
 */
export const PressStatusSchema = z.enum(["pending", "answered", "declined", "expired"]);

export const PressConferenceSchema = z.object({
  id: z.string().min(1),
  /** 열린 날 */
  date: z.string(),
  trigger: PressTriggerSchema,
  /** 한 줄 배경 — "3연패 뒤" 같은 맥락. 사실을 읽는 데 필요한 최소한만 */
  context: z.string(),
  /** 기자가 물을 수 있는 것의 **전부** — 이 밖의 사실은 세계에 없다 */
  facts: z.array(PressFactSchema).min(1),
  /**
   * 이 자리를 여는 기자 (`Persona.characterId`).
   *
   * **세계가 먼저 여는 자리는 키워드를 기다리지 않는다.** 회견은 감독이 기자
   * 이름을 말해서 열리는 게 아니라 세계가 부르는 것이므로, 그 기자의 인물지가
   * 실릴 근거도 감독의 말이 아니라 **코어가 지목한 사실**이어야 한다
   * (overview.md §1 철칙 4 — 코어는 사실만 낸다).
   *
   * 옛 세이브엔 없다 (optional) — 없다고 로드가 막히면 안 된다.
   */
  reporterId: z.string().min(1).optional(),
  status: PressStatusSchema,
  /**
   * 이 자리가 얼마나 큰가 (1~3). 실제로 파장이 다르다 — 평범한 주중 경기 뒤
   * 회견과 더비 참패 뒤 회견에 같은 무게를 주면 둘 다 의미를 잃는다.
   * 효과 한도가 이 값에 비례한다.
   */
  weight: z.number().int().min(1).max(3),
});
export type PressConference = z.infer<typeof PressConferenceSchema>;

/**
 * 감독이 취한 태도 — 자연어 답변을 LLM이 이 중 하나로 옮긴다.
 *
 * 스탠스를 **감독에게 고르게 하지 않는** 이유: 이 게임의 인터페이스는 말이다.
 * 감독은 하고 싶은 말을 하고, 그 말이 어떤 태도였는지는 세계가 읽는다.
 */
export const PRESS_STANCES = [
  /** 선수·팀을 감싼다 — 선수단이 오르고 언론은 시큰둥하다 */
  "defend",
  /** 책임을 진다 — 보드·선수단이 오르지만 언론 앞에서 약해 보인다 */
  "own",
  /** 공개적으로 날을 세운다 — 언론은 좋아하고 라커룸은 식는다 */
  "criticise",
  /** 도발·자신감 — 언론이 물고 보드는 불안해한다 */
  "bold",
  /** 말을 아낀다 — 아무것도 크게 움직이지 않는다 */
  "deflect",
] as const;
export type PressStance = (typeof PRESS_STANCES)[number];

/**
 * 다가옴 (APPROACH) — **세계가 회견 밖에서 감독에게 말을 거는 자리** (people.md §8).
 *
 * 회견과 같은 것이 둘, 다른 것이 둘이다. 같은 것: **사실 카드**(`PressFact`)를 넘기고
 * 문장은 GM이 쓴다는 것, 그리고 감독의 답을 스탠스 5종으로 옮긴다는 것. 다른 것:
 * 회견은 경기·이적이라는 **사건**이 열지만 다가옴은 **시간**이 연다(압력이 임계를
 * 넘는다), 그리고 마이크 앞이 아니라 복도와 감독실이라 언론에 실리지 않는다.
 */

/**
 * 무엇 때문에 오는가 — **선수 채널의 주제는 라커룸 불만의 사유 코드 그대로다**
 * (`PLAYER_ISSUE_REASONS`). 사유가 하나 늘면 다가옴의 주제도 함께 는다: 같은 사실을
 * 두 개의 이름으로 부르면 어느 쪽이 진짜인지 코드가 매번 다시 정해야 한다.
 */
export const APPROACH_TOPICS = [
  ...PLAYER_ISSUE_REASONS,
  /**
   * 타 구단이 우리 핵심 선수를 원했고 그 오퍼가 거절·만료됐다 — 에이전트가 온다.
   * **사유 코드가 아니다**: 불만이 걸리지 않고 원장의 사실만 서므로, 창이 지나면
   * 답 없이도 식는다 (people.md §8).
   */
  "interest",
  /** 라커룸이 식었다 — 주장이 대신 온다 */
  "morale",
  /** 성적이 보드 기대 아래다 — 구단주가 온다 (보드 요청, career.md §5) */
  "results",
  /**
   * **시즌이 끝났다** — 구단주가 지난 시즌의 평가를 들고 마주 앉는다 (career.md §5
   * 「시즌 리뷰 면담」). 압력이 아니라 **달력이 여는** 유일한 주제라 눈금도 계단도
   * 타지 않는다 (people.md §8).
   */
  "season-review",
] as const;
export const ApproachTopicSchema = z.enum(APPROACH_TOPICS);
export type ApproachTopic = z.infer<typeof ApproachTopicSchema>;

/**
 * 사다리의 절대 상한 — 스키마가 막는 값. 꼭대기는 주제마다 다르다
 * (`approachTopStep`): 불만 사유인 주제만 언론 유출(4)·이적 요청(5)으로 이어진다.
 */
export const APPROACH_MAX_STEP = 5;

/** 언론 유출이 서는 계단 — 자리가 아니라 사건이다 (people.md §8) */
export const APPROACH_LEAK_STEP = 4;

/**
 * 불만 사유 그대로인 주제인가 — **위 두 계단이 서는 자격이다.**
 *
 * 유출(4)도 이적 요청(5)도 「방치된 불만」이 있어야 서는 사건이라, 불만이 없는
 * 주제(`interest`·`morale`·`results`)는 거기까지 오를 것이 없다 (people.md §8).
 */
export function isIssueTopic(topic: ApproachTopic): topic is PlayerIssueReason {
  return (PLAYER_ISSUE_REASONS as readonly string[]).includes(topic);
}

/** 불만 사유가 아닌 주제가 멈추는 계단 — 보드 경고가 3/3에 서는 것과 같은 규약 */
export const APPROACH_PLAIN_TOP_STEP = 3;

/**
 * 이 주제의 사다리 꼭대기 — **채널이 아니라 주제가 정한다** (people.md §8).
 *
 * 채널로 재던 자리다. 계약 이야기를 에이전트가 들고 오는 순간 `agent` 채널이
 * 꼭대기 5를 뜻하기도 하고 3을 뜻하기도 해서, 한 값이 두 가지를 가리켰다.
 */
export function approachTopStep(topic: ApproachTopic): number {
  return isIssueTopic(topic) ? APPROACH_MAX_STEP : APPROACH_PLAIN_TOP_STEP;
}

/**
 * 압력 눈금 — **감독이 무엇을 하지 않았는지의 누적.**
 *
 * 세이브가 드는 값 중 장부에서 파생할 수 없는 유일한 것이다. 불만도 순위도 폼도
 * 지금의 사실이지만, "그 사실을 며칠째 두었는가"는 어디에도 원본이 없다.
 */
export const ApproachPressureSchema = z.object({
  /**
   * 이 압력의 주인 — 선수 채널이면 `GAME_PLAYER.id`, 주장·구단주 채널은 그 자리를
   * 가리키는 고정 열쇠다(선수가 바뀌어도 라커룸은 라커룸이다).
   */
  subject: z.string().min(1),
  topic: ApproachTopicSchema,
  /** 쌓인 압력 — 임계(`100 × (계단 + 1)`)를 넘으면 장면이 열린다 */
  value: z.number().min(0),
  /** 지금까지 오른 계단 — 0이면 아직 한 번도 열리지 않았다 */
  step: z.number().int().min(0).max(APPROACH_MAX_STEP),
  /** 마지막으로 이 주제의 장면이 열린 날 — 같은 화자 쿨다운이 여기서 센다 */
  openedOn: DateString.optional(),
});
export type ApproachPressure = z.infer<typeof ApproachPressureSchema>;

/**
 * 다가옴의 **한 줄 배경** — 코드와 수치. 문장은 읽는 쪽이 만든다
 * (→ docs/data/people.md §8).
 */
export const ApproachContextSchema = z.object({
  code: z.enum([
    /** 이적 요청 — 에이전트가 대리로 들고 온다 */
    "transfer-request",
    /** 방치된 불만 — `reason`이 그 사유, `days`가 그 기간 */
    "grievance",
    /** 라커룸의 온도 — 1군 평균 폼 */
    "dressing-room-form",
    /** 리그에서 서 있는 자리와 보드가 건 자리 */
    "standing",
    /** 계약 만료가 다가온다 — `value`가 남은 일수 */
    "contract-demand",
    /** 타 구단의 관심 — `value`가 최근 창의 오퍼 건수 */
    "interest",
    /**
     * 재정이 부른 구단주 요청 — 동결·강등이 그 창의 조건을 매각 요구로 갈았다
     * (career.md §5.2 「재정 갈래」). 사람을 지목한 요청이면 자리의 주인이 그
     * 선수이고, 금액 요청이면 `value`가 목표액이다.
     */
    "board-demand",
    /**
     * 시즌 리뷰 면담 — `value`가 지난 시즌 최종 순위, `limit`이 그 시즌의 기대 순위다
     * (career.md §5). 시즌 번호는 사실 카드가 든다.
     */
    "season-review",
  ]),
  /** 불만의 사유 코드 (`PLAYER_ISSUE_REASONS`) — 있는 갈래에만 */
  reason: z.enum(PLAYER_ISSUE_REASONS).optional(),
  /** 그 코드가 가리키는 값 — 기간(일)·평균 폼·현재 순위·오퍼 건수 */
  value: z.number().optional(),
  /** 그 값이 견주는 자리 — 보드가 건 순위 */
  limit: z.number().optional(),
  /**
   * 이 자리를 연 사람이 라커룸에서 선 자리 — 같은 불만이라도 주장이 들고 온 것과
   * 후보 선수가 들고 온 것은 다른 자리다 (people.md §5-1). 옛 세이브엔 없다.
   */
  leader: LeaderRoleSchema.optional(),
});
export type ApproachContext = z.infer<typeof ApproachContextSchema>;

export const ApproachSchema = z.object({
  id: z.string().min(1),
  /** 열린 날 */
  date: DateString,
  channel: ApproachChannelSchema,
  topic: ApproachTopicSchema,
  /**
   * 말을 거는 사람 (`Persona.characterId`). 선수·주장은 그 선수의 이름이고
   * 구단주는 구단주의 이름이다 — 회견의 `reporterId`와 같은 자리로 캐릭터북에
   * 실린다(people.md §6). **세계가 먼저 여는 자리는 감독이 이름을 부르기를
   * 기다리지 않는다.**
   */
  speakerId: z.string().min(1),
  /** 이 자리가 걸린 선수 — 팀·구단에 대한 자리면 없다 */
  about: z.string().nullable(),
  /** 한 줄 배경의 카드 — 옛 세이브엔 없다(optional) */
  contextCard: ApproachContextSchema.optional(),
  /** 옛 세이브가 들고 있는 배경 문장 — 새 자리는 적지 않는다 (`contextCard`의 폴백) */
  context: z.string().optional(),
  /** 그 사람이 아는 것의 **전부** — 이 밖의 사실은 이 자리에 없다 */
  facts: z.array(PressFactSchema).min(1),
  /** 사다리의 몇 번째 칸인가 — 효과의 폭이 여기 비례한다 */
  step: z.number().int().min(1).max(APPROACH_MAX_STEP),
  status: PressStatusSchema,
});
export type Approach = z.infer<typeof ApproachSchema>;

/**
 * 언론 유출 — **사다리 계단 4의 사건** (people.md §8). 방치된 불만이 신문에
 * 흘러나왔고, **다음 회견이 실어 갈 때까지만** 여기 남는다 — 회견은 두 시점에
 * 걸쳐 있어 세이브가 들지만, 유출은 소비되는 순간 카드가 되어 회견으로 옮겨
 * 간다. 옛 세이브엔 없다 (빈 배열 로드 — 세이브 버전 유지).
 */
export const PressLeakSchema = z.object({
  /** 불만의 주인 (`GAME_PLAYER.id`) — 유출은 선수 주제에만 있다 */
  playerId: z.string().min(1),
  topic: ApproachTopicSchema,
  /** 흘러나온 날 */
  date: DateString,
});
export type PressLeak = z.infer<typeof PressLeakSchema>;

/**
 * 라이벌 구단의 경질 — **유출과 같은 결의 대기열이다** (people.md §4). 더비 표의
 * 상대가 감독을 자르면 여기 서고, **다음에 열리는 회견 하나가** 싣고 비운다.
 *
 * 자리를 따로 열지 않는 이유도 유출과 같다 — 회견은 이미 경기마다 열린다.
 * 순위를 카드가 아니라 여기 적어 두는 것은 후임이 앉는 순간 그 구단의 자리가
 * 달라지기 때문이다: 그날의 사실은 그날 적어야 한다.
 * 옛 세이브엔 없다 (빈 배열 로드 — 세이브 버전 유지).
 */
export const PressSackingSchema = z.object({
  /** 잘린 구단 (`GameTeam.id`) */
  teamId: z.string().min(1),
  /** 그날 */
  date: DateString,
  /** 그날 그 구단의 리그 순위 — 순위표가 없는 구단이면 없다 */
  position: z.number().int().min(1).optional(),
});
export type PressSacking = z.infer<typeof PressSackingSchema>;

/**
 * 상대 감독이 마이크 앞에서 내는 **결** — 원형이 정하고(people.md §2 표) 카드의
 * `tags[0]`에 실린다. 문장이 아니라 코드다: 인용은 그 사람의 말투로 GM이 쓴다.
 */
export const RIVAL_VOICES = ["provoke", "respect", "analysis", "patience", "defensive"] as const;
export type RivalVoice = (typeof RIVAL_VOICES)[number];

/**
 * 그 결의 **한국어 이름** — 카드 한 줄이 되는 자리가 여기 하나다 (people.md §4).
 * 평가어도 물음표도 없다: 그가 무엇을 말했는가라는 사실이다.
 */
export const RIVAL_VOICE_KO: Record<RivalVoice, string> = {
  provoke: "우리를 찌르는 말을 했다",
  respect: "우리를 높이는 말을 했다",
  analysis: "경기를 뜯어 말했다",
  patience: "자기 팀의 긴 시야를 말했다",
  defensive: "지키는 축구를 말했다",
};

/**
 * 스탠스가 옮기는 축 — 평판 3축과 사기 셋 (`club/press.ts`의 표가 채운다).
 *
 * `rival`만 **우리 밖**이다: 상대 감독을 겨눈 답이 그 라커룸에 닿는 자리이고,
 * 그 자리에서만 산다 (people.md §4).
 */
export type PressAxis = "board" | "media" | "squad" | "target" | "team" | "rival";

/**
 * 채널이 닿는 축 — **그 자리에 있던 사람에게만 닿는다** (people.md §8).
 *
 * 회견의 스탠스 표를 그대로 쓰되 언론 축이 죽는 이유가 이것이다: 감독실 문을 닫고
 * 한 이야기가 다음 날 신문에 실리면, 사석과 마이크 앞을 가른 의미가 없다.
 */
export const APPROACH_AXES: Record<ApproachChannel, readonly PressAxis[]> = {
  player: ["squad", "target", "team"],
  captain: ["squad", "team"],
  owner: ["board"],
  // 당사자는 자리에 없지만 답은 에이전트를 타고 그에게 닿고, 라커룸은
  // 감독이 선수의 에이전트를 어떻게 대하는지 듣는다. 팀 전체는 방 밖이다.
  agent: ["squad", "target"],
};

// ── 카드에서 문장으로 ──────────────────────────────────────────

/**
 * 불만 사유의 **한국어 이름** — 문장이 아니라 이름이다 (people.md §5).
 *
 * 회견 카드·다가옴 배경·심경 사실이 같은 표를 읽는다. 사유를 자리마다 옮겨 적으면
 * 같은 불만이 화면에서 두 이름으로 선다.
 */
export const ISSUE_REASON_KO: Record<PlayerIssueReason, string> = {
  minutes: "출전 기회",
  "losing-run": "연패",
  "early-return": "휴가 반납 소집",
  demotion: "2군 강등",
  listed: "이적 리스트 등재",
  "blocked-move": "막힌 이적",
  contract: "계약 만료",
  "out-of-position": "자리 밖 기용",
  promise: "어긴 약속",
  number: "등번호",
  overload: "과부하",
};

/** 사유 이름 — 수치가 이름을 대신하는 것은 넷뿐이다. 코드가 없으면 `null` */
export function issueReasonKo(
  reason: PlayerIssueReason | null | undefined,
  count?: number | null,
): string | null {
  if (!reason) return null;
  if (count != null) {
    if (reason === "losing-run") return `${count}연패`;
    if (reason === "out-of-position") return `${count}경기 자리 밖`;
    // 등번호 불만은 **어느 번호를 잃었나**가 곧 사유다 — "등번호 불만"으로는 그 자리가 서지 않는다
    if (reason === "number") return `${count}번을 잃었다`;
    // 과부하는 **며칠째인가**가 사유의 무게다 (player.md §5.5)
    if (reason === "overload") return `${count}일째 과부하`;
  }
  return ISSUE_REASON_KO[reason];
}

const OUTCOME_KO: Record<string, string> = { win: "승", draw: "무", loss: "패" };
const SIDE_KO: Record<string, string> = { home: "홈", away: "원정" };

/** 이적료·위약금 한 조각 — 0이면 "없음"이라고 말한다 (없는 것도 사실이다) */
function feeSuffix(label: string, amount: number | undefined): string {
  return amount !== undefined && amount > 0
    ? ` · ${label} ${formatMoney(amount)}`
    : ` · ${label} 없음`;
}

/**
 * 사실 카드 한 줄 — **화면·GM·테스트가 같은 함수를 부른다** (people.md §4).
 *
 * 코어가 세이브에 적는 것은 카드뿐이라, 문구를 고치면 지난 회견의 줄까지 함께
 * 고쳐진다. 옛 세이브는 카드 없이 문장만 들고 있어 그때만 `text`로 떨어진다 —
 * **보여 주는 자리의 폴백이지 판정의 폴백이 아니다** (game-state.md §6).
 */
export function pressFactText(fact: PressFact): string {
  const d = fact.data;
  if (!d) return fact.text ?? "";
  const v = d.values ?? {};
  const tags = d.tags ?? [];
  const sub = tags[0];
  const name = d.name ?? "";
  const reason = issueReasonKo((tags[1] ?? null) as PlayerIssueReason | null) ?? "사유 불명";
  switch (fact.kind) {
    case "result":
      // 더비 전적 — 이번 경기는 세지 않았다 (people.md §4). 첫 더비면 0승 0무 0패다
      if (sub === "derby") {
        return `${tags[1] ?? "더비"} — 그 전까지 ${v.won ?? 0}승 ${v.drawn ?? 0}무 ${v.lost ?? 0}패`;
      }
      return sub === "recent"
        ? `최근 ${v.matches ?? 0}경기 ${tags
            .slice(1)
            .map((t) => OUTCOME_KO[t] ?? t)
            .join("")}`
        : `${name}전 ${v.for ?? 0}-${v.against ?? 0} ${outcomeWord(tags[1])} (${SIDE_KO[tags[2] ?? "home"] ?? ""})`;
    case "winless":
      return `최근 ${v.matches ?? 0}경기 무승 (${tags.map((t) => OUTCOME_KO[t] ?? t).join("")})`;
    case "slump":
      return name ? `${name} 폼 ${sub ?? ""}` : `폼 ${sub ?? ""}`;
    case "unhappy":
      if (sub === "count") return `라커룸 불만 ${v.count ?? 0}건`;
      if (sub === "grievance") {
        /**
         * 어긴 약속은 **감독 자신이 세운 원인**이라, 사유 이름만으로는 그 자리가
         * 서지 않는다 (people.md §5-2) — 무엇을 약속했고 그것이 며칠 전이었나까지가
         * 그 선수가 아는 사실이다. `tags[2]`가 갈래 코드, `promised`가 약속한 날부터
         * 오늘까지의 일수다. 다른 사유의 카드에는 둘 다 없다.
         */
        const kind = tags[2] as PromiseKind | undefined;
        return (
          `${reason} 불만 ${v.days ?? 0}일째` +
          (kind ? ` · ${PROMISE_KIND_KO[kind] ?? kind} 약속` : "") +
          (v.promised === undefined ? "" : ` · ${v.promised}일 전의 약속`)
        );
      }
      return `${name} 라커룸 불만 (${reason})`;
    case "arrival":
      return sub === "summer-top"
        ? `여름 최대 영입 ${name} (${formatMoney(v.fee ?? 0)})`
        : `${name} 영입 확정 (${tags[1] ?? ""})${feeSuffix("이적료", v.fee)}`;
    case "departure":
      return sub === "released"
        ? `${name} 계약 해지 (${tags[1] ?? ""})${feeSuffix("위약금", v.severance)}`
        : `${name} 매각 확정 (${tags[1] ?? ""})${feeSuffix("이적료", v.fee)}`;
    case "squeezed":
      return `${name}이(가) 같은 자리(${sub ?? ""})를 봐 왔다`;
    case "minutes":
      /**
       * 지위와 창의 수치는 **있을 때만** 선다 (people.md §5·§5-2). 이것이 없으면
       * "출전 기회 불만"이 어느 기대에 대해 모자란 것인지가 서지 않아, 백업의
       * 침묵과 핵심의 불만을 읽는 쪽이 가르지 못한다. 옛 세이브의 카드에는
       * 없으므로 그때는 앞의 두 조각만 남는다.
       */
      return (
        `출전 기회 불만 ${v.days ?? 0}일째 · 시즌 출전 ${v.apps ?? 0}경기` +
        (sub ? ` · ${SQUAD_STATUS_KO[sub as SquadStatus] ?? sub} 지위` : "") +
        (v.played === undefined ? "" : ` · 최근 ${v.played}경기 선발 ${v.starts ?? 0}회`)
      );
    case "demoted":
      return `2군 ${v.days ?? 0}일째 · 불만 ${v.issueDays ?? 0}일째`;
    case "morale":
      // 리더 그룹의 폼은 있을 때만 — 라커룸이 통째로 식은 것과 리더들만 처진 것은
      // 감독이 손댈 자리가 다르다 (people.md §5-1)
      return `1군 평균 폼 ${sub ?? ""}` + (tags[1] ? ` · 리더 그룹 ${tags[1]}` : "");
    case "standing":
      if (sub === "board-target") {
        /**
         * 갈래가 바뀐 시즌에는 **옛 기대가 함께 선다** (career.md §5 「시즌 리뷰 면담」) —
         * 승격·강등으로 체급이 옮겨 간 것을 모르면 구단주가 그 변화를 말할 근거가 없다.
         * 안 바뀐 시즌의 카드에는 `tags[2]`도 `previous`도 없다.
         */
        const before =
          tags[2] === undefined
            ? ""
            : ` (지난 시즌 ${boardExpectationText(tags[2] as BoardExpectationCode, v.previous)})`;
        return (
          `보드 기대 ${v.rank ?? 0}위 (${boardExpectationText((tags[1] ?? "mid") as BoardExpectationCode)})` +
          before
        );
      }
      if (sub === "warnings") return `보드 경고 ${v.count ?? 0}/${v.limit ?? 3}`;
      if (sub === "versus") return `리그 ${v.rank ?? 0}위 · ${name} ${v.opponentRank ?? 0}위`;
      return `리그 ${v.rank ?? 0}위 · ${v.played ?? 0}경기`;
    case "fixture":
      return sub === "derby"
        ? `${tags[1] ?? "더비"} — ${name}전 (${SIDE_KO[tags[2] ?? "home"] ?? ""})`
        : `개막전 ${name} (${SIDE_KO[tags[1] ?? "home"] ?? ""})`;
    case "leak":
      return `${name}의 ${reasonOf(tags[0])} 불만이 언론에 보도됐다`;
    case "transfer-request":
      /**
       * `tags[0]`이 **요청의 사유**(`TRANSFER_REQUEST_REASONS`), `tags[1]`이 감독의
       * 답이다 (transfer.md §1-1). 옛 세이브의 카드는 `tags[0]`에 불만 사유를 들고
       * 있어 표에서 안 잡히고, 그때만 사유 이름으로 떨어진다.
       */
      return (
        `${name} 이적 요청 (${TRANSFER_REQUEST_REASON_KO[sub as TransferRequestReason] ?? reasonOf(sub)})` +
        ` — ${v.days ?? 0}일째` +
        (tags[1] === "accept"
          ? " · 감독이 받아들였다"
          : tags[1] === "refuse"
            ? " · 감독이 거부했다"
            : "")
      );
    case "board-demand":
      return (
        `보드 요청 — ${boardDemandText(sub, name, v.baseline)}` +
        causeTail(d.tags?.[1]) +
        (d.date ? ` · 기한 ${d.date}` : "")
      );
    case "season-verdict":
      return (
        `시즌 ${v.season ?? 0} 최종 ${v.rank ?? 0}위` +
        ` · 기대 ${boardExpectationText((tags[1] ?? "mid") as BoardExpectationCode, v.target)}` +
        ` — ${sub === "met" ? "달성" : "미달"}`
      );
    case "vision":
      /**
       * 항목 줄은 **비전의 표가 쓴다** (`visionItemText` — career.md §5). 카드가 문장을
       * 따로 만들면 같은 항목이 화면과 구단주의 입에서 다른 이름으로 선다.
       * 코드가 표 밖이면(옛 세이브) 그릴 것이 없어 이름만 남긴다.
       */
      if (!(VISION_CODES as readonly string[]).includes(sub ?? ""))
        return `구단 비전 — ${sub ?? ""}`;
      return `구단 비전 — ${visionItemText({
        code: sub as VisionCode,
        target: v.target ?? 0,
        weight: v.weight ?? 0,
        progress: v.progress ?? 0,
        ...((TACTIC_AXIS_KEYS as readonly string[]).includes(tags[1] ?? "")
          ? { axis: tags[1] as TacticAxisKey }
          : {}),
      })}`;
    case "demands-kept":
      return `구단주 요청 ${v.total ?? 0}건 — 이행 ${v.met ?? 0} · 불이행 ${v.failed ?? 0}`;
    case "budget":
      return `새 시즌 이적 예산 ${formatMoney(v.budget ?? 0)}`;
    case "milestone":
      return `${name} ${milestonePhrase((sub ?? "apps") as MilestoneCode, v.value ?? 1)}`;
    case "contract-demand":
      return (
        `계약 만료 ${v.days ?? 0}일 · 현 주급 ${formatMoney(v.wage ?? 0)}/주` +
        ` · 요구 ${formatMoney(v.asking ?? 0)}/주`
      );
    case "interest":
      return (
        `최근 ${v.days ?? 0}일 타 구단 오퍼 ${v.offers ?? 0}건` +
        ` · 최고 ${formatMoney(v.fee ?? 0)}${name ? ` (${name})` : ""}` +
        ` · 시즌 출전 ${v.apps ?? 0}경기`
      );
    case "rumour":
      // `tags[0]`이 사다리의 칸, `name`이 그 구단, `days`가 관심이 선 뒤 흐른 날
      return (
        `${name || "타 구단"} 관심 ${INTEREST_STAGE_KO[(sub ?? "watching") as InterestStage] ?? sub}` +
        ` · ${v.days ?? 0}일째`
      );
    case "retirement":
      return (
        `${name} 이번 시즌 뒤 은퇴 — 만 ${v.age ?? 0}세` +
        ` · 우리 팀에서 ${v.apps ?? 0}경기 ${v.goals ?? 0}골` +
        (d.date ? ` · ${d.date} 예고` : "")
      );
    case "farewell":
      /**
       * 전야에는 날짜만, 경기 뒤에는 **그가 뛰었는가**가 선다 (people.md §4). 대진은
       * 회견의 국면 줄이 이미 말하므로 카드가 다시 들지 않는다. 세우고 안 세우고는
       * 감독의 결정이라, 코어가 적는 것은 그 결정의 결과뿐이다.
       */
      if (sub === "played" || sub === "unused") {
        return `${name} 마지막 홈경기 — ${sub === "played" ? "출전" : "출전 없음"}`;
      }
      return `${name} 마지막 홈경기${d.date ? ` — ${d.date}` : ""}`;
    case "number-open":
      /**
       * 계보가 없는 공석은 **번호만** 말한다 (player.md §1.1) — 앞서 아무도 달지
       * 않은 번호에 "앞서 아무도"를 적으면 읽는 쪽이 그 없음을 사실로 옮겨 적는다.
       */
      return `${v.number ?? 0}번 공석` + lineageTail(name, v.seasons, v.since);
    case "number-inherited":
      return `${v.number ?? 0}번을 물려받았다` + lineageTail(name, v.seasons, v.since);
    case "manager-milestone":
      // 눈금이 무엇을 세는가는 `tags[0]`이다 — 경기와 승은 같은 통산의 두 눈금이다
      return `감독 통산 ${v.value ?? 0}${sub === "wins" ? "승" : "경기"}`;
    case "manager-contract":
      /**
       * 부임의 줄은 **새로 선 계약**이고, 나머지는 **끝을 향해 남은 날**이다
       * (career.md §5.4). 보드의 판정은 만료 90일 전에 한 번뿐이라, 그 판정 전과
       * 후가 같은 카드에서 코드로만 갈린다.
       */
      if (sub === "signed") {
        return (
          `감독 계약 ${v.years ?? 0}년 · 연봉 ${formatMoney(v.salary ?? 0)}` +
          (v.pledge ? ` · 이적 예산 약속 ${formatMoney(v.pledge)}` : "")
        );
      }
      return (
        `감독 계약 만료 D-${v.days ?? 0}` +
        (sub === "renewal"
          ? " · 보드가 재계약을 제안했다"
          : sub === "no-renewal"
            ? " · 보드가 재계약하지 않기로 했다"
            : " · 보드는 아직 말이 없다")
      );
    case "manager-fund":
      /**
       * 등급은 `tags[0]`이 들지만 줄에는 서지 않는다 — 백분율이 이미 그 사실이고,
       * 등급은 평판과 회견 창이 읽는 코드다 (career.md §5.4). 보너스 인원은 **있을
       * 때만**: 예산에만 부은 감독의 줄에 "보너스 0명"을 적으면 라커룸이 그 돈을
       * 아는 것처럼 읽힌다.
       */
      return (
        `사재 출연 ${formatMoney(v.amount ?? 0)} — 구단 이적 예산 약속의 ${v.percent ?? 0}%` +
        (v.players ? ` · 사재 보너스 ${v.players}명` : "")
      );
    case "sacking":
      /**
       * 전임의 줄에는 **그 구단에 걸려 있던 기대**가 함께 선다 — 몇 위에서 잘렸는가는
       * 그 구단이 몇 위를 바랐는가를 모르면 읽히지 않는다. 라이벌의 줄은 남의 집
       * 일이라 순위와 며칠 전인가로 족하다.
       */
      if (sub === "predecessor") {
        return (
          `전임 감독 퇴장` +
          (v.position === undefined ? "" : ` — 그때 리그 ${v.position}위`) +
          ` · 기대 ${boardExpectationText((tags[1] ?? "mid") as BoardExpectationCode, v.target)}`
        );
      }
      return (
        `${name || "라이벌"} 감독 경질 · ${v.days ?? 0}일 전` +
        (v.position === undefined ? "" : ` · 그때 리그 ${v.position}위`)
      );
    case "key-player":
      return (
        `1군 핵심 ${name}${sub ? ` (${sub})` : ""} · 만 ${v.age ?? 0}세` +
        (v.contractDays === undefined ? "" : ` · 계약 만료 D-${v.contractDays}`)
      );
    case "rival-quote":
      // 이름과 결 하나 — 카드가 아는 것이 그 둘뿐이다 (people.md §4)
      return `상대 감독 ${name} — ${RIVAL_VOICE_KO[(sub ?? "") as RivalVoice] ?? "마이크 앞에 섰다"}`;
  }
}

/**
 * 계보 꼬리 — **누가 몇 시즌, 몇 시즌 만인가.** 공석과 물려받음이 같은 표를 읽는다:
 * 두 벌을 두면 같은 계보가 근황에서와 회견에서 다른 말로 선다.
 */
function lineageTail(name: string, seasons: number | undefined, since: number | undefined): string {
  if (!name) return "";
  return (
    ` — 앞서 ${name}${seasons === undefined ? "" : `이(가) ${seasons}시즌`}` +
    (since === undefined ? "" : ` · ${since}시즌 만에`)
  );
}

function outcomeWord(tag: string | undefined): string {
  return tag === "win" ? "승리" : tag === "draw" ? "무승부" : "패배";
}

/** `tags[0]`이 사유 코드인 갈래 — 유출·이적 요청 */
function reasonOf(tag: string | undefined): string {
  return issueReasonKo((tag ?? null) as PlayerIssueReason | null) ?? "사유 불명";
}

/**
 * 재정 요청의 사유 꼬리 — `tags[1]`이 그 코드다 (career.md §5.2). 사유가 없는
 * 평소 조건에는 붙지 않는다.
 */
function causeTail(tag: string | undefined): string {
  const label = BOARD_DEMAND_CAUSE_LABEL[(tag ?? "") as BoardDemandCause];
  return label ? ` · ${label}` : "";
}

/**
 * 다가옴의 배경 한 줄 — 카드에서 만든다 (people.md §8).
 *
 * `labels`는 코어만 아는 이름이다: 자리의 주인(선수 이름)과 폼 라벨. 카드에 이름을
 * 적어 두면 카탈로그가 이름을 고쳐도 옛 자리가 옛 이름으로 남고, 폼 눈금은 엔진의
 * 자라 도메인이 알 수 없다.
 */
export function approachContextText(
  context: ApproachContext,
  labels: { subject?: string; form?: string } = {},
): string {
  const who = labels.subject ?? "";
  const reason = issueReasonKo(context.reason ?? null) ?? "불만";
  /** 라커룸에서 선 자리 — 리더가 아닌 선수에겐 붙지 않는다 (people.md §5-1) */
  const seat = context.leader ? ` · ${LEADER_ROLE_LABEL[context.leader]}` : "";
  switch (context.code) {
    case "transfer-request":
      return `${who} 이적 요청 · ${reason}${seat}`;
    case "grievance":
      return `${who} · ${reason}${seat}`;
    case "dressing-room-form":
      return `라커룸 · 1군 평균 폼 ${labels.form ?? ""}`.trimEnd();
    case "standing":
      return `리그 ${context.value ?? 0}위 · 기대 ${context.limit ?? 0}위`;
    case "contract-demand":
      return `${who} 계약 만료 D-${context.value ?? 0}`;
    case "interest":
      return `${who} 타 구단 오퍼 ${context.value ?? 0}건`;
    case "board-demand":
      // 지목한 요청은 그 이름이, 금액 요청은 그 값이 배경이다 (career.md §5.2)
      return who
        ? `구단주 요청 · ${who} 매각`
        : `구단주 요청 · 매각 ${formatMoney(context.value ?? 0)}`;
    case "season-review":
      return `시즌 결산 · 최종 ${context.value ?? 0}위 · 기대 ${context.limit ?? 0}위`;
  }
}
