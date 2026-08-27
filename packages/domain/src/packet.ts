/**
 * 전력 분석 패킷 — 코어가 결정적으로 계산하는 **경기의 판세**.
 *
 * 이 패킷은 "LLM에게 주는 힌트"가 아니라 **결과를 정하는 수치**다. 선수×경로
 * 슈팅 프로필(`guide.shotProfiles`)이 두 시뮬레이터의 발생률 원본이고, 사건은
 * 코어가 굴린다. LLM은 그 사건을 중계·연출한다
 * (match.md §1·§2).
 *
 * **패킷이 싣는 것은 사실 태그(`PacketTag`)뿐이고 문장은 이 파일의 렌더러
 * 하나(`packetTagText`)가 만든다** — 화면·중계·CLI·테스트가 같은 함수를 부른다.
 */

import { legacyTag, otherSide, type MatchSide, type PacketTagSource, type SubCause } from "./match";
import { AXIS_KO } from "./player";
import {
  DIRECTIVE_INTENSITY_KO,
  PLAYER_DIRECTIVE_KO,
  SET_PIECE_KO,
  SET_PIECE_ROLE_KO,
  TACTIC_AXES,
  tacticWord,
  type BoardPoint,
  type SetPieceRole,
} from "./tactics";

export interface ZoneStrength {
  attack: number;
  midfield: number;
  defense: number;
}

/**
 * 세 전선 — **패킷 전체가 쓰는 한 낱말.** 존 전력·매치업·지역 전술의 밴드·공략이
 * 닿는 존이 모두 이 셋이고, 한 곳만 다른 이름으로 두면 같은 자리가 두 값이 된다.
 */
export type MatchupZone = "attack" | "midfield" | "defense";
export type EdgeSide = MatchSide | "even";
export type EdgeSize = "slight" | "clear" | "big";

export interface Matchup {
  /** 홈 팀 관점의 존 — attack = 홈 공격 vs 어웨이 수비 */
  zone: MatchupZone;
  edge: EdgeSide;
  size: EdgeSize;
  /** 그 존의 양팀 값 — 근거 문장이 유일한 보관처였던 수치 */
  homeValue?: number;
  awayValue?: number;
  /** 진행 중인 옛 세이브가 들고 있는 근거 문장 — 새 패킷은 적지 않는다 */
  why?: string;
}

/**
 * 패킷이 싣는 **사실 태그** — 키포인트·상성·구멍·개인 지시·공략·지역 플랜이 전부
 * 이 한 모양이다 (match.md §1).
 *
 * 코어가 한국어 문장을 만들어 실으면 그 문장이 원인 태그로 골에 복사되고 진행 중인
 * 세이브에 굳는다 — 그러면 문구를 고치는 순간 전술 XP의 근거가 달라진다. 태그를
 * 문장으로 옮기는 것은 그것을 읽는 쪽(화면·중계·CLI)이 같은 렌더러 하나로 한다.
 */
export interface PacketTag {
  /** 어느 갈래에서 나왔나 — 목록은 `PACKET_TAG_SOURCES`(match.ts) 한 벌이다 */
  source: PacketTagSource;
  /** 축·상성·지시의 코드 — 판정과 집계의 열쇠 ("space_behind" · "backline-pace") */
  code: string;
  /** 이 사실이 **이로운 편** — 약점을 가진 쪽이 아니다. 편이 없는 사실이면 null */
  favours: MatchSide | null;
  /**
   * 이 사실을 **가진 쪽** — 이름이 서는 선수들의 팀이자 미스매치 문장의 주어다.
   *
   * `favours`와 갈리는 것은 강점 축이다: 창조자·마무리·골키퍼 배급·세트피스 키커는
   * 가진 쪽이 곧 이로운 쪽이고, 나머지 축은 반대다 (sim `key-points.ts`). 없으면
   * (구멍·옛 세이브처럼 가진 쪽이 언제나 잃는 갈래) 이로운 편의 반대로 본다.
   */
  holder?: MatchSide;
  /**
   * 수치를 드러내도 되는가 — 감독의 눈(분석)이 정한다. `false`면 렌더러가 흐린
   * 문장을 낸다 (match.md §1.6 — 못 본 수치가 노트로 새어 들어오지 않게 하는 칸).
   */
  sharp: boolean;
  /** 이름이 서는 선수들 — 팀 단위 사실이면 빈 배열 */
  playerIds: string[];
  /** 라벨 붙은 수치 — `{ pace: 88, defencePace: 61 }` */
  values: Record<string, number>;
  /** 문장 안에 숨어 있던 조건부 축 — "sweeper" · "trap-unfamiliar" */
  flags: string[];
  /**
   * 구조로 못 옮기는 자유 문장 — 지역 플랜의 모델 원문, 옛 세이브의 줄, 그리고
   * 카탈로그가 가진 고유 명사(컨텍스트 태그의 더비 이름).
   */
  text?: string;
}

/**
 * 전술 지시가 존 전력에 남긴 흔적 — **감독의 결정이 어떻게 수치가 됐는가**.
 *
 * 이득과 대가를 함께 적는다. 지시는 공짜가 아니고(라인을 올리면 뒷공간이 열린다),
 * 소화율(`uptake`)은 **이득에 온전히, 대가에는 층마다 다르게** 걸린다 — 전술 6축과
 * 공략은 대가도 절반을 태우고 개인 지시·전술 상성은 대가를 온전히 문다
 * (match.md §1.2의 표).
 */
export interface TacticalRead {
  /** 지시 적용률 0.45~1.0 — 감독 전술 능력 + 팀 전술 적응도 */
  uptake: number;
  /** 이득·대가의 사실 태그 (지시가 수치를 움직였을 때만) */
  notes: PacketTag[];
}

export type RegionalBand = MatchupZone;
/** 좌·중·우 — 지역 전술·판세 격자·공격 경로가 나눠 쓰는 눈금 */
export type RegionalLane = "left" | "center" | "right";
export type RegionalIntent = "overload" | "press" | "protect" | "transition";

