import type { PacketPlayer, RegionalIntent, StrengthPacket } from "@story-fm/domain";
import { anchorOf, PITCH_BANDS } from "@story-fm/domain";

/**
 * 판세 격자 — **세 전선을 좌·중·우로 한 번 더 쪼갠 것.**
 *
 * 존 막대 셋은 "중원이 밀린다"까지만 말한다. 그런데 감독이 실제로 손보는 것은
 * 자리다 — 밀리는 게 왼쪽인지 가운데인지에 따라 바꿀 선수도 지시도 다르다.
 *
 * ## 왜 존 전력을 쪼개기만 하나
 *
 * 격자는 **새 수치가 아니다.** 각 줄 세 칸의 평균은 그 줄의 존 전력과 같다
 * (`normalize`). 화면에만 있고 결과에 닿지 않는 숫자를 세우면 감독을 속이게 된다
 * — 왼쪽이 밀린다고 읽고 그 자리를 손보면, 존 전력이 실제로 움직여 결과까지
 * 닿아야 한다. 그래서 여기서 하는 일은 **배분**뿐이고, 판정은 그대로 존이 한다.
 *
 * ## 배분의 근거는 배치다
 *
 * 선수는 점이 아니라 영역을 맡는다. 각 선수가 자기 전술판 좌표에서 거리만큼
 * 옅어지며 이웃 칸에도 기여한다(`REACH`) — 그래서 왼쪽에 아무도 없어도 그 칸이
 * 0이 되지 않고, 가운데 선수들이 흘려 준 만큼 남는다.
 *
 * ## 지역 플랜이 결과에 닿는 길
 *
 * 격자가 줄 안에서 제로섬이라, 칸 하나를 두껍게 만드는 것만으로는 기대 득점이
 * 움직이지 않는다 — 옆 칸에서 그만큼 잃기 때문이다. 플랜이 값을 하는 것은
 * **슈팅이 그 레인으로 몰릴 때**다(`PLAN_ROUTE_FOCUS`, strength-packet.ts):
 * 상대가 얇은 칸을 골랐으면 이득이고, 이미 두꺼운 칸을 골랐으면 옆 칸을 헐어
 * 손해를 본다. 그래서 지역 플랜에는 **별도의 득점 계수가 없다** — 격자 하나가
 * 슈팅 생성의 유일한 수치 원본이라는 §1.4의 규칙을 그대로 지킨다.
 */

export type GridLane = "left" | "center" | "right";
export type GridBand = "defense" | "midfield" | "attack";

export const GRID_LANES: readonly GridLane[] = ["left", "center", "right"];
export const GRID_BANDS: readonly GridBand[] = ["defense", "midfield", "attack"];

/** 칸의 중심 — 전술판 좌표계(0~100). y는 **자기 골문이 100**이다 */
const LANE_X: Record<GridLane, number> = { left: 17, center: 50, right: 83 };
/** 세로 자리는 화면과 나눠 쓴다 — 경기 화면이 선수를 같은 칸에 앉힌다 */
const BAND_Y: Record<GridBand, number> = PITCH_BANDS.center;

/**
 * 한 선수가 칸에 닿는 거리 — 이보다 멀면 기여가 없다.
 * 좌우 칸 간격이 33이라, 옆 칸에는 절반쯤 흘러가고 대각선 끝까지는 닿지 않는다.
 */
const REACH = 46;

/**
 * 지역 플랜이 그 칸으로 끌어오는 전력의 몫 — 의도마다 무게가 다르다.
 *
 * 줄 안에서 다시 정규화되므로(`normalize`) 존 전력은 그대로다 — 목표 칸이
 * 두꺼워진 만큼 같은 줄의 나머지 두 칸이 얇아진다. **한쪽으로 사람을 몰면
 * 반대쪽이 빈다**는 사실이 이 한 줄에 들어 있다.
 *
 * 보호가 가장 큰 이유는 **공격 배분을 옮기지 않기 때문이다** — 다른 세 의도는
 * 슈팅을 그 레인으로 끌어와서도 값을 하지만(`PLAN_ROUTE_FOCUS`) 보호는 그 칸을
 * 두껍게 하는 것이 전부다. 상대가 실제로 다니는 레인을 골라야 값을 한다.
 */
export const REGIONAL_INTENT_WEIGHT: Record<RegionalIntent, number> = {
  overload: 0.12,
  press: 0.1,
  protect: 0.18,
  transition: 0.1,
};

