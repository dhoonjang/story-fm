import {
  CAPTAIN_ROLE_LABEL,
  HEAD_COACH_ROLE_LABEL,
  PERSONA_ROLE_LABEL,
  normalizeSpeaker,
  type Negotiation,
  type Persona,
} from "@story-fm/domain";
import { realCoachNameOf } from "../data/coach-seeds";
import { realOwnerNameOf } from "../data/owner-seeds";
import { leagueCatalogById } from "../data/league-catalog";
import { countryOfTeam, leagueOfTeam } from "../data/team-catalog";
import { makeRng, pick } from "../core/rng";

/**
 * 페르소나 생성 — **시드로 결정적**이다 (people.md §2).
 *
 * 기획서는 핵심 인물을 LLM으로 한 번 생성해 고정하라고 하지만, 그 앞단인
 * **원형 분류는 규칙 기반**이다. 여기 있는 건 그 규칙 단계다. 코어에 둔 이유는
 * 새 게임 생성이 결정적 순수 함수라서다 — 여기에 LLM 호출을 끼우면 `createGame`이
 * 비동기가 되고 mock 모드·테스트가 전부 흔들린다. 나중에 LLM이 이 원형 위에
 * 살을 붙이더라도, 실패하면 이 결과가 그대로 남는다.
 *
 * 같은 세이브는 언제 열어도 같은 사람을 만난다 (시드 해시).
 */

interface CoachArchetype {
  key: string;
  label: string;
  traits: string[];
  motivation: string;
  speech: { note: string; samples: string[] };
}

/**
 * 수석코치 원형 — 실제 코칭스태프의 결을 나눈 것이다. 감독(유저)이 어떤 사람과
 * 한 시즌을 보내느냐가 새 게임마다 달라진다.
 *
 * 각 원형은 **같은 상황에서 다른 것을 먼저 본다** — 분석가는 숫자를, 조련사는
 * 몸 상태를, 인간관계형은 라커룸 공기를. 그게 페르소나가 서사에 하는 일이다.
 */
const COACH_ARCHETYPES: readonly CoachArchetype[] = [
  {
    key: "analyst",
    label: "데이터 분석가형",
    traits: ["숫자로 말한다", "차분함", "준비성"],
    motivation: "감(感)이 아니라 근거로 이기는 팀을 만들고 싶다.",
    speech: {
      note: "존댓말. 수치와 영상 근거를 먼저 대고 결론은 짧게 맺는다. 단정보다 확률로 말한다.",
      samples: [
        "지난 다섯 경기 지표를 보면 측면 전환이 눈에 띄게 줄었습니다. 원인은 두 가지로 좁혀집니다.",
        "감독님, 확률로는 이쪽이 낫습니다. 다만 표본이 적어 단정하진 않겠습니다.",
      ],
    },
  },
  {
    key: "drill_sergeant",
    label: "야전 조련사형",
    traits: ["직설적", "규율 중시", "체력 신봉"],
    motivation: "누구보다 잘 뛰는 팀이면 나머지는 따라온다고 믿는다.",
    speech: {
      note: "존댓말이지만 문장이 짧고 군더더기가 없다. 몸 상태와 강도를 먼저 언급한다.",
      samples: [
        "다리가 안 돌아갑니다. 오늘 강도로는 90분을 못 버팁니다.",
        "말은 됐고, 훈련장에서 증명하게 하겠습니다.",
      ],
    },
  },
  {
    key: "man_manager",
    label: "인간관계형",
    traits: ["세심함", "라커룸 감각", "중재자"],
    motivation: "선수들이 서로를 믿는 라커룸을 지키는 것이 자기 일이라 여긴다.",
    speech: {
      note: "존댓말. 사람 이름과 표정을 먼저 이야기하고 전술은 그다음이다. 완곡하게 돌려 말한다.",
      samples: [
        "감독님, 전술 얘기 전에 한 가지만. 라커룸 분위기가 지난주와 다릅니다.",
        "본인은 괜찮다고 하는데, 표정이 그렇지 않았습니다. 한 번 불러보시는 게 어떨까요.",
      ],
    },
  },
  {
    key: "youth_developer",
    label: "유스 육성형",
    traits: ["장기적 시야", "어린 선수 옹호", "인내심"],
    motivation: "아카데미에서 키운 아이가 1군에서 뛰는 걸 보려고 이 일을 한다.",
    speech: {
      note: "존댓말. 어린 선수의 성장 곡선을 자주 언급하고, 당장의 결과보다 다음 시즌을 함께 본다.",
      samples: [
        "이 나이대에 이 정도면 충분히 빠릅니다. 기회를 조금만 더 주시죠.",
        "지금 쓰면 무너질 수도 있습니다. 다만 안 쓰면 영영 안 큽니다.",
      ],
    },
  },
  {
    key: "veteran_tactician",
    label: "노장 전술가형",
    traits: ["신중함", "경험 신뢰", "보수적"],
    motivation: "오래 본 눈으로 팀이 같은 실수를 되풀이하지 않게 하려 한다.",
    speech: {
      note: "존댓말. 과거 사례를 끌어와 비교하고, 새로운 시도에는 한 번 더 확인을 붙인다.",
      samples: [
        "예전에도 이 구조로 한 시즌을 보낸 적이 있습니다. 그때 무너진 지점이 여기였습니다.",
        "나쁘지 않은 생각입니다. 다만 두 경기만 지켜보고 결정하셔도 늦지 않습니다.",
      ],
    },
  },
  {
    key: "club_loyalist",
    label: "구단 토박이형",
    traits: ["구단 자부심", "팬 정서 대변", "우직함"],
    motivation: "이 클럽에서 자랐고, 클럽이 부끄럽지 않은 축구를 하길 바란다.",
    speech: {
      note: "존댓말. 구단의 역사와 팬 이야기를 자주 꺼내고, 성적만큼 태도를 따진다.",
      samples: [
        "이 유니폼을 입고 그렇게 뛰면 관중석이 먼저 압니다.",
        "감독님, 결과도 결과지만 오늘 경기는 팬들이 오래 기억할 겁니다.",
      ],
    },
  },
];

