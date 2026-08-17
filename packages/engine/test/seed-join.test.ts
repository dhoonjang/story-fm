import { describe, expect, it } from "vitest";
import { ageOf, weightSlotOf } from "@story-fm/domain";
import { CATALOG_AGE_REF, deriveAxes, derivePositions, overallFor } from "@story-fm/engine";
import { REAL_SQUADS, type RealPlayerSeed } from "../src/data/epl-players";
import { EU_SQUADS } from "../src/data/eu-squads";
import { MARKET_LEAGUE_SQUADS } from "../src/data/market-leagues";

/**
 * 시드 갱신 오조인 가드 — **(이름 + 생년월일) 조인이 동명이인을 받았는지**를
 * 시드 배열만 읽어 잡는다 (data/sources.md).
 *
 * 조인이 어긋나면 6축이 통째로 다른 사람 것이 되고, OVR은 전력 패킷·이적 평가·
 * 라인업 판단이 모두 읽는 값이라 리그 서열 자체가 깨진다. 그래서 시드 안에서
 * **EA 6축 조인과 독립인 세 축**으로 교차 검증한다.
 *
 * 1. **주급** — salarysport라는 별개 출처다. 능력치가 다른 사람 것으로 바뀌어도
 *    주급은 그대로 남으므로, 주급 층과 파생 OVR 층의 괴리가 조인 실패 신호다.
 * 2. **자리** — 위키 등록 스쿼드에서 온다. 윙어인데 수비가 최고축이면 받아온
 *    레코드가 그 자리의 선수가 아니다.
 * 3. **잠재력** — 시드가 사람 판단으로 매긴 값이고 EA 갱신이 덮지 않는다.
 *    오조인이 OVR만 끌어내리면 `potential − OVR` 간격이 나이에 안 맞게 벌어진다.
 *
 * 세 축의 신뢰도는 같지 않다. 1·2는 별개 출처의 **실측**이라 걸리면 거의 조인
 * 실패다. 3의 `potential`은 **판단값**이라, EA가 등급을 정당하게 내렸는데 잠재력을
 * 함께 손보지 않은 선수도 걸린다 — 3의 위반은 조인 실패의 증거가 아니라 **확인할
 * 후보 목록**이다.
 *
 * 세계를 세우지 않는다 — 순수 데이터 불변식이라 시드 배열과 파생 함수만 쓴다.
 */

/** 파생 OVR — 카탈로그가 쓰는 경로 그대로 (catalog.ts `entryFromSeed`) */
function overallOf(s: RealPlayerSeed): number {
  const axes = deriveAxes(s.nameEn, s.position, s, ageOf(s.birthdate, CATALOG_AGE_REF));
  return overallFor(s.position, axes, derivePositions(s.nameEn, s.position));
}

interface SeedRow {
  seed: RealPlayerSeed;
  team: string;
  ovr: number;
}

function rowsOf(squads: Record<string, readonly RealPlayerSeed[]>): SeedRow[] {
  return Object.entries(squads).flatMap(([team, squad]) =>
    squad.map((seed) => ({ seed, team, ovr: overallOf(seed) })),
  );
}

/**
 * 백분위 순위 (0~100) — 동값은 같은 백분위를 받는다.
 *
 * 절대 £ 값이나 절대 OVR에 임계를 걸지 않는 이유: 주급은 해마다 오르고 OVR은
 * 공식이 바뀌면 통째로 움직인다. 순위는 그 둘 다에 견딘다.
 */
function pctRankOf(values: readonly number[]): (v: number) => number {
  const sorted = [...values].sort((a, b) => a - b);
  const pct = new Map<number, number>();
  for (const v of sorted) {
    if (pct.has(v)) continue;
    pct.set(v, ((sorted.indexOf(v) + sorted.lastIndexOf(v)) / 2 / (sorted.length - 1)) * 100);
  }
  return (v) => pct.get(v) ?? 0;
}

const axisLine = (s: RealPlayerSeed): string =>
  [s.pace, s.shooting, s.passing, s.dribbling, s.defending, s.physical].join("/") +
  (s.goalkeeping === undefined ? "" : `/gk${s.goalkeeping}`);