/** 자연어 세부 전술을 코어가 검증해 경기 패킷에 남긴 지역 플랜. */
export interface RegionalInstruction {
  id: string;
  band: RegionalBand;
  lane: RegionalLane;
  intent: RegionalIntent;
  note: string;
  /** 팀 전술 소화율이 적용된 실제 강도. */
  uptake: number;
}

/**
 * 개인 지시·공략이 판세 격자의 한 줄 안에서 기울인 몫 — **줄 합은 0이다.**
 *
 * 지시의 산출은 밴드×레인 아홉 칸이고, 그 줄 평균은 존 전력에 실린다. 여기 오는
 * 것은 평균을 뺀 나머지뿐이라 격자는 **배분만** 받는다 — 같은 전력이 존과 칸에
 * 두 번 세어지지 않게 하는 자리다 (match.md §1.7, sim `zone-grid.ts`).
 */
export interface LaneBias {
  band: RegionalBand;
  lane: RegionalLane;
  /** 존 전력 대비 비율 — 양수면 그 칸이 두꺼워지고 같은 줄 나머지가 얇아진다 */
  share: number;
}

export interface PacketPlayer {
  id: string;
  name: string;
  position: string;
  /** 실제 전술판 좌표 — 없으면 position의 기본 좌표를 사용한다. */
  point?: BoardPoint;
  /** 이 경기에서 수행하는 세부 역할. */
  roleId?: string;
  /** 이 자리에서 지금 내는 전력 (상태·적응도 반영) */
  effective: number;
  /**
   * 기회 생성에 쓰는 전력. 실제 결정력은 리그 기준값으로 치환하고 나머지
   * 역할·상태·적응도만 반영한다 — 결정력의 슈팅 접근 효과는 별도 항에서 한 번만 센다.
   */
  creationEffective?: number;
  fit: {
    /** 포지션 적응도 0~99 */
    position: number;
    /** 전술 적응도 0~100 */
    tactical: number;
    /** 이 자리가 전술 적응에 얼마나 민감한가 (0.6~1.4) */
    sensitivity: number;
  };
}

export type ShotRoute = RegionalLane;

/** 한 선수가 한 공격 경로에서 갖는 90분 슈팅 분포. */
export interface PlayerShotRoute {
  route: ShotRoute;
  /** 이 경로에서의 90분 기대 슈팅 수 — 포아송 강도. */
  expectedShots: number;
  /** 이 경로에서 만들어지는 슛 하나의 평균 기회 xG. */
  meanXg: number;
}

/** 팀 총량을 나누지 않고 선수×지역에서 직접 만든 슈팅 프로필. */
export interface PlayerShotProfile {
  playerId: string;
  routes: PlayerShotRoute[];
  expectedShots: number;
  /** 생성 레이어의 기대값 Σ(경로 기대 슈팅 × 평균 xG). */
  chanceXg: number;
  /** 결정력을 반영한 기대 득점. */
  expectedGoals: number;
}

/**
 * 팀의 **세트피스 프로필** — 코너·프리킥·페널티 (match.md §1.4).
 *
 * ⚠️ 팀 기대 슈팅 **위에 더하는 것이 아니라 안에서 옮긴 몫**이다. 선수×경로
 * 프로필(`shotProfiles`)은 이 몫을 뺀 **열린 플레이만** 싣고, 세 채널의 합이
 * `guide.expectedShots`다 — 그래야 "실측 슈팅 = 패킷 기대 슈팅" 계약이 산다.
 */
export interface SetPieceProfile {
  /** 90분 기대 죽은 공 슛 — 코너 + 프리킥 */
  expectedShots: number;
  /** 그 슛 하나의 평균 기회 xG — 키커의 킥력과 박스 안 제공권이 정한다 */
  meanXg: number;
  /** 90분 기대 페널티 — 그것도 슛 하나로 센다 */
  penalties: number;
  /** 90분 기대 코너 — 사건이 아니라 굴리지 않고 나누는 양이다 (§4) */
  corners: number;
  /** 90분 기대 파울 — 같은 자리 */
  fouls: number;
  /**
   * 죽은 공을 차는 사람 — 감독의 지정(`TeamTactics.setPieceTakers`)이 있으면 그 사람,
   * 없으면 그라운드 위 최고(코너·프리킥은 `kicking`, 페널티는 `penaltySkill`).
   * 명단이 비면 null이다.
   */
  takers: { corner: string | null; freeKick: string | null; penalty: string | null };
}

export interface SidePacket {
  teamId: string;
  teamName: string;
  zones: ZoneStrength;
  /** 결정력을 중립화한 기회 생성용 존 전력. */
  creationZones?: ZoneStrength;
  /** 감독 전술 능력치가 만든 전술 소화율 계수 (career.md §2) */
  tacticalFit: number;
  /** 전술 지시의 반영 — 적용률과 이득·대가 (설명 가능성) */
  tactical: TacticalRead;
  /** 이 경기에만 유효한 지역별 세부 전술. */
  regional?: RegionalInstruction[];
  /**
   * 개인 지시·공략이 격자의 배분을 기울인 몫. 지시가 없거나 레인을 겨냥하지 않은
   * 경기에는 없고, **옛 세이브에도 없다** — 그때는 격자가 배치와 지역 플랜만 읽는다.
   */
  laneBias?: LaneBias[];
  /**
   * 그라운드 위 선수 명단 — id·이름·자리에 **그 선수가 지금 내는 전력**까지.
   *
   * `effective` = roleFit(16축 × 자리 가중치) × 상태(폼·사기·피로) × 포지션 적응도
   * × 전술 적응도. 존 전력은 이 값들의 평균일 뿐이라, "누가 안 돌아가는가"는
   * 여기서만 답할 수 있다. `fit`은 그 값이 왜 깎였는지의 분해다.
   */
  lineup: PacketPlayer[];
  bench: PacketPlayer[];
}

/**
 * 공략 표적 — 키포인트 하나를 지시로 겨냥할 수 있게 만든 형태.
 *
 * `id`는 **경기 안에서 안정적**이어야 한다(라인업이 그대로면 같은 id). 모델이
 * 이 목록에서 골라 부르고, 코어는 그 id가 지금도 실재하는지만 확인한다 —
 * 교체로 그 선수가 나가면 표적이 사라지고 공략도 함께 끝난다.
 */
