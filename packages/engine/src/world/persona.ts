import {
  CAPTAIN_ROLE_LABEL,
  LEADER_ROLE_LABEL,
  CharacterMemorySchema,
  HEAD_COACH_ROLE_LABEL,
  isStaffRole,
  normalizeSpeaker,
  personaRoleLabel,
  PersonaSchema,
  STAFF_ROLES,
  type CharacterMemory,
  type Negotiation,
  type Persona,
  type PersonaRole,
  type RivalVoice,
  type SpeechStyle,
  type StaffRole,
} from "@story-fm/domain";
import { realCoachNameOf } from "../data/coach-seeds";
import { realOwnerNameOf } from "../data/owner-seeds";
import { WORLD_FIGURE_SEEDS, isWorldFigureName, type WorldFigureSeed } from "../data/world-figures";
import { MARKET_LEAGUE_SQUADS } from "../data/market-leagues";
import { claimPersonaName, personaNamePoolOf } from "../data/names";
import { countryOfTeam } from "../data/team-catalog";
import { hashChannel, makeRng, pick, randInt, shuffled } from "../core/rng";
import { catalogTierOf } from "../core/club-tier";
import { contractUntil } from "../core/dates";
import { clubEconomyLevel } from "../data/league-economy";

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

/**
 * 인물 사전이 훑는 말 — **한 곳에서만 만든다** (people.md §6).
 *
 * 코치·구단주·기자·선수가 같은 헬퍼를 부르고, 옛 세이브를 메우는 `ensurePersonas`도
 * 여기를 부른다. 자리마다 따로 적으면 한쪽만 고쳐져 같은 이름이 어떤 인물에게는
 * 걸리고 어떤 인물에게는 걸리지 않는다.
 *
 * ⚠️ **나열한 것만 본다** — 성만 쓴 "홀란드"를 같은 사람으로 보는 부분 일치는
 * 오탐을 만든다는 `normalizeSpeaker`의 원칙이 인물 사전에도 그대로다.
 */

/** 두 글자 미만은 키워드가 되지 못한다 — 한 글자는 아무 문장에나 걸린다 */
const KEYWORD_MIN_LENGTH = 2;

/**
 * 자리를 부르는 말 — 이름 대신 직책으로 부른 턴에도 그 사람이 선다.
 *
 * ⚠️ **매 턴 나오는 말은 넣지 않는다.** 한 턴 상한이 3장이라 "이적" 같은 말이
 * 자리를 다 채우면 정작 이름으로 불린 인물이 밀린다.
 */
const ROLE_KEYWORDS: Partial<Record<PersonaRole, readonly string[]>> = {
  head_coach: ["수석코치", "코치"],
  owner: ["구단주", "회장", "보드"],
  reporter: ["기자", "회견", "인터뷰"],
  /**
   * 스태프 — 자리 이름(「피지컬 코치」)은 여기 적지 않는다. 그 말은 고용 정보에
   * 이미 있고, 그 사람의 키워드는 `staffPersona`가 이름과 함께 세운다. 여기 있는
   * 것은 **자리를 뭉뚱그려 부르는 말**이다.
   */
  coach: ["코치"],
  medic: ["의료진", "닥터", "메디컬", "트레이너"],
  scout: ["스카우트"],
};

/** 이 인물이 불렸다고 볼 말들 — 이름 · 이름 조각 · 자리를 부르는 말 · 소속 매체 */
export function personaKeywords(persona: Pick<Persona, "name" | "role" | "outlet">): string[] {
  const candidates = [
    persona.name,
    ...persona.name.split(/\s+/u),
    ...(persona.outlet !== undefined ? [persona.outlet] : []),
    ...(ROLE_KEYWORDS[persona.role] ?? []),
  ];
  const keywords: string[] = [];
  for (const raw of candidates) {
    const word = raw.trim();
    if (word.length < KEYWORD_MIN_LENGTH || keywords.includes(word)) continue;
    keywords.push(word);
  }
  return keywords;
}

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
 * 한 세이브의 가상 이름 — 아홉 자리(기자 3 · 수석코치 · 구단주 · 스태프 4)를
 * **한 번에** 뽑는다.
 *
 * 자리마다 독립 추첨하면 같은 풀에서 같은 이름이 나오고, 겹친 이름은
 * `speakerRoles`가 둘 다 포기해 **직책과 아이콘이 함께 사라진다**
 * (people.md §1 — 태그는 전역 유일). 그래서 앞사람이 쥔 이름을 넘겨가며 뽑는다.
 *
 * **순서가 규칙이다.** 실명이 먼저 자리를 잡고(그 사람의 이름은 흔들 수 없다),
 * 그다음이 기자다 — 기자는 구단이 아니라 리그를 따라다니므로 뒤로 밀면 감독이
 * 팀을 옮길 때마다 담당 기자의 이름이 갈린다. **스태프는 맨 뒤다** — 나중에 생긴
 * 자리라 앞으로 끼우면 진행 중인 세이브의 코치·구단주 이름이 통째로 갈린다.
 */
function personaNames(
  seed: number,
  teamId: string,
): {
  reporters: Record<string, string>;
  headCoach: string;
  owner: string;
  /** 자리 열쇠(`${역할}:${번호}`) → 이름 */
  staff: Record<string, string>;
} {
  const pool = personaNamePoolOf(countryOfTeam(teamId));
  const realCoach = realCoachNameOf(teamId);
  const realOwner = realOwnerNameOf(teamId);
  const taken = new Set([realCoach, realOwner].filter((n) => n !== null));
  const reporters: Record<string, string> = {};
  for (const archetype of REPORTER_ARCHETYPES) {
    reporters[archetype.key] = claimPersonaName(
      makeRng(seed, `persona:name:reporter:${archetype.key}`),
      pool,
      taken,
    );
  }
  const headCoach =
    realCoach ?? claimPersonaName(makeRng(seed, `persona:name:head_coach:${teamId}`), pool, taken);
  const owner =
    realOwner ?? claimPersonaName(makeRng(seed, `persona:name:owner:${teamId}`), pool, taken);
  const staff: Record<string, string> = {};
  for (const role of STAFF_ROLES) {
    for (let index = 0; index < STAFF_OPENINGS[role]; index += 1) {
      staff[`${role}:${index}`] = claimPersonaName(
        makeRng(seed, `persona:name:staff:${role}:${index}:${teamId}`),
        pool,
        taken,
      );
    }
  }
  return { reporters, headCoach, owner, staff };
}

/**
 * 그 나라 사람다운 가상 이름 하나 — 수석코치·기자와 같은 풀을 쓴다.
 * 감독 시장(`manager-market.ts`)이 후임 감독의 이름을 여기서 얻는다.
 *
 * `taken`과 겹치면 같은 rng로 다시 뽑는다 — 이름이 곧 `characterId`(전역 유일)라,
 * 다른 벤치의 감독과 겹치면 두 벤치가 한 사람으로 읽힌다 (people.md §2).
 */
export function inventPersonName(rng: () => number, teamId: string, taken?: Set<string>): string {
  return claimPersonaName(rng, personaNamePoolOf(countryOfTeam(teamId)), taken ?? new Set());
}

/**
 * 이미 서 있는 사람들의 이름 — 가상 감독 이름을 뽑을 때 피해야 할 집합이다.
 *
 * 벤치의 감독 전원과 세이브의 페르소나, 감독(유저) 본인, 그리고 **무직 감독 풀에
 * 앉은 사람들**까지 담는다. 선수 이름은 담지 않는다 — 선수 풀과 인물 풀은 성을
 * 나눠 가져 조합이 겹칠 수 없다 (people.md §2).
 *
 * ⚠️ **풀을 빼면 안 된다.** 무직인 사람은 벤치에 없어서 눈에 띄지 않지만 세계에
 * 있고, 이름이 곧 `characterId`(전역 유일)다. 지어낸 후임이 그 이름을 받으면 두
 * 사람이 한 사람으로 읽히고, 그가 다시 부임하는 날 같은 이름이 벤치 둘에 앉는다.
 */
export function occupiedPersonNames(state: {
  teams: Array<{ managerName?: string }>;
  personas?: Persona[];
  manager?: { name: string };
  managerPool?: ReadonlyArray<{ name: string }>;
  staffPool?: ReadonlyArray<{ name: string }>;
}): Set<string> {
  return new Set([
    ...state.teams.map((t) => t.managerName).filter((n): n is string => n !== undefined),
    ...(state.personas ?? []).map((p) => p.name),
    ...(state.manager !== undefined ? [state.manager.name] : []),
    ...(state.managerPool ?? []).map((e) => e.name),
    // 스태프 풀도 세계에 있는 사람이다 — 감독 풀을 빼면 안 되는 이유가 그대로다
    ...(state.staffPool ?? []).map((e) => e.name),
  ]);
}

/**
 * 빈 벤치의 가상 감독 이름 — **(시드, 팀) 채널로 결정적**이다 (people.md §2).
 *
 * 세계 생성과 로드 보정(`ensureSeededManagers`)이 같은 채널을 쓰므로, 옛 세이브를
 * 채워도 그 벤치의 사람은 늘 같다 — 세이브 버전을 올리지 않는 근거다.
 */