/**
 * 이름 풀 — **실명을 모르는 팀**의 대체 이름이다 (`coach-seeds.ts`에 없는 팀).
 *
 * 나라별로 나눈 이유는 아스날 수석코치가 "안드레 페레스"이면 그 자체로 어색하기
 * 때문이다. 리그 국적을 따라가면 실명이 아니어도 그 구단의 사람처럼 읽힌다.
 * 한국어 중계 문맥의 표기를 따른다.
 */
interface NamePool {
  given: readonly string[];
  family: readonly string[];
}

const NAME_POOLS: Record<string, NamePool> = {
  잉글랜드: {
    given: ["제임스", "토마스", "대니얼", "마이클", "올리버", "해리", "에런", "루크"],
    family: ["베넷", "콜린스", "하퍼", "그레이", "모건", "라이언", "웰스", "다우니"],
  },
  스페인: {
    given: ["파블로", "하비에르", "세르히오", "알바로", "이반", "미겔"],
    family: ["페레스", "리코", "가르시아", "몰리나", "세라노", "나바로"],
  },
  이탈리아: {
    given: ["루카", "마르코", "안드레아", "다비데", "스테파노", "마테오"],
    family: ["마르케티", "리치", "베르가모", "콘티", "파리네티", "갈리"],
  },
  독일: {
    given: ["슈테판", "토비아스", "마티아스", "얀", "플로리안", "닐스"],
    family: ["브란트", "뮐러", "케슬러", "바그너", "호프만", "슈나이더"],
  },
  프랑스: {
    given: ["니콜라", "티에리", "쥘리앵", "마티외", "로랑", "뱅상"],
    family: ["뒤퐁", "모로", "르콩트", "지라르", "베르나르", "포르티에"],
  },
};

const FALLBACK_POOL = NAME_POOLS["잉글랜드"]!;

/** 나라 → 이름 풀. 풀이 없는 나라는 잉글랜드로 떨어진다 */
function namePoolOf(country: string | undefined): NamePool {
  return (country !== undefined ? NAME_POOLS[country] : undefined) ?? FALLBACK_POOL;
}

/**
 * 그 나라 사람다운 가상 이름 하나 — 수석코치·기자와 같은 풀을 쓴다.
 * 감독 시장(`manager-market.ts`)이 후임 감독의 이름을 여기서 얻는다.
 */