/**
 * 주급이 있는 EPL 선수 + 주급·OVR 백분위 괴리. 탐지기 1과 3이 **같은 모집단**을
 * 쓴다 — 주급은 `epl-players.ts`에만 있어서 5대 리그 나머지는 이 축이 없다.
 */
function eplWageGapRows() {
  const rows = rowsOf(REAL_SQUADS).flatMap((r) =>
    r.seed.weeklyWage === undefined ? [] : [{ ...r, wage: r.seed.weeklyWage }],
  );
  const wagePct = pctRankOf(rows.map((r) => r.wage));
  const ovrPct = pctRankOf(rows.map((r) => r.ovr));
  return rows.map((r) => {
    const w = wagePct(r.wage);
    const o = ovrPct(r.ovr);
    return { ...r, w, o, wageGap: w - o };
  });
}

const wageGapLine = (v: ReturnType<typeof eplWageGapRows>[number]): string =>
  `주급 ${v.w.toFixed(1)}%(£${v.wage.toLocaleString("en-US")}/주) - OVR ${v.o.toFixed(1)}%(${v.ovr}) = ${v.wageGap.toFixed(1)}%p`;

/**
 * 주급 백분위가 OVR 백분위보다 이만큼(%p) 높으면 **그 하나만으로** 조인 실패로 본다.
 *
 * 60인 근거: `026710e` 이전 시드에서 가장 큰 괴리가 **51.7%p**(칼빈 필립스 —
 * 실제로 과지급 계약이라 오조인이 아니다)였다. 과지급·부상 이탈·구계약 같은
 * 정상적인 괴리가 사는 띠가 거기까지이므로, 그 위에 여유 8을 얹었다.
 */
const WAGE_OVR_GAP_LIMIT = 60;

/**
 * 한쪽 방향만 본다 — 주급이 높은데 OVR이 낮은 경우.
 *
 * 반대 방향(저주급 고OVR)은 유망주가 전부 걸린다. 라얀 -67%p, 코비 마이누
 * -63%p처럼 어린 선수의 계약은 원래 실력보다 훨씬 싸다.
 */
describe("주급 대비 파생 OVR 괴리 — 조인이 다른 사람의 능력치를 받았다", () => {
  it(`주급 백분위가 OVR 백분위보다 ${WAGE_OVR_GAP_LIMIT}%p 넘게 높은 선수는 없다`, () => {
    const violations = eplWageGapRows()
      .filter((v) => v.wageGap > WAGE_OVR_GAP_LIMIT)
      .sort((a, b) => b.wageGap - a.wageGap)
      .map(
        (v) =>
          `${v.seed.nameKo}(${v.seed.nameEn}) ${v.team} ${v.seed.position} ` +
          `괴리 ${wageGapLine(v)} · 6축 ${axisLine(v.seed)} · 생 ${v.seed.birthdate}`,
      );

    expect(violations).toEqual([]);
  });
});

/**
 * 자리별로 수비 축이 있을 수 없는 위치 — 칸첼리에리(윙어)가 수비 65를 최고축으로
 * 갖는 55/31/45/37/65/61로 뒤집힌 게 이 축에 걸린다.
 *
 * ⚠️ 골키퍼는 뺀다. GK의 6축은 EA의 골키퍼 세부 능력치라 `dribbling`·`defending`이
 * 한 자릿수까지 내려가는 게 정상이다 (epl-players.ts 상단 주석).
 */
const ATTACKING_SLOTS: readonly string[] = ["W", "CF", "ST"];

/**
 * 모순 판정의 여유. 0 = 동률도 위반.
 *
 * `026710e` 이전 시드의 필드플레이어 2,622명에서 위반이 **0명**이었으니 여유를
 * 둘 이유가 없다 — 5대 리그에 "수비가 최고축인 윙어"나 "수비가 최저축인 센터백"은
 * 존재하지 않는다.
 */
const PROFILE_MARGIN = 0;

