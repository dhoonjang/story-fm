import { describe, expect, it } from "vitest";
import { rolesFor, type WeightSlot } from "@story-fm/domain";
import {
  ROLE_TENDENCY_DELTA,
  SLOT_TENDENCY,
  TENDENCY_AXES,
  roleTendencyOf,
} from "../src/live/roles";

/** 자리 묶음마다 대표 포지션 코드 하나 — 역할 목록은 묶음 단위라 이것으로 전부를 돈다 */
const POSITION_OF_SLOT: Record<WeightSlot, string> = {
  GK: "GK",
  CB: "CB",
  FB: "RB",
  DM: "DM",
  CM: "CM",
  AM: "AM",
  W: "RW",
  CF: "CF",
  ST: "ST",
};
const SLOTS = Object.keys(POSITION_OF_SLOT) as WeightSlot[];

const inUnit = (v: number) => v >= 0 && v <= 1;

describe("역할 성향표 — ROLE_DEFS의 모든 역할이 한 줄씩 선다", () => {
  it("모든 자리의 기본값이 0..1 안이다", () => {
    for (const slot of SLOTS)
      for (const axis of TENDENCY_AXES) expect(inUnit(SLOT_TENDENCY[slot][axis])).toBe(true);
  });

  it("ROLE_DEFS의 역할 id마다 차이 줄이 있고, 얹은 결과는 0..1 안이다", () => {
    for (const slot of SLOTS) {
      const position = POSITION_OF_SLOT[slot];
      for (const role of rolesFor(position)) {
        // 줄이 없으면 조용히 기본값이 된다 — 역할을 더한 날 이 단언이 그것을 알린다
        expect(ROLE_TENDENCY_DELTA, `${slot}/${role.id}`).toHaveProperty(role.id);
        const t = roleTendencyOf(position, role.id);
        for (const axis of TENDENCY_AXES) expect(inUnit(t[axis]), `${role.id}.${axis}`).toBe(true);
      }
    }
  });

  it("표의 열쇠는 전부 어느 자리엔가 있는 역할이다 — 오타는 아무 데도 붙지 않는다", () => {
    const known = new Set(SLOTS.flatMap((s) => rolesFor(POSITION_OF_SLOT[s]).map((r) => r.id)));
    for (const id of Object.keys(ROLE_TENDENCY_DELTA)) expect(known.has(id), id).toBe(true);
  });

  it("역할을 비우면 기본 역할, 그 자리에 없는 역할이면 자리 기본값이다", () => {
    expect(roleTendencyOf("ST")).toEqual(roleTendencyOf("ST", "advanced-forward"));
    expect(roleTendencyOf("LCB", "poacher")).toEqual(SLOT_TENDENCY.CB);
    expect(roleTendencyOf("RB", "not-a-role")).toEqual(SLOT_TENDENCY.FB);
    // 한글 이름·약어도 같은 줄을 찾는다
    expect(roleTendencyOf("RW", "인버티드 윙어")).toEqual(roleTendencyOf("RW", "inverted-winger"));
    expect(roleTendencyOf("DM", "A")).toEqual(roleTendencyOf("DM", "anchor"));
  });

  it("역할의 뜻이 성향에 남는다", () => {
    expect(roleTendencyOf("RW", "inverted-winger").inside).toBeGreaterThan(
      roleTendencyOf("RW", "winger").inside,
    );
    expect(roleTendencyOf("ST", "poacher").boxPresence).toBeGreaterThan(
      roleTendencyOf("CF", "false-nine").boxPresence,
    );
    expect(roleTendencyOf("DM", "anchor").hold).toBeGreaterThan(
      roleTendencyOf("CM", "box-to-box").hold,
    );
    expect(roleTendencyOf("RB", "wing-back").advance).toBeGreaterThan(
      roleTendencyOf("RB", "no-nonsense-fb").advance,
    );
    expect(roleTendencyOf("GK", "sweeper-keeper").sweep).toBeGreaterThan(
      roleTendencyOf("GK", "goalkeeper").sweep,
    );
    expect(roleTendencyOf("ST", "pressing-forward").press).toBeGreaterThan(
      roleTendencyOf("CF", "trequartista").press,
    );
  });
});