export function inventPersonName(rng: () => number, teamId: string): string {
  const pool = namePoolOf(countryOfTeam(teamId));
  return `${pick(rng, pool.given)} ${pick(rng, pool.family)}`;
}

/**
 * 수석코치를 만든다 — **이름은 구단이, 사람됨은 시드가** 정한다.
 *
 * 이름: 실제 수석코치를 아는 구단이면 그 사람이고(`coach-seeds.ts`), 모르면 리그
 * 국적에 맞는 가상 이름을 뽑는다. 어느 쪽이든 성격·동기·말투는 게임이 지어낸다 —
 * 그래서 실명 항목은 라이선스 부채를 진다 (sources.md §7).
 *
 * 구단을 시드 채널에 섞는 이유: 같은 시드로 다른 팀을 맡으면 다른 코치를 만나야
 * 한다. 부임한 곳이 다르면 만나는 사람도 다르다.
 */
export function generateHeadCoach(seed: number, teamId: string): Persona {
  const rng = makeRng(seed, `persona:head_coach:${teamId}`);
  const archetype = pick(rng, COACH_ARCHETYPES);
  const real = realCoachNameOf(teamId);
  const pool = namePoolOf(countryOfTeam(teamId));
  const name = real ?? `${pick(rng, pool.given)} ${pick(rng, pool.family)}`;
  return {
    // 화자 태그는 직책이 아니라 **이름**이다 — 선수가 @손흥민:으로 말하듯
    characterId: name,
    name,
    role: "head_coach",
    archetype: archetype.label,
    traits: [...archetype.traits],
    motivation: archetype.motivation,
    speechStyle: { note: archetype.speech.note, samples: [...archetype.speech.samples] },
    /** 실존 인물인가 — 서사 가드가 이 표식을 본다 (부정적 실명 서사 금지) */
    real: real !== null ? true : undefined,
    seed,
  };
}

/**
 * 구단주 원형 — **감독을 고용한 사람이지 옆에서 돕는 사람이 아니다.**
 *
 * 수석코치와 결이 갈리는 지점을 원형마다 다르게 잡았다: 무엇으로 감독을 평가하고
 * (성적·수익·상징성), 돈을 어떻게 다루며, 인내심이 얼마나 있는가. 같은 "영입해
 * 주십시오"에 누구는 손익계산서를 펴고 누구는 트로피를 묻는다.
 */