describe("자리-프로필 모순 — 조인이 다른 자리의 선수를 받았다", () => {
  it("공격 자원의 최고축은 수비가 아니고, 센터백의 최저축은 수비가 아니다", () => {
    const rows = [...rowsOf(REAL_SQUADS), ...rowsOf(EU_SQUADS)].filter(
      (r) => weightSlotOf(r.seed.position) !== "GK",
    );

    const violations: { margin: number; line: string }[] = [];
    for (const r of rows) {
      const s = r.seed;
      const slot = weightSlotOf(s.position);
      /** 수비를 뺀 다섯 축 — 수비가 이 안에서 어디에 서는지가 자리의 색이다 */
      const others = [s.pace, s.shooting, s.passing, s.dribbling, s.physical];
      const say = (why: string, margin: number) => {
        violations.push({
          margin,
          line:
            `${s.nameKo}(${s.nameEn}) ${r.team} ${s.position} — ${why} ${margin} ` +
            `· 6축 ${axisLine(s)} · OVR ${r.ovr} · 생 ${s.birthdate}`,
        });
      };

      if (ATTACKING_SLOTS.includes(slot)) {
        const margin = s.defending - Math.max(...others);
        if (margin >= PROFILE_MARGIN) say("수비가 최고축, 차이", margin);
      }
      if (slot === "CB") {
        const margin = Math.min(...others) - s.defending;
        if (margin >= PROFILE_MARGIN) say("수비가 최저축, 차이", margin);
      }
    }

    expect(violations.sort((a, b) => b.margin - a.margin).map((v) => v.line)).toEqual([]);
  });
});

/**
 * 나이 밴드별 `potential − OVR` 상한 — 어린 선수는 간격이 큰 게 정상이고 전성기
 * 선수는 아니다. 경계는 `026710e` 이전 시드의 **나이별 최대 간격 곡선**에서 왔다:
 *
 * ```
 * 16세 28 · 17세 23 · 18세 25 · 19세 26 | 20세 22 · 21세 19 | 22세 14 · 23세 13 ·
 * 24세 13 | 25세 10 · 26세 11 · 27세 9 · 28세 7 · 29~30세 8 · 31세+ ≤6
 * ```
 *
 * 곡선이 꺾이는 자리(19→20, 21→22, 24→25)에서 끊고, 밴드 안의 최대값을 `oldMax`로
 * 적었다. 20~22를 한 밴드로 묶으면 20세의 22가 22세의 14를 가려 오조인이 숨는다.
 */
const POTENTIAL_GAP_BANDS: readonly { maxAge: number; oldMax: number }[] = [
  { maxAge: 19, oldMax: 28 },
  { maxAge: 21, oldMax: 22 },
  { maxAge: 24, oldMax: 14 },
  { maxAge: 99, oldMax: 11 },
];

/**
 * 밴드 상한에 얹는 여유. 임계 = `oldMax + 3`이고, 이 값에서 `026710e` 이전 시드
 * 2,957명의 위반이 **0명**이다 — 탐지기 1과 같은 방식(정상 띠의 천장 + 여유)이다.
 */
const POTENTIAL_GAP_MARGIN = 3;

const potentialGapLimit = (age: number): number =>
  (POTENTIAL_GAP_BANDS.find((b) => age <= b.maxAge)?.oldMax ?? 0) + POTENTIAL_GAP_MARGIN;

/**
 * 주급 괴리와 함께 볼 때 쓰는 **교차검증용** 주급 임계. 단독 임계(60)보다 낮다 —
 * 다른 독립 축이 같은 방향으로 어긋난 게 이미 증거이기 때문이다.
 *
 * ⚠️ 이 값만은 **"옛 데이터 위반 0명"으로 보정할 수 없었다.** 두 조건의 AND인데
 * 잠재력 조건 하나만으로 이미 옛 시드 위반이 0명이라, 주급 임계를 35까지 낮춰도
 * AND는 0명이다. 그래서 두 가지로 값을 잡았다.
 *
 * - **위**: 안드레이 산투스의 주급 괴리가 53.5%p다. 이 사례를 잡는 게 목적이므로
 *   임계는 그 아래여야 한다 (55로 올리면 산투스가 빠진다).
 * - **아래**: 주급 조건이 실질적인 관문으로 남아야 한다. 옛 시드 EPL 776명 중
 *   주급 조건을 통과하는 사람이 임계 50에서 **2명**, 45에서 6명, 35에서 18명이다.
 *   50이면 교차검증이 여전히 무언가를 걸러낸다.
 */
const WAGE_OVR_GAP_CORROBORATION = 50;

