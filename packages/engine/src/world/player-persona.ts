import {
  ageOf,
  naturalPositionOf,
  weightSlotOf,
  PLAYER_ARCHETYPE_LABEL,
  PLAYER_ARCHETYPE_TRAITS,
  type GamePlayer,
  type Persona,
  type PlayerArchetypeKey,
  type PlayerArchetypeTraits,
  type WeightSlot,
} from "@story-fm/domain";
import { buildSeasonCalendar, FIRST_SEASON } from "../competition/calendar";
import { makeRng, pickWeighted } from "../core/rng";
import { personaKeywords } from "./persona";

/**
 * 선수 페르소나 — **저장하지 않고 (시드, 선수 id)에서 파생한다** (people.md §6).
 *
 * 리그 전체 4,000명분 카드를 세이브에 넣을 이유가 없다. 생성이 결정적이라 파생으로
 * 충분하고, 그래서 같은 세이브는 언제 열어도 같은 사람을 만난다 — 세이브에 남는
 * 페르소나는 자리가 하나뿐인 인물(수석코치·구단주·기자단)뿐이다.
 *
 * 코치·구단주·기자와 같은 규칙 위에 서 있다: 이름은 세계가 정하고, 사람됨은 시드가
 * 정한다. 선수만 다른 것은 **추첨이 균일하지 않다**는 점이다 (아래 가중).
 */

interface PlayerArchetype {
  key: PlayerArchetypeKey;
  traits: string[];
  motivation: string;
  speech: { note: string; samples: string[] };
  /** 이 원형이 자주 서는 자리 — 적지 않은 자리는 기울지 않는다 */
  slots?: Partial<Record<WeightSlot, number>>;
  /** 이 원형이 자주 나오는 나이대 */
  ages?: Partial<Record<AgeBand, number>>;
}

/** 기울지 않은 자리 — 표에 적지 않은 칸의 값이다 */
const EVEN_WEIGHT = 1;
/** 그 자리·그 나이대의 전형 */
const LIKELY = 2.5;
/** 그쪽 결이 조금 더 있다 */
const LEANING = 1.6;
/** 드물다 — 없애지는 않는다. 표는 세계를 설명하되 가두지 않는다 */
const RARE = 0.4;
/** 말이 되지 않는 조합 — 라벨 자체가 나이와 어긋나는 자리에만 쓴다 */
const NEVER = 0;

/**
 * 선수 원형 — **감독 앞에서 무엇을 먼저 말하는가**로 갈린다.
 *
 * 수석코치가 "같은 상황에서 무엇을 먼저 보는가"로 갈리듯, 선수는 감독실 문을 열고
 * 들어와 꺼내는 첫 문장이 다르다. 같은 벤치 강등에도 누구는 출전 시간을 따지고
 * 누구는 자기가 뭘 잘못했는지를 되묻는다.
 *
 * 존댓말이 기본이되 코치·구단주보다 어리고, 감독은 자기를 쓰거나 쓰지 않는 사람이다 —
 * 요구도 하소연도 그 관계 안에서 나온다.
 */