const OWNER_ARCHETYPES: readonly CoachArchetype[] = [
  {
    key: "industrialist",
    label: "산업가형",
    traits: ["효율 신봉", "구조 개혁", "인내심 짧음"],
    motivation: "낭비 없는 조직을 만들어 이 구단을 정상으로 되돌려 놓겠다.",
    speech: {
      note: "간결한 존댓말. 숫자와 기한을 먼저 못 박고 감정은 드러내지 않는다. 요청에는 조건을 붙여 답한다.",
      samples: [
        "예산은 드립니다. 다만 임금 총액은 지금보다 늘어나선 안 됩니다.",
        "이번 창까지입니다. 그 뒤엔 성적으로 이야기하죠.",
      ],
    },
  },
  {
    key: "financier",
    label: "투자자형",
    traits: ["자산 가치 중시", "위험 회피", "계약 조항에 밝다"],
    motivation: "구단의 가치를 키워 언젠가 몇 배로 되판다.",
    speech: {
      note: "차분한 존댓말. 지출을 늘 투자·회수의 언어로 옮긴다. 결론 앞에 조건을 단다.",
      samples: [
        "8,000만이면 4년 상각입니다. 그 값이 장부에 남을 만한 선수입니까?",
        "매각이 먼저입니다. 들어오는 돈이 확정되면 그만큼 열어 드리죠.",
      ],
    },
  },
  {
    key: "fan_owner",
    label: "축구광형",
    traits: ["감정 기복", "팬 여론에 민감", "낭만적"],
    motivation: "내가 어릴 때 사랑한 그 축구를 다시 보고 싶다.",
    speech: {
      note: "격의 없는 존댓말. 경기 이야기를 먼저 꺼내고 흥분하면 말이 길어진다. 숫자보다 장면을 기억한다.",
      samples: [
        "지난 주말 그 역습, 그거였어요. 그런 축구를 보고 싶습니다.",
        "돈이야 어떻게든 해보죠. 대신 홈에서 그렇게 지는 건 못 봅니다.",
      ],
    },
  },
  {
    key: "sovereign",
    label: "국부펀드형",
    traits: ["장기 계획", "체면 중시", "자원은 넉넉하다"],
    motivation: "이 구단을 세계가 아는 이름으로 만든다 — 시간은 얼마든 있다.",
    speech: {
      note: "정중하고 격식 있는 존댓말. 서두르지 않고 큰 그림을 먼저 말한다. 거절도 완곡하다.",
      samples: [
        "예산은 문제가 아닙니다. 다만 우리가 왜 그 선수여야 하는지는 설명해 주셔야죠.",
        "3년을 봅니다. 첫해의 순위로 감독님을 판단하지 않겠습니다.",
      ],
    },
  },
  {
    key: "local_patron",
    label: "지역 유지형",
    traits: ["보수적", "연고 애착", "빚을 싫어한다"],
    motivation: "이 도시의 구단을 물려받은 그대로 다음 세대에 넘긴다.",
    speech: {
      note: "느릿한 존댓말. 구단의 역사와 지역 이야기를 곁들인다. 큰 지출 앞에서는 말을 아낀다.",
      samples: [
        "우리 구단은 빚으로 성적을 산 적이 없습니다. 그건 앞으로도 그렇습니다.",
        "유스에서 올라온 아이들 이야기를 좀 해주시죠. 그쪽이 더 궁금합니다.",
      ],
    },
  },
  {
    key: "showman",
    label: "흥행가형",
    traits: ["주목을 즐긴다", "즉흥적", "스타 선호"],
    motivation: "사람들이 우리 구단 이야기를 하게 만든다.",
    speech: {
      note: "활기찬 존댓말. 화제성과 이름값을 먼저 언급한다. 언론 반응을 자주 끌어온다.",
      samples: [
        "그 이름이면 셔츠가 팔립니다. 데려오죠.",
        "기자들이 뭐라고 쓸지는 제가 감당합니다. 감독님은 경기만 보세요.",
      ],
    },
  },
];

/**
 * 구단주를 만든다 — 수석코치와 같은 규칙이다.
 *
 * 이름은 구단이(`owner-seeds.ts`), 사람됨은 시드가 정한다. 시드 채널이 코치와
 * 달라야 한 세이브에서 두 사람이 같은 원형으로 겹치지 않는다.
 */
export function generateOwner(seed: number, teamId: string): Persona {
  const rng = makeRng(seed, `persona:owner:${teamId}`);
  const archetype = pick(rng, OWNER_ARCHETYPES);
  const real = realOwnerNameOf(teamId);
  const pool = namePoolOf(countryOfTeam(teamId));
  const name = real ?? `${pick(rng, pool.given)} ${pick(rng, pool.family)}`;
  return {
    characterId: name,
    name,
    role: "owner",
    archetype: archetype.label,
    traits: [...archetype.traits],
    motivation: archetype.motivation,
    speechStyle: { note: archetype.speech.note, samples: [...archetype.speech.samples] },
    real: real !== null ? true : undefined,
    seed,
  };
}

/** 원형 목록 — 테스트·어드민이 전수를 훑을 때 쓴다 */
export const OWNER_ARCHETYPE_LABELS = OWNER_ARCHETYPES.map((a) => a.label);

/** 원형 목록 — 테스트·어드민이 전수를 훑을 때 쓴다 */
export const HEAD_COACH_ARCHETYPES = COACH_ARCHETYPES.map((a) => a.label);

/**
 * 끝난 협상 — 나머지(`open`·`agreed`)는 아직 테이블에 사람이 앉아 있다.
 * 종료 상태를 빼는 방향이라 상태가 하나 늘어도 화자가 조용히 사라지지 않는다.
 */
const CLOSED_NEGOTIATION = new Set<string>([
  "completed",
  "rejected",
  "expired",
] satisfies Negotiation["status"][]);

/** 화자 사전을 만들 최소 상태 — 세이브 전체가 아니라 필요한 것만 받는다 */
interface SpeakerSource {
  seed: number;
  userTeamId: string;
  personas?: Persona[];
  players?: Array<{ id?: string; name: string; teamId: string; isCaptain?: boolean }>;
  negotiations?: Array<{ gamePlayerId: string; status: string }>;
}