/**
 * **두 독립 축이 동시에 어긋날 때만** 위반으로 삼는다.
 *
 * 주급(salarysport)과 잠재력(시드의 수기 판단값)은 **둘 다 EA 6축 조인과 독립**이다.
 * 독립 출처 둘이 동시에 파생 OVR과 어긋나면 조인을 의심할 근거가 되지만, **하나만**
 * 어긋나는 건 그 출처가 낡았다는 뜻일 수 있다.
 *
 * 잠재력 하나만 보면 실제로 그렇게 된다. `eu-squads.ts`에는 **정상 조인인데 잠재력만
 * 낡은 선수가 수백 명** 있다 — 옛 값이 실측이 아니라 밴드 판단값이었고 `potential`은
 * 그 밴드에 맞춰 손으로 매긴 값이라, EA 실측이 들어오면서 통째로 낡았다. 평균6 컷을
 * -4까지 내려 뽑은 후보 306명 중 294명이 조인 실패의 지문(생년월일·키·주발 변화)이
 * 없었다. 낡은 잠재력을 고치는 건 성장 상한을 움직이는 밸런스 변경이라 별개 일이다.
 *
 * 그래서 이 탐지기는 **주급이 있는 EPL 선수만** 본다. EU가 이 축의 사각지대가 되는
 * 것은 받아들인다 — 주급이 독립 출처라는 성질에 딸린 한계이고, EU는 탐지기 2·4가 덮는다.
 */
describe("주급 괴리 + 잠재력 간격 교차검증 — 독립 출처 둘이 함께 어긋났다", () => {
  it("주급과 잠재력이 동시에 파생 OVR과 어긋난 선수는 없다", () => {
    const violations = eplWageGapRows()
      .map((r) => {
        const age = ageOf(r.seed.birthdate, CATALOG_AGE_REF);
        return { ...r, age, potGap: r.seed.potential - r.ovr, potLimit: potentialGapLimit(age) };
      })
      .filter((v) => v.wageGap > WAGE_OVR_GAP_CORROBORATION && v.potGap > v.potLimit)
      .sort((a, b) => b.potGap - a.potGap)
      .map(
        (v) =>
          `${v.seed.nameKo}(${v.seed.nameEn}) ${v.team} ${v.seed.position} 만 ${v.age}세 — ` +
          `주급 괴리 ${wageGapLine(v)} (교차검증 임계 ${WAGE_OVR_GAP_CORROBORATION}%p) · ` +
          `잠재력 간격 ${v.potGap} (잠재력 ${v.seed.potential} - OVR ${v.ovr}, 이 나이 상한 ${v.potLimit}) ` +
          `· 6축 ${axisLine(v.seed)} · 생 ${v.seed.birthdate}`,
      );

    expect(violations).toEqual([]);
  });
});

/**
 * 자리별 키 하한(cm) — **자연법칙 쪽 불변식**이다. 160cm 골키퍼는 존재하지 않는다.
 *
 * 다른 셋과 달리 이 임계는 `026710e` **이전 데이터로 보정할 수 없었다**. 옛 시드에는
 * 키 실측이 2,957명 중 **118명**뿐이라(나머지는 `physiqueOf`가 능력치에서 파생했다)
 * 자리별 표본이 GK 10 · CB 20 · 필드 88명에 그친다. 그래서 임계는 **현재 시드의
 * 실측 2,414명 분포**와 실제 축구의 하한에서 왔다 — 그만큼 근거가 얇다.
 *
 * 분포(현재 시드, 실측만):
 * ```
 * GK    n=264  최소 172 · p1 181 · p5 183 · 중앙 190
 * CB    n=466  최소 168 · p1 174 · p5 181 · 중앙 188
 * 필드  n=1684 최소 162 · p1 168 · p5 171 · 중앙 181
 * ```
 * 필드 하한을 165로 두면 **실존하는 단신 선수가 걸린다** — 라메크 반다 162,
 * 마리오 소리아노 163, 브라이언 사라고사 164는 모두 맞는 값이다. 그래서 필드는
 * 160으로 내렸다. 오조인을 잡는 힘은 GK·CB 두 자리에서 나온다.
 */
const MIN_HEIGHT_CM: Readonly<Record<"GK" | "CB" | "FIELD", number>> = {
  /** 5대 리그 최단신 골키퍼가 179다. 그 아래는 조인 실패로 본다 */
  GK: 179,
  /** 센터백은 172~175도 실재한다(리산드로 마르티네스). 170 아래가 없는 자리다 */
  CB: 170,
  /** 실측 최소가 162(라메크 반다)다. 프로 무대에 160 미만은 없다 */
  FIELD: 160,
};