const PLAYER_ARCHETYPES: readonly PlayerArchetype[] = [
  {
    key: "ambitious",
    traits: ["출전 시간에 민감", "자기 확신", "계산이 빠르다"],
    motivation: "더 큰 무대에서 뛸 자격이 있다는 걸 지금 증명하고 싶다.",
    speech: {
      note: "존댓말이지만 에두르지 않는다. 자기 출전 시간과 다음 단계를 먼저 꺼내고, 답이 모호하면 한 번 더 묻는다.",
      samples: [
        "감독님, 제 자리가 어디인지 알고 싶습니다. 벤치에서 배우라는 말은 충분히 들었습니다.",
        "이번 시즌 구상에 제가 있습니까? 없다면 그것도 말씀해 주십시오.",
      ],
    },
    slots: { ST: LIKELY, W: LIKELY, CF: LEANING, AM: LEANING, GK: RARE },
    ages: { youth: LEANING, veteran: RARE },
  },
  {
    key: "team_first",
    traits: ["팀을 먼저 본다", "책임감", "요구 대신 제안"],
    motivation: "이 팀이 제대로 돌아가는 걸 보고 유니폼을 벗고 싶다.",
    speech: {
      note: "차분한 존댓말. 자기 이야기보다 팀 상황을 먼저 꺼내고, 불만도 제안의 형태로 말한다.",
      samples: [
        "제 출전 이야기는 나중에 하죠. 지금은 뒷문이 먼저입니다.",
        "어느 자리든 뛰겠습니다. 다만 어린 선수들에게는 미리 말씀해 두시는 게 좋겠습니다.",
      ],
    },
    slots: { CB: LEANING, DM: LEANING, GK: LEANING },
    ages: { youth: RARE, veteran: LIKELY },
  },
  {
    key: "quiet_craftsman",
    traits: ["과묵함", "훈련 벌레", "자기 기준이 높다"],
    motivation: "말이 아니라 훈련장에서 자기 값을 증명한다.",
    speech: {
      note: "짧은 존댓말. 묻는 말에만 답하고, 답도 훈련과 자기 자리에 대한 것뿐이다.",
      samples: ["고치고 있습니다. 두 주만 주시면 됩니다.", "알겠습니다. 그렇게 하겠습니다."],
    },
    slots: { CB: LEANING, FB: LEANING, DM: LEANING },
  },
  {
    key: "fierce_competitor",
    traits: ["지는 걸 못 견딘다", "감정이 앞선다", "몸을 사리지 않는다"],
    motivation: "오늘 진 것을 다음 경기에서 갚아야 잠이 온다.",
    speech: {
      note: "존댓말이 흔들릴 만큼 열이 오른다. 진 경기와 상대 이야기를 먼저 꺼내고, 자기 몸 상태는 뒤로 미룬다.",
      samples: [
        "그렇게 지고 어떻게 그냥 넘어갑니까. 다음 주에 다시 붙었으면 좋겠습니다.",
        "빼지 말아 주십시오. 뛰다 쓰러져도 제가 감당하겠습니다.",
      ],
    },
    slots: { ST: LEANING, W: LEANING, DM: LEANING },
    ages: { youth: LEANING },
  },
  {
    key: "anxious_prospect",
    traits: ["눈치를 본다", "인정에 목마르다", "실수를 오래 곱씹는다"],
    motivation: "여기 남을 수 있는 선수인지 감독의 입으로 듣고 싶다.",
    speech: {
      note: "조심스러운 존댓말. 말끝을 흐리고, 자기가 잘하고 있는지를 먼저 되묻는다.",
      samples: [
        "감독님, 지난 경기 그 장면 말인데요… 많이 안 좋았습니까?",
        "괜찮습니다. 기회가 오면 준비돼 있겠습니다. 정말입니다.",
      ],
    },
    ages: { youth: LIKELY, veteran: NEVER },
  },
  {
    key: "dressing_room_leader",
    traits: ["남의 이야기를 대신 가져온다", "무게가 있다", "선을 지킨다"],
    motivation: "라커룸이 갈라지지 않게 붙잡는 것이 자기 몫이라 여긴다.",
    speech: {
      note: "정중한 존댓말. 자기 이야기 전에 다른 선수 이야기를 꺼내고, 누구인지 이름으로 짚는다.",
      samples: [
        "제 얘기는 아닙니다. 요즘 몇 명이 흔들리는데, 감독님이 한마디 해주시면 다릅니다.",
        "라커룸은 제가 붙잡고 있겠습니다. 대신 그 친구를 한 번만 더 써주십시오.",
      ],
    },
    slots: { CB: LIKELY, GK: LEANING, DM: LEANING, CM: LEANING },
    ages: { youth: RARE, veteran: LIKELY },
  },
  {
    key: "professional",
    traits: ["군더더기가 없다", "규율", "감정을 드러내지 않는다"],
    motivation: "맡은 자리를 매주 같은 수준으로 해내는 것이 자기 직업이라 여긴다.",
    speech: {
      note: "건조한 존댓말. 무엇을 원하시는지부터 확인하고, 확인이 끝나면 말을 늘리지 않는다.",
      samples: [
        "역할만 정해 주시면 됩니다. 나머지는 제가 맞추겠습니다.",
        "몸은 문제없습니다. 주중까지 회복됩니다.",
      ],
    },
    slots: { GK: LIKELY, CB: LEANING, FB: LEANING, DM: LEANING },
  },
  {
    key: "weighing_star",
    traits: ["자기 위상에 민감", "에이전트를 앞세운다", "무대를 즐긴다"],
    motivation: "자기 값을 알아주는 곳에서 뛰고 싶다 — 그게 여기라면 여기다.",
    speech: {
      note: "여유 있는 존댓말. 자기 역할과 위상을 먼저 확인하고, 답이 흡족하지 않으면 밖의 이야기를 꺼낸다.",
      samples: [
        "제가 이 팀의 중심이 맞습니까? 그것만 확실하면 다른 이야기는 필요 없습니다.",
        "밖에서 연락이 온 건 사실입니다. 저는 감독님 말씀을 먼저 듣고 싶었습니다.",
      ],
    },
    slots: { ST: LIKELY, W: LIKELY, AM: LEANING, CF: LEANING },
    ages: { youth: RARE },
  },
  {
    key: "homegrown_heart",
    traits: ["구단에서 자랐다", "팬 앞에서 힘을 낸다", "떠나는 이야기를 싫어한다"],
    motivation: "이 유니폼을 입고 뭔가 하나는 남기고 싶다.",
    speech: {
      note: "예의 바른 존댓말. 구단과 팬 이야기를 자주 꺼내고, 밖의 관심에는 말수가 준다.",
      samples: [
        "여기서 자랐습니다. 다른 데 가서 뛰는 건 생각해 본 적 없습니다.",
        "홈에서 그렇게 진 건 오래 갑니다. 다음 홈경기는 다를 겁니다.",
      ],
    },
  },
  {
    key: "film_reader",
    traits: ["장면을 기억한다", "질문이 구체적", "준비가 빠르다"],
    motivation: "왜 그 장면이 그렇게 됐는지 알고 나서야 다음 경기를 준비한다.",
    speech: {
      note: "차분한 존댓말. 특정 장면과 시간을 짚어 묻고, 지시를 받으면 그 자리에서 되짚어 확인한다.",
      samples: [
        "후반 20분 그 장면, 제가 안으로 좁혔어야 했습니까? 영상으로 다시 봤습니다.",
        "그 지시대로면 제 뒤 공간은 누가 채웁니까?",
      ],
    },
    slots: { DM: LEANING, CM: LEANING, AM: LEANING },
  },
];