export interface ExploitTarget {
  id: string;
  /** 어느 팀의 약점인가 — 우리가 노리는 쪽 */
  side: MatchSide;
  /** 그 지점의 사실 태그 — 감독이 본 해상도가 `sharp`에 실린다 */
  tag: PacketTag;
  /** 공략이 닿는 존 */
  zone: MatchupZone;
  /**
   * 그 짝이 얼마나 벌어졌나 (`KeyPoint.weight`) — **공략의 이득이 이 값을 탄다.**
   * 크게 벌어진 약점이 문턱을 겨우 넘은 약점보다 크게 값을 해야 감독이 무엇을
   * 읽었는지가 결과에 남는다. 진행 중인 옛 세이브에는 없고, 그때는 기준 눈금으로
   * 본다(sim `exploits.ts`).
   */
  weight?: number;
  /**
   * 그 약점이 선 레인 — **약점을 가진 쪽의 방향**이다. 표적이 팀 전체인 지점
   * (백라인 조직·중원 활동량)에는 없고, 그때 공략은 세 레인에 고르게 실린다.
   */
  lane?: RegionalLane;
}

export interface StrengthPacket {
  home: SidePacket;
  away: SidePacket;
  matchups: Matchup[];
  /** 위협/약점 포인트 — 사실 태그. 이로운 편은 태그의 `favours`가 갖는다 */
  keyPoints: PacketTag[];
  /**
   * 각 키포인트가 **누구에게 이로운가** — `keyPoints`와 같은 순서.
   *
   * 진행 중인 경기를 담은 **옛 세이브만** 갖는다 (지금은 태그의 `favours`가 원본).
   */
  keyPointSides?: MatchSide[];
  /**
   * **공략할 수 있는 지점** — 감독이 겨냥해 지시할 수 있는 키포인트.
   *
   * 위 `keyPoints`가 화면에 그대로 서는 문장(상성·구멍 포함)이라면 이쪽은
   * **표적**이다. id로 지목하면 코어가 실재를 대조하고 존 조정을 얹는다
   * (sim `key-points.ts` · `exploits.ts`). 남의 팀 약점도 들어 있다 —
   * 감독은 우리 약점을 메우는 쪽으로도 지시할 수 있어야 한다.
   */
  targets: ExploitTarget[];
  guide: {
    /** 선수별 프로필의 결정력 반영 기대 득점을 합친 90분 판독값. */
    expectedGoals: { home: number; away: number };
    /** 선수×경로 기대 슈팅의 합. 새 패킷은 항상 갖고, 진행 중인 옛 세이브에는 없다. */
    expectedShots?: { home: number; away: number };
    /** 결정력을 넣기 전 기회 xG의 합. */
    chanceXg?: { home: number; away: number };
    /**
     * 선수별·공격 경로별 슈팅 분포 — 구간/간이 시뮬의 공통 원본.
     * **열린 플레이만** 싣는다: 죽은 공 몫은 아래 `setPieces`가 갖는다 (match.md §1.4).
     */
    shotProfiles?: { home: PlayerShotProfile[]; away: PlayerShotProfile[] };
    /**
     * 팀 단위 죽은 공 프로필 — 두 시뮬의 공통 원본. 진행 중인 옛 세이브에는 없고,
     * 없으면 그 경기의 남은 구간에 죽은 공 채널이 서지 않는다(열린 플레이만 굴린다).
     */
    setPieces?: { home: SetPieceProfile; away: SetPieceProfile };
    /**
     * 공을 쥐는 비율 (0.35~0.65) — **중원 우위가 정한다.**
     * 기대 득점에 실리고, 공 없는 팀의 체력 소모를 키운다.
     */
    possession: { home: number; away: number };
    /** 경기 강도 0.8~1.3 — 압박·템포에서 나온다. 피로·파울·부상률을 함께 움직인다 */
    intensity: { home: number; away: number };
  };
}

/**
 * 태그의 `code`(=`ShotOrigin`)가 가리키는 자리 — **이름은 여기 적지 않는다.**
 * 자리 이름 한 벌은 `SET_PIECE_ROLE_KO`가 갖고 있고, 같은 세 낱말을 여기 한 번 더
 * 적어 두면 화면과 문장이 조용히 갈린다.
 */
const SET_PIECE_ROLE_BY_ORIGIN: Record<string, SetPieceRole> = {
  corner: "corner",
  free_kick: "freeKick",
  penalty: "penalty",
};

// ── 태그 → 문장 ───────────────────────────────────────
/**
 * 태그가 이름을 대는 자리 — **패킷이 원본이다** (`packetTagContext`).
 *
 * 태그는 선수 id와 편만 들고 다닌다. 이름은 그때그때의 명단에서 오는 것이라
 * 태그에 굳혀 두면 교체로 사라진 선수의 이름이 세이브에 남는다.
 */
export interface PacketTagContext {
  home: string;
  away: string;
  player: (id: string) => { name: string; position: string } | undefined;
}

/** 패킷 하나에서 이름표를 만든다 — 라인업과 벤치를 함께 본다(판을 떠난 선수도 부른다) */
export function packetTagContext(packet: StrengthPacket): PacketTagContext {
  const byId = new Map<string, PacketPlayer>();
  for (const side of [packet.home, packet.away]) {
    for (const p of [...side.lineup, ...side.bench]) byId.set(p.id, p);
  }
  return {
    home: packet.home.teamName,
    away: packet.away.teamName,
    player: (id) => byId.get(id),
  };
}

/** 교체의 갈래를 부르는 말 — 세는 것은 `subCause` 코드다 (match.md §4) */
const SUB_CAUSE_KO: Record<SubCause, string> = {
  injury: "부상 — 교체 불가피",
  chase: "승부수 — 공격 자원 투입",
  hold: "리드 굳히기 — 수비 보강",
  fatigue: "체력 저하 — 로테이션",
};

export function subCauseText(code: SubCause): string {
  return SUB_CAUSE_KO[code];
}

const SIZE_KO: Record<EdgeSize, string> = {
  slight: "근소한",
  clear: "뚜렷한",
  big: "압도적인",
};

