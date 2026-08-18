import { describe, expect, it } from "vitest";
import { ageOf, weightSlotOf } from "@story-fm/domain";
import { CATALOG_AGE_REF, deriveAxes, derivePositions, overallFor } from "@story-fm/engine";
import { REAL_SQUADS, type RealPlayerSeed } from "../src/data/epl-players";
import { INJURY_HISTORY } from "../src/data/injury-history";
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
 * 실패다. 3의 `potential`은 **판단값**이라, 걸린 선수가 오조인인지 "6축만 갈고
 * 잠재력을 다시 재지 않았는지"를 이 축이 가르지 못한다 — 3의 위반은 조인 실패의
 * 증거가 아니라 **확인할 후보 목록**이다. 가를 필요도 없다: 둘 다 갱신이 남긴
 * 오류이고, 어느 쪽이든 고쳐야 한다.
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
 * 주급이 있는 EPL 선수 + 주급·OVR 백분위 괴리. **이 축만 모집단이 좁다** — 주급은
 * `epl-players.ts`에만 있어서 5대 리그 나머지는 이 축이 없다. 나머지 셋은 전원을 본다.
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
 * 나이별 `potential − OVR` 상한 — **`docs/data/player.md` §6.5 대역 표의 상한 행
 * 그대로다.** 어린 선수는 간격이 큰 게 정상이고 전성기 선수는 아니다. 곡선의 출처는
 * `026710e` 실측 이전 시드의 나이별 최대 간격이다: 그 시절 `potential`과 종합은 같은
 * 판단값에서 나왔으므로, 그 곡선이 시드를 쓴 사람이 쥐고 있던 밴드다. 거기에 **+3**이
 * 얹혀 있다 — 종합이 축 가중 평균이 되며 상위권이 그만큼 내려갔는데 `potential`은
 * 축의 눈금에 그대로 남아, 같은 시드의 간격이 통째로 벌어졌다 (player.md §4·§6.5).
 *
 * ⚠️ **나이를 뭉치지 않는다.** 20~22를 한 밴드로 묶으면 20세의 22가 22세의 14를 가려
 * 과대평가가 숨는다. 문서의 표와 한 칸씩 대조할 수 있어야 하므로 나이별로 적는다.
 */
const POTENTIAL_GAP_MAX: Readonly<Record<number, number>> = {
  16: 31,
  17: 26,
  18: 28,
  19: 29,
  20: 25,
  21: 22,
  22: 17,
  23: 16,
  24: 16,
  25: 13,
  26: 14,
  27: 12,
  28: 10,
  29: 11,
  30: 11,
};
/** 표 밖의 양 끝 — 시드에 만 15세 이하는 없고, 31세부터는 곡선이 평평하다 */
const GAP_MAX_UNDER_16 = 31;
const GAP_MAX_OVER_30 = 9;

/**
 * 대역 상한에 얹는 여유. 임계 = `상한 + 3`.
 *
 * **여유가 없으면 이 탐지기는 서지 못한다.** 다른 셋과 달리 상한이 관측된 정상 띠의
 * 천장이 아니라 시드를 접어 둔 경계라, **255명이 상한에 정확히 붙어 있다.** 여유 0에
 * 걸면 탐지기가 자기가 만든 경계에 서서 어떤 변화에도 발화한다.
 *
 * 3인 근거: 판정된 오조인은 6축 평균이 8 이상 떨어진 선수들이었다. 파생 OVR을 4 이상
 * 끌어내리는 갱신이면 걸리고, 그보다 작은 흔들림은 지나간다.
 */
const POTENTIAL_GAP_MARGIN = 3;

const potentialGapLimit = (age: number): number =>
  (age <= 15 ? GAP_MAX_UNDER_16 : (POTENTIAL_GAP_MAX[age] ?? GAP_MAX_OVER_30)) +
  POTENTIAL_GAP_MARGIN;

/**
 * **잠재력 축은 단독으로 선다** — 5대 리그 전원을 본다.
 *
 * 이 축을 주급 괴리와의 AND로 좁혀 둘 수밖에 없던 시기가 있었다. `potential`이 옛
 * 6축에 맞춰 매긴 값이라 EA 실측이 들어와 OVR이 정당하게 내려간 선수가 수백 명
 * 걸렸고, 그 대가로 주급이 없는 EU 2,192명이 통째로 사각지대였다. 시드를 나이 대역
 * 안으로 접고 나서 그 오탐의 원인이 없어졌다 — **AND 없이도 위반은 0명이다.**
 *
 * ⚠️ **다시 좁히기 전에 시드가 대역 밖으로 나갔는지부터 본다.** 이 축이 시끄러워지는
 * 정상적인 이유는 하나뿐이다: 6축을 갈고 `potential`을 다시 재지 않은 갱신
 * (`docs/data/sources.md` §4.1의 마지막 단계). 그건 탐지기가 잡아야 할 것이지
 * 임계를 풀 이유가 아니다.
 */
