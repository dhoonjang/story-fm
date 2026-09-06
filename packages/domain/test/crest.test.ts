import { describe, expect, it } from "vitest";
import {
  CLUB_HI_MIN_CONTRAST,
  CLUB_TONE_SURFACE,
  CREST_INKS,
  CREST_MIN_INK_CONTRAST,
  FIELD_SEPARATION,
  type ClubColours,
  type Crest,
  clubTonesOf,
  contrastRatio,
  crestOf,
  flankTone,
} from "@story-fm/domain";
/**
 * 96팀의 공식 색 — 엔진의 데이터 파일이지만 domain 타입만 가져오는 잎 모듈이라 엔진
 * 그래프를 끌어오지 않는다. 불변식은 색이 어디 살든 문장이 지켜야 하므로 여기서 잰다
 * (ui/design-system.md ⚠️ 불변식).
 */
import { CLUB_COLOURS } from "../../engine/src/data/club-colours";

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

// ── 공식 색 (team.md §3.1 · ui/design-system.md §2) ──────────────────────────

const { panel2: PANEL_2, bg: BG } = CLUB_TONE_SURFACE;
const INK_LIGHT = CREST_INKS.light;

/** 두 후보 중 더 읽히는 쪽이 닿는 대비 — 공식 색은 깊게 하지 않으므로 이것이 상한이다 */
const bestInkContrast = (fill: string, inks: readonly string[]): number =>
  Math.max(...inks.map((ink) => contrastRatio(ink, fill)));

/** 어두운 남색 — 어두운 바닥에 묻혀 밝혀야 하는 쪽 */
const NAVY: ClubColours = { primary: "#001489", secondary: "#ffffff", accent: "#001489" };
/** 하늘색 — 강조색 그대로 선다 */
const SKY: ClubColours = { primary: "#6cadde", secondary: "#00285d", accent: "#6cadde" };
/** 클라렛·하늘색 — 강조색은 묻히고 두 번째 공식색이 선다 */
const CLARET: ClubColours = { primary: "#480024", secondary: "#94bee5", accent: "#480024" };
/** 흑백 — 유채색이 없다 */
const MONO: ClubColours = { primary: "#000000", secondary: "#ffffff", accent: "" };

describe("공식 색 — 색은 카탈로그의 것이고 도형은 여전히 id의 것이다", () => {
  it("공식 색이 있으면 채움이 그 값 그대로다 — 깊게 하지 않는다", () => {
    const crest = crestOf({ id: "chelsea", colours: NAVY });
    expect(crest.primary).toBe(NAVY.primary);
    expect(crest.secondary).toBe(NAVY.secondary);
    expect(crest.svg).toContain(`fill="${NAVY.primary}"`);
  });

  it("공식 색이 있어도 방패·분할·글자는 해시 그대로다", () => {
    const hashed = crestOf({ id: "chelsea", shortName: "CHE" });
    const official = crestOf({ id: "chelsea", shortName: "CHE", colours: NAVY });
    expect(official.shape).toBe(hashed.shape);
    expect(official.division).toBe(hashed.division);
    expect(official.initials).toBe(hashed.initials);
  });

  it("잉크는 두 벌 중 밑색과 더 대비되는 쪽이다", () => {
    expect(crestOf({ id: "x", colours: NAVY }).ink).toBe(CREST_INKS.light);
    expect(crestOf({ id: "x", colours: SKY }).ink).toBe(CREST_INKS.dark);
  });

  it("공식 색이 없으면 오늘의 값 그대로다 — 해시 경로는 바이트 단위로 같다", () => {
    // 이 값이 움직이면 모든 세이브의 문장이 통째로 달라진다
    expect(crestOf({ id: "arsenal" }).primary).toBe("#3741cd");
    expect(crestOf({ id: "arsenal" }).secondary).toBe("#d4c3e9");
    expect(crestOf({ id: "mancity" }).primary).toBe("#2f6cbc");
    expect(crestOf({ id: "psg" }).primary).toBe("#2caf95");
    expect(crestOf({ id: "psg" }).ink).toBe(CREST_INKS.dark);
    expect(crestOf({ id: "club-7-4" }).primary).toBe("#224d87");
  });
});