const ZONE_MATCHUP_KO: Record<MatchupZone, string> = {
  attack: "홈 공격 vs 어웨이 수비",
  defense: "어웨이 공격 vs 홈 수비",
  midfield: "중원",
};
/** 코드에서 되짚는 자리 — 옛 세이브가 모르는 존 이름을 들고 와도 그대로 세운다 */
const ZONE_MATCHUP_KO_BY_CODE: Record<string, string | undefined> = ZONE_MATCHUP_KO;

/** 존 우열의 태그 코드 — 원인 태그가 매치업을 인용할 때 쓰는 열쇠 */
const zoneCode = (zone: MatchupZone) => `zone-${zone}`;

/**
 * 존 우열 → 사실 태그. **매치업도 태그 하나로 읽힌다** — 골의 원인이 매치업일 때
 * 장부에 실리는 것이 이 태그다 (`sim/match-engine.ts`의 `causesFor`).
 */
export function matchupTag(m: Matchup): PacketTag {
  const values: Record<string, number> =
    m.homeValue !== undefined && m.awayValue !== undefined
      ? { home: m.homeValue, away: m.awayValue }
      : {};
  return {
    source: "mismatch",
    code: zoneCode(m.zone),
    favours: m.edge === "even" ? null : m.edge,
    sharp: true,
    playerIds: [],
    values,
    flags: [m.size],
    // 값을 잃은 옛 세이브의 매치업만 문장을 들고 있다
    ...(Object.keys(values).length === 0 && m.why ? { text: m.why } : {}),
  };
}

export function matchupText(m: Matchup): string {
  return packetTagText(matchupTag(m));
}

/** 지시를 얼마나 감당하나 — 소화력 한 눈금을 감독이 읽는 말로 */
const aptitudeRead = (apt: number): string =>
  apt >= 1.15 ? "여유가 있다" : apt >= 0.95 ? "감당할 만하다" : "버거워 보인다";

/** 겨눈 상대와의 싸움 — 듀얼 성공률을 말로 */
const duelRead = (rate: number): string =>
  rate >= 0.6 ? "따라붙을 만하다" : rate >= 0.4 ? "버거운 싸움이다" : "상대가 한 수 위다";

/** 지시가 그라운드에서 무엇으로 보이는가 — 이득과 대가가 한 줄에 함께 선다 */
const DIRECTIVE_KO: Record<string, (by: string, target: string) => string> = {
  man_mark: (n, t) => `${n}이(가) ${t}을(를) ${PLAYER_DIRECTIVE_KO.man_mark}, 본업을 던다`,
  press_target: (n, t) =>
    `${n}이(가) ${t}을(를) ${PLAYER_DIRECTIVE_KO.press_target}, 자리를 비운다`,
  focus_play: (n) => `${n}에게 공격을 몰아준다, 다른 길이 줄어든다`,
  stay_back: (n) => `${n}은(는) 뒤에 남는다, 앞의 인원이 준다`,
  join_attack: (n) => `${n}이(가) 적극적으로 올라간다, 뒷공간을 내준다`,
  careful: (n) => `${n}이(가) 발을 뺀다, 그 자리의 압박이 준다`,
};

/** 공략이 그라운드에서 무엇으로 보이는가 — 축 하나가 한 낱말이다 */
const EXPLOIT_KO: Record<string, string> = {
  "backline-pace": "뒷공간으로 계속 넘긴다",
  "wing-duel": "측면에서 계속 걸어 들어간다",
  aerial: "크로스를 계속 올린다",
  "press-resistance": "상대 중원을 물고 늘어진다",
  keeper: "먼 거리에서도 때린다",
  "keeper-distribution": "골문까지 압박을 올린다",
  "backline-shape": "라인 사이로 파고든다",
  "backline-leader": "라인 사이로 파고든다",
  physical: "최전방에 붙여 두고 걷어 올린다",
  "set-piece": "세트피스에 사람을 올린다",
  discipline: "그 선수 앞으로 계속 몰고 간다",
  creator: "중원 배급을 끊는다",
  finisher: "최전방을 가둔다",
  stamina: "속도를 올려 체력을 갉는다",
};

/**
 * 벤치가 판을 옮긴 **갈래** — 축이 어느 쪽으로 갔는지는 이 낱말이 이미 말한다
 * (`chase`는 전부 위로, `hold`는 전부 아래로 — match.md §2).
 */
const AI_SHIFT_KO: Record<string, string> = {
  chase: "벤치가 판을 앞으로 밀었다",
  hold: "벤치가 내려서서 잠갔다",
};

/** `축:값` 꼴 flag의 값 — 세기·축처럼 낱말 하나가 실리는 자리 */
function flagValue(tag: PacketTag, key: string): string | undefined {
  const at = tag.flags.find((f) => f.startsWith(`${key}:`));
  return at?.slice(key.length + 1);
}

/** 세기의 한국어 — flag가 실어 온 낱말은 검증 밖이라 표에서 찾는다 */
const DIRECTIVE_INTENSITY_KO_BY_CODE: Record<string, string | undefined> = DIRECTIVE_INTENSITY_KO;

/** 태그가 문장으로 설 때 필요한 것 — 이름·수치·조건 */
interface Render {
  /** 이 사실이 **선 팀** — 상성은 그 수를 둔 쪽, 미스매치는 그 지점을 가진 쪽 */
  subject: string;
  /** 그 반대편 */
  rival: string;
  /** 이름이 선 선수 (없으면 id, 그마저 없으면 빈 문자열) */
  who: (i: number) => string;
  /** 이름을 찾았는가 — 지어낸 id와 벤치를 가른다 */
  named: (i: number) => string | undefined;
  v: (key: string, fallback?: number) => number;
  has: (flag: string) => boolean;
}

/**
 * 상성 열넷 — **주어가 이득을 본 쪽인가 대가를 치른 쪽인가**를 함께 적는다.
 * `favours`는 이로운 편이므로, 대가의 주어는 그 반대편이다.
 */
const COUNTER_KO: Record<
  string,
  { blames?: true | ((r: Render) => boolean); text: (r: Render) => string }