describe("잠재력 − OVR 간격 — 갱신이 6축만 갈고 잠재력을 그대로 두었다", () => {
  it("나이 대역 상한을 넘는 잠재력 간격을 가진 선수는 없다", () => {
    const violations = [...rowsOf(REAL_SQUADS), ...rowsOf(EU_SQUADS)]
      .map((r) => {
        const age = ageOf(r.seed.birthdate, CATALOG_AGE_REF);
        return { ...r, age, potGap: r.seed.potential - r.ovr, potLimit: potentialGapLimit(age) };
      })
      .filter((v) => v.potGap > v.potLimit)
      .sort((a, b) => b.potGap - b.potLimit - (a.potGap - a.potLimit))
      .map(
        (v) =>
          `${v.seed.nameKo}(${v.seed.nameEn}) ${v.team} ${v.seed.position} 만 ${v.age}세 — ` +
          `잠재력 간격 ${v.potGap} (잠재력 ${v.seed.potential} - OVR ${v.ovr}, 이 나이 임계 ${v.potLimit}) ` +
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

/**
 * 소속 불변식 — **한 선수는 한 구단에만 있고, 한 구단 안에서 번호가 겹치지 않는다**
 * (sources.md §4.1.1).
 *
 * 선수를 구단 사이로 옮기는 갱신이 조용히 깨는 자리다. 중복은 두 구단의 스쿼드
 * 깊이·급여 총액·라인업 후보를 함께 어긋내고, 겹친 번호는 `ensureSquadNumbers`가
 * 손대지 않는다 — 그 함수는 **빈 번호만** 채우므로 시드가 들여온 충돌은 그대로
 * 게임에 실린다.
 *
 * ⚠️ **이름만으로 중복을 잡을 수는 없다.** 생일이 19일 떨어진 동명이인이 실재한다
 * (알렉스 히메네스 2005-05-08 · 2005-04-19). 그래서 키는 (이름 + 생년월일)이고,
 * 생일까지 어긋난 중복은 이 축으로 잡히지 않는다 — 그쪽은 위키 구단 문서와의
 * 대조만이 가른다.
 */
describe("소속 불변식 — 한 선수 한 구단, 한 구단 안에서 번호는 하나", () => {
  const ALL_SQUADS: Record<string, readonly RealPlayerSeed[]> = {
    ...REAL_SQUADS,
    ...EU_SQUADS,
    ...MARKET_LEAGUE_SQUADS,
  };

  it("같은 (이름 + 생년월일)이 두 구단에 실려 있지 않다", () => {
    const teamsOf = new Map<string, string[]>();
    for (const [team, squad] of Object.entries(ALL_SQUADS)) {
      for (const seed of squad) {
        const key = `${seed.nameEn}|${seed.birthdate}`;
        teamsOf.set(key, [...(teamsOf.get(key) ?? []), team]);
      }
    }
    const violations = [...teamsOf]
      .filter(([, teams]) => new Set(teams).size > 1)
      .map(([key, teams]) => `${key} — ${teams.join(", ")}`);

    expect(violations).toEqual([]);
  });

  it("한 구단이 같은 등번호를 두 명에게 주지 않는다", () => {
    const violations = Object.entries(ALL_SQUADS).flatMap(([team, squad]) => {
      const namesOf = new Map<number, string[]>();
      for (const seed of squad) {
        if (seed.squadNumber === undefined) continue;
        namesOf.set(seed.squadNumber, [...(namesOf.get(seed.squadNumber) ?? []), seed.nameEn]);
      }
      return [...namesOf]
        .filter(([, names]) => names.length > 1)
        .map(([number, names]) => `${team} #${number} — ${names.join(", ")}`);
    });

    expect(violations).toEqual([]);
  });
});

/**
 * 부상 이력 조인 — **표의 키가 전부 시드에 닿는가.**
 *
 * `INJURY_HISTORY`는 `RealPlayerSeed.nameEn`으로 잇는다(`injury.ts`
 * `seedInjuryHistory`). 이름 표기가 바뀌거나 그 선수가 시드에서 빠지면 그 이력은
 * **조용히 죽는다** — 부상 행도 초기 성향도 생기지 않고, 화면엔 아무 일도 안 난
 * 것처럼 보인다. 오타 하나로 리스 제임스가 철인이 되는 자리다.
 *
 * 반대 방향(시드에 있는데 이력이 없다)은 위반이 아니다 — 조사가 닿은 선수만
 * 적는 표다 (injury-history.ts 상단).
 */
describe("부상 이력 조인 — 이력의 이름이 시드에 없다", () => {
  const ALL_SQUADS: Record<string, readonly RealPlayerSeed[]> = {
    ...REAL_SQUADS,
    ...EU_SQUADS,
    ...MARKET_LEAGUE_SQUADS,
  };

  it("INJURY_HISTORY의 모든 키가 실선수 시드의 nameEn에 있다", () => {
    const seeded = new Set(
      Object.values(ALL_SQUADS).flatMap((squad) => squad.map((s) => s.nameEn)),
    );
    const orphans = Object.keys(INJURY_HISTORY).filter((name) => !seeded.has(name));

    expect(orphans).toEqual([]);
  });
});