/** 원형 목록 — 테스트·어드민이 전수를 훑을 때 쓴다 */
export const PLAYER_ARCHETYPE_LABELS = PLAYER_ARCHETYPES.map((a) => PLAYER_ARCHETYPE_LABEL[a.key]);

type AgeBand = "youth" | "prime" | "veteran";

/** 아직 자리를 잡는 중 — 조급함과 불안이 여기 몰린다 */
const YOUTH_AGE_MAX = 21;
/** 커리어의 뒤쪽 — 멘토와 팀 우선이 여기 몰린다 */
const VETERAN_AGE_MIN = 30;

function ageBandOf(age: number): AgeBand {
  if (age <= YOUTH_AGE_MAX) return "youth";
  return age >= VETERAN_AGE_MIN ? "veteran" : "prime";
}

/**
 * 나이를 재는 **고정 기준일** — 세계가 시작한 날(첫 시즌 프리시즌 개시)이다.
 *
 * ⚠️ `state.date`로 재면 안 된다. 시즌이 흐르는 동안 선수가 나이 경계를 넘는 순간
 * 같은 선수가 다른 원형으로 바뀌어, **같은 세이브는 언제 열어도 같은 사람을 만난다**는
 * 요구(people.md 요구사항 1)가 깨진다. 사람됨은 세이브 안에서 변하지 않는다.
 */