> = {
  space_behind: {
    blames: true,
    text: (r) =>
      `${r.subject}의 높은 라인 뒤가 열린다 — ${r.rival} 전방 스피드 ${Math.round(r.v("fwPace"))} vs 수비 ${Math.round(r.v("cbPace"))}` +
      (r.has("sweeper") ? " (골키퍼가 커버 범위를 넓혀 버틴다)" : "") +
      // 트랩은 **감독이 켰을 때만** 문장에 선다 — 내린 적 없는 지시의 대가를 말하지 않는다
      (r.has("trap-unfamiliar") ? " · 오프사이드 트랩이 아직 손에 안 익었다" : "") +
      (r.has("trap-drilled") ? " · 오프사이드 트랩이 손에 익어 타이밍으로 덮는다" : ""),
  },
  press_trap: {
    text: (r) =>
      `${r.subject}의 압박이 ${r.rival}의 짧은 빌드업을 높은 곳에서 끊는다 (상대 후방 연결 ${Math.round(r.v("link"))})`,
  },
  press_bypassed: {
    blames: true,
    text: (r) =>
      r.has("long-ball")
        ? `${r.rival}이(가) 압박을 롱볼로 넘겨 버린다 — ${r.subject}의 전방 압박이 허공을 뛴다`
        : `${r.rival} 중원이 압박을 견딘다 (압박 저항 ${Math.round(r.v("pressResist"))})`,
  },
  buildup_collapse: {
    blames: true,
    text: (r) =>
      `${r.subject}의 후방이 짧은 연결을 감당하지 못한다 (빌드업 ${Math.round(r.v("buildUp"))}) — 압박에 위험 지역에서 흘린다`,
  },
  midfield_overload: {
    text: (r) =>
      `중원 숫자에서 ${r.subject}이(가) ${r.v("edge")}명 앞선다 (${r.v("mf")} vs ${r.v("rivalMf")})` +
      (r.has("stretched") ? " — 다만 폭을 넓게 써 중앙이 얇아진다" : ""),
  },
  wing_space: {
    text: (r) =>
      `${r.rival}이(가) 중앙에 몰려 측면이 비었다 — ${r.subject} 측면 자원 ${Math.round(r.v("wideQuality"))}`,
  },
  crossing_barrage: {
    text: (r) =>
      `${r.subject}이(가) 측면에서 올려 제공권으로 해결한다 (전방 공중볼 ${Math.round(r.v("aerialAtk"))} vs 수비 ${Math.round(r.v("aerialDef"))})`,
  },
  sterile_possession: {
    blames: true,
    text: (r) =>
      `${r.rival}의 밀집 수비를 ${r.subject}이(가) 느리고 좁게 두드린다 — 공은 갖되 길이 없다`,
  },
  stretch_block: {
    text: (r) => `${r.subject}이(가) 빠르고 넓게 움직여 ${r.rival}의 블록을 좌우로 흔든다`,
  },
  counter_attack: {
    text: (r) =>
      (r.has("ordered")
        ? `${r.subject}이(가) 역습을 지시했다`
        : `${r.subject}이(가) 내려서서 역습을 노린다`) +
      ` — ${r.rival}이(가) 올라온 뒤가 넓다 (전방 스피드 ${Math.round(r.v("fwPace"))})`,
  },
  stretched_shape: {
    blames: true,
    text: (r) =>
      `${r.subject}의 전후 간격이 벌어졌다 — 멘탈리티 ${r.v("mentality")}에 수비 라인 ${r.v("defensiveLine")}, 중원이 빈다`,
  },
  rushed_errors: {
    blames: true,
    text: (r) =>
      `${r.subject}이(가) 서두르다 ${r.rival}의 압박에 흘린다 (중원 침착성 ${Math.round(r.v("pressResist"))})`,
  },
  backline_numbers: {
    // 남으면 이득, 모자라면 대가 — 주어는 언제나 그 수비진을 세운 팀이다
    blames: (r) => r.v("spare") < 0,
    text: (r) =>
      r.v("spare") > 0
        ? `${r.subject} 수비 ${r.v("df")}명이 상대 전방 ${r.v("fw")}명을 두고 남는다 — 커버가 두텁다`
        : `${r.subject} 수비 ${r.v("df")}명이 상대 전방 ${r.v("fw")}명에게 커버 없는 일대일을 강요당한다`,
  },
  flank_mismatch: {
    text: (r) =>
      `측면 속도에서 ${r.subject}이(가) 앞선다 (${Math.round(r.v("wideAttack"))} vs ${Math.round(r.v("wideDefend"))}) — 폭을 쓰는 만큼 살아난다`,
  },
};

/**
 * 미스매치 열넷 — **정밀한 문장과 흐린 문장은 같은 사실의 두 해상도다.**
 *
 * 어느 쪽을 낼지는 태그의 `sharp`가 가른다(match.md §1.6). 주어(`subject`)는 그
 * 지점을 **가진 쪽**이고 상대(`rival`)가 그것으로 득을 보는 쪽이다.
 */