export function seededVirtualManagerName(seed: number, teamId: string, taken: Set<string>): string {
  return inventPersonName(makeRng(seed, `persona:manager-name:${teamId}`), teamId, taken);
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
export function generateHeadCoach(seed: number, teamId: string, today?: string): Persona {
  const rng = makeRng(seed, `persona:head_coach:${teamId}`);
  const archetype = pick(rng, COACH_ARCHETYPES);
  const real = realCoachNameOf(teamId);
  const name = personaNames(seed, teamId).headCoach;
  return {
    // 화자 태그는 직책이 아니라 **이름**이다 — 선수가 @손흥민:으로 말하듯
    characterId: name,
    name,
    role: "head_coach",
    archetype: archetype.label,
    traits: [...archetype.traits],
    motivation: archetype.motivation,
    speechStyle: { note: archetype.speech.note, samples: [...archetype.speech.samples] },
    keywords: personaKeywords({ name, role: "head_coach" }),
    /**
     * 고용 정보 — 스태프와 같은 칸이다 (people.md §2-2). **날짜를 모르면 서지 않는다**:
     * 옛 세이브를 되찾는 폴백(`headCoachOf`)은 오늘을 모르는 자리라, 없는 계약을
     * 지어내느니 비워 두고 로드 보정(`ensurePersonas`)이 채운다.
     */
    employment:
      today === undefined
        ? undefined
        : {
            teamId,
            title: HEAD_COACH_ROLE_LABEL,
            since: today,
            contract: {
              salary: headCoachSalaryOf(teamId),
              until: contractUntil(today, HEAD_COACH_CONTRACT_YEARS),
            },
          },
    /** 실존 인물인가 — 실명 부채의 장부가 이 표식으로 센다 (sources.md §7). 프롬프트는 읽지 않는다 */
    real: real !== null ? true : undefined,
    seed,
  };
}

// ── 스태프 — 구단이 고용한 사람들 (people.md §2-2) ────────────────

/**
 * 스태프 원형 — **자리(직책)와 결을 한 줄이 함께 든다** (people.md §2 원형 표).
 *
 * 자리와 결을 따로 추첨하면 표가 둘이 되고 같은 사실을 두 곳에 적는다. 「피지컬
 * 코치」는 강도로 말하고 「골키퍼 코치」는 손끝을 보므로, 그 둘은 애초에 한 사람의
 * 두 면이다.
 */
interface StaffArchetype extends CoachArchetype {
  /** 그 사람이 맡은 자리 — 고용 정보의 `title`이자 화면 칩에 서는 값이다 */
  title: string;
}

const COACH_STAFF_ARCHETYPES: readonly StaffArchetype[] = [
  {
    key: "physical",
    title: "피지컬 코치",
    label: "강도형",
    traits: ["수치로 강도를 잰다", "타협 없음", "회복 신봉"],
    motivation: "시즌 끝까지 다리가 남아 있는 팀을 만들고 싶다.",
    speech: {
      note: "존댓말. 주간 부하와 회복 수치를 먼저 대고, 훈련량을 줄이자는 말에는 근거를 요구한다.",
      samples: [
        "이번 주 부하가 지난주보다 18% 높습니다. 수요일은 낮춰야 합니다.",
        "지금 빼면 다음 달에 두 명 더 눕습니다. 오늘 조절하시죠.",
      ],
    },
  },
  {
    key: "keeper",
    title: "골키퍼 코치",
    label: "손끝형",
    traits: ["세밀함", "반복 훈련", "골키퍼 편"],
    motivation: "우리 골문에 선 사람이 매 경기 같은 얼굴이길 바란다.",
    speech: {
      note: "존댓말. 골키퍼 한 사람의 손끝과 발밑을 이야기하고, 전술 이야기에는 잘 끼어들지 않는다.",
      samples: [
        "발밑은 지난달보다 낫습니다. 다만 크로스 상황의 판단이 아직 늦습니다.",
        "그 실점은 준비 자세였습니다. 이번 주에 잡겠습니다.",
      ],
    },
  },
  {
    key: "set_piece",
    title: "세트피스 코치",
    label: "도면형",
    traits: ["패턴 수집", "집요함", "영상 광"],
    motivation: "한 시즌에 세트피스로만 열 골을 만들어 보이겠다.",
    speech: {
      note: "존댓말. 상대의 수비 배치와 우리 패턴을 도면 이야기하듯 설명한다. 숫자보다 그림이다.",
      samples: [
        "저쪽은 니어에 둘을 세웁니다. 그러면 파 포스트가 비죠.",
        "이 패턴은 세 경기째 안 통했습니다. 새로 하나 넣겠습니다.",
      ],
    },
  },
  {
    key: "technical",
    title: "기술 코치",
    label: "기본기형",
    traits: ["반복 신봉", "차분함", "어린 선수 선호"],
    motivation: "기본이 흔들리지 않으면 전술은 무엇이든 얹을 수 있다고 믿는다.",
    speech: {
      note: "존댓말. 개인 기술의 습관을 이야기하고, 결과보다 그날 훈련장의 장면을 말한다.",
      samples: [
        "첫 터치가 몸에서 멀어졌습니다. 그것부터 잡겠습니다.",
        "전술이 문제가 아니라 그 상황에서 받는 발이 틀렸습니다.",
      ],
    },
  },
];

const MEDIC_ARCHETYPES: readonly StaffArchetype[] = [
  {
    key: "cautious",
    title: "팀 닥터",
    label: "신중형",
    traits: ["보수적 판단", "기록을 남긴다", "재발을 가장 두려워한다"],
    motivation: "한 번 더 뛰게 하려다 한 시즌을 잃는 일만은 막으려 한다.",
    speech: {
      note: "존댓말. 진단과 기간을 먼저 말하고 감독의 재촉에는 위험을 숫자로 답한다. 단정하지 않는다.",
      samples: [
        "근육은 붙었습니다. 다만 지금 넣으면 재발 확률이 두 배입니다.",
        "2주로 보고 있습니다. 그 안에 밀어붙이시면 제 소견은 반대로 남깁니다.",
      ],
    },
  },
  {
    key: "return_first",
    title: "재활 트레이너",
    label: "복귀 우선형",
    traits: ["적극적", "선수와 가깝다", "현장 감각"],
    motivation: "선수가 하루라도 빨리 잔디를 밟게 하는 것이 자기 일이라 여긴다.",
    speech: {
      note: "존댓말이지만 문장이 짧다. 선수 본인이 뭐라고 했는지를 먼저 전한다.",
      samples: [
        "본인은 뛸 수 있다고 합니다. 저도 이번 주말은 가능하다고 봅니다.",
        "통증은 없습니다. 45분은 문제없고, 그 뒤는 보면서 정하시죠.",
      ],
    },
  },
  {
    key: "preventive",
    title: "스포츠 과학자",
    label: "예방형",
    traits: ["데이터 신봉", "장기적 시야", "훈련장에 상주"],
    motivation: "다치기 전에 막는 것이 치료보다 싸다는 것을 증명하고 싶다.",
    speech: {
      note: "존댓말. 부상 이력과 누적 부하를 함께 놓고 말하며, 아직 안 다친 선수 이야기를 자주 꺼낸다.",
      samples: [
        "지금 아픈 사람보다 다음 주에 아플 사람이 걱정입니다.",
        "이 선수는 두 시즌 연속 같은 시기에 눕습니다. 이번엔 미리 빼시죠.",
      ],
    },
  },
];

const SCOUT_ARCHETYPES: readonly StaffArchetype[] = [
  {
    key: "field",
    title: "현장 스카우트",
    label: "발품형",
    traits: ["직접 본 것만 믿는다", "부지런함", "경기장 냄새"],
    motivation: "아무도 안 간 경기장에서 다음 시즌의 주전을 찾아내고 싶다.",
    speech: {
      note: "존댓말. 자기가 몇 번 봤는지를 먼저 말하고, 영상으로만 본 선수에는 유보를 단다.",
      samples: [
        "네 경기 직접 봤습니다. 세 번은 같은 장면이 나왔습니다.",
        "영상으로는 좋아 보입니다만, 제가 아직 안 봤습니다.",
      ],
    },
  },
  {
    key: "video",
    title: "영상 스카우트",
    label: "자료형",
    traits: ["표로 말한다", "표본을 따진다", "조용함"],
    motivation: "눈으로 놓치는 것을 자료로 잡아내는 게 자기 몫이라 여긴다.",
    speech: {
      note: "존댓말. 지표와 표본 크기를 함께 대고, 결론은 확률로 맺는다.",
      samples: [
        "리그 상위 5%의 지표입니다. 다만 표본이 아홉 경기뿐입니다.",
        "같은 나이·같은 포지션에서 이 값이면 위쪽입니다.",
      ],
    },
  },
  {
    key: "network",
    title: "수석 스카우트",
    label: "인맥형",
    traits: ["발이 넓다", "소문에 밝다", "협상 감각"],
    motivation: "남들이 알기 전에 이야기를 듣는 자리에 계속 있고 싶다.",
    speech: {
      note: "존댓말. 누구에게 들었는지를 먼저 흘리고, 값과 분위기를 함께 말한다.",
      samples: [
        "그쪽 단장과 어제 통화했습니다. 여름엔 열어 둘 생각이랍니다.",
        "에이전트가 먼저 우리를 떠봤습니다. 값은 부르기 나름입니다.",
      ],
    },
  },
];

/** 역할 → 원형 표. 표를 직접 인덱싱하는 자리를 여기 하나로 묶는다 */
const STAFF_ARCHETYPES: Record<StaffRole, readonly StaffArchetype[]> = {
  coach: COACH_STAFF_ARCHETYPES,
  medic: MEDIC_ARCHETYPES,
  scout: SCOUT_ARCHETYPES,
};

/**
 * 새 게임의 시작 인원 (people.md §2-2) — **코치 둘 · 의료진 하나 · 스카우트 하나.**
 *
 * 코치만 둘인 이유는 자리가 넷이라서다: 피지컬과 골키퍼는 어느 구단에나 있는 자리이고,
 * 하나만 세우면 감독이 만나는 훈련장이 원형 하나에 통째로 걸린다.
 */
export const STAFF_OPENINGS: Record<StaffRole, number> = { coach: 2, medic: 1, scout: 1 };

/**
 * 역할별 자리 상한 — **훈련장의 자리는 유한하다** (people.md §2-2).
 *
 * 상한이 없으면 잔고가 허락하는 만큼 고용해 장부의 명명 줄이 스무 개가 된다. 그건
 * 사람이 아니라 목록이다.
 */
export const STAFF_LIMIT: Record<StaffRole, number> = { coach: 4, medic: 2, scout: 3 };

/**
 * 자리별 기준 연봉 (£/년) — **EPL 3등급 구단이 1.0 자리다** (people.md §2-2).
 *
 * 선수 주급 모델(`world/wages.ts`)이 아니라 **구단 경제 수준** 축을 탄다: 스태프 급여는
 * 선수 시장이 아니라 구단의 살림 크기를 따라가고, 고정비가 이미 그 축 위에 있다
 * (finance.md §6.2). 넷을 합쳐도 파생 스태프 급여 기준액의 한참 아래라, 명명된 몫을
 * 덜어 내도 장부 총액은 지금 실측 그대로다 (finance.md §6.4-1).
 */
const STAFF_SALARY_BASE: Record<StaffRole, number> = {
  coach: 450_000,
  medic: 280_000,
  scout: 180_000,
};

/**
 * 등급 계수 — **같은 리그 안의 차이를 만드는 자리다.**
 *
 * `clubEconomyLevel`은 EPL에서 1로 포화하므로(리그 배율 + 브랜드 보정), 그것만으로는
 * EPL 스무 구단의 코치가 전부 같은 값을 받는다. 폭은 티켓의 등급 보정과 같은 꼴이다.
 */
const STAFF_TIER_FACTOR: Record<1 | 2 | 3 | 4, number> = { 1: 1.3, 2: 1.1, 3: 0.9, 4: 0.7 };

/** 천 파운드 단위로 끊는다 — 연봉은 사람이 읽는 값이라 £452,317이 설 자리가 아니다 */
const SALARY_ROUNDING = 1_000;

/**
 * 이 구단의 이 자리가 받는 연봉 (£/년) — 구단 경제 수준 × 등급 계수 (people.md §2-2).
 *
 * 세이브를 읽지 않고 카탈로그만 본다: 스태프 연봉은 계약에 적혀 굳는 값이라 그날의
 * 승강·브랜드 편집을 좇을 이유가 없고, 세계 생성 시점에도 답해야 한다.
 */
export function staffSalaryOf(teamId: string, role: StaffRole): number {
  const raw =
    STAFF_SALARY_BASE[role] * clubEconomyLevel(teamId) * STAFF_TIER_FACTOR[catalogTierOf(teamId)];
  return Math.max(SALARY_ROUNDING, Math.round(raw / SALARY_ROUNDING) * SALARY_ROUNDING);
}

/**
 * 수석코치는 코치 기준의 **두 배**다 — 훈련장의 한 자리가 아니라 감독 옆에 서는
 * 한 사람이고, 감독이 바뀌어도 그 구단의 축구를 아는 사람이다 (people.md §2-1).
 */
const HEAD_COACH_SALARY_FACTOR = 2;

/** 수석코치 계약의 길이 — 감독의 임기보다 길다. 그가 구단의 사람인 이유가 그것이다 */
const HEAD_COACH_CONTRACT_YEARS = 3;

/** 수석코치의 연봉 (£/년) — 스태프와 같은 자를 두 배로 읽는다 */
export function headCoachSalaryOf(teamId: string): number {
  return (
    Math.round((staffSalaryOf(teamId, "coach") * HEAD_COACH_SALARY_FACTOR) / SALARY_ROUNDING) *
    SALARY_ROUNDING
  );
}

/** 시작 스태프가 그 구단에 있어 온 햇수의 폭 — 그들은 감독보다 먼저 있었다 */
const STAFF_TENURE_MIN = 1;
const STAFF_TENURE_MAX = 6;
/** 시작 스태프의 남은 계약 연수 폭 — 계약은 6월 30일에 끝난다 */
const STAFF_CONTRACT_MIN = 1;
const STAFF_CONTRACT_MAX = 3;

/**
 * 스태프를 만든다 — **이름은 구단이, 사람됨은 시드가** (people.md §2-2).
 *
 * 수석코치와 같은 규칙이되 자리가 여럿이라 채널에 번호가 붙는다. **한 역할 안에서는
 * 원형이 겹치지 않는다** — 피지컬 코치 둘이 서면 감독이 두 사람을 구분할 근거가 없다.
 *
 * 부임일이 감독보다 앞서는 것이 요점이다: 그들은 감독이 오기 전부터 그 구단에 있었고,
 * 카드의 「부임 4년째」가 그 사실을 말한다.
 *
 * @param today 세계의 오늘 — 부임일과 계약 만료가 여기서 뒤로·앞으로 뻗는다
 */
export function generateStaff(seed: number, teamId: string, today: string): Persona[] {
  const names = personaNames(seed, teamId).staff;
  const people: Persona[] = [];
  for (const role of STAFF_ROLES) {
    const table = STAFF_ARCHETYPES[role];
    // 한 역할 안에서 원형이 겹치지 않게 — 표를 결정적으로 섞고 앞에서 끊는다
    const order = shuffled(table, seed, `persona:staff-order:${role}:${teamId}`);
    for (let index = 0; index < STAFF_OPENINGS[role]; index += 1) {
      const archetype = order[index % order.length]!;
      const name = names[`${role}:${index}`];
      if (name === undefined) continue;
      const rng = makeRng(seed, `persona:staff:${role}:${index}:${teamId}`);
      const tenure = randInt(rng, STAFF_TENURE_MIN, STAFF_TENURE_MAX);
      const left = randInt(rng, STAFF_CONTRACT_MIN, STAFF_CONTRACT_MAX);
      people.push(
        staffPersona({
          seed,
          teamId,
          name,
          role,
          archetype,
          since: `${Number(today.slice(0, 4)) - tenure}-07-01`,
          until: contractUntil(today, left),
          salary: staffSalaryOf(teamId, role),
        }),
      );
    }
  }
  return people;
}

/**
 * 한 사람을 세운다 — **생성과 고용이 같은 문을 지난다.**
 *
 * 새 게임의 시작 인원도, 풀에서 데려온 사람도 여기서 같은 꼴이 된다. 두 곳에 적으면
 * 고용한 코치만 키워드가 없거나 말투가 비는 날이 온다.
 */
export function staffPersona(input: {
  seed: number;
  teamId: string;
  name: string;
  role: StaffRole;
  archetype: StaffArchetype;
  since: string;
  until: string;
  salary: number;
  from?: string;
}): Persona {
  const { archetype } = input;
  return {
    characterId: input.name,
    name: input.name,
    role: input.role,
    archetype: archetype.label,
    traits: [...archetype.traits],
    motivation: archetype.motivation,
    speechStyle: { note: archetype.speech.note, samples: [...archetype.speech.samples] },
    keywords: personaKeywords({ name: input.name, role: input.role }),
    employment: {
      teamId: input.teamId,
      title: archetype.title,
      since: input.since,
      contract: { salary: input.salary, until: input.until },
      ...(input.from === undefined ? {} : { from: input.from }),
    },
    seed: input.seed,
  };
}

/**
 * 원형 라벨 → 표의 줄. 세이브와 풀이 드는 것은 라벨이므로(사람이 읽는 데이터라
 * 생성이 키를 버린다) 그 사이를 되짚는 자리가 여기 하나다.
 *
 * 표에 없는 라벨은 `null` — `coachArchetypeKeyOf`와 같은 규약이다.
 */
export function staffArchetypeOf(role: StaffRole, label: string): StaffArchetype | null {
  return STAFF_ARCHETYPES[role].find((a) => a.label === label) ?? null;
}

/** 그 역할의 원형 전수 — 풀이 사람을 뽑을 때와 테스트가 훑을 때가 같은 표를 본다 */
export function staffArchetypesOf(role: StaffRole): readonly StaffArchetype[] {
  return STAFF_ARCHETYPES[role];
}

export type { StaffArchetype };

/**
 * 이 세이브의 스태프 — 고용 정보를 든 사람들. **수석코치는 여기 없다**
 * (`headCoachOf`가 답한다).
 *
 * 옛 세이브라 비어 있으면 빈 배열이다 — 없는 것이 곧 뜻이고, 로드 보정
 * (`ensureStaff`)이 채운다.
 */
export function staffOf(state: { personas?: Persona[] }, role?: StaffRole): Persona[] {
  return (state.personas ?? []).filter(
    (p) => isStaffRole(p.role) && (role === undefined || p.role === role),
  );
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
  const name = personaNames(seed, teamId).owner;
  return {
    characterId: name,
    name,
    role: "owner",
    archetype: archetype.label,
    traits: [...archetype.traits],
    motivation: archetype.motivation,
    speechStyle: { note: archetype.speech.note, samples: [...archetype.speech.samples] },
    keywords: personaKeywords({ name, role: "owner" }),
    real: real !== null ? true : undefined,
    seed,
  };
}

/** 원형 목록 — 테스트·어드민이 전수를 훑을 때 쓴다 */
export const OWNER_ARCHETYPE_LABELS = OWNER_ARCHETYPES.map((a) => a.label);

/**
 * 저장된 구단주 원형 **라벨 → 키** — `coachArchetypeKeyOf`와 같은 규약이다.
 *
 * 세이브에 남는 것은 `"지역 유지형"` 같은 라벨인데(페르소나는 사람이 읽는 데이터라
 * `generateOwner`가 키를 버린다), 클럽 비전의 항목표(career.md §5)와 보드 요청표
 * (§5.2)는 **키**로 갈린다. 그 사이를 되짚는 자리가 여기 하나다.
 *
 * 표에 없는 라벨은 `null`이다 — 옛 세이브의 커스텀 구단주는 조용히 빈손이 되고,
 * 다른 원형의 결이 대신 서지는 않는다.
 */
export function ownerArchetypeKeyOf(persona: Pick<Persona, "archetype">): string | null {
  return OWNER_ARCHETYPES.find((a) => a.label === persona.archetype)?.key ?? null;
}

/** 원형 목록 — 테스트·어드민이 전수를 훑을 때 쓴다 */
export const HEAD_COACH_ARCHETYPES = COACH_ARCHETYPES.map((a) => a.label);

/**
 * 수석코치 원형 **키 → 라벨** 전수 — 키는 원형이 무엇을 먼저 보는지 가르는 축이고
 * (people.md §7-1), 라벨은 세이브에 남는 것이다. 둘을 잇는 표가 여기 하나다.
 */
export const COACH_ARCHETYPE_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  COACH_ARCHETYPES.map((a) => [a.key, a.label]),
);