const PERSONA_AGE_REF = buildSeasonCalendar(FIRST_SEASON).preseasonStart;

/**
 * 원형의 무게 — **나이와 포지션이 확률을 기울인다** (people.md §6).
 *
 * 스트라이커와 센터백이 같은 확률로 같은 사람이 되면 원형 표가 세계를 설명하지
 * 못한다. ⚠️ **국적은 걸지 않는다** — 실명 선수에 국민성 고정관념이 실린다
 * (sources.md §7).
 */
function archetypeWeight(archetype: PlayerArchetype, slot: WeightSlot, band: AgeBand): number {
  return (archetype.slots?.[slot] ?? EVEN_WEIGHT) * (archetype.ages?.[band] ?? EVEN_WEIGHT);
}

/**
 * 선수의 페르소나 — 저장하지 않고 (시드, 선수 id)에서 결정적으로 파생한다.
 *
 * 시드 채널에 **선수 id**를 넣는 이유: 이름은 동명이인이 있고 이적으로 팀이 바뀌어도
 * 사람은 그대로여야 한다. 실존 인물 표식(`real`)은 붙이지 않는다 — `GamePlayer`가
 * 그 출처를 들고 있지 않다.
 */
export function generatePlayerPersona(seed: number, player: GamePlayer): Persona {
  const archetype = archetypeOf(seed, player);
  return {
    // 화자 태그는 직책이 아니라 이름이다 — 코치와 같은 규약
    characterId: player.name,
    name: player.name,
    role: "player",
    archetype: PLAYER_ARCHETYPE_LABEL[archetype.key],
    traits: [...archetype.traits],
    motivation: archetype.motivation,
    speechStyle: { note: archetype.speech.note, samples: [...archetype.speech.samples] },
    keywords: personaKeywords({ name: player.name, role: "player" }),
    seed,
  };
}

/** 추첨 한 번 — 카드를 짓는 쪽과 계수를 읽는 쪽이 같은 뽑기를 지난다 */
function archetypeOf(seed: number, player: GamePlayer): PlayerArchetype {
  const rng = makeRng(seed, `persona:player:${player.id}`);
  const slot = weightSlotOf(naturalPositionOf(player).position);
  const band = ageBandOf(ageOf(player.birthdate, PERSONA_AGE_REF));
  return pickWeighted(rng, PLAYER_ARCHETYPES, (a) => archetypeWeight(a, slot, band));
}

/**
 * 이 선수의 원형 코드 — 카드를 짓지 않고 **뽑기만** 한다.
 *
 * 코어 판정(불만 문턱·선수 관문·성장·정착)이 매번 부르는 자리라 말투·예시 대사까지
 * 짓는 `generatePlayerPersona`를 쓰지 않는다. 같은 난수 채널을 지나므로 둘은 언제나
 * 같은 원형을 낸다.
 */
export function playerArchetypeOf(seed: number, player: GamePlayer): PlayerArchetypeKey {
  return archetypeOf(seed, player).key;
}

/**
 * 이 선수의 **상태 전이 계수** — 원형 표(도메인)의 한 행 (people.md §6).
 *
 * 저장하지 않는다: 원형이 (시드, 선수 id)의 결정적 파생이므로 계수도 파생이고,
 * 옛 세이브는 로드만으로 같은 값을 얻는다.
 */
export function archetypeTraitsOf(seed: number, player: GamePlayer): PlayerArchetypeTraits {
  return PLAYER_ARCHETYPE_TRAITS[playerArchetypeOf(seed, player)];
}