const MISMATCH_KO: Record<string, { sharp: (r: Render) => string; vague: (r: Render) => string }> =
  {
    "backline-pace": {
      sharp: (r) =>
        `${r.rival} 뒷공간 공략: ${r.who(0)}(${AXIS_KO.pace} ${r.v("pace")}) vs ${r.who(1)}(${AXIS_KO.pace} ${r.v("defencePace")})`,
      vague: (r) => `${r.subject} 최종 수비가 발이 느리다 — 뒷공간이 열린다`,
    },
    "wing-duel": {
      sharp: (r) =>
        `${r.rival} 1대1 우위: ${r.who(0)}(${AXIS_KO.dribbling} ${r.v("dribbling")}) vs ${r.who(1)}(${AXIS_KO.tackling} ${r.v("tackling")})`,
      vague: (r) => `${r.rival}는 측면에서 사람을 벗겨낼 수 있다`,
    },
    aerial: {
      sharp: (r) =>
        `${r.rival} 제공권 우위: ${r.who(0)}(${AXIS_KO.aerial} ${r.v("aerial")}) vs ${r.who(1)}(${r.v("defenceAerial")})`,
      vague: (r) => `${r.rival}가 공중에서 앞선다 — 크로스와 세트피스가 통한다`,
    },
    "press-resistance": {
      sharp: (r) =>
        `${r.subject} 빌드업 약점: ${r.who(0)}(${AXIS_KO.composure} ${r.v("composure")} · ${AXIS_KO.passing} ${r.v("passing")}) — 압박하면 흔들린다`,
      vague: (r) => `${r.subject} 중원은 압박에 약하다`,
    },
    creator: {
      sharp: (r) =>
        `${r.subject} 창조의 축: ${r.who(0)}(${AXIS_KO.vision} ${r.v("vision")}) — 이 선수를 지우면 공격이 멎는다`,
      vague: (r) => `${r.subject}의 공격은 중원 한 명에게서 시작된다`,
    },
    finisher: {
      sharp: (r) =>
        `${r.subject} 결정력: ${r.who(0)}(${AXIS_KO.finishing} ${r.v("finishing")}) — 한 번의 기회로 끝낸다`,
      vague: (r) => `${r.subject} 최전방은 기회를 놓치지 않는다`,
    },
    keeper: {
      sharp: (r) =>
        `${r.subject} 골문 불안: ${r.who(0)}(${AXIS_KO.goalkeeping} ${r.v("goalkeeping")})`,
      vague: (r) => `${r.subject} 골키퍼가 미덥지 않다`,
    },
    "keeper-distribution": {
      sharp: (r) =>
        `${r.subject} 골키퍼 배급: ${r.who(0)}(${AXIS_KO.passing} ${r.v("passing")}) — 뒤에서부터 풀어 나온다`,
      vague: (r) => `${r.subject}는 골키퍼부터 빌드업한다`,
    },
    "backline-shape": {
      sharp: (r) =>
        `${r.subject} 수비 조직: 백라인 평균 ${AXIS_KO.positioning} ${Math.round(r.v("positioning"))} — 라인이 자주 어긋난다`,
      vague: (r) => `${r.subject} 수비는 짜임새가 헐겁다`,
    },
    "backline-leader": {
      sharp: (r) =>
        `${r.subject} 백라인에 조율자가 없다 (최고 ${AXIS_KO.leadership} ${r.v("leadership")})`,
      vague: (r) => `${r.subject} 수비는 서로를 부르지 않는다`,
    },
    physical: {
      sharp: (r) =>
        `${r.rival} 몸싸움 우위: ${r.who(0)}(${AXIS_KO.strength} ${r.v("strength")}) vs ${r.who(1)}(${r.v("defenceStrength")})`,
      vague: (r) => `${r.rival} 최전방이 등지고 버틴다`,
    },
    stamina: {
      sharp: (r) =>
        `${r.subject} 중원 활동량 부족: 평균 ${AXIS_KO.stamina} ${Math.round(r.v("stamina"))} — 후반에 밀린다`,
      vague: (r) => `${r.subject} 중원은 후반에 다리가 무거워진다`,
    },
    "set-piece": {
      sharp: (r) => `${r.subject} 세트피스 키커: ${r.who(0)}(${AXIS_KO.kicking} ${r.v("kicking")})`,
      vague: (r) => `${r.subject}는 ${SET_PIECE_KO}가 위협적이다`,
    },
    discipline: {
      sharp: (r) =>
        `${r.subject} 카드 위험: ${r.who(0)}(${AXIS_KO.aggression} ${r.v("aggression")} · ${AXIS_KO.composure} ${r.v("composure")})`,
      vague: (r) => `${r.subject}에 발끈하는 선수가 있다`,
    },
  };

/** 전술 6축이 존에 남긴 이득과 대가 — 눈금 하나가 한 줄이다 */
const TACTICAL_KO: Record<string, (r: Render) => string> = {
  mentality: (r) =>
    r.v("step") > 0
      ? "공격적 멘탈리티: 앞선 가중, 후방 노출"
      : "수비적 멘탈리티: 뒤를 두껍게, 공격 포기",
  pressing: (r) =>
    r.v("step") > 0
      ? `강한 압박: 중원 주도권(${AXIS_KO.stamina} ${r.v("stamina") >= 1 ? "충분" : "부족"}), 빌드업을 앞에서 끊되 뒷공간 위험`
      : "압박 완화: 중원을 내주고 자리를 지킨다",
  "defensive-line": (r) =>
    r.v("step") > 0
      ? `높은 수비 라인: 압축 이득, 상대 스피드에 뒷공간 노출(위험 ×${r.v("paceRisk").toFixed(2)})`
      : "내려선 수비 라인: 뒷공간을 지우고 전진을 포기",
  tempo: (r) =>
    r.v("step") > 0
      ? `빠른 템포: 기회 증가, ${AXIS_KO.composure}(${r.v("composure") >= 1 ? "양호" : "불안"})만큼 실책 위험`
      : "느린 템포: 안정적으로 돌리되 기회가 준다",
  width: (r) =>
    r.v("step") > 0
      ? `측면 확장: 폭을 쓰는 이득(측면 자원 ${r.v("wide") >= 1 ? "우수" : "평범"}), 중앙 밀집 약화`
      : "중앙 집중: 중원을 두껍게, 폭을 포기",
  "pass-style": (r) =>
    r.v("step") > 0
      ? `롱볼 지향: 제공권 ${r.v("aerial") >= 1 ? "우위" : "열세"}, 중원 점유 포기`
      : `짧은 패스: 점유로 중원 장악 (연결 ${r.v("passing") >= 1 ? "안정" : "불안"}), 전진은 느리다`,
  // ── 갈래 넷 — 켠 쪽만 줄을 갖는다 (match.md §1.2) ──
  transition: (r) =>
    r.has("counter")
      ? `역습 전환: 뺏으면 곧장 앞으로 (최전방 스피드 ${r.v("trait") >= 1 ? "우수" : "평범"}), 중원은 비운다`
      : "재정비: 뺏으면 자리부터 잡는다, 되받을 기회는 접는다",
  "offside-trap": () => "오프사이드 트랩: 상대를 라인 앞에 가두되 타이밍이 어긋나면 그대로 열린다",
  tackling: (r) =>
    r.has("hard")
      ? `강한 태클: 경합을 이긴다 (태클·적극성 ${r.v("trait") >= 1 ? "충분" : "부족"}), 파울·카드·부상이 함께 오른다`
      : "약한 태클: 카드와 부상을 줄이는 대신 전진을 허용한다",
  "keeper-distribution": (r) =>
    r.has("long")
      ? `긴 배급: 한 번에 넘긴다 (제공권 ${r.v("trait") >= 1 ? "우위" : "열세"}), 2차 볼을 내준다`
      : `짧은 배급: 뒤에서부터 숫자를 만든다 (후방 연결 ${r.v("trait") >= 1 ? "안정" : "불안"}), 우리 문 앞에서 잃을 위험`,
};

