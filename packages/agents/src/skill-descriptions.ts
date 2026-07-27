import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { dataDir } from "@story-fm/engine";

export type SkillGroup = "진행" | "전술·훈련" | "대화·서사" | "조회" | "경기";

export interface SkillCatalogEntry {
  name: string;
  label: string;
  group: SkillGroup;
  readOnly: boolean;
  description: string;
}

/** 모델에 제공하는 도구 설명의 코드 기본값과 어드민 표시 메타데이터. */
export const SKILL_CATALOG = [
  {
    name: "advance_time",
    label: "시간 진행",
    group: "진행",
    readOnly: false,
    description:
      "다음 경기일(next_match) 또는 지정 일수만큼 시간을 전진시킨다. 시간이 흐르는 유일한 경로.",
  },
  {
    name: "start_match",
    label: "경기 시작",
    group: "진행",
    readOnly: false,
    description: "경기일에 킥오프를 준비한다. 이후 경기 마스터가 경기를 진행한다.",
  },
  {
    name: "set_lineup",
    label: "라인업 지정",
    group: "전술·훈련",
    readOnly: false,
    description:
      "선발 11명과 각자의 포지션을 확정한다. GK 포지션 1명이 필수이고 부상·정지 선수는 선발할 수 없다. position은 생략하면 포메이션 기본 슬롯을 사용한다.",
  },
  {
    name: "set_captain",
    label: "주장 지정",
    group: "전술·훈련",
    readOnly: false,
    description: "우리 팀 선수 한 명을 주장으로 지명한다.",
  },
  {
    name: "set_tactics",
    label: "팀 전술 변경",
    group: "전술·훈련",
    readOnly: false,
    description:
      "포메이션·멘탈리티·수비 라인·압박·템포·폭·패스 방식을 변경한다. 감독이 언급한 항목만 보내며, 경기 중 변경은 다음 진행부터 반영된다.",
  },
  {
    name: "set_player_instruction",
    label: "개인 지시",
    group: "전술·훈련",
    readOnly: false,
    description: "우리 팀 선수 한 명에게 자연어 개인 지시를 설정한다.",
  },
  {
    name: "set_training",
    label: "훈련 지정",
    group: "전술·훈련",
    readOnly: false,
    description:
      "감독이 말한 훈련만 등록한다. 특정 날짜 sessions 또는 요일 반복 repeatWeekly에 오전(am)·오후(pm), 자연어 label, 효과 대상 focus를 지정한다. focus는 능력치 축 또는 tactical·recovery를 사용한다. 임의로 빈 세션을 채우지 말고 감독의 표현을 구체적인 훈련과 관련 focus로 해석한다.",
  },
  {
    name: "team_talk",
    label: "팀 토크",
    group: "대화·서사",
    readOnly: false,
    description:
      "감독이 선수단 전체에 한 발화의 결과를 기록한다. outcome은 맥락 적합성·설득 근거·선수단 수용성을 보고 판정하고, intensity는 발화 강도에 맞춘다.",
  },
  {
    name: "talk_to_player",
    label: "선수 면담",
    group: "대화·서사",
    readOnly: false,
    description:
      "감독과 선수 개인의 면담 결과를 기록한다. outcome은 발화의 질과 대상의 수용성을 보고 판정하며, 해당 선수의 불만 이슈가 있으면 결과에 따라 해소될 수 있다.",
  },
  {
    name: "substitute",
    label: "선수 교체",
    group: "경기",
    readOnly: false,
    description:
      "경기 정지점에서 우리 팀 선수를 교체한다. out에는 나가는 선수 id, in에는 들어오는 벤치 선수 id를 넣는다.",
  },
  {
    name: "apply_narrative_event",
    label: "서사 상태 반영",
    group: "대화·서사",
    readOnly: false,
    description:
      "서사에서 실제로 일어난 사건의 사기·폼 변화를 허용 범위 안에서 기록한다. 능력치나 다른 장부 값은 바꿀 수 없다.",
  },
  {
    name: "search_players",
    label: "선수 검색",
    group: "조회",
    readOnly: true,
    description:
      '포지션·이름·나이·가용 상태 등으로 선수를 찾는다. team="mine"은 우리 팀, 팀 id·이름은 특정 팀, 생략하면 리그 전체를 조회한다. 우리 선수는 정확한 정보, 타 팀 선수는 지식 수준에 따른 평가를 반환한다.',
  },
  {
    name: "get_player",
    label: "선수 상세 조회",
    group: "조회",
    readOnly: true,
    description:
      "선수 한 명의 상세 정보를 조회한다. 감독이 특정 선수를 언급했고 현재 컨텍스트만으로 답할 수 없으면 먼저 호출한다. 타 팀 선수 정보에는 스카우팅 수준에 따른 안개가 적용된다.",
  },
  {
    name: "get_team",
    label: "팀 조회",
    group: "조회",
    readOnly: true,
    description:
      "팀의 순위·전적·전술·최근 경기·주요 선수를 조회한다. 다음 상대를 브리핑하거나 감독이 다른 팀을 물을 때 사용한다.",
  },
  {
    name: "get_league",
    label: "리그 조회",
    group: "조회",
    readOnly: true,
    description:
      'view="standings"는 순위표, view="fixtures"는 지난 결과와 예정 일정을 반환한다. 순위·승점·일정은 추측하지 말고 이 도구로 확인한다.',
  },
  {
    name: "scout_player",
    label: "스카우트 파견",
    group: "조회",
    readOnly: false,
    description:
      "타 팀 선수에게 스카우트를 파견한다. 며칠 뒤 보고서가 완료되면 능력치를 정확히 파악하지만 잠재력은 공개되지 않는다. 진지한 영입 검토나 상대 핵심 분석에 사용하며 동시 파견 한도가 있다.",
  },
  {
    name: "log_match_events",
    label: "경기 사건 기록",
    group: "경기",
    readOnly: false,
    description:
      "경기에서 일어난 주요 사건을 시간순으로 장부에 기록한다. 중계에 등장한 골·슛·세이브·카드·교체·부상·하프타임·종료는 반드시 기록해야 한다. substitution의 actors는 [나가는 선수 id, 들어오는 선수 id]다.",
  },
] as const satisfies readonly SkillCatalogEntry[];

