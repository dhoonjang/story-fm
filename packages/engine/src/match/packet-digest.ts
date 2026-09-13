import type {
  BoardPoint,
  LaneBias,
  Matchup,
  PacketTag,
  RegionalInstruction,
  StrengthPacket,
  ZoneStrength,
} from "@story-fm/domain";
import { zoneGrid, type GridCell } from "@story-fm/sim";

/**
 * **패킷 요약** — 기록(`journal`)에 싣는 패킷의 모양 (models.md §5-3).
 *
 * 패킷 통째는 구간마다 수십 KB다 — 슈팅 프로필(선수 × 경로)과 죽은 공 프로필이 크고,
 * 둘 다 존·명단에서 **유도**되는 값이라 되짚을 때 다시 세울 수 있다. 여기 남기는
 * 것은 판정이 읽는 수치와 그 근거다: 존 셋과 9칸 격자, 매치업, 기대 득점·점유·강도,
 * 키포인트와 전술 노트의 **태그**, 레인 편향과 지역 플랜, 그리고 양 팀 명단의 자리·
 * 좌표·역할·개인 전력. 존 편향(#779)도 좌우 겹침(#782)도 지시의 탈락(#781)도 이
 * 안에서 센다.
 *
 * 태그는 문장으로 옮기지 않는다 — 문구를 고친 날 옛 기록의 집계가 깨진다.
 */
export interface PacketDigest {
  expectedGoals: { home: number; away: number };
  expectedShots: { home: number; away: number } | null;
  chanceXg: { home: number; away: number } | null;
  possession: { home: number; away: number };
  intensity: { home: number; away: number };
  matchups: Matchup[];
  zones: { home: ZoneStrength; away: ZoneStrength };
  creationZones: { home: ZoneStrength | null; away: ZoneStrength | null };
  /** 9칸 격자 — 홈 기준. 각 칸의 `away`는 그 자리에서 마주 선 원정의 전력이다 */
  grid: GridCell[];
  keyPoints: PacketTag[];
  /** 공략할 수 있는 지점의 id — 감독이 고를 수 있는 전부 */
  targets: string[];
  tactical: {
    home: { uptake: number; notes: PacketTag[] };
    away: { uptake: number; notes: PacketTag[] };
  };
  laneBias: { home: LaneBias[]; away: LaneBias[] };
  regional: { home: RegionalInstruction[]; away: RegionalInstruction[] };
  lineup: { home: DigestPlayer[]; away: DigestPlayer[] };
  bench: { home: string[]; away: string[] };
}

export interface DigestPlayer {
  id: string;
  position: string;
  point: BoardPoint | null;
  roleId: string | null;
  effective: number;
  creationEffective: number | null;
  fit: { position: number; tactical: number; sensitivity: number };
}

function playersOf(side: StrengthPacket["home"]): DigestPlayer[] {
  return side.lineup.map((p) => ({
    id: p.id,
    position: p.position,
    point: p.point ? { ...p.point } : null,
    roleId: p.roleId ?? null,
    effective: p.effective,
    creationEffective: p.creationEffective ?? null,
    fit: { ...p.fit },
  }));
}

export function packetDigest(packet: StrengthPacket): PacketDigest {
  const { home, away, guide } = packet;
  return {
    expectedGoals: { ...guide.expectedGoals },
    expectedShots: guide.expectedShots ? { ...guide.expectedShots } : null,
    chanceXg: guide.chanceXg ? { ...guide.chanceXg } : null,
    possession: { ...guide.possession },
    intensity: { ...guide.intensity },
    matchups: packet.matchups.map((m) => ({ ...m })),
    zones: { home: { ...home.zones }, away: { ...away.zones } },
    creationZones: {
      home: home.creationZones ? { ...home.creationZones } : null,
      away: away.creationZones ? { ...away.creationZones } : null,
    },
    grid: zoneGrid(packet),
    keyPoints: packet.keyPoints.map((t) => ({ ...t })),
    targets: packet.targets.map((t) => t.id),
    tactical: {
      home: { uptake: home.tactical.uptake, notes: home.tactical.notes.map((t) => ({ ...t })) },
      away: { uptake: away.tactical.uptake, notes: away.tactical.notes.map((t) => ({ ...t })) },
    },
    laneBias: { home: [...(home.laneBias ?? [])], away: [...(away.laneBias ?? [])] },
    regional: { home: [...(home.regional ?? [])], away: [...(away.regional ?? [])] },
    lineup: { home: playersOf(home), away: playersOf(away) },
    bench: { home: home.bench.map((p) => p.id), away: away.bench.map((p) => p.id) },
  };
}