const heightGroupOf = (position: string): "GK" | "CB" | "FIELD" => {
  const slot = weightSlotOf(position);
  return slot === "GK" || slot === "CB" ? slot : "FIELD";
};

/**
 * 상한은 두지 않았다 — 위 셋(비카리오 194→160 · 조 고메스 188→167 ·
 * 마마르다슈빌리 199→178)이 전부 하한에 걸리기 때문이다. 키를 **키우는** 방향의
 * 오조인(리산드로 마르티네스 175→182)은 이 축이 못 잡는다 — 탐지기 2가 잡았다.
 */
describe("자리별 신체 하한 — 조인이 다른 체격의 사람을 받았다", () => {
  it("골키퍼·센터백·필드 어느 자리에도 그 자리에 없는 키는 없다", () => {
    const violations = [...rowsOf(REAL_SQUADS), ...rowsOf(EU_SQUADS)]
      // 시드에 실측이 있는 선수만 — 없으면 카탈로그가 `physiqueOf`로 파생한다
      .flatMap((r) => (r.seed.height === undefined ? [] : [{ ...r, height: r.seed.height }]))
      .map((r) => ({ ...r, group: heightGroupOf(r.seed.position) }))
      .filter((v) => v.height < MIN_HEIGHT_CM[v.group])
      .sort((a, b) => a.height - b.height)
      .map(
        (v) =>
          `${v.seed.nameKo}(${v.seed.nameEn}) ${v.team} ${v.seed.position} — ` +
          `${v.height}cm (${v.group} 하한 ${MIN_HEIGHT_CM[v.group]}cm)` +
          `${v.seed.weight === undefined ? "" : ` · ${v.seed.weight}kg`} · 생 ${v.seed.birthdate}`,
      );

    expect(violations).toEqual([]);
  });
});

/**
 * 1월 1일은 **조사가 닿지 않은 자리를 채우는 값**으로 쓰여 왔다 — 라로 고메스가
 * `2006-01-01`로 실려 있었지만 실제는 2006-10-16이었다. 실제 1월 1일생과 값이
 * 같아서, 표식이 없으면 "확인했더니 1월 1일"과 "확인하지 않았다"가 구분되지
 * 않는다. 그 구분이 사라지면 조인 실패의 기본값("옛 값 유지")이 지킬 사실 없는
 * 값을 지키게 된다 (sources.md §4.1).
 *
 * 그래서 `-01-01`은 `birthdateApprox`를 **생략할 수 없다**. 새 갱신이 조사되지
 * 않은 1월 1일을 다시 들여오면 여기서 걸린다.
 */
describe("자리표시자 생년월일 — 1월 1일이 실제 날짜인지 표시돼 있다", () => {
  const ALL_SQUADS: Record<string, readonly RealPlayerSeed[]> = {
    ...REAL_SQUADS,
    ...EU_SQUADS,
    ...MARKET_LEAGUE_SQUADS,
  };
  const allRows = Object.entries(ALL_SQUADS).flatMap(([team, squad]) =>
    squad.map((seed) => ({ seed, team })),
  );
  const isJan1 = (seed: RealPlayerSeed): boolean => seed.birthdate.endsWith("-01-01");

  it("1월 1일생 시드는 전부 birthdateApprox를 명시한다", () => {
    const violations = allRows
      .filter((r) => isJan1(r.seed) && r.seed.birthdateApprox === undefined)
      .map((r) => `${r.seed.nameKo}(${r.seed.nameEn}) ${r.team} — ${r.seed.birthdate}`);

    expect(violations).toEqual([]);
  });

  // 날짜를 바로잡고 표식만 남기면 자리표시자가 아닌 값이 자리표시자로 읽힌다.
  it("1월 1일이 아닌 시드에는 birthdateApprox가 남아 있지 않다", () => {
    const violations = allRows
      .filter((r) => !isJan1(r.seed) && r.seed.birthdateApprox !== undefined)
      .map((r) => `${r.seed.nameKo}(${r.seed.nameEn}) ${r.team} — ${r.seed.birthdate}`);

    expect(violations).toEqual([]);
  });
});