export type SkillName = (typeof SKILL_CATALOG)[number]["name"];
export type SkillDescriptions = Record<SkillName, string>;

export const SKILL_NAMES = SKILL_CATALOG.map((skill) => skill.name);

export const DEFAULT_SKILL_DESCRIPTIONS = Object.fromEntries(
  SKILL_CATALOG.map((skill) => [skill.name, skill.description]),
) as SkillDescriptions;

export interface ResolvedSkillDescriptions {
  descriptions: SkillDescriptions;
  edited: boolean;
}

const StoredSkillDescriptionsSchema = z.object({
  version: z.literal(1),
  descriptions: z.record(z.string().min(1)),
});

/** 스킬 설명 오버라이드 파일 — 시스템 프롬프트와 별도로 관리한다. */
export function skillDescriptionsPath(): string {
  return path.join(dataDir(), "skill-descriptions.json");
}

/** 저장된 설명 중 현재 코드에 존재하는 스킬만 읽는다. */
export function loadSkillDescriptionOverrides(): Partial<SkillDescriptions> | null {
  const file = skillDescriptionsPath();
  if (!existsSync(file)) return null;
  try {
    const parsed = StoredSkillDescriptionsSchema.safeParse(
      JSON.parse(readFileSync(file, "utf8")) as unknown,
    );
    if (!parsed.success) return null;
    const overrides: Partial<SkillDescriptions> = {};
    for (const name of SKILL_NAMES) {
      const description = parsed.data.descriptions[name];
      if (description !== undefined) overrides[name] = description;
    }
    return overrides;
  } catch {
    return null;
  }
}

/** 코드 기본값과 저장된 편집본을 합쳐 이번 LLM 턴에 사용할 설명을 만든다. */
export function resolveSkillDescriptions(
  defaults: SkillDescriptions = DEFAULT_SKILL_DESCRIPTIONS,
): ResolvedSkillDescriptions {
  const overrides = loadSkillDescriptionOverrides();
  if (!overrides) return { descriptions: defaults, edited: false };
  const descriptions = { ...defaults, ...overrides };
  return {
    descriptions,
    edited: SKILL_NAMES.some((name) => descriptions[name] !== defaults[name]),
  };
}

/** 모든 현재 스킬 설명을 원자적으로 저장한다. */
export function saveSkillDescriptionOverrides(descriptions: SkillDescriptions): void {
  for (const name of SKILL_NAMES) {
    if (descriptions[name].trim().length === 0) {
      throw new Error(`빈 스킬 설명: ${name}`);
    }
  }
  const parsed = StoredSkillDescriptionsSchema.parse({ version: 1, descriptions });
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const file = skillDescriptionsPath();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed, null, 2), "utf8");
  renameSync(tmp, file);
}

/** 저장된 스킬 설명 편집본을 삭제하고 코드 기본값으로 되돌린다. */
export function resetSkillDescriptionOverrides(): void {
  const file = skillDescriptionsPath();
  if (existsSync(file)) rmSync(file);
}
