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

import { josa } from "./josa";
import {
  legacyTag,
  normalizeTag,
  otherSide,
  type MatchSide,
  type PacketTagSource,
  type SubCause,
} from "./match";
import { AXIS_KO } from "./player";
import { SHEET_SHAPE_KO, type Point, type SheetLine, type SheetShape } from "./sheet";
import {
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
 * 세 전선 — **패킷 전체가 쓰는 한 낱말.** 존 전력·매치업·시트의 밴드가 모두 이
 * 셋이고, 한 곳만 다른 이름으로 두면 같은 자리가 두 값이 된다.
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
 * 패킷이 싣는 **사실 태그** — 상성·구멍·컨텍스트·시트가 전부 이 한 모양이다
 * (match.md §1).
 *
 * 코어가 한국어 문장을 만들어 실으면 그 문장이 원인 태그로 골에 복사되고 진행 중인
 * 세이브에 굳는다 — 그러면 문구를 고치는 순간 전술 XP의 근거가 달라진다. 태그를
 * 문장으로 옮기는 것은 그것을 읽는 쪽(화면·중계·CLI)이 같은 렌더러 하나로 한다.
 */
export interface PacketTag {
  /** 어느 갈래에서 나왔나 — 목록은 `PACKET_TAG_SOURCES`(match.ts) 한 벌이다 */
  source: PacketTagSource;
  /** 상성·구멍·시트 모양의 코드 — 판정과 집계의 열쇠 ("space_behind" · "edge") */
  code: string;
  /** 이 사실이 **이로운 편** — 약점을 가진 쪽이 아니다. 편이 없는 사실이면 null */
  favours: MatchSide | null;
  /**
   * 이 사실을 **가진 쪽** — 이름이 서는 선수들의 팀이자 문장의 주어다.
   *
   * 시트 태그는 표적이 선 편이다 — 상대 선수의 −는 그 상대가 가진 사실이되 우리에게
   * 이롭다. 없으면(구멍·옛 세이브처럼 가진 쪽이 언제나 잃는 갈래) 이로운 편의 반대로 본다.
   */
  holder?: MatchSide;
  /**
   * 수치를 드러내도 되는가 — `false`면 렌더러가 흐린 문장을 낸다. 지금 새 패킷이
   * 싣는 태그는 전부 `true`다 — 안개는 태그가 아니라 어느 포인트를 보여 주는가에 걸린다
   * (match.md §1.6).
   */
  sharp: boolean;
  /** 이름이 서는 선수들 — 팀 단위 사실이면 빈 배열 */
  playerIds: string[];
  /** 라벨 붙은 수치 — `{ fwPace: 88, cbPace: 61 }` */
  values: Record<string, number>;
  /** 문장 안에 숨어 있던 조건부 축 — "sweeper" · "trap-unfamiliar" · "band:attack" */
  flags: string[];
  /**
   * 구조로 못 옮기는 자유 문장 — 시트 태그의 포인트 문장, 옛 세이브의 줄, 그리고
   * 카탈로그가 가진 고유 명사(컨텍스트 태그의 더비 이름).
   */
  text?: string;
}

/**
 * 전술 지시가 존 전력에 남긴 흔적 — **감독의 결정이 어떻게 수치가 됐는가**.
 *
 * 이득과 대가를 함께 적는다. 지시는 공짜가 아니고(라인을 올리면 뒷공간이 열린다),
 * 소화율(`uptake`)은 **이득에 온전히, 대가에는 층마다 다르게** 걸린다 — 전술 6축은
 * 대가도 절반을 태우고 시트·전술 상성은 대가를 온전히 문다 (match.md §1.2의 표).
 */
export interface TacticalRead {
  /** 지시 적용률 0.45~1.0 — 감독 전술 능력 + 팀 전술 적응도 (+ 시트의 `cohesion`) */
  uptake: number;
  /** 이득·대가의 사실 태그와 시트가 남긴 노트 (지시가 수치를 움직였거나 걸리지 못했을 때) */
  notes: PacketTag[];
}

export type RegionalBand = MatchupZone;
/** 좌·중·우 — 시트·판세 격자·공격 경로가 나눠 쓰는 눈금 */
export type RegionalLane = "left" | "center" | "right";

/**
 * 시트가 판세 격자의 한 줄 안에서 기울인 몫 — **줄 합은 0이다.**
 *
 * 시트의 산출은 밴드×레인 아홉 칸이고, 그 줄 평균은 존 전력에 실린다. 여기 오는
 * 것은 평균을 뺀 나머지뿐이라 격자는 **배분만** 받는다 — 같은 전력이 존과 칸에
 * 두 번 세어지지 않게 하는 자리다 (match.md §1.7, sim `zone-grid.ts`).
 */
export interface LaneBias {
  band: RegionalBand;
  lane: RegionalLane;
  /** 존 전력 대비 비율 — 양수면 그 칸이 두꺼워지고 같은 줄 나머지가 얇아진다 */
  share: number;
}

/**
 * 시트의 `edge +`가 공격 배분을 그 레인으로 끌어오는 몫 (match.md §1.7).
 * 선수의 자리 가중치에 곱해지므로 레인을 통째로 바꾸지는 못한다.
 */
export interface RouteFocus {
  lane: RegionalLane;
  /** `SHEET_ROUTE_FOCUS[band] × step × uptake`의 합 */
  weight: number;
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
   * 없으면 그라운드 위 **필드 플레이어** 최고(코너·프리킥은 `kicking`, 페널티는
   * `penaltySkill`). 골키퍼는 기본값의 후보가 아니다 — `kicking`이 골킥 능력이라
   * 걸러 내지 않으면 모든 팀의 코너를 골키퍼가 올린다. 명단이 비면 null이다.
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
  /**
   * 시트가 격자의 배분을 기울인 몫. 시트가 없거나 레인을 겨냥하지 않은 경기에는
   * 없고, **옛 세이브에도 없다** — 그때는 격자가 배치만 읽는다.
   */
  laneBias?: LaneBias[];
  /** 시트의 `edge +`가 공격 배분을 끌어오는 레인 — 없으면 배치가 정한 배분 그대로다 */
  routeFocus?: RouteFocus[];
  /**
   * 선수 id → 카드·파울 가중에 거는 배수 — 시트의 `temper` (match.md §1.6). 1인
   * 선수는 담지 않는다. 구간 시뮬이 `bookingWeight`·곧장 퇴장·파울 배분에서 읽는다.
   */
  temper?: Record<string, number>;
  /** 선수 id → 체력 소모 배수 — 시트의 `legs`. 구간 시뮬이 `conditionDrain`에서 읽는다 */
  legs?: Record<string, number>;
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

export interface StrengthPacket {
  home: SidePacket;
  away: SidePacket;
  matchups: Matchup[];
  /**
   * 이 경기의 태그 — 컨텍스트 · 상성 · 구멍 · **시트의 걸린 줄** (match.md §1.6).
   * 이로운 편은 태그의 `favours`가 갖는다.
   */
  keyPoints: PacketTag[];
  /**
   * 각 키포인트가 **누구에게 이로운가** — `keyPoints`와 같은 순서.
   *
   * 진행 중인 경기를 담은 **옛 세이브만** 갖는다 (지금은 태그의 `favours`가 원본).
   */
  keyPointSides?: MatchSide[];
  /**
   * 이 패킷이 읽은 **전술 포인트와 시트** — 판독기가 쓴 그대로 (match.md §1.6).
   *
   * 원본은 `pendingMatch.points`·`sheet`이고 여기 실리는 것은 그 복사다 — 기록
   * (`packetDigest`)과 화면이 "이 판이 무엇을 읽고 섰는가"를 패킷 하나로 답하게.
   * 판독이 없는 경기(간이 시뮬·옛 세이브·킥오프 실패)에는 없다.
   */
  points?: Point[];
  sheet?: SheetLine[];
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

/**
 * 벤치가 판을 옮긴 **갈래** — 축이 어느 쪽으로 갔는지는 이 낱말이 이미 말한다
 * (`chase`는 전부 위로, `hold`는 전부 아래로 — match.md §2).
 */
const AI_SHIFT_KO: Record<string, string> = {
  chase: "벤치가 판을 앞으로 밀었다",
  hold: "벤치가 내려서서 잠갔다",
  counter: "벤치가 우리 전술을 읽고 맞섰다",
};

/** `축:값` 꼴 flag의 값 — 밴드·레인·포인트처럼 낱말 하나가 실리는 자리 */
function flagValue(tag: PacketTag, key: string): string | undefined {
  const at = tag.flags.find((f) => f.startsWith(`${key}:`));
  return at?.slice(key.length + 1);
}

/** 태그가 문장으로 설 때 필요한 것 — 이름·수치·조건 */
interface Render {
  /** 이 사실이 **선 팀** — 상성은 그 수를 둔 쪽, 시트는 표적이 선 쪽 */
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
        ? `${josa(r.rival, "이/가")} 압박을 롱볼로 넘겨 버린다 — ${r.subject}의 전방 압박이 허공을 뛴다`
        : `${r.rival} 중원이 압박을 견딘다 (압박 저항 ${Math.round(r.v("pressResist"))})`,
  },
  buildup_collapse: {
    blames: true,
    text: (r) =>
      `${r.subject}의 후방이 짧은 연결을 감당하지 못한다 (빌드업 ${Math.round(r.v("buildUp"))}) — 압박에 위험 지역에서 흘린다`,
  },
  midfield_overload: {
    text: (r) =>
      `중원 숫자에서 ${josa(r.subject, "이/가")} ${r.v("edge")}명 앞선다 (${r.v("mf")} vs ${r.v("rivalMf")})` +
      (r.has("stretched") ? " — 다만 폭을 넓게 써 중앙이 얇아진다" : ""),
  },
  wing_space: {
    text: (r) =>
      `${josa(r.rival, "이/가")} 중앙에 몰려 측면이 비었다 — ${r.subject} 측면 자원 ${Math.round(r.v("wideQuality"))}`,
  },
  crossing_barrage: {
    text: (r) =>
      `${josa(r.subject, "이/가")} 측면에서 올려 제공권으로 해결한다 (전방 공중볼 ${Math.round(r.v("aerialAtk"))} vs 수비 ${Math.round(r.v("aerialDef"))})`,
  },
  sterile_possession: {
    blames: true,
    text: (r) =>
      `${r.rival}의 밀집 수비를 ${josa(r.subject, "이/가")} 느리고 좁게 두드린다 — 공은 갖되 길이 없다`,
  },
  stretch_block: {
    text: (r) => `${josa(r.subject, "이/가")} 빠르고 넓게 움직여 ${r.rival}의 블록을 좌우로 흔든다`,
  },
  counter_attack: {
    text: (r) =>
      (r.has("ordered")
        ? `${josa(r.subject, "이/가")} 역습을 지시했다`
        : `${josa(r.subject, "이/가")} 내려서서 역습을 노린다`) +
      ` — ${josa(r.rival, "이/가")} 올라온 뒤가 넓다 (전방 스피드 ${Math.round(r.v("fwPace"))})`,
  },
  stretched_shape: {
    blames: true,
    text: (r) =>
      `${r.subject}의 전후 간격이 벌어졌다 — 멘탈리티 ${r.v("mentality")}에 수비 라인 ${r.v("defensiveLine")}, 중원이 빈다`,
  },
  rushed_errors: {
    blames: true,
    text: (r) =>
      `${josa(r.subject, "이/가")} 서두르다 ${r.rival}의 압박에 흘린다 (중원 침착성 ${Math.round(r.v("pressResist"))})`,
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
      `측면 속도에서 ${josa(r.subject, "이/가")} 앞선다 (${Math.round(r.v("wideAttack"))} vs ${Math.round(r.v("wideDefend"))}) — 폭을 쓰는 만큼 살아난다`,
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
  // ── 세트피스 두 축 — 이득은 죽은 공 질에 있고 여기 서는 것은 대가다 (match.md §1.4) ──
  "set-piece-commit": (r) =>
    r.v("step") > 0
      ? `${SET_PIECE_KO} 가담 많이: 박스에 사람을 채우되 걷어낸 공 뒤가 열린다`
      : `${SET_PIECE_KO} 가담 적게: 죽은 공을 포기하고 뒤를 지킨다`,
  "set-piece-guard": (r) =>
    r.v("step") > 0
      ? `${SET_PIECE_KO} 수비 많이: 상대 박스 공격을 지우되 되받아 나갈 사람이 없다`
      : `${SET_PIECE_KO} 수비 적게: 되받을 사람을 남기고 상대 죽은 공을 감수한다`,
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

/** 시트의 밴드·레인 낱말 — 판세 격자와 같은 자리를 가리킨다 */
const BAND_KO: Record<string, string> = {
  defense: "우리 진영",
  midfield: "중원",
  attack: "상대 진영",
};
const LANE_KO: Record<string, string> = { left: "왼쪽", center: "가운데", right: "오른쪽" };

/**
 * 시트 줄의 **표적** 한 마디 — 선수면 이름, 칸이면 편과 자리다.
 * 밴드는 그 팀의 방향으로 적혀 있어(sim `sheet.ts`) 주어가 그 팀이다.
 */
function sheetTargetText(tag: PacketTag, r: Render): string {
  if (r.named(0) || tag.playerIds.length > 0) return r.who(0);
  const band = flagValue(tag, "band");
  const lane = flagValue(tag, "lane");
  const at = [lane ? LANE_KO[lane] : undefined, band ? BAND_KO[band] : undefined]
    .filter((s): s is string => s !== undefined)
    .join(" ");
  return at.length > 0 ? `${r.subject} ${at}`.trim() : r.subject;
}

/**
 * 시트 줄의 **방향과 눈금** — 수치가 아니라 화살표다. 시트는 GM에게 가지 않고
 * 판세에는 문장으로 서므로, 감독이 읽는 것은 "어느 쪽으로 얼마나"까지다.
 */
function sheetStepText(tag: PacketTag): string {
  const step = Math.max(1, Math.min(3, Math.round(tag.values.step ?? 1)));
  const arrow = (tag.values.sign ?? 1) < 0 ? "↓" : "↑";
  return arrow.repeat(step);
}

/**
 * **판에 닿지 못한 시트 줄** — 조용히 버리면 거짓 성공이 된다 (match.md §2).
 * 꼴은 하나다: `무엇이 안 걸렸는가 — 왜`. 코드는 까닭이고 sim `sheet.ts`가 낸다.
 */
const SHEET_DROPPED_KO: Record<string, (r: Render) => string> = {
  "no-point": () => "가리킨 포인트가 판에 없다",
  "off-pitch": (r) =>
    r.named(0) ? `${josa(r.who(0), "은/는")} 그라운드에 없다` : "겨냥한 선수가 그라운드에 없다",
  "bad-target": () => "모양과 표적이 맞지 않는다",
  duplicate: () => "같은 표적에 이미 한 줄이 걸려 있다",
  "target-cap": () => "그 표적이 받을 수 있는 폭을 넘었다",
  budget: () => "한 팀의 시트 폭을 다 썼다",
  "net-cap": () => "이득만 있는 시트는 없다 — 대가 줄이 없어 잘렸다",
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
    case "mismatch":
      // 존 매치업만 이 갈래에 남았다 — 다른 코드는 옛 기록의 것이다
      return tag.code.startsWith("zone-") ? zoneMatchupText(tag) : (tag.text ?? "");
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
        return `${head} — ${josa(`${taker}${skill}`, "이/가")} 직접 마무리했다`;
      }
      const kick = tag.sharp && kicking !== undefined ? `(킥력 ${Math.round(kicking)})` : "";
      const head_ = tag.sharp && aerial !== undefined ? `(공중볼 ${Math.round(aerial)})` : "";
      return (
        `${head} — ${josa(`${taker}${kick}`, "이/가")} 올리고 ` +
        `${josa(`${finisher}${head_}`, "이/가")} 마무리했다`
      );
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
    case "sheet": {
      /**
       * 걸린 줄은 **그 포인트의 문장**을 말한다 — 골의 원인·중계·판세가 같은 문장을
       * 인용한다 (match.md §1.6). 뒤에 표적과 모양·방향을 붙여 같은 포인트의 두 줄이
       * 갈리게 한다.
       */
      const s = sides(tag.holder ?? (tag.favours ? otherSide(tag.favours) : null));
      const shape = SHEET_SHAPE_KO[tag.code as SheetShape] ?? tag.code;
      const head = tag.text ?? "판독";
      return `${head} — ${sheetTargetText(tag, s)} ${shape} ${sheetStepText(tag)}`.trim();
    }
    case "sheet-dropped": {
      const why = SHEET_DROPPED_KO[tag.code]?.(r) ?? tag.text ?? "";
      const head = tag.text ? `“${tag.text}”` : "시트 한 줄";
      return `${head}이 걸리지 않았다 — ${why}`;
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
/** 진행 중이던 옛 세이브의 패킷 — 문장이 서 있던 칸들과 사라진 층 */
interface LegacyPacket {
  keyPoints: Array<PacketTag | string>;
  keyPointSides?: MatchSide[];
  /** 공략 표적 — 사라진 층. 있으면 걷는다 */
  targets?: unknown;
  home: { tactical: { notes: Array<PacketTag | string> }; regional?: unknown };
  away: { tactical: { notes: Array<PacketTag | string> }; regional?: unknown };
}

/**
 * 진행 중이던 경기의 옛 패킷을 태그로 — **읽는 자리에서 한 번만** 지난다.
 *
 * `PendingMatch.packet`은 세이브 스키마의 검사 밖(passthrough)이라 옛 세이브는
 * `keyPoints: string[]`·`tactical.notes: string[]`·공략 표적·지역 플랜을 들고 온다.
 * 판정은 이 폴백을 보지 않는다 — 옛 문장으로 다시 갈래를 가르면 이 구조가 뜻을
 * 잃으므로, 옮겨진 태그는 `code: "legacy"` 하나다 (match.md §4). 사라진 층은 걷는다.
 */
export function normalizePacket(packet: StrengthPacket): StrengthPacket {
  const raw = packet as unknown as LegacyPacket;
  const isLegacy = (tag: PacketTag | string) =>
    typeof tag === "string" || normalizeTag(tag) !== tag;
  const notes = (list: Array<PacketTag | string>) => list.map((n) => normalizeTag(n) as PacketTag);
  const stale =
    raw.keyPoints.some(isLegacy) ||
    raw.home.tactical.notes.some(isLegacy) ||
    raw.away.tactical.notes.some(isLegacy) ||
    raw.targets !== undefined ||
    raw.home.regional !== undefined ||
    raw.away.regional !== undefined;
  if (!stale) return packet;
  const { targets: _targets, ...rest } = raw as LegacyPacket & StrengthPacket;
  void _targets;
  const { regional: _homePlans, ...home } = rest.home as SidePacket & { regional?: unknown };
  const { regional: _awayPlans, ...away } = rest.away as SidePacket & { regional?: unknown };
  void _homePlans;
  void _awayPlans;
  return {
    ...(rest as StrengthPacket),
    keyPoints: raw.keyPoints.map((k, i) => {
      if (typeof k !== "string") return normalizeTag(k) as PacketTag;
      // 문장 하나를 든 옛 키포인트 — 편만 알면 태그가 된다
      const tag = legacyTag(k);
      const favours = raw.keyPointSides?.[i];
      return favours ? { ...tag, favours } : tag;
    }),
    home: { ...home, tactical: { ...home.tactical, notes: notes(raw.home.tactical.notes) } },
    away: { ...away, tactical: { ...away.tactical, notes: notes(raw.away.tactical.notes) } },
  };
}