/**
 * 이 경기가 무슨 경기인가 (`source: "context"`) — 전력이 아니라 **대진이 가진 사실**.
 * 편이 없으므로 주어를 세우지 않는다.
 */
export const DERBY_HEAT_KO: Record<number, string> = {
  1: "이웃 사이의 자존심이 걸린 경기",
  2: "오랜 앙숙이 만나는 경기",
  3: "도시를 반으로 가르는 경기",
};

const CONTEXT_KO: Record<string, (tag: PacketTag) => string> = {
  derby: (tag) => {
    const heat = DERBY_HEAT_KO[Math.round(tag.values.heat ?? 1)] ?? DERBY_HEAT_KO[1]!;
    return `${tag.text ?? "더비"} — ${heat}`;
  },
};

/**
 * **판에 닿지 못한 지시·공략** — 조용히 버리면 거짓 성공이 된다.
 * 꼴은 하나다: `무엇이 안 걸렸는가 — 왜`. 한 줄만 읽어도 다시 내릴지가 정해져야 한다.
 */
const DROPPED_KO: Record<string, (r: Render) => string> = {
  "off-pitch": (r) =>
    r.named(0)
      ? `${r.who(0)}은(는) 그라운드에 없어 지시가 걸리지 않았다`
      : "그라운드에 없는 선수에게 내린 지시라 걸리지 않았다",
  "gone-target": (r) =>
    `${r.who(0)}의 지시가 걸리지 않았다 — ` +
    (r.named(1) ? `${r.who(1)}은(는) 이미 그라운드를 떠났다` : "겨냥한 상대가 그라운드에 없다"),
  overflow: (r) =>
    `${r.named(0) ? `${r.who(0)}에게 내린 지시가` : "지시 하나가"} 판에 닿지 않았다 — 한 경기에 ${r.v("limit")}개까지다`,
};

/** 공략이 걸리지 않은 까닭 */
const EXPLOIT_DROPPED_KO: Record<string, (r: Render) => string> = {
  missing: () => "그 지점이 그라운드에 없어 걸리지 않았다",
  "own-side": () => "우리 쪽 약점이라 노릴 수 없다",
  overflow: (r) => `동시에 ${r.v("limit")}곳까지라 이 공략은 걸리지 않았다`,
};

/**
 * 사실 태그 → 한 줄. **문장을 만드는 자리는 여기 하나뿐이다** (match.md §1).
 *
 * 코드와 수치와 flags 로 같은 문장이 나오므로, 문구를 고쳐도 판정과 집계는
 * 그대로다 — 그게 태그를 상태에 싣는 이유다.
 */