/**
 * 사람이 적은 칸의 감점 폭 — 최대 이만큼만 깎는다.
 *
 * 크게 잡으면 안 된다: 뒤에서 세 칸을 존 전력에 맞춰 되늘리므로(`normalize`)
 * 여기서 깎은 만큼이 옆 칸에서 그대로 증폭된다. 한 칸 비었다고 전력이 절반이
 * 되는 화면은 실제 판세보다 훨씬 과장된 그림을 그린다.
 */
const THIN_PENALTY = 0.18;

/** 그 칸에서 실제로 뛰는 전력 — 가까운 선수일수록 크게 친다 */
function presence(
  players: readonly PacketPlayer[],
  lane: GridLane,
  band: GridBand,
  metric: "effective" | "creation",
): number {
  let weight = 0;
  let sum = 0;
  for (const p of players) {
    const at = p.point ?? anchorOf(p.position);
    const d = Math.hypot(at.x - LANE_X[lane], at.y - BAND_Y[band]);
    const w = Math.max(0, 1 - d / REACH);
    if (w === 0) continue;
    weight += w;
    sum += w * (metric === "creation" ? (p.creationEffective ?? p.effective) : p.effective);
  }
  if (weight === 0) return 0;
  // 그 자리에 사람이 얼마나 붙어 있나 — 얇으면 조금 깎인다
  const density = Math.min(1, weight / 1.2);
  return (sum / weight) * (1 - THIN_PENALTY * (1 - density));
}

/** 세 칸의 평균이 그 줄의 존 전력이 되도록 맞춘다 — 격자는 존을 쪼갠 것이다 */
function normalize(raw: number[], zone: number): number[] {
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  if (mean <= 0) return raw.map(() => zone);
  return raw.map((v) => (v / mean) * zone);
}

/** 격자 한 칸 — 같은 자리를 두고 맞선 두 전력 */
export interface GridCell {
  band: GridBand;
  lane: GridLane;
  /** 홈의 전력 */
  home: number;
  /** 그 자리에서 맞서는 원정의 전력 */
  away: number;
}

/** 상대는 거울이다 — 홈의 왼쪽 공격은 원정의 오른쪽 수비와 만난다 */
const MIRROR_LANE: Record<GridLane, GridLane> = {
  left: "right",
  center: "center",
  right: "left",
};
const FACING_BAND: Record<GridBand, GridBand> = {
  attack: "defense",
  midfield: "midfield",
  defense: "attack",
};

/**
 * 홈 기준 3×3 격자 — 화면이 우리 편 기준으로 다시 뒤집는다 (engine `views.ts`).
 *
 * `band`·`lane`은 **홈이 보는 방향**이다: `attack`은 홈이 공격하는 쪽,
 * `left`는 홈의 왼쪽. 각 칸의 `away`는 그 자리에서 마주 선 원정의 전력이라
 * 이미 거울로 뒤집혀 있다.
 */
export function zoneGrid(
  packet: StrengthPacket,
  metric: "effective" | "creation" = "effective",
): GridCell[] {
  const sideCells = (side: "home" | "away") => {
    const players = packet[side].lineup;
    const zones =
      metric === "creation"
        ? (packet[side].creationZones ?? packet[side].zones)
        : packet[side].zones;
    const out = new Map<string, number>();
    for (const band of GRID_BANDS) {
      const raw = GRID_LANES.map((lane) => {
        const base = presence(players, lane, band, metric);
        const plan = packet[side].regional?.find(
          (entry) => entry.band === band && entry.lane === lane,
        );
        if (!plan) return base;
        // 기존 배치가 이미 한 칸에만 잡혀도 지시가 사라지지 않게, 줄 전력의 한
        // 몫을 목표 칸에 더한 뒤 같은 줄 안에서 다시 정규화한다.
        return base + zones[band] * REGIONAL_INTENT_WEIGHT[plan.intent] * plan.uptake;
      });
      const fixed = normalize(raw, zones[band]);
      GRID_LANES.forEach((lane, i) => out.set(`${band}:${lane}`, fixed[i]!));
    }
    return out;
  };
  const homeCells = sideCells("home");
  const awayCells = sideCells("away");
  return GRID_BANDS.flatMap((band) =>
    GRID_LANES.map((lane) => ({
      band,
      lane,
      home: homeCells.get(`${band}:${lane}`) ?? 0,
      away: awayCells.get(`${FACING_BAND[band]}:${MIRROR_LANE[lane]}`) ?? 0,
    })),
  );
}