describe("96팀 불변식 — 공식 색 위에서 글자가 읽히고 가는 자리가 선다", () => {
  const clubs = Object.entries(CLUB_COLOURS);

  it("표는 1부 96팀이고 값은 소문자 #rrggbb다", () => {
    expect(clubs).toHaveLength(96);
    for (const [, colours] of clubs) {
      expect(colours.primary).toMatch(/^#[0-9a-f]{6}$/);
      expect(colours.secondary).toMatch(/^#[0-9a-f]{6}$/);
      expect(colours.accent).toMatch(/^(#[0-9a-f]{6})?$/);
    }
  });

  it("잉크는 밑색 위 4.5 — 순수한 빨강처럼 닿지 못하는 색은 닿을 수 있는 최대다", () => {
    for (const [id, colours] of clubs) {
      const crest = crestOf({ id, colours });
      const got = contrastRatio(crest.ink, crest.primary);
      const reachable = bestInkContrast(crest.primary, [CREST_INKS.light, CREST_INKS.dark]);
      expect(got, id).toBeCloseTo(reachable, 10);
      expect(got, id).toBeGreaterThanOrEqual(Math.min(CREST_MIN_INK_CONTRAST, reachable));
      // 어느 잉크로도 4.5에 못 미치는 공식 색은 있어도(중간 빨강 계열), 큰 글자 기준 아래는 없다
      expect(got, id).toBeGreaterThanOrEqual(CLUB_HI_MIN_CONTRAST);
    }
  });

  it("가는 자리 색은 --panel-2 위 3:1을 넘고, 그 위 잉크는 닿을 수 있는 최대다", () => {
    for (const [id, colours] of clubs) {
      const tones = clubTonesOf(crestOf({ id, colours }), colours);
      expect(contrastRatio(tones.hi, PANEL_2), id).toBeGreaterThanOrEqual(CLUB_HI_MIN_CONTRAST);
      const reachable = bestInkContrast(tones.hi, [BG, INK_LIGHT]);
      expect(contrastRatio(tones.hiInk, tones.hi), id).toBeCloseTo(reachable, 10);
      expect(contrastRatio(tones.hiInk, tones.hi), id).toBeGreaterThanOrEqual(
        Math.min(CREST_MIN_INK_CONTRAST, reachable),
      );
    }
  });
});

describe("clubTonesOf — 후보 순서 (ui/design-system.md §2 「--club-hi의 규칙」)", () => {
  it("강조색이 그대로 3:1을 넘으면 그 값이다", () => {
    const tones = clubTonesOf(crestOf({ id: "x", colours: SKY }), SKY);
    expect(tones).toEqual({ hi: SKY.accent, hiInk: BG, lifted: false });
  });

  it("강조색이 묻히면 두 번째 공식 유채색이 선다", () => {
    const tones = clubTonesOf(crestOf({ id: "x", colours: CLARET }), CLARET);
    expect(tones.hi).toBe(CLARET.secondary);
    expect(tones.lifted).toBe(false);
  });

  it("둘 다 묻히면 명도만 올린다 — 색상은 남고 3:1에 닿는다", () => {
    const tones = clubTonesOf(crestOf({ id: "x", colours: NAVY }), NAVY);
    expect(tones.lifted).toBe(true);
    expect(tones.hi).not.toBe(NAVY.primary);
    expect(contrastRatio(tones.hi, PANEL_2)).toBeGreaterThanOrEqual(CLUB_HI_MIN_CONTRAST);
    // 걸음이 0.02라 문턱을 크게 넘지 않는다 — 원색에 가장 가까운 첫 값이다
    expect(contrastRatio(tones.hi, PANEL_2)).toBeLessThan(CLUB_HI_MIN_CONTRAST + 0.6);
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(tones.hi.slice(at, at + 2), 16));
    expect(b).toBeGreaterThan(r!);
    expect(b).toBeGreaterThan(g!);
  });

  it("유채색이 하나도 없으면 은색이다", () => {
    const tones = clubTonesOf(crestOf({ id: "x", colours: MONO }), MONO);
    expect(tones).toEqual({ hi: "#c9d1c8", hiInk: BG, lifted: false });
  });

  it("공식 색이 없으면 해시 색을 같은 규칙으로 밝힌다", () => {
    for (const id of manyIds.slice(0, 40)) {
      const tones = clubTonesOf(crestOf({ id }));
      expect(contrastRatio(tones.hi, PANEL_2), id).toBeGreaterThanOrEqual(CLUB_HI_MIN_CONTRAST);
    }
  });
});

describe("flankTone — 두 밑색이 갈리지 않으면 원정만 보조색으로 물러난다", () => {
  const withPrimary = (crest: Crest, primary: string): Crest => ({ ...crest, primary });
  const home = withPrimary(crestOf({ id: "h" }), "#000000");
  const away = crestOf({ id: "a" });

  it("경계 1.9 — 닿으면 밑색, 못 닿으면 보조색", () => {
    // #3c3c3c은 검정 위 1.90, #3b3b3b은 1.87 — 경계 양옆 한 단계
    const apart = withPrimary(away, "#3c3c3c");
    const close = withPrimary(away, "#3b3b3b");
    expect(contrastRatio(home.primary, apart.primary)).toBeGreaterThanOrEqual(FIELD_SEPARATION);
    expect(contrastRatio(home.primary, close.primary)).toBeLessThan(FIELD_SEPARATION);
    expect(flankTone(home, apart)).toEqual({ home: home.primary, away: apart.primary });
    expect(flankTone(home, close)).toEqual({ home: home.primary, away: close.secondary });
  });

  it("홈은 언제나 밑색이다", () => {
    expect(flankTone(home, withPrimary(away, "#000000")).home).toBe(home.primary);
  });
});