/**
 * 화자의 **자리** — 이름 옆의 직책과 앞의 아이콘이 여기서 나온다.
 *
 * `label`은 화면에 글자로 붙고 `kind`는 아이콘을 고른다. **둘이 따로인 이유**는
 * 선수다: 대화마다 `(선수)`가 따라붙으면 시끄럽지만, 유니폼 아이콘 하나는
 * "지금 말하는 사람이 선수구나"를 조용히 알린다.
 */
export type SpeakerKind = "head_coach" | "owner" | "reporter" | "captain" | "player";
export interface SpeakerRole {
  kind: SpeakerKind;
  /** 이름 옆에 글자로 붙는 직책 — 없으면 아이콘만 선다 */
  label?: string;
}

/**
 * 화자 이름 → 자리 — 화면이 `스티브 홀랜드 (수석코치)`로 보여 주기 위한 사전.
 *
 * 세 가지 원칙 위에 서 있다:
 *
 * ① **모델의 출력에 기대지 않는다.** LLM은 이름만 뱉고(태그에 직책을 쓰지 말라고
 *    지시했으니 당연하다), 직책은 세이브가 안다. 그래야 어떤 턴에서도 빠지지 않는다.
 * ② **수석코치만 특별대우하지 않는다.** 자리를 아는 화자는 다 알려 준다 — 페르소나(수석코치·구단주)·
 *    **주장**·**우리 선수단**, 그리고 협상 테이블에 앉은 상대 선수까지. 포지션은
 *    넣지 않는다: 대화마다 따라붙기엔 시끄럽고, 그건 명단이 답하는 정보다.
 * ③ **잘못된 자리보다 없는 게 낫다.** 같은 이름이 둘이면(코치와 선수가 동명이인)
 *    무엇을 붙여도 절반은 틀리므로 **아예 붙이지 않는다** — 화면은 사람 아이콘만 세운다.
 *
 * 사전에 **전 리그 4,000명을 담지 않는 이유**도 ③과 같다: 남의 팀 3군까지 넣으면
 * 동명이인이 늘어 정작 우리 선수가 사라진다. 우리 선수단은 40명 남짓이라 사전이
 * 가볍고, 대화에 서는 사람의 대부분이기도 하다.
 */
export function speakerRoles(state: SpeakerSource): Record<string, SpeakerRole> {
  // null = 이름이 겹쳐 판단을 포기한 자리
  const seen = new Map<string, SpeakerRole | null>();
  const put = (rawName: string, role: SpeakerRole) => {
    const key = normalizeSpeaker(rawName);
    if (!key) return;
    const previous = seen.get(key);
    if (previous === undefined) seen.set(key, role);
    else if (previous === null || previous.kind !== role.kind || previous.label !== role.label) {
      seen.set(key, null); // 동명이인 → 생략
    }
  };

  // 페르소나 — 빈 배열도 "없음"으로 본다. `?? `만 쓰면 `personas: []` 세이브에서
  // 사전이 통째로 비어 직책이 조용히 사라진다 (실제로 그랬다)
  const personas = state.personas?.length
    ? state.personas
    : [headCoachOf(state), ownerOf(state), ...reportersOf(state)];
  for (const persona of personas) {
    put(persona.characterId, {
      kind: persona.role,
      /**
       * 기자는 **직책보다 매체가 정보다** — "기자"는 마이크 아이콘이 이미 말하고,
       * 감독이 알아야 할 것은 "어디 소속이 묻는가"다(지역지냐 타블로이드냐로
       * 질문의 결이 갈린다). 매체를 모르는 옛 세이브는 직책으로 돌아간다.
       */
      label:
        persona.role === "reporter" && persona.outlet
          ? persona.outlet
          : PERSONA_ROLE_LABEL[persona.role],
    });
  }

  // 우리 선수단 — 주장만 직책을 글자로 얻고, 나머지는 아이콘으로만 선다
  const squad = (state.players ?? []).filter((p) => p.teamId === state.userTeamId);
  for (const player of squad) {
    if (player.isCaptain === true) put(player.name, { kind: "captain", label: CAPTAIN_ROLE_LABEL });
    else put(player.name, { kind: "player" });
  }

  // 협상 테이블의 상대 선수 — 남의 팀이지만 지금 대화에 앉아 있다.
  // 합의 뒤 메디컬을 기다리는 자리(`agreed`)도 아직 진행 중이다
  const negotiating = new Set(
    (state.negotiations ?? [])
      .filter((n) => !CLOSED_NEGOTIATION.has(n.status))
      .map((n) => n.gamePlayerId),
  );
  if (negotiating.size > 0) {
    for (const player of state.players ?? []) {
      if (player.id !== undefined && negotiating.has(player.id))
        put(player.name, { kind: "player" });
    }
  }

  const roles: Record<string, SpeakerRole> = {};
  for (const [key, role] of seen) if (role !== null) roles[key] = role;
  return roles;
}