/**
 * 저장된 원형 **라벨 → 키**.
 *
 * 세이브에 남는 것은 `"데이터 분석가형"` 같은 라벨이다(`generateHeadCoach`가 키를
 * 버리고 라벨만 적는다 — 페르소나는 사람이 읽는 데이터라서다). 그런데 코치가 무엇을
 * 먼저 보는지 가르는 표는 **키**로 갈리므로, 그 사이를 여기서 되짚는다.
 *
 * 표에 없는 라벨은 `null`이다 — 옛 세이브가 사라진 원형을 들고 있어도 조용히 빈손이
 * 되고, 다른 코치의 눈이 대신 서지는 않는다.
 */
export function coachArchetypeKeyOf(persona: Pick<Persona, "archetype">): string | null {
  return COACH_ARCHETYPES.find((a) => a.label === persona.archetype)?.key ?? null;
}

/**
 * 타 팀 감독 원형 — **어떤 축구로 이기려는 사람이고, 마이크 앞에서 무엇을 말하는가.**
 *
 * 수석코치(감독을 돕는 사람)·구단주(감독을 고용한 사람)와 자리가 다르다: 이 사람들은
 * 감독의 **맞수**다. 말은 회견장과 중계, 경기 전후의 악수에서 들린다 — 존대는
 * 하되 동료 감독의 거리다.
 */
