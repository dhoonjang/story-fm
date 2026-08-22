import { describe, expect, it } from "vitest";
import { CREST_MIN_INK_CONTRAST, contrastRatio, crestOf } from "@story-fm/domain";

/** 절차 생성 문장 (crest.ts · team.md §3.1) */

const CLUBS = [
  { id: "arsenal", shortName: "ARS" },
  { id: "mancity", shortName: "MCI" },
  { id: "realmadrid", shortName: "RMA" },
  { id: "bayern", shortName: "FCB" },
  { id: "inter", shortName: "INT" },
  { id: "psg", shortName: "PSG" },
  { id: "freeagents", shortName: "FA" },
];

/** 어드민이 만들 수 있는 id까지 훑는다 — 문자 제약이 없다 */
const manyIds = Array.from({ length: 240 }, (_, i) => `club-${i}-${(i * 37) % 11}`);

describe("결정성 — 문장이 가리키는 것은 이름이 아니라 id다", () => {
  it("같은 id는 언제나 같은 SVG를 낸다", () => {
    for (const club of CLUBS) {
      expect(crestOf(club).svg).toBe(crestOf({ ...club }).svg);
    }
  });

  it("이름이 바뀌어도 색과 모양은 그대로고 글자만 따라간다", () => {
    const before = crestOf({ id: "arsenal", shortName: "ARS" });
    const after = crestOf({ id: "arsenal", shortName: "북런던 FC" });
    expect(after.primary).toBe(before.primary);
    expect(after.secondary).toBe(before.secondary);
    expect(after.shape).toBe(before.shape);
    expect(after.division).toBe(before.division);
    expect(after.initials).not.toBe(before.initials);
  });

  it("id가 다르면 문장도 다르다", () => {
    const svgs = new Set(manyIds.map((id) => crestOf({ id, shortName: "AAA" }).svg));
    expect(svgs.size).toBe(manyIds.length);
  });
});

describe("대비 — 글자는 어떤 밑색 위에서도 읽힌다", () => {
  it("잉크와 밑색이 최소 대비를 지킨다", () => {
    for (const id of [...manyIds, ...CLUBS.map((c) => c.id)]) {
      const crest = crestOf({ id });
      expect(contrastRatio(crest.ink, crest.primary)).toBeGreaterThanOrEqual(
        CREST_MIN_INK_CONTRAST,
      );
    }
  });

  it("보조색은 밑색과 갈린다 — 분할이 보이지 않으면 도형이 없는 것과 같다", () => {
    for (const id of manyIds) {
      const crest = crestOf({ id });
      expect(contrastRatio(crest.secondary, crest.primary)).toBeGreaterThan(1.6);
    }
  });
});

describe("축이 서로 독립이다 — 한 해시를 나눠 쓰면 조합이 곱이 아니라 합이 된다", () => {
  it("id를 충분히 넣으면 방패도 분할도 네 가지가 다 나온다", () => {
    const crests = manyIds.map((id) => crestOf({ id }));
    expect(new Set(crests.map((c) => c.shape)).size).toBe(4);
    expect(new Set(crests.map((c) => c.division)).size).toBe(4);
    expect(new Set(crests.map((c) => c.primary)).size).toBeGreaterThan(24);
  });
});

describe("SVG 문자열", () => {
  it("한 문서에 여러 문장이 서도 clipPath id가 겹치지 않는다", () => {
    const ids = manyIds.map((id) => crestOf({ id }).svg.match(/<clipPath id="([^"]+)"/)?.[1]);
    expect(new Set(ids).size).toBe(manyIds.length);
  });

  it("id가 어떤 문자를 담아도 id 속성과 마크업이 성립한다", () => {
    const svg = crestOf({ id: 'club "&<>/ 1', shortName: '<b>&"' }).svg;
    expect(svg.match(/<clipPath id="([^"]+)"/)?.[1]).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).not.toContain("<b>");
  });
});

describe("글자 — 약칭이 클럽을 가리킨다", () => {
  it("여러 낱말이면 머리글자, 한 낱말이면 앞 세 글자", () => {
    expect(crestOf({ id: "x", shortName: "Real Sociedad B" }).initials).toBe("RSB");
    expect(crestOf({ id: "x", shortName: "ARS" }).initials).toBe("ARS");
    expect(crestOf({ id: "x", shortName: "Nottingham" }).initials).toBe("NOT");
  });

  it("세 글자를 넘지 않는다", () => {
    expect([...crestOf({ id: "x", shortName: "A B C D E" }).initials]).toHaveLength(3);
  });

  it("약칭이 비면 id가 대신한다", () => {
    expect(crestOf({ id: "sunderland", shortName: "" }).initials).toBe("SUN");
    expect(crestOf({ id: "sunderland" }).initials).toBe("SUN");
  });

  it("어느 쪽에서도 글자를 못 뽑으면 자리를 비우지 않는다", () => {
    expect(crestOf({ id: "-", shortName: "!!" }).initials).toBe("FC");
  });
});