/** 이 세이브의 수석코치 — 옛 세이브라 비어 있으면 시드로 그 자리에서 만든다 */
export function headCoachOf(state: {
  seed: number;
  userTeamId: string;
  personas?: Persona[];
}): Persona {
  const found = state.personas?.find((p) => p.role === "head_coach");
  return found ?? generateHeadCoach(state.seed, state.userTeamId);
}

/** 이 세이브의 구단주 — 옛 세이브라 비어 있으면 시드로 그 자리에서 만든다 */
export function ownerOf(state: {
  seed: number;
  userTeamId: string;
  personas?: Persona[];
}): Persona {
  const found = state.personas?.find((p) => p.role === "owner");
  return found ?? generateOwner(state.seed, state.userTeamId);
}

/** 이 세이브의 기자단 — 옛 세이브라 비어 있으면 시드로 그 자리에서 만든다 */
export function reportersOf(state: {
  seed: number;
  userTeamId: string;
  personas?: Persona[];
}): Persona[] {
  const found = (state.personas ?? []).filter((p) => p.role === "reporter");
  return found.length > 0 ? found : generateReporters(state.seed, state.userTeamId);
}

/**
 * 기자 원형 — **감독에게 질문하는 사람들.** 회견장에 앉는 얼굴이 매번 달라지면
 * 회견은 그냥 질문 목록이 된다. 같은 사람이 시즌 내내 같은 자리에서 물어야
 * "저 친구는 늘 라커룸부터 캔다"가 성립하고, 감독의 지난 답이 다음 질문에 걸린다.
 *
 * 셋으로 나눈 기준은 **무엇을 먼저 묻는가**다 — 구단의 내일(지역지), 리그의 판도와
 * 전술(전국지), 사람 사이의 일(타블로이드). 같은 패배에도 셋의 첫 문장이 다르다.
 */
interface ReporterArchetype extends CoachArchetype {
  /** 매체의 결 — 이름은 나라별 풀에서 뽑는다 */
  outletKind: string;
}

const REPORTER_ARCHETYPES: readonly ReporterArchetype[] = [
  {
    key: "local",
    label: "지역지 베테랑",
    outletKind: "지역 일간지",
    traits: ["구단을 오래 봤다", "애정과 잔소리가 반반", "팬의 목소리를 대신한다"],
    motivation: "이 구단이 다시 자랑스러워지는 걸 보고 은퇴하고 싶다.",
    speech: {
      note: "존댓말이지만 거리가 가깝다. 옛일을 자주 꺼내고, 팬들이 뭐라 하는지를 근거로 든다.",
      samples: [
        "20년 봤습니다만, 홈에서 이런 경기는 오랜만입니다. 팬들한테 뭐라고 하시겠습니까?",
        "그 자리, 예전에도 같은 문제로 시즌을 놓친 적이 있습니다. 이번엔 다릅니까?",
      ],
    },
  },
  {
    key: "national",
    label: "전국지 전술 기자",
    outletKind: "전국지",
    traits: ["전술을 읽는다", "숫자를 들고 온다", "감정에 흔들리지 않는다"],
    motivation: "경기 안에서 실제로 무슨 일이 있었는지 정확히 쓰고 싶다.",
    speech: {
      note: "건조한 존댓말. 장면과 수치를 짚어 묻고, 감독의 말을 그대로 인용해 다음 질문을 만든다.",
      samples: [
        "후반에 라인을 내리셨는데, 그 뒤 15분 동안 중원이 비었습니다. 의도하신 겁니까?",
        "지난주엔 '측면으로 푼다'고 하셨습니다. 오늘은 그 반대로 보였는데요.",
      ],
    },
  },
  {
    key: "tabloid",
    label: "타블로이드",
    outletKind: "타블로이드",
    traits: ["사람 사이를 캔다", "자극적인 제목", "물러서지 않는다"],
    motivation: "아무도 말하지 않는 라커룸 이야기를 먼저 쓰고 싶다.",
    speech: {
      note: "예의는 갖추되 찌르는 질문. 소문을 사실처럼 얹어 반응을 떠보고, 부인해도 한 번 더 묻는다.",
      samples: [
        "그 선수가 감독님 방식에 불만이 있다는 이야기가 있습니다. 사실입니까?",
        "이적설이 도는데, 구단은 아니라고 하더군요. 감독님도 같은 말씀이십니까?",
      ],
    },
  },
];