interface ManagerArchetype extends CoachArchetype {
  /**
   * **마이크 앞의 결과 그 말이 설 확률** (people.md §2 표). 결 코드는 회견 카드의
   * `tags[0]`이 되고, 확률은 우리 경기의 자리 하나에 그가 입을 열 확률이다
   * (더비면 `RIVAL_VOICE_DERBY_BONUS`가 더해진다 — `club/press.ts`).
   */
  voice: { code: RivalVoice; chance: number };
}

const MANAGER_ARCHETYPES: readonly ManagerArchetype[] = [
  {
    key: "structure_architect",
    voice: { code: "analysis", chance: 0.3 },
    label: "구조 설계자형",
    traits: ["이론가", "완벽주의", "내용 우선", "자기 확신"],
    motivation: "결과보다 먼저, 경기가 자기 그림대로 굴러가는 것을 보고 싶다.",
    speech: {
      note: "경기를 구조와 공간의 언어로 설명한다. 패배 뒤에도 내용을 먼저 말한다.",
      samples: [
        "점수는 그렇게 나왔지만, 60분까지는 우리가 설계한 경기였습니다.",
        "상대가 잘한 게 아니라 우리가 간격을 잃은 겁니다. 그건 고칠 수 있습니다.",
      ],
    },
  },
  {
    key: "winner",
    voice: { code: "provoke", chance: 0.45 },
    label: "승부사형",
    traits: ["결과 지상주의", "도발을 즐긴다", "승부처를 읽는다"],
    motivation: "말은 남지 않는다 — 이긴 기록만 남는다.",
    speech: {
      note: "짧게 자르고 단정한다. 웃는 얼굴로 찌르는 말을 한다.",
      samples: [
        "내용이요? 순위표에는 내용을 적는 칸이 없습니다.",
        "저쪽 벤치가 무슨 말을 했는지는 모르겠고, 스코어는 제가 기억합니다.",
      ],
    },
  },
  {
    key: "pragmatist",
    voice: { code: "respect", chance: 0.35 },
    label: "실용주의형",
    traits: ["상대 분석 우선", "유연함", "계산된 겸손"],
    motivation: "가진 패로 이길 수 있는 판을 만든다.",
    speech: {
      note: "자기 팀을 낮추고 상대를 올리는 말로 시작하지만, 준비한 수는 정확히 안다.",
      samples: [
        "우리가 더 좋은 팀이라고는 안 했습니다. 오늘 더 준비된 팀이었을 뿐이죠.",
        "상대가 강하면 판을 바꾸면 됩니다. 자존심은 순위표 옆에 두고 옵니다.",
      ],
    },
  },
  {
    key: "firebrand",
    voice: { code: "provoke", chance: 0.4 },
    label: "열혈 지휘관형",
    traits: ["감정이 크다", "선수를 끌어안는다", "터치라인의 소란"],
    motivation: "선수들이 자기를 위해 뛰게 만든다 — 전술은 그다음이다.",
    speech: {
      note: "목소리가 크고 감정이 그대로 드러난다. 심판과 일정 이야기가 자주 나온다.",
      samples: [
        "우리 선수들은 오늘 전부를 쏟았습니다. 그걸 못 보셨다면 다른 경기를 보신 겁니다.",
        "그 판정 하나에 경기가 갈렸습니다. 말 안 하고 넘어갈 수는 없죠.",
      ],
    },
  },
  {
    key: "youth_believer",
    voice: { code: "patience", chance: 0.25 },
    label: "육성 신봉형",
    traits: ["장기 시야", "어린 선수 신뢰", "인내"],
    motivation: "3년 뒤에 완성될 팀을 지금부터 만든다.",
    speech: {
      note: "결과 질문에 성장의 언어로 답한다. 어린 선수의 이름을 자주 부른다.",
      samples: [
        "오늘 데뷔한 열여덟 살을 보셨습니까? 이 경기에서 우리가 가져가는 건 그 아이입니다.",
        "지금 순위로 우리를 판단하셔도 됩니다. 2년 뒤에 다시 이야기하죠.",
      ],
    },
  },
  {
    key: "bolt_realist",
    voice: { code: "defensive", chance: 0.2 },
    label: "빗장 현실주의형",
    traits: ["수비 조직 신봉", "냉정한 계산", "낭만 없음"],
    motivation: "가진 것보다 많이 내주지 않는 팀으로 살아남는다.",
    speech: {
      note: "실점과 승점의 산수로 말한다. 화려함을 물으면 예산 이야기로 답한다.",
      samples: [
        "아름다운 축구요? 우리 임금 총액으로는 승점 1점이 아름답습니다.",
        "무실점이면 최소 승점 1입니다. 우리는 거기서 시작합니다.",
      ],
    },
  },
];

/** 원형 목록 — 테스트·어드민이 전수를 훑을 때 쓴다 */
export const MANAGER_ARCHETYPE_LABELS = MANAGER_ARCHETYPES.map((a) => a.label);

/**
 * **명부 감독의 원형 라벨을 위 여섯 중 하나로 되짚는 표** (people.md §2).
 *
 * 명부(`data/world-figures.ts`)는 원형을 추첨하지 않고 사람마다 직접 적으므로, 그
 * 라벨 중에는 수석코치 쪽 이름을 쓰는 것이 있다. 결 코드를 명부 줄마다 또 적으면
 * 같은 규칙이 두 표에 살고 한쪽만 고쳐진 채 오래 산다 — 되짚는 자리를 여기 하나로
 * 둔다. 감독 원형 여섯은 자기 라벨로 자기를 가리킨다.
 *
 * 표에 없는 라벨은 **말하지 않는다** (`coachArchetypeKeyOf`와 같은 규약).
 */
const MANAGER_ARCHETYPE_OF_LABEL: Readonly<Record<string, string>> = {
  ...Object.fromEntries(MANAGER_ARCHETYPES.map((a) => [a.label, a.key])),
  // 몸과 강도를 먼저 보는 사람의 마이크다
  "야전 조련사형": "firebrand",
  // 사람을 먼저 보면 상대도 높여 말한다
  인간관계형: "pragmatist",
  // 과거 사례와의 비교는 분석의 언어다
  "노장 전술가형": "structure_architect",
  // 구단의 역사를 말하는 사람은 긴 시야다
  "구단 토박이형": "youth_believer",
  "유스 육성형": "youth_believer",
  "데이터 분석가형": "structure_architect",
};

