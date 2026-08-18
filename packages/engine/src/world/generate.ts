import type { GamePlayer, PositionGroup } from "@story-fm/domain";
import { bestOverall } from "@story-fm/domain";
import { claimSyntheticName, syntheticNamePoolOf } from "../data/names";
import { countryOfTeam, TIER_BASE } from "../data/team-catalog";
import { deriveAxes } from "./attributes";
import { derivePositions, physiqueOf, syntheticFoot } from "./catalog";
import { claimPlayerId, slugifyName } from "./player-id";
import { makeRng, pick, randInt } from "../core/rng";

/**
 * 게임 중 생성되는 선수 — 유스 콜업 등. 카탈로그에 없으므로 catalogId = null.
 * 실존 유소년에게 가상 서사를 입히는 리스크를 피해 합성 가명을 쓴다 (people.md §2).
 */

const clamp99 = (x: number) => Math.max(1, Math.min(99, Math.round(x)));

/** 그룹별 대표 포지션 — 유스의 주 포지션 */
const GROUP_POSITION: Record<PositionGroup, string[]> = {
  GK: ["GK"],
  DF: ["RB", "CB", "LCB", "LB"],
  MF: ["DM", "CM", "AM", "RCM"],
  FW: ["ST", "RW", "LW", "CF"],
};

export function generateYouthPlayer(
  seed: number,
  teamId: string,
  season: number,
  index: number,
  tier: 1 | 2 | 3 | 4,
  /** 이미 쓰인 선수 id — 새 id를 여기에 등록하며 고른다 */
  taken: Set<string>,
  /** 지정 시 그 그룹으로 — GK 고갈 방지 등 (리뷰 발견) */
  forceGroup?: PositionGroup,
  /** 합류 연도 (유스는 시즌 개막 연도 기준 17~19세) */
  refYear = 2026 + season,
  /**
   * 이 팀에 이미 있는 이름 — 새 이름을 여기에 등록하며 고른다. 안 넘기면
   * 콜업된 유스가 1군 선수와 동명이인으로 설 수 있다 (people.md §2).
   */
  takenNames: Set<string> = new Set(),
): GamePlayer {
  const rng = makeRng(seed, `youth:${teamId}:${season}:${index}`);
  const groups: PositionGroup[] = ["GK", "DF", "DF", "MF", "MF", "FW", "FW"];
  const group = forceGroup ?? pick(rng, groups);
  const position = pick(rng, GROUP_POSITION[group]);
  /**
   * 합성 유스는 **채움용**이다 — 실명 유망주보다 낮아야 한다.
   *
   * 예전엔 `TIER_BASE - 8`(맨유 76)이라 열여섯 살 합성 선수가 OVR 85로 나왔다.
   * 실제 유망주인 헤븐(72)·레이시(71)는 물론 **1군 최저(66)보다도 높아서**,
   * 2군 상위를 이름 없는 선수들이 독점하고 유스 발굴의 재미가 사라졌다.
   * 실명 유망주 분포(62~72)의 아래쪽에 깔리게 낮춘다.
   *
   * 대신 **잠재력은 넉넉히 준다**(아래) — 유스의 매력은 지금 실력이 아니라 여지다.
   */
  const base = TIER_BASE[tier] - 24;

  const { ko: nameKo, en: nameEn } = claimSyntheticName(
    rng,
    syntheticNamePoolOf(countryOfTeam(teamId)),
    takenNames,
  );
  const v = (d = 6) => clamp99(base + randInt(rng, -d, d));
  const strong = () => clamp99(base + randInt(rng, 0, 8));
  const weak = () => clamp99(base + randInt(rng, -18, -8));

  const attrs =
    group === "GK"
      ? {
          pace: weak(),
          shooting: weak(),
          passing: v(),
          dribbling: weak(),
          defending: v(),
          physical: v(),
          goalkeeping: strong(),
        }
      : group === "DF"
        ? {
            pace: v(),
            shooting: weak(),
            passing: v(),
            dribbling: v(),
            defending: strong(),
            physical: strong(),
            goalkeeping: clamp99(15 + randInt(rng, 0, 20)),
          }
        : group === "MF"
          ? {
              pace: v(),
              shooting: v(),
              passing: strong(),
              dribbling: v(),
              defending: v(),
              physical: v(),
              goalkeeping: clamp99(15 + randInt(rng, 0, 20)),
            }
          : {
              pace: strong(),
              shooting: strong(),
              passing: v(),
              dribbling: strong(),
              defending: weak(),
              physical: v(),
              goalkeeping: clamp99(15 + randInt(rng, 0, 20)),
            };

  const age = randInt(rng, 17, 19);
  const month = randInt(rng, 1, 12);
  const day = randInt(rng, 1, 28);
  const birthdate = `${refYear - age}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // 시드 6축 → 15축 (실선수 카탈로그와 같은 파생 공식)
  const axes = deriveAxes(
    `${nameEn}-${slugifyName(teamId)}-${season}-${index}`,
    position,
    attrs,
    age,
  );
  // 카탈로그·어드민과 **같은 함수**로 종합을 낸다 — 보유 자리 목록이 인자다 (player.md §4)
  const positions = derivePositions(
    `${nameEn}-${slugifyName(teamId)}-${season}-${index}`,
    position,
  );
  const overall = bestOverall(axes, positions);

  return {
    id: claimPlayerId(nameEn, birthdate, taken),
    catalogId: null,
    teamId,
    squadLevel: "reserve",
    name: nameKo,
    birthdate,
    positions,
    // 적응도 파생과 **같은 키**로 주발을 뽑는다 — 같은 선수는 언제나 같은 발이다
    foot: syntheticFoot(`${nameEn}-${slugifyName(teamId)}-${season}-${index}`, position),
    ...physiqueOf(`${nameEn}-${slugifyName(teamId)}-${season}-${index}`, position, axes),
    attributes: {
      ...axes,
      overall,
      // 유스의 매력은 지금 실력이 아니라 **성장 여지**다 — 기준선을 낮춘 만큼
      // 잠재력 폭을 넓혀, 드물게 진짜 물건이 섞이게 둔다
      potential: clamp99(overall + randInt(rng, 10, 26)),
    },
    state: { form: 0, condition: randInt(rng, 70, 84) },
    isCaptain: false,
  };
}