/** 매체 이름 — 도시·나라가 아니라 결로 짓는다 (실존 매체명은 쓰지 않는다) */
const OUTLET_NAMES: Record<string, string[]> = {
  local: ["시티 이브닝", "타운 크로니클", "로컬 포스트"],
  national: ["더 내셔널", "위클리 풋볼", "매치 리포트"],
  tabloid: ["데일리 버즈", "더 미러볼", "핫라인"],
};

/**
 * 기자단 — 한 세이브에 셋. 구단이 아니라 **리그**를 따라다니므로 시드 채널에
 * 팀을 넣지 않는다. 감독이 다른 팀으로 옮겨도 같은 기자를 만난다.
 */
export function generateReporters(seed: number, teamId: string): Persona[] {
  // 이름 풀의 기준도 리그다 — 시드 채널과 어긋나면 같은 담당 기자의 이름이 갈린다
  const pool = namePoolOf(leagueCatalogById(leagueOfTeam(teamId))?.country);
  return REPORTER_ARCHETYPES.map((archetype) => {
    const rng = makeRng(seed, `persona:reporter:${archetype.key}`);
    const name = `${pick(rng, pool.given)} ${pick(rng, pool.family)}`;
    const outlet = pick(rng, OUTLET_NAMES[archetype.key] ?? ["프레스"]);
    return {
      characterId: name,
      name,
      role: "reporter" as const,
      archetype: `${archetype.label} · ${outlet}`,
      traits: [...archetype.traits],
      motivation: archetype.motivation,
      speechStyle: { note: archetype.speech.note, samples: [...archetype.speech.samples] },
      outlet,
      seed,
    };
  });
}

/**
 * 로드 보정 — 페르소나가 없는 옛 세이브를 채운다.
 *
 * 생성이 시드로 결정적이라 **채워 넣어도 그 세이브의 코치는 늘 같은 사람**이다.
 * 그래서 세이브 버전을 올리지 않고 조용히 메울 수 있다 (AGENTS.md 세이브 호환성).
 */
export function ensurePersonas(state: {
  seed: number;
  userTeamId: string;
  personas?: Persona[];
}): void {
  const coach = state.personas?.find((p) => p.role === "head_coach");
  if (!coach) {
    state.personas = [...(state.personas ?? []), generateHeadCoach(state.seed, state.userTeamId)];
  } else if (coach.characterId === HEAD_COACH_ROLE_LABEL) {
    // 태그를 직책에서 이름으로 옮기기 전 세이브 — 그 사람의 이름으로 고쳐 준다.
    // 이름·성격은 그대로라 감독이 만난 사람은 바뀌지 않는다.
    coach.characterId = coach.name;
  }
  // 구단주가 없던 세이브 — 코치와 같은 이유로 조용히 채운다(생성이 결정적이다).
  // 이걸 안 하면 GM이 구단주를 즉흥으로 연기해 만날 때마다 다른 사람이 된다.
  if (!state.personas?.some((p) => p.role === "owner")) {
    state.personas = [...(state.personas ?? []), generateOwner(state.seed, state.userTeamId)];
  }
  // 기자단 — 회견은 세계가 먼저 부르는 자리라, 부를 사람이 없으면 GM이 즉흥으로
  // 지어내 매번 다른 기자가 된다 (press.ts)
  if (!state.personas?.some((p) => p.role === "reporter")) {
    state.personas = [
      ...(state.personas ?? []),
      ...generateReporters(state.seed, state.userTeamId),
    ];
  }
}