/** 상대 벤치의 목소리 — 누가 앉아 있고, 무슨 결로, 얼마나 자주 말하는가 */
export interface RivalVoiceCard {
  /** 그 감독 — 이름이 곧 `characterId`다 (people.md §1) */
  name: string;
  code: RivalVoice;
  /** 그 자리 하나에 입을 열 확률 — 더비 가산은 부르는 쪽이 얹는다 */
  chance: number;
}

/**
 * 그 벤치의 사람이 마이크 앞에서 내는 결 — **명부든 가상이든 같은 문을 지난다**
 * (people.md §2·§4).
 *
 * 이름이 없는 벤치(감독 자신의 구단, 옛 세이브의 빈 벤치)와 표가 되짚지 못하는
 * 원형은 `null`이다 — 없는 사람의 말을 지어내는 것보다 아무도 말하지 않는 편이 낫다.
 */
export function rivalVoiceOf(
  state: {
    seed: number;
    userTeamId: string;
    teams: readonly { id: string; managerName?: string; managerPersonaSeat?: string }[];
    managerPool?: readonly { name: string }[];
  },
  teamId: string,
): RivalVoiceCard | null {
  if (teamId === state.userTeamId) return null;
  const bench = state.teams.find((t) => t.id === teamId);
  const name = bench?.managerName;
  if (name === undefined || name === "") return null;
  const persona =
    worldFigureByName(state, name) ??
    generateVirtualManager(state.seed, name, bench?.managerPersonaSeat);
  const key = MANAGER_ARCHETYPE_OF_LABEL[persona.archetype];
  const archetype = MANAGER_ARCHETYPES.find((a) => a.key === key);
  return archetype ? { name, code: archetype.voice.code, chance: archetype.voice.chance } : null;
}

/**
 * 가상 감독을 만든다 — **저장하지 않고 (시드, 이름)에서 파생한다** (people.md §2).
 *
 * 선수 페르소나와 같은 규약이다: 리그 95개 벤치분 카드를 세이브에 넣을 이유가 없고,
 * 생성이 결정적이라 파생으로 충분하다. **채널에 팀이 없는 것이 핵심이다** — 감독은
 * 자리가 아니라 사람이라 잘렸다가 다른 벤치에 다시 서도 같은 원형·같은 말투다
 * (→ ../../../../docs/simulation/transfer.md §7 「감독 풀」). 이름이 채널의 전부이므로
 * 경질 후임은 전임과 독립인 추첨을 받는다.
 *
 * 키워드는 명부 인물의 규칙을 따른다(전체 이름 + 성) — 이름 조각을 전부 담으면
 * 흔한 이름 조각이 남의 문장에 걸려 한 턴 상한 3장을 남의 이름이 먹는다.
 *
 * @param personaSeat 옛 채널의 팀 — 채널이 `(시드, 팀, 이름)`이던 시절의 세이브만
 *                    든다 (`GameTeam.managerPersonaSeat`). 그 표식이 있으면 그때
 *                    서 있던 사람을 그대로 돌려준다.
 */
export function generateVirtualManager(seed: number, name: string, personaSeat?: string): Persona {
  const rng = makeRng(
    seed,
    personaSeat === undefined
      ? `persona:manager:${name}`
      : `persona:manager:${personaSeat}:${name}`,
  );
  const archetype = pick(rng, MANAGER_ARCHETYPES);
  const parts = name.split(/\s+/u);
  const surname = parts[parts.length - 1] ?? "";
  return {
    characterId: name,
    name,
    role: "manager",
    archetype: archetype.label,
    traits: [...archetype.traits],
    motivation: archetype.motivation,
    speechStyle: { note: archetype.speech.note, samples: [...archetype.speech.samples] },
    keywords: surname.length >= KEYWORD_MIN_LENGTH && surname !== name ? [name, surname] : [name],
    seed,
  };
}

/**
 * 끝난 협상 — 나머지(`open`·`agreed`)는 아직 테이블에 사람이 앉아 있다.
 * 종료 상태를 빼는 방향이라 상태가 하나 늘어도 화자가 조용히 사라지지 않는다.
 */
const CLOSED_NEGOTIATION = new Set<string>([
  "completed",
  "rejected",
  "expired",
] satisfies Negotiation["status"][]);

/**
 * **이름난 현역의 선** — 종합이 이만큼이면 세계가 그 이름을 안다 (people.md §6).
 *
 * 세계에 명성 필드가 없어 능력치로 긋는다. 시장가는 나이 먹은 레전드를 0으로 만들어
 * **정확히 담아야 할 이름을 떨어뜨리고**, 잠재력은 85 이상이 대부분 스물 미만이라
 * 더 나쁘다. 82는 세계 5,300명 중 58명이 서는 선이다 — 여기를 낮추면 동명이인이
 * 늘어 정작 우리 선수가 사라진다(`candidatesOf`).
 */
const FAMOUS_PLAYER_OVERALL = 82;

/**
 * 능력치가 답하지 못하는 이름들 — **시장 전용 리그(사우디·MLS)의 시드 명단**.
 *
 * 마흔한 살 호날두는 82지만 서른아홉 메시는 80이고 수아레스는 75다. 나이가 깎은
 * 것은 기량이지 이름값이 아니다. 그 표는 이미 "감독이 데려올 만한 이름"만 담기로
 * 하고 만든 명단이므로(`data/market-leagues.ts`), **표가 곧 명성의 선이다** —
 * 표에서 지우면 그 이름은 세계에서 사라진다.
 *
 * 팀이 아니라 이름으로 본다: 그 선수가 유럽으로 돌아와도 세계가 아는 이름은 그대로다.
 */
const MARKET_LEGEND_NAMES: ReadonlySet<string> = new Set(
  Object.values(MARKET_LEAGUE_SQUADS)
    .flat()
    .map((seed) => seed.nameKo),
);

/**
 * 세계가 이 이름을 아는가 — 능력치의 선, 또는 시장 전용 리그의 시드 명단.
 * 인물 사전(`candidatesOf`)과 화자 사전(`collectSpeakers`)이 같은 선을 든다 —
 * 두 곳이 다른 세계를 알면 화면·기억·등록 검사가 서로 어긋난다.
 */
export function isFamousPlayer(overall: number, name: string): boolean {
  return overall >= FAMOUS_PLAYER_OVERALL || MARKET_LEGEND_NAMES.has(name);
}

/** 화자 사전을 만들 최소 상태 — 세이브 전체가 아니라 필요한 것만 받는다 */
interface SpeakerSource {
  seed: number;
  userTeamId: string;
  personas?: Persona[];
  players?: Array<{
    id?: string;
    name: string;
    teamId: string;
    isCaptain?: boolean;
    isViceCaptain?: boolean;
    /** 이름난 현역 판정용 — 없으면(축약 픽스처) 이름난 현역으로 서지 않는다 */
    attributes?: { overall: number };
  }>;
  negotiations?: Array<{ gamePlayerId: string; status: string }>;
  /** 가상 감독 판정용 — 없으면(축약 픽스처) 타 팀 벤치가 사전에 서지 않는다 */
  teams?: Array<{ id: string; managerName?: string }>;
  /** 명부 감독이 지금 세계에 서 있는지 — 잘려서 풀에 앉은 사람도 이름을 갖는다 */
  managerPool?: ReadonlyArray<{ name: string }>;
}

/**
 * 화자의 **자리** — 이름 옆의 직책과 앞의 아이콘이 여기서 나온다.
 *
 * `label`은 화면에 글자로 붙고 `kind`는 아이콘을 고른다. **둘이 따로인 이유**는
 * 선수다: 대화마다 `(선수)`가 따라붙으면 시끄럽지만, 유니폼 아이콘 하나는
 * "지금 말하는 사람이 선수구나"를 조용히 알린다.
 */
export type SpeakerKind = PersonaRole | "captain";
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
 *    **주장**·**우리 선수단**·협상 테이블에 앉은 상대 선수, 그리고 **이름난 현역과
 *    세계 인물 명부, 타 팀 벤치의 가상 감독**까지(인물 사전의 세 겹 그대로 —
 *    people.md §6). 포지션은 넣지 않는다: 대화마다 따라붙기엔 시끄럽고, 그건
 *    명단이 답하는 정보다.
 * ③ **잘못된 자리보다 없는 게 낫다.** 같은 이름이 둘이면(코치와 선수가 동명이인)
 *    무엇을 붙여도 절반은 틀리므로 **아예 붙이지 않는다** — 화면은 사람 아이콘만 세운다.
 *    이름난 현역·명부는 예외다: 뒤 겹은 이미 찬 자리를 넘보지 않으므로(인물 사전과
 *    같은 답) 그쪽과 겹쳐도 우리 쪽 칩이 사라지지 않는다.
 *
 * 사전에 **전 리그 4,000명을 담지 않는 이유**도 ③과 같다: 남의 팀 3군까지 넣으면
 * 동명이인이 늘어 정작 우리 선수가 사라진다. 우리 선수단은 40명 남짓이라 사전이
 * 가볍고, 대화에 서는 사람의 대부분이기도 하다.
 */
export function speakerRoles(state: SpeakerSource): Record<string, SpeakerRole> {
  const roles: Record<string, SpeakerRole> = {};
  for (const [key, role] of collectSpeakers(state)) if (role !== null) roles[key] = role;
  return roles;
}

/**
 * 사전을 만들기 **전**의 자리들 — 값이 `null`이면 이름이 겹쳐 판단을 포기한 자리다.
 *
 * `speakerRoles`가 걸러 내기 전 단계를 따로 두는 이유는 **이름 충돌 검사**다: 겹쳐서
 * 빠진 이름은 사전에 없지만 그 이름의 자리는 이미 차 있다. 사전만 보고 등록하면
 * 하필 그 자리에 새 인물이 선다 (`registerCharacters`).
 */