export function packetTagText(tag: PacketTag, ctx?: PacketTagContext): string {
  const named = (i: number) => {
    const id = tag.playerIds[i];
    return id === undefined ? undefined : ctx?.player(id)?.name;
  };
  const r: Render = {
    subject: "",
    rival: "",
    who: (i) => named(i) ?? tag.playerIds[i] ?? "",
    named,
    v: (key, fallback = 0) => tag.values[key] ?? fallback,
    has: (flag) => tag.flags.includes(flag),
  };
  const nameOf = (side: MatchSide) =>
    side === "home" ? (ctx?.home ?? "홈") : (ctx?.away ?? "어웨이");
  /** 태그의 편 기준으로 주어와 상대를 세운다 — 편이 없는 태그는 이름을 쓰지 않는다 */
  const sides = (subject: MatchSide | null): Render => {
    if (!subject) return r;
    return { ...r, subject: nameOf(subject), rival: nameOf(otherSide(subject)) };
  };

  switch (tag.source) {
    case "legacy":
      return tag.text ?? "";
    case "context":
      return CONTEXT_KO[tag.code]?.(tag) ?? tag.text ?? "";
    case "zone-plan":
      return `${tag.favours ? nameOf(tag.favours) : ""} 지역 플랜: ${tag.text ?? ""}`.trim();
    case "gap": {
      // 구멍은 그 팀의 것이다 — 이로운 쪽은 반대편이라 주어를 되짚는다
      const holder = tag.favours ? otherSide(tag.favours) : null;
      const at = ctx?.player(tag.playerIds[0] ?? "");
      const s = sides(holder);
      return `${s.subject} ${at?.position ?? ""}에 구멍: ${s.who(0)}의 다리가 멈췄다 — 교체하지 않으면 그 자리가 계속 열린다`;
    }
    case "counter": {
      const entry = COUNTER_KO[tag.code];
      if (!entry || !tag.favours) return tag.text ?? "";
      const blames = typeof entry.blames === "function" ? entry.blames(r) : entry.blames === true;
      // 대가의 주어는 이로운 편의 반대다
      return entry.text(sides(blames ? otherSide(tag.favours) : tag.favours));
    }
    case "mismatch": {
      if (tag.code.startsWith("zone-")) return zoneMatchupText(tag);
      const entry = MISMATCH_KO[tag.code];
      if (!entry || !tag.favours) return tag.text ?? "";
      // 미스매치의 주어는 그 지점을 **가진** 쪽 — 강점 축은 그게 이로운 편 자신이다
      const s = sides(tag.holder ?? otherSide(tag.favours));
      return tag.sharp ? entry.sharp(s) : entry.vague(s);
    }
    case "tactical":
      return TACTICAL_KO[tag.code]?.(r) ?? tag.text ?? "";
    case "set-piece": {
      const role = SET_PIECE_ROLE_BY_ORIGIN[tag.code];
      const head = role === undefined ? SET_PIECE_KO : SET_PIECE_ROLE_KO[role];
      // 키커가 직접 찬 세트피스(직접 프리킥·페널티)는 마무리가 곧 키커라 한 사람만 선다
      const taker = r.who(0);
      const finisher = r.who(1);
      const kicking = tag.values.kicking;
      const aerial = tag.values.aerial;
      if (!finisher || finisher === taker) {
        const skill = tag.sharp && kicking !== undefined ? ` (킥력 ${Math.round(kicking)})` : "";
        return `${head} — ${taker}${skill}가 직접 마무리했다`;
      }
      const kick = tag.sharp && kicking !== undefined ? `(킥력 ${Math.round(kicking)})` : "";
      const head_ = tag.sharp && aerial !== undefined ? `(공중볼 ${Math.round(aerial)})` : "";
      return `${head} — ${taker}${kick}가 올리고 ${finisher}${head_}가 마무리했다`;
    }
    case "directive": {
      const line = DIRECTIVE_KO[tag.code]?.(r.who(0), r.who(1));
      if (line === undefined) return tag.text ?? "";
      const read =
        tag.values.duel !== undefined
          ? duelRead(tag.values.duel)
          : aptitudeRead(r.v("aptitude", 1));
      const intensity = flagValue(tag, "intensity");
      const ko = intensity === undefined ? undefined : DIRECTIVE_INTENSITY_KO_BY_CODE[intensity];
      return `${line} — ${read}${ko ? ` (${ko})` : ""}`;
    }
    case "ai-shift": {
      const head = AI_SHIFT_KO[tag.code] ?? "벤치가 판을 다시 깔았다";
      // 옮긴 축만 낱말로 — 눈금 숫자는 화면의 점이 이미 그린다
      const moved = TACTIC_AXES.filter((axis) => tag.values[axis.key] !== undefined).map(
        (axis) => `${axis.brief} ${tacticWord(axis.key, tag.values[axis.key]!)}`,
      );
      const shape = flagValue(tag, "formation");
      const parts = [...moved, ...(shape ? [`${shape} 모양으로 갈아 꼈다`] : [])];
      return parts.length > 0 ? `${head} — ${parts.join(" · ")}` : head;
    }
    case "directive-dropped":
      return DROPPED_KO[tag.code]?.(r) ?? tag.text ?? "";
    case "exploit": {
      const note = EXPLOIT_KO[tag.code];
      if (!note) return tag.text ?? "";
      return `${note} (${packetTagText({ ...tag, source: "mismatch" }, ctx)})`;
    }
    case "exploit-dropped": {
      const axis = flagValue(tag, "axis");
      const note = axis === undefined ? undefined : EXPLOIT_KO[axis];
      const why = EXPLOIT_DROPPED_KO[tag.code]?.(r) ?? tag.text ?? "";
      return `${note ?? "노린 지점을 찾지 못했다"} — ${why}`;
    }
  }
}

function zoneMatchupText(tag: PacketTag): string {
  const zone = tag.code.slice("zone-".length);
  const head = ZONE_MATCHUP_KO_BY_CODE[zone] ?? zone;
  const values =
    tag.values.home !== undefined && tag.values.away !== undefined
      ? ` (${tag.values.home} vs ${tag.values.away})`
      : "";
  // 값을 잃은 옛 세이브의 매치업 — 그때는 들고 온 문장이 전부다
  if (values === "" && tag.text) return tag.text;
  if (!tag.favours) return `${head}: 팽팽하다${values}`;
  const size = tag.flags.find((f): f is EdgeSize => f in SIZE_KO);
  const ko = size ? SIZE_KO[size] : "";
  return `${head}: ${tag.favours === "home" ? "홈" : "어웨이"}의 ${ko} 우위${values}`;
}

// ── 옛 세이브 읽기 ────────────────────────────────────
/** 진행 중이던 옛 세이브의 패킷 — 문장이 서 있던 칸들 */
interface LegacyPacket {
  keyPoints: Array<PacketTag | string>;
  keyPointSides?: MatchSide[];
  targets: Array<ExploitTarget & { label?: string }>;
  home: { tactical: { notes: Array<PacketTag | string> } };
  away: { tactical: { notes: Array<PacketTag | string> } };
}

/**
 * 진행 중이던 경기의 옛 패킷을 태그로 — **읽는 자리에서 한 번만** 지난다.
 *
 * `PendingMatch.packet`은 세이브 스키마의 검사 밖(passthrough)이라 옛 세이브는
 * `keyPoints: string[]`·`tactical.notes: string[]`·`targets[].label`을 들고 온다.
 * 판정은 이 폴백을 보지 않는다 — 옛 문장으로 다시 갈래를 가르면 이 구조가 뜻을
 * 잃으므로, 옮겨진 태그는 `code: "legacy"` 하나다 (match.md §4).
 */
export function normalizePacket(packet: StrengthPacket): StrengthPacket {
  const raw = packet as unknown as LegacyPacket;
  const notes = (list: Array<PacketTag | string>) =>
    list.map((n) => (typeof n === "string" ? legacyTag(n) : n));
  const stale =
    raw.keyPoints.some((k) => typeof k === "string") ||
    raw.home.tactical.notes.some((n) => typeof n === "string") ||
    raw.away.tactical.notes.some((n) => typeof n === "string") ||
    raw.targets.some((t) => t.tag === undefined);
  if (!stale) return packet;
  return {
    ...packet,
    keyPoints: raw.keyPoints.map((k, i) => {
      if (typeof k !== "string") return k;
      const tag = legacyTag(k);
      const favours = raw.keyPointSides?.[i];
      return favours ? { ...tag, favours } : tag;
    }),
    targets: raw.targets.map((t) => (t.tag ? t : { ...t, tag: legacyTag(t.label ?? t.id) })),
    home: {
      ...packet.home,
      tactical: { ...packet.home.tactical, notes: notes(raw.home.tactical.notes) },
    },
    away: {
      ...packet.away,
      tactical: { ...packet.away.tactical, notes: notes(raw.away.tactical.notes) },
    },
  };
}