function collectSpeakers(state: SpeakerSource): Map<string, SpeakerRole | null> {
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
          : /**
             * 스태프는 **직책이 정보다** — 「코치」는 클립보드 아이콘이 이미 말하고,
             * 감독이 알아야 할 것은 훈련장의 어느 자리냐다 (people.md §3). 기자가
             * 직책 대신 매체를 다는 것과 같은 규약이고, 고용 정보가 없는 옛 세이브는
             * 역할 라벨로 돌아간다.
             */
            isStaffRole(persona.role) && persona.employment
            ? persona.employment.title
            : // 선수는 유니폼 아이콘이 이미 말한다 — 대화마다 `(선수)`가 따라붙으면 시끄럽다
              persona.role === "player"
              ? undefined
              : personaRoleLabel(persona.role),
    });
  }

  /**
   * 우리 선수단 — **완장만 직책을 글자로 얻고**, 나머지는 아이콘으로만 선다.
   * 부주장도 같은 아이콘을 쓴다: 그림이 가리키는 것은 완장이고, 둘 중 어느
   * 자리인지는 글자가 말한다 (people.md §5-1).
   */
  const squad = (state.players ?? []).filter((p) => p.teamId === state.userTeamId);
  for (const player of squad) {
    if (player.isCaptain === true) put(player.name, { kind: "captain", label: CAPTAIN_ROLE_LABEL });
    else if (player.isViceCaptain === true) {
      put(player.name, { kind: "captain", label: LEADER_ROLE_LABEL.vice });
    } else put(player.name, { kind: "player" });
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

  // ── 이름난 현역 · 세계 인물 명부 — 인물 사전의 세 겹 그대로 (people.md §3·§6) ──
  // **이미 찬 자리는 넘보지 않는다**: 인물 사전이 후보를 모으는 순서와 같은 답이라,
  // 뒤 겹 때문에 우리 선수가 칩을 잃지 않는다. `put`의 "둘 다 버린다"는 우리
  // 사람끼리 겹쳤을 때의 것이다 — 그때는 어느 쪽을 골라도 절반은 틀린다.
  const claim = (rawName: string, role: SpeakerRole) => {
    const key = normalizeSpeaker(rawName);
    if (key && !seen.has(key)) seen.set(key, role);
  };
  for (const player of state.players ?? []) {
    if (player.attributes !== undefined && isFamousPlayer(player.attributes.overall, player.name))
      // 유니폼 아이콘이 이미 말한다 — 라벨을 붙일 직책이 없다
      claim(player.name, { kind: "player" });
  }
  for (const figure of worldFigures(state)) {
    claim(figure.characterId, {
      kind: figure.role,
      label: personaRoleLabel(figure.role),
    });
  }
  // 타 팀 벤치의 감독 — 명부 감독은 위에서 이미 섰고(같은 이름), 나머지가 가상 감독이다.
  // 유저 팀 벤치는 유저의 것이라 빠진다 (people.md §2)
  for (const team of state.teams ?? []) {
    if (team.id === state.userTeamId || team.managerName === undefined) continue;
    claim(team.managerName, { kind: "manager", label: personaRoleLabel("manager") });
  }

  return seen;
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

/**
 * **사실의 화자** — 코어가 내는 사실은 그대로고, 그 사실이 프롬프트에서 누구의 것으로
 * 서는가만 정한다 (people.md §3 「화자 표」).
 *
 * | 갈래         | 무엇                                       | 누가     |
 * | ------------ | ------------------------------------------ | -------- |
 * | `medical`    | 부상 · 부상 이력 · 과부하                  | 의료진   |
 * | `scouting`   | 스카우팅 진행 · 도착한 보고서·임무          | 스카우트 |
 * | `coach_eye`  | 원형이 고른 사실 (people.md §7-1)          | 수석코치 |
 * | `training`   | 훈련 결산 · 임대 리포트 · 2군 유망주       | 코치     |
 *
 * **자리가 비면 수석코치가 대신 선다** — 의료진을 자른 세이브에서도 부상 줄은 서야
 * 하고, 화자 없는 사실 덩어리는 이 장치가 없애려던 바로 그 모습이다.
 *
 * 여럿이면 **명단의 첫 사람**이다. 굴림을 넣으면 같은 턴을 두 번 그릴 때 화자가 갈리고,
 * 이력에 굳은 카드와 어긋난다.
 */
export type FactChannel = "medical" | "scouting" | "coach_eye" | "training";

const FACT_SPEAKER_ROLE: Record<FactChannel, StaffRole | null> = {
  medical: "medic",
  scouting: "scout",
  coach_eye: null,
  training: "coach",
};

export function factSpeakerOf(
  state: { seed: number; userTeamId: string; personas?: Persona[] },
  channel: FactChannel,
): Persona {
  const role = FACT_SPEAKER_ROLE[channel];
  return (role === null ? undefined : staffOf(state, role)[0]) ?? headCoachOf(state);
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
 * 팀을 넣지 않는다. 같은 리그 안에서 팀을 옮기면 같은 기자를 만나고, 리그를
 * 건너면 부임이 갈아 세운다 (`reseatClubPersonas`).
 */
export function generateReporters(seed: number, teamId: string): Persona[] {
  const names = personaNames(seed, teamId);
  return REPORTER_ARCHETYPES.map((archetype) => {
    const rng = makeRng(seed, `persona:reporter:${archetype.key}`);
    const name = names.reporters[archetype.key]!;
    const outlet = pick(rng, OUTLET_NAMES[archetype.key] ?? ["프레스"]);
    return {
      characterId: name,
      name,
      role: "reporter" as const,
      archetype: `${archetype.label} · ${outlet}`,
      traits: [...archetype.traits],
      motivation: archetype.motivation,
      speechStyle: { note: archetype.speech.note, samples: [...archetype.speech.samples] },
      keywords: personaKeywords({ name, role: "reporter", outlet }),
      outlet,
      seed,
    };
  });
}

/* ------------------------------------------------------------------ *
 * 세계 인물 명부 — 구단 밖의 이름들 (people.md §2-1)
 * ------------------------------------------------------------------ */

/**
 * 명부는 **뽑히지 않는다** — 성격도 말투도 표가 직접 적으므로 재현할 추첨이 없다.
 * 스키마가 `seed`를 요구하는 자리에 그 사실을 그대로 적는다.
 */
const WORLD_FIGURE_SEED_MARK = 0;

/**
 * 명부 인물의 키워드 — **전체 이름과 성**이다.
 *
 * `personaKeywords`처럼 이름 조각을 전부 담지 않는 이유: "펩"·"루이스"·"사비"는
 * 다른 사람의 이름 안에도 있어서, 담으면 한 턴 상한 3장을 남의 이름이 먹는다.
 * 성이 흔한 말과 겹치는 사람(치부·캐릭)은 표가 직접 키워드를 적어 성 호출을 끈다.
 */
function worldFigureKeywords(seed: WorldFigureSeed): string[] {
  if (seed.keywords !== undefined) return [...seed.keywords];
  const parts = seed.name.split(/\s+/u);
  const surname = parts[parts.length - 1] ?? "";
  return surname.length >= KEYWORD_MIN_LENGTH && surname !== seed.name
    ? [seed.name, surname]
    : [seed.name];
}

function worldFigurePersonaOf(seed: WorldFigureSeed): Persona {
  return {
    characterId: seed.name,
    name: seed.name,
    role: seed.role,
    archetype: seed.archetype,
    traits: [...seed.traits],
    motivation: seed.motivation,
    speechStyle: { note: seed.speech.note, samples: [...seed.speech.samples] },
    keywords: worldFigureKeywords(seed),
    real: true,
    seed: WORLD_FIGURE_SEED_MARK,
  };
}

/**
 * 명부가 사는 세계 — **어디에 서 있는가를 묻는 쪽의 타입** (people.md §2-1).
 *
 * `teams`가 optional인 이유: 에이전트 한 사람을 뽑는 자리(`agentForPlayer`)처럼
 * 벤치를 들고 있지 않은 호출부가 있고, 그 자리가 묻는 시드에는 벤치가 애초에 없다.
 */
interface WorldFigureScope {
  userTeamId: string;
  teams?: readonly { id: string; managerName?: string }[];
  managerPool?: readonly { name: string }[];
}

/**
 * 이 명부 인물이 **지금 세계에 서 있는가** (people.md §2-1).
 *
 * 감독만 자리를 묻는다 — 어느 벤치의 `managerName`이거나 무직 감독 풀에 있으면
 * 세계의 사람이고, 둘 다 아니면 없는 사람이다. 세계 생성 때 유저가 맡은 팀의 명부
 * 감독이 그 자리다: 그 벤치를 감독(유저)이 받았으므로 어디에도 서지 못했다.
 * 에이전트·해설은 구단의 자리가 아니라 언제나 세계에 있다.
 *
 * 벤치를 모르는 호출부는 **시드가 적은 팀**으로 떨어진다 — 감독이 옮겨 다니기
 * 전까지는 같은 답이고, 그런 호출부는 감독 시드를 묻지 않는다.
 */
function figureStands(state: WorldFigureScope, seed: WorldFigureSeed): boolean {
  if (seed.role !== "manager") return true;
  if (state.teams === undefined) return seed.teamId !== state.userTeamId;
  return (
    state.teams.some((t) => t.id !== state.userTeamId && t.managerName === seed.name) ||
    (state.managerPool ?? []).some((e) => e.name === seed.name)
  );
}

/**
 * 이 세이브가 사는 세계의 명부 (people.md §2-1).
 *
 * **세이브에 넣지 않는다** — 불변 초기치라 읽는 자리에서 파생하고, 표를 비우면 그
 * 인물은 세계에서 사라진다. 코치·구단주 시드와 같은 청산 구조다.
 *
 * 감독은 **지금 어디 있는가**로 걸러진다(`figureStands`) — 잘려도 풀에 남아 있는
 * 한 세계의 사람이고, 어디에도 서지 못한 사람만 빠진다.
 */
export function worldFigures(state: WorldFigureScope): Persona[] {
  return WORLD_FIGURE_SEEDS.filter((f) => figureStands(state, f)).map(worldFigurePersonaOf);
}

/**
 * 이 선수를 대리하는 에이전트 — **(시드, 선수)에서 결정적으로 뽑는다.** 같은 세이브의
 * 같은 선수는 언제나 같은 사람이 대리한다 (people.md §1 일관성).
 *
 * 이적 요청을 들고 오는 자리(`club/approach.ts`)와 협상 테이블 건너편
 * (`market/counterparty.ts`)이 같은 사람을 봐야 하므로, 규칙은 둘 다 의존하는 여기
 * 하나에 산다 (AGENTS.md §5).
 *
 * 명부에 에이전트가 한 사람도 없으면 `null`이다 — 코어는 화자를 지어내지 않는다.
 */
export function agentForPlayer(
  state: WorldFigureScope & { seed: number },
  playerId: string,
): Persona | null {
  const agents = worldFigures(state).filter((f) => f.role === "agent");
  if (agents.length === 0) return null;
  return pick(makeRng(state.seed, `agent-of:${playerId}`), agents);
}

/**
 * 그 라운드의 평가를 낸 해설 — **(시드, 시즌, 라운드)에서 결정적으로 뽑는다**
 * (people.md §4-1). 같은 세이브의 같은 라운드는 언제나 같은 사람이 말한다.
 *
 * `agentForPlayer`와 **같은 자리, 같은 규약**이다: 명부에서 역할 하나로 한 사람을
 * 뽑는 규칙은 여기 하나에 산다 (AGENTS.md §5). 명부에 해설이 한 사람도 없으면
 * `null`이다 — 표를 비우는 것이 곧 라이선스 청산이라(§2-1), 코어는 화자를 지어내지
 * 않고 그 갈래가 세계에서 조용히 사라진다.
 */
export function punditForRound(
  state: WorldFigureScope & { seed: number },
  season: number,
  round: number,
): Persona | null {
  const pundits = worldFigures(state).filter((f) => f.role === "pundit");
  if (pundits.length === 0) return null;
  return pick(makeRng(state.seed, `pundit:${season}:${round}`), pundits);
}

/** 명부에서 이 이름을 찾는다 — 이력을 다시 그릴 때의 입구 (`characterEntryOf`) */
export function worldFigureByName(state: WorldFigureScope, name: string): Persona | null {
  const seed = WORLD_FIGURE_SEEDS.find((f) => f.name === name);
  return seed && figureStands(state, seed) ? worldFigurePersonaOf(seed) : null;
}

/**
 * 부임 — 구단에 묶인 자리를 새 구단 기준으로 다시 세운다 (career.md §5.1).
 *
 * 수석코치·구단주는 구단의 사람이라 언제나 갈리고, 기자단은 리그를 따라다니므로
 * 리그를 건널 때만 갈린다. 생성이 시드로 결정적이라 같은 세이브가 같은 이직을
 * 하면 같은 사람을 만나고, 실명 시드가 있는 구단이면 그 실명 코치·구단주가 선다.
 *
 * `characterMemories`는 건드리지 않는다 — 기억은 `characterId`에 묶여 있어 옛
 * 코치의 기억은 옛 이름에 남고, 새 코치는 빈 채로 시작한다. GM이 등록한 인물
 * (friend·supporter)도 그대로다 — 구단이 아니라 감독의 사람들이다.
 *
 * 빈자리를 지우기만 하고 `ensurePersonas`에 맡기지 않는 이유: 그 보정은 로드에서
 * 돌므로, 부임한 세션의 남은 턴이 코치 없는 세이브로 흐른다.
 */
export function reseatClubPersonas(
  state: { seed: number; date: string; personas?: Persona[] },
  teamId: string,
  options: { crossedLeague: boolean },
): void {
  const clubBound = new Set<PersonaRole>([
    "head_coach",
    "owner",
    /**
     * **스태프는 구단의 사람이다** (people.md §2-2) — 감독이 데려가는 것이 아니라
     * 옛 구단에 남고, 새 구단에는 그 구단의 코치·의료진·스카우트가 이미 서 있다.
     * 리그를 건너는지와 무관하다: 기자만 리그를 따라다닌다.
     */
    ...STAFF_ROLES,
    ...(options.crossedLeague ? (["reporter"] satisfies PersonaRole[]) : []),
  ]);
  state.personas = [
    ...(state.personas ?? []).filter((p) => !clubBound.has(p.role)),
    generateHeadCoach(state.seed, teamId, state.date),
    generateOwner(state.seed, teamId),
    ...generateStaff(state.seed, teamId, state.date),
    ...(options.crossedLeague ? generateReporters(state.seed, teamId) : []),
  ];
}

/**
 * 로드 보정 — **옛 사람됨 채널을 쓰던 세이브의 벤치에 자리 표식을 심는다**
 * (people.md §2 · transfer.md §7 「감독 풀」).
 *
 * 가상 감독의 사람됨 채널이 `(시드, 팀, 이름)`에서 `(시드, 이름)`으로 바뀌었다.
 * 그대로 두면 진행 중인 세이브의 AI 감독 전원이 하루아침에 다른 원형을 갖는다 —
 * 이름은 그대로인데 사람이 갈리는 것이라, 감독이 시즌 내내 상대한 벤치가 통째로
 * 낯설어진다.
 *
 * **가르는 표식은 `managerPool`의 유무 하나다.** 새 게임은 빈 배열로 서고, 이
 * 보정이 지나간 세이브도 빈 배열이 되므로, `undefined`인 세이브는 풀이 생기기
 * 전에 저장된 것 — 곧 옛 채널의 세계다. 멱등이라 두 번 돌아도 같다.
 *
 * 명부 감독의 벤치는 건너뛴다 — 그들의 사람됨은 추첨이 아니라 표가 적으므로
 * 채널이 바뀌어도 갈릴 것이 없다 (people.md §2-1).
 */
export function ensureManagerPool(state: {
  userTeamId: string;
  managerPool?: unknown[];
  teams: Array<{ id: string; managerName?: string; managerPersonaSeat?: string }>;
}): void {
  if (state.managerPool !== undefined) return;
  for (const team of state.teams) {
    if (team.id === state.userTeamId || team.managerName === undefined) continue;
    if (isWorldFigureName(team.managerName)) continue;
    team.managerPersonaSeat ??= team.id;
  }
  state.managerPool = [];
}

/**
 * 로드 보정 — 페르소나가 없는 옛 세이브를 채운다.
 *
 * 생성이 시드로 결정적이라 **채워 넣어도 그 세이브의 코치는 늘 같은 사람**이다.
 * 그래서 세이브 버전을 올리지 않고 조용히 메울 수 있다 (AGENTS.md 세이브 호환성).
 */
export function ensurePersonas(state: {
  seed: number;
  date: string;
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
  /**
   * 스태프가 없던 세이브 — 코치·구단주와 같은 이유로 조용히 채운다 (people.md §2-2).
   *
   * **역할마다 따로 본다**: 의료진만 자른 세이브에 코치까지 다시 세우면 감독이 자른
   * 사람이 이튿날 훈련장에 서 있다. 생성이 결정적이라 채워도 그 세이브의 사람은 같고,
   * 부임일·계약은 **오늘**을 기준으로 뒤로 뻗으므로 옛 세이브도 제 나이의 계약을 얻는다.
   */
  for (const role of STAFF_ROLES) {
    if (state.personas?.some((p) => p.role === role)) continue;
    state.personas = [
      ...(state.personas ?? []),
      ...generateStaff(state.seed, state.userTeamId, state.date).filter((p) => p.role === role),
    ];
  }
  /**
   * 수석코치의 고용 정보 — 스태프와 같은 칸을 든다 (people.md §2-2). 이 칸이 생기기
   * 전의 세이브는 없으므로 그때 채운다. **자리는 그대로이고 계약만 선다** — 사람이
   * 갈리지 않는다.
   */
  const head = state.personas?.find((p) => p.role === "head_coach");
  if (head && head.employment === undefined) {
    head.employment = {
      teamId: state.userTeamId,
      title: HEAD_COACH_ROLE_LABEL,
      since: state.date,
      contract: {
        salary: headCoachSalaryOf(state.userTeamId),
        until: contractUntil(state.date, HEAD_COACH_CONTRACT_YEARS),
      },
    };
  }
  // 키워드가 없던 세이브 — 인물 사전이 훑을 말이 없으면 그 인물은 불려도 서지 않는다.
  // 이름·자리에서 파생하므로 채워도 같은 사람이다 (세이브 버전 유지).
  //
  // ⚠️ **선수는 여기서 만들지 않는다.** 선수 페르소나는 파생이라 세이브에 넣지
  // 않는다 (people.md §6) — 밀어 넣으면 리그 전체가 세이브에 굳는다.
  for (const persona of state.personas ?? []) {
    if (persona.keywords === undefined || persona.keywords.length === 0) {
      persona.keywords = personaKeywords(persona);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 인물 사전 갱신 — 이력이 접힐 때 그 구간이 남기는 것 (people.md §9-1)
 *
 * 맡기는 것은 둘뿐이다: **인물별 기억 한 줄**과 **새 화자 등록**. 인물지의
 * 성격·동기·말투는 시드가 정하고 LLM이 고쳐 쓰지 않는다 — 덮어쓰면 "같은
 * 세이브는 같은 사람을 만난다"가 깨진다 (AGENTS.md §6.4).
 * ------------------------------------------------------------------ */

/** 인물당 남기는 기억 — 넘치면 오래된 것부터 민다 */
export const CHARACTER_MEMORY_KEEP = 6;

/** 모델이 무게를 적지 않았을 때 — 서사 메모리의 기본값(`pushNarrative`)과 같은 눈금이다 */
const CHARACTER_MEMORY_DEFAULT_SALIENCE = 2;

export interface CharacterMemoryDraft {
  characterId: string;
  text: string;
  /** 없으면 코어가 기본값을 준다 */
  salience?: number;
}

/** 기억을 적을 최소 상태 — 날짜는 세이브가 안다 */
interface CharacterMemorySource extends SpeakerSource {
  date: string;
  characterMemories?: CharacterMemory[];
}

/**
 * 이 세계가 이름을 아는 사람 전부 — **인물 사전이 이름을 찾는 해석(`personaOf`)과
 * 같은 범위**다 (people.md §9-1): 화자 사전이 아는 자리 전부(페르소나·우리 선수단·
 * 협상 상대·이름난 현역·명부)에 **리그의 선수 전부**를 더한다. 선수 페르소나는
 * 이름에서 파생하므로(`generatePlayerPersona`) 이름이 곧 그 사람이다.
 *
 * 기억 필터와 등록 검사가 같은 집합을 들어야 두 곳이 갈리지 않는다 — 필터가 화자
 * 사전만 보면 파생 선수 앞으로 적힌 기억이 버려지고, 등록 검사가 좁으면 압축이
 * 실존 이름 위에 지어낸 인격을 세운다.
 */
function knownSpeakerKeys(state: SpeakerSource): Set<string> {
  const keys = new Set(collectSpeakers(state).keys());
  for (const player of state.players ?? []) {
    const key = normalizeSpeaker(player.name);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * LLM이 낸 기억을 검사해 반영한다 — 걸린 항목만 버리고 나머지는 반영한다
 * (`applyMoodNotes`와 같은 계약).
 *
 * 거르는 조건은 셋이다:
 * ① **이 세계가 이름을 모르는 사람** — GM이 지어낸 이름에 붙인 기억은 아무에게도
 *    닿지 않는다. 범위는 인물 사전과 같은 해석이다(`knownSpeakerKeys`) — 명부
 *    인물·파생 선수 앞으로 적힌 기억이 버려지면 카드가 설 때 함께 실릴 것이 없다.
 *    겹쳐서 사전에서 빠진 이름도 집합에는 남으므로, 동명이인이라고 그 사람의
 *    기억까지 사라지진 않는다.
 * ② 스키마 밖 — 길이 120자와 무게 1~5는 `CharacterMemorySchema`가 정한다.
 * ③ **글자까지 같은 기억** — 압축이 되풀이되면 같은 구간을 다시 읽는다.
 *
 * `date`는 모델이 적은 것을 믿지 않고 `state.date`로 채운다.
 *
 * @returns 실제로 반영된 수
 */
export function applyCharacterMemories(
  state: CharacterMemorySource,
  drafts: readonly CharacterMemoryDraft[],
): number {
  const speakers = knownSpeakerKeys(state);
  const memories = state.characterMemories ?? [];
  let applied = 0;
  for (const draft of drafts) {
    const characterId = draft.characterId.trim();
    if (!speakers.has(normalizeSpeaker(characterId))) continue;
    const parsed = CharacterMemorySchema.safeParse({
      characterId,
      date: state.date,
      text: draft.text.trim(),
      salience: draft.salience ?? CHARACTER_MEMORY_DEFAULT_SALIENCE,
    });
    if (!parsed.success) continue;
    const memory = parsed.data;
    if (memories.some((m) => m.characterId === characterId && m.text === memory.text)) continue;
    memories.push(memory);
    // 상한을 넘긴 인물은 **그 인물의** 가장 오래된 것부터 민다 (§9 서사 메모리와 같은 규약)
    const over = memories
      .filter((m) => m.characterId === characterId)
      .slice(0, -CHARACTER_MEMORY_KEEP);
    for (const old of over) memories.splice(memories.indexOf(old), 1);
    applied += 1;
  }
  state.characterMemories = memories;
  return applied;
}

export interface CharacterDraft {
  characterId: string;
  name: string;
  role: PersonaRole;
  archetype: string;
  traits: string[];
  motivation: string;
  speechStyle: SpeechStyle;
}

/**
 * GM이 세울 수 있는 자리 — 나머지 셋은 이유가 다르다.
 *
 * `head_coach`·`owner`는 `headCoachOf`/`ownerOf`가 **첫 번째 하나**를 찾는 자리라,
 * 둘째가 서면 그 세이브의 코치가 조용히 바뀐다. `player`는 선수 페르소나가 저장이
 * 아니라 파생이라서다 (people.md §6) — 세이브에 밀어 넣으면 그 규약이 깨진다.
 *
 * ⚠️ **여기서 역할을 늘리지 마라.** `PersonaRoleSchema`는 열린 집합이라고 적혀 있지만
 * 실제로는 `z.enum`이고, 하나를 늘리려면 라벨·아이콘·화자 사전이 함께 움직여야
 * 한다. `manager`·`agent`·`pundit`은 등록이 아니라 **세계 인물 명부로 선다**
 * (people.md §2-1) — 표가 직접 적은 인격이라 GM이 세울 자리가 아니다.
 */
export const REGISTERABLE_ROLES = ["reporter", "friend", "supporter"] as const;
const REGISTERABLE = new Set<PersonaRole>(REGISTERABLE_ROLES);

/**
 * 새 화자를 인물 사전에 세운다 — 검사에 걸린 항목만 버린다.
 *
 * 거르는 조건은 셋이다:
 * ① 자리가 하나뿐인 역할(→ `REGISTERABLE_ROLES`)
 * ② **이미 있는 `characterId`** — 기존 인물은 자리를 지킨다. 성격·동기·말투를
 *    덮어쓰지 않고 그냥 등록하지 않는다. 갱신은 기억을 더하는 것뿐이다.
 * ③ **이 세계가 이미 이름을 아는 사람** — 범위는 기억 필터와 같은 집합이다
 *    (`knownSpeakerKeys`: 화자 사전 전부 + 명부 + 리그의 선수 전부). 우리 선수와
 *    이름이 같은 에이전트를 세우면 화면이 두 사람을 한 사람으로 읽고, **명부·파생
 *    선수의 이름 위에 등록하면 인물 사전이 저장된 페르소나를 먼저 찾으므로 표가
 *    적은 인격이 LLM이 지어낸 인격에 가려진다** (people.md §9-1).
 *
 * `seed`는 모델이 아니라 코어가 (세이브 시드, `characterId`)에서 결정적으로 뽑고,
 * `keywords`는 `personaKeywords`가 채운다.
 *
 * @returns 실제로 등록된 수
 */
export function registerCharacters(
  state: SpeakerSource,
  drafts: readonly CharacterDraft[],
): number {
  const occupied = knownSpeakerKeys(state);
  // 페르소나가 빈 세이브에 새 인물만 밀어 넣으면 `speakerRoles`의 시드 폴백이 꺼져
  // 코치·구단주·기자단이 사전에서 통째로 사라진다. 폴백과 같은 사람들을 함께 세운다
  const personas = state.personas?.length
    ? state.personas
    : [headCoachOf(state), ownerOf(state), ...reportersOf(state)];
  const ids = new Set(personas.map((p) => p.characterId));
  const added: Persona[] = [];
  for (const draft of drafts) {
    if (!REGISTERABLE.has(draft.role)) continue;
    const characterId = draft.characterId.trim();
    const name = draft.name.trim();
    if (ids.has(characterId)) continue;
    const keys = [normalizeSpeaker(characterId), normalizeSpeaker(name)];
    if (keys.some((key) => key.length === 0 || occupied.has(key))) continue;
    const persona = {
      characterId,
      name,
      role: draft.role,
      archetype: draft.archetype.trim(),
      traits: draft.traits.map((t) => t.trim()),
      motivation: draft.motivation.trim(),
      speechStyle: {
        note: draft.speechStyle.note.trim(),
        samples: draft.speechStyle.samples.map((s) => s.trim()),
      },
      // 같은 세이브는 같은 사람을 만난다 — 등록된 인물도 시드에서 파생한다
      seed: (state.seed ^ hashChannel(`persona:registered:${characterId}`)) >>> 0,
    };
    const parsed = PersonaSchema.safeParse({
      ...persona,
      keywords: personaKeywords(persona),
    });
    if (!parsed.success) continue;
    added.push(parsed.data);
    ids.add(characterId);
    for (const key of keys) occupied.add(key);
  }
  if (added.length > 0) state.personas = [...personas, ...added];
  return added.length;
}
