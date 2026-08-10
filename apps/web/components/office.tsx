"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { OfficeViews } from "@story-fm/engine";
import {
  AXIS_GROUPS,
  AXIS_GROUP_KO,
  AXIS_KO,
  CHIP_SIZE,
  anchorOf,
  conditionLabel,
  clampToBoard,
  isNaturalAt,
  positionAtPoint,
  footLabel,
  physiqueLabel,
  MANAGER_ATTRIBUTES,
  MANAGER_ATTRIBUTE_KO,
  positionGroupOf,
  positionProficiency,
  adaptationOf,
  defaultRoleOf,
  rolesFor,
  separateBoardPoints,
  shapeOf,
  snapToBoard,
  type BoardPoint,
} from "@story-fm/domain";
import type { GamePayload } from "@/lib/store";
import { slotOverallOf } from "@/lib/slot-overall";
import { IconBoard, IconChevron } from "@/components/icons";

const money = (n: number) => `£${(n / 1e6).toFixed(1)}M`;

/** 전술판 슬롯 하나 — 좌표가 원본, 포지션 코드는 `positionAtPoint`의 파생 (domain tactics.ts) */
type BoardSlot = { playerId: string; point: BoardPoint } | null;

/** 칩에 쓰는 이름 — 성(마지막 어절)만. 좁은 칩에서 "카이 하베…"보다 "하베르츠"가 읽힌다 */
const chipName = (name: string) => name.trim().split(/\s+/).at(-1) ?? name;

/**
 * 감독 능력치 5축 — **오각형**.
 *
 * 막대 다섯 줄로는 "이 감독이 어느 쪽으로 치우친 사람인가"가 읽히지 않는다.
 * 값을 하나씩 비교하게 만들 뿐이라 다섯 번 눈이 움직인다. 오각형은 **모양 하나로**
 * 성향을 말한다 — 넓적하면 만능형, 한쪽으로 뾰족하면 전문가형.
 *
 * 눈금(0·25·50·75·100)을 옅은 오각형으로 깔아 절대값을 읽을 수 있게 두고,
 * 숫자는 축 이름 옆에 그대로 적는다 — 도형은 인상을, 숫자는 사실을 맡는다.
 */
const RADAR_R = 74;
/**
 * 꼭짓점 바깥 여백 — **라벨이 들어갈 자리**다. 40으로 뒀더니 오른쪽 `전술 61`이
 * viewBox를 넘어 카드 밖으로 잘렸다. 가장 긴 라벨(이름 두 자 + 숫자 세 자)이
 * 축 끝에서 바깥으로 뻗는 길이만큼 잡는다.
 */
const RADAR_PAD = 60;
const RADAR_SIZE = (RADAR_R + RADAR_PAD) * 2;

/** 축 i의 좌표 — 12시에서 시작해 시계 방향 (꼭짓점이 위로 오게) */
function radarPoint(i: number, count: number, radius: number): [number, number] {
  const angle = (Math.PI * 2 * i) / count - Math.PI / 2;
  const c = RADAR_R + RADAR_PAD;
  return [c + Math.cos(angle) * radius, c + Math.sin(angle) * radius];
}
const radarPath = (radius: number, count: number) =>
  Array.from({ length: count }, (_, i) => radarPoint(i, count, radius).join(","))
    .map((p, i) => `${i === 0 ? "M" : "L"}${p}`)
    .join(" ") + " Z";

function ManagerRadar({ attributes }: { attributes: Record<string, number | undefined> }) {
  const axes = MANAGER_ATTRIBUTES;
  const values = axes.map((a) => Math.max(0, Math.min(100, attributes[a] ?? 0)));
  const shape =
    values
      .map((v, i) => radarPoint(i, axes.length, (v / 100) * RADAR_R).join(","))
      .map((p, i) => `${i === 0 ? "M" : "L"}${p}`)
      .join(" ") + " Z";
  return (
    <div className="mgr-radar">
      <svg viewBox={`0 0 ${RADAR_SIZE} ${RADAR_SIZE}`} role="img" aria-label="감독 능력치 오각형">
        {[25, 50, 75, 100].map((pct) => (
          <path key={pct} className="ring" d={radarPath((pct / 100) * RADAR_R, axes.length)} />
        ))}
        {axes.map((a, i) => {
          const [x, y] = radarPoint(i, axes.length, RADAR_R);
          return (
            <line
              key={a}
              className="spoke"
              x1={RADAR_R + RADAR_PAD}
              y1={RADAR_R + RADAR_PAD}
              x2={x}
              y2={y}
            />
          );
        })}
        <path className="area" d={shape} />
        {values.map((v, i) => {
          const [x, y] = radarPoint(i, axes.length, (v / 100) * RADAR_R);
          return <circle key={axes[i]} className="dot" cx={x} cy={y} r={2.6} />;
        })}
        {axes.map((a, i) => {
          // 라벨은 꼭짓점 바깥 — 위/아래 꼭짓점만 가운데 정렬, 좌우는 바깥으로 민다
          const [x, y] = radarPoint(i, axes.length, RADAR_R + 17);
          const c = RADAR_R + RADAR_PAD;
          const anchor = Math.abs(x - c) < 4 ? "middle" : x > c ? "start" : "end";
          return (
            <text key={a} className="axis-label" x={x} y={y} textAnchor={anchor}>
              <tspan>{MANAGER_ATTRIBUTE_KO[a]}</tspan>
              <tspan className="axis-value" dx="5">
                {values[i]}
              </tspan>
            </text>
          );
        })}
      </svg>
    </div>
  );
}

// ── 스쿼드 (전술판 · 전술 · 명단) ─────────────────────────
type SquadRow = OfficeViews["squad"]["players"][number];
type TacticsView = OfficeViews["squad"]["tactics"];
type Selection = { kind: "slot"; index: number } | { kind: "bench"; id: string } | null;

/** 상세에서 보여줄 축 묶음 순서 — 라벨·구성은 domain(AXIS_GROUPS)이 단일 소스 */
const AXIS_GROUP_ORDER = ["physical", "technical", "mental", "goalkeeping"] as const;

/**
 * 전술 5축 — 값 1~5의 뜻을 말로 보여준다. 슬라이더 숫자만 두면 "3이 뭔데?"가 된다.
 * 라벨 문구는 GM이 이해하는 축(match-sim §1)과 같은 뜻이어야 한다.
 *
 * `brief`는 접힌 줄에 값과 **함께** 세우는 이름이다. "맹렬히"만 적혀 있으면 그게
 * 압박인지 템포인지 알 수 없어 툴팁을 하나씩 짚어야 했다. 축 이름을 그대로 쓰면
 * 여섯 쌍이 한 줄을 넘기므로 여기서만 짧게 줄인다.
 */
const TACTIC_AXES = [
  {
    key: "mentality" as const,
    label: "멘탈리티",
    brief: "멘탈",
    values: ["매우 수비적", "수비적", "균형", "공격적", "매우 공격적"],
  },
  {
    key: "defensiveLine" as const,
    label: "수비 라인",
    brief: "라인",
    values: ["매우 낮게", "낮게", "보통", "높게", "매우 높게"],
  },
  {
    key: "pressing" as const,
    label: "압박",
    brief: "압박",
    values: ["최소", "약하게", "보통", "강하게", "맹렬히"],
  },
  {
    key: "tempo" as const,
    label: "템포",
    brief: "템포",
    values: ["매우 느리게", "느리게", "보통", "빠르게", "매우 빠르게"],
  },
  {
    key: "width" as const,
    label: "공격 폭",
    brief: "폭",
    values: ["매우 좁게", "좁게", "보통", "넓게", "매우 넓게"],
  },
  {
    key: "passStyle" as const,
    label: "패스",
    brief: "패스",
    values: ["매우 짧게", "짧게", "혼합", "길게", "매우 길게"],
  },
];

/**
 * ── 전술을 판 위에 긋는다 ──────────────────────────────────
 *
 * 낱말로만 적힌 전술은 "높게"가 얼마나 높은지, "넓게"가 어디까지인지를 감독이
 * 머릿속에서 판으로 옮겨야 한다. 값이 곧 선의 자리가 되면 그 번역이 사라지고,
 * 눈금을 만질 때 선이 따라 움직이니 무엇을 바꾸는 중인지도 보인다.
 *
 * 좌표는 판 기준 %(위가 상대 골문). 이 눈금은 **화면의 감각**일 뿐 시뮬레이션
 * 수치가 아니다 — 경기 판정은 코어가 전력 패킷으로 따로 한다 (match-sim.md).
 */
/**
 * 눈금은 **기본 배치의 칩 자리에 맞춰** 잡았다 — 보통(3)일 때 수비 라인은 센터백
 * 높이(75%)에, 폭은 윙어 자리(14%/86%)에 선다. 선이 칩과 어긋나 있으면 그림이
 * 배치를 설명하지 못하고 따로 도는 장식이 된다.
 */
const DEF_LINE_TOP = (v: number) => 87 - (v - 1) * 6;
const PRESS_LINE_TOP = (v: number) => 70 - (v - 1) * 11;
const WIDTH_INSET = (v: number) => 24 - (v - 1) * 5;

/**
 * 판 위의 전술 선 — 수비 라인 · 압박 시작선 · 공격 폭.
 *
 * 여섯 축 중 셋만 긋는다. 이 셋은 **자리를 뜻하는 축**이라 판 위에 그대로 앉지만,
 * 템포·패스는 공간이 아니라 속도와 거리라 선으로 그으면 뜻이 어긋난다. 멘탈리티는
 * 칩이 어디 서 있는지가 이미 말한다.
 *
 * 압박선은 늘 수비 라인보다 위다 — 압박은 그 앞에서 시작하는 것이라, 눈금이
 * 뒤집혀도(낮은 압박 + 높은 라인) 선이 교차하면 그림이 거짓말이 된다.
 */
export function PitchTactics({
  tactics,
}: {
  /** 자리를 뜻하는 세 축만 받는다 — 우리 판(`TacticsView`)과 상대 판이 같이 쓴다 */
  tactics: { defensiveLine: number; pressing: number; width: number };
}) {
  const def = DEF_LINE_TOP(tactics.defensiveLine);
  const press = Math.min(PRESS_LINE_TOP(tactics.pressing), def - 6);
  const inset = WIDTH_INSET(tactics.width);
  return (
    <div className="pitch-tactics" aria-hidden>
      <span className="tac-width" style={{ left: `${inset}%`, right: `${inset}%` }} />
      <span className="tac-block" style={{ top: `${def}%` }} />
      <span className="tac-line press" style={{ top: `${press}%` }} />
      <span className="tac-line def" style={{ top: `${def}%` }} />
    </div>
  );
}

/**
 * 이 선수가 그 자리에서 갖는 적응도(표시용) — 규칙은 domain의 `positionProficiency`
 * 하나뿐이다. 엔진(`proficiencyAt`)도 같은 함수를 부르므로 화면 값과 서버 값이
 * 갈리지 않는다 (복제하면 조용히 어긋난다).
 */
/**
 * 그 자리의 포지션 적응도. 보유 목록에 없는 자리도 도메인이 결정적으로 값을 내므로
 * "정확/추정"을 나눌 이유가 없다 — 어느 쪽이든 같은 규칙으로 나온 같은 값이다.
 */
function fitAt(p: SquadRow, code: string): { value: number } {
  return { value: positionProficiency(p.positions, code, p.foot) };
}

/**
 * 적응도 게이지의 색 — **10 단위**로 조금씩 옮겨 간다.
 *
 * 3단계(good/ok/bad)는 79와 80이 전혀 다른 색이 되고 60과 79는 같은 색이 됐다.
 * 눈금을 잘게 두면 명단을 훑을 때 **줄이 아니라 기울기**가 먼저 읽힌다 —
 * 어디가 붉고 어디가 푸른지가 표를 읽지 않아도 보인다.
 */
const fitClass = (v: number) => `f${Math.min(9, Math.max(0, Math.floor(v / 10)))}`;

/**
 * **이 숫자를 얼마나 믿어도 되는가** — OVR 옆의 `±N`.
 *
 * 예전엔 적응 중인 영입에만 `?` 하나가 붙었다. "정확하지 않다"는 사실은 전했지만
 * **얼마나** 정확하지 않은지는 툴팁을 열어야 알 수 있었고, 갓 데려온 선수와 거의
 * 다 적응한 선수가 같은 표식을 달고 있었다. `±3`과 `±1`은 감독이 그 숫자를 믿고
 * 라인업을 짤지 말지를 가른다.
 *
 * 오차가 0이면 아무것도 그리지 않는다 — 우리 선수 대부분이 그렇고, 전원에게
 * `±0`이 붙으면 표식이 정보가 아니라 배경이 된다.
 */
function Margin({ observation }: { observation: SquadRow["observation"] }) {
  if (observation.margin <= 0) return null;
  return (
    <span className="est" title={`이 숫자는 ±${observation.margin} 안에서만 정확합니다`}>
      ±{observation.margin}
    </span>
  );
}

/** OVR 칸의 툴팁 — 전술판 칩과 **같은 줄**을 쓴다 (같은 숫자를 다르게 설명하지 않는다) */
function ovrTitle(p: SquadRow): string | undefined {
  return (
    [
      p.slotOverall !== null
        ? `${p.assignedPosition} 자리 기준 ${p.slotOverall} — 경기에서 쓰이는 값입니다`
        : null,
      `주 포지션(${p.position}) 기준 ${p.overall}`,
      p.observation.margin > 0
        ? `${p.observation.label} — 오차 ±${p.observation.margin}` +
          (p.settling !== null ? ` (적응 ${p.settling}%, 진행할수록 좁아집니다)` : "")
        : null,
    ]
      .filter(Boolean)
      .join("\n") || undefined
  );
}

/**
 * 적응도 게이지 — **숫자가 아니라 채워진 원**.
 *
 * 적응도는 정확한 값을 읽을 일이 거의 없다. 감독이 알고 싶은 건 "이 자리를 아는
 * 선수인가"이고, 그 판단에 필요한 건 74와 76의 차이가 아니라 **얼마나 찼는가**다.
 * 숫자로 두면 명단·전술판·상세에 두 자리 수가 흩어져 OVR·나이·평점과 뒤섞이고,
 * 정작 눈으로 세로 비교가 안 된다.
 *
 * 원 하나를 `stroke-dasharray`로 잘라 그린다 — 12시에서 시계 방향. 색은 폼 화살표와
 * 색은 10 단위 계단(`fitClass`)이고, 정확한 값은 툴팁이 갖는다.
 */
function FitGauge({
  value,
  label = "적응도",
}: {
  value: number;
  /** 툴팁 앞머리 */
  label?: string;
}) {
  const r = 6;
  const circumference = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(100, value)) / 100) * circumference;
  /**
   * 보유 목록에 없는 자리도 `positionProficiency`가 결정적으로 값을 낸다 —
   * 추정도 안개도 아니라서 "(추정)"이나 물음표를 붙이지 않는다.
   */
  const title = `${label} ${value}`;
  return (
    <span className={`fit-gauge ${fitClass(value)}`} title={title} role="img" aria-label={title}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle className="fg-track" cx="8" cy="8" r={r} />
        <circle
          className="fg-fill"
          cx="8"
          cy="8"
          r={r}
          strokeDasharray={`${filled} ${circumference}`}
        />
      </svg>
    </span>
  );
}

/**
 * 폼 화살표 — **엔진이 준 라벨을 그대로 쓴다.**
 *
 * 폼은 소수(−3.0~3.0)이고 경계는 `engine/form.ts`가 정한다(±1 · ±2.2). UI가
 * 따로 7단계 라벨을 갖고 있으면 같은 값이 화면과 채팅에서 달라 보인다.
 */
/**
 * 폼 화살표 — **도형 하나를 각도로 돌린다.**
 *
 * 유니코드 화살표(`↑↗→↘↓`)를 쓰던 때는 일곱 단계로 끊겼고, 이중 화살표(`⇑⇓`)만
 * 폴백 폰트로 빠져 가장 강조돼야 할 절정·바닥이 되레 가늘게 보였다. 각도는
 * 엔진이 준다(`formAngle`) — 절정(+1)에서만 12시를 보고, 평소는 3시, 바닥은 6시다.
 */
/**
 * 폼 → **색을 섞는 양**. 그대로 |폼|을 쓰면 눈에 안 보인다.
 *
 * 폼은 대부분 0 근처에 모여 있는데(±0.3 안이 흔하다) 선형으로 섞으면 그 구간이
 * 통째로 회색에 머문다 — 0.15 차이가 화면에서 안 보였다. 제곱근에 가까운 곡선을
 * 씌워 **작은 값에서 더 크게 움직이게** 한다: 0.15 → 35%, 0.3 → 51%, 0.6 → 74%.
 * 단조증가라 순서는 그대로고, 절정·바닥(±1)에서만 색이 다 찬다.
 */
function formMix(form: number): number {
  return Math.min(1, Math.abs(form)) ** 0.55;
}

function FormArrow({ p }: { p: Pick<SquadRow, "form" | "formLabel" | "formAngle" | "formTone"> }) {
  const title = `${p.formLabel} (${p.form > 0 ? "+" : ""}${p.form.toFixed(2)})`;
  return (
    <span
      /**
       * 색은 **끊기지 않고 폼을 따라간다.** `formTone`은 세 단(up·flat·down)이라
       * 그걸로 칠하면 +0.19와 +0.21이 회색과 초록으로 갈린다 — 각도는 연속인데
       * 색만 계단이면 같은 값을 두 방식으로 말하게 된다.
       *
       * 뜨거운 쪽(초록/빨강)은 **부호**가 고르고, 섞는 양은 `--f`(=|폼|)가 정한다.
       * 보간은 CSS `color-mix`가 하므로 **팔레트 토큰이 그대로 원본**이다 —
       * 여기에 색값을 복사해 두면 테마를 바꿀 때 이 화살표만 옛 색으로 남는다.
       */
      className={`form-arrow ${p.formTone} ${p.form >= 0 ? "pos" : "neg"}`}
      style={{ "--f": formMix(p.form) } as CSSProperties}
      title={title}
      aria-label={`폼 ${title}`}
      data-testid="form-arrow"
      data-angle={p.formAngle}
    >
      <svg
        viewBox="0 0 24 24"
        style={{ transform: `rotate(${p.formAngle}deg)` }}
        aria-hidden="true"
      >
        <path d="M12 21 V5 M12 3.5 L5.5 11 M12 3.5 L18.5 11" />
      </svg>
    </span>
  );
}

/**
 * 최근 경기 평점 추이 — **폼이 어디서 왔는지**를 보여준다.
 *
 * 폼 숫자 하나로는 "오르는 중"과 "식는 중"을 구분할 수 없다. 왼쪽이 오래된
 * 경기고 오른쪽이 최근이라, 눈으로 훑으면 방향이 읽힌다.
 */
function RatingTrend({ ratings }: { ratings: number[] }) {
  if (ratings.length === 0) return <span className="rt-empty">기록 없음</span>;
  return (
    <span className="rating-trend" data-testid="rating-trend">
      {ratings.map((r, i) => (
        <span
          className={`rt-dot ${r >= 7.5 ? "hot" : r >= 6.5 ? "good" : r >= 5.5 ? "flat" : "cold"}`}
          key={i}
          title={`${i + 1}번째 전 경기 평점 ${r.toFixed(1)}`}
        >
          {r.toFixed(1)}
        </span>
      ))}
    </span>
  );
}

/** 상태 막대 — 사기·피로를 눈으로 표현한다 (피로는 높을수록 나쁘다) */
function StatBar({
  value,
  max = 100,
  kind,
}: {
  value: number;
  max?: number;
  kind: "form" | "condition";
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  // 체력은 낮을수록 나쁘다 — 색으로도 알린다
  const level = kind === "condition" ? (value < 35 ? " bad" : value < 50 ? " low" : "") : "";
  return (
    <span className={`stat-bar ${kind}${level}`} title={`${value}`}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

/** 선수 상태 배지 묶음 — 표·상세·전술판이 같은 규칙을 쓴다 */
/**
 * 상태 표식 — **자격 표식(HG·U21)과 같은 물건이다.**
 *
 * 예전엔 `.badge`(11px·테두리·둥근 모서리)와 `.tag`(9px·배경만)가 한 칸 안에
 * 나란히 서서, 같은 줄의 표식들이 서로 다른 물건처럼 보였다. 크기·모양은
 * `.tag` 하나로 맞추고 **갈리는 것은 톤뿐**이다: 자격은 각주처럼 가라앉히고,
 * 감독이 지금 손을 써야 하는 상태(부상·정지·불만)는 색을 살려 눈에 남긴다.
 */
function StatusBadges({ p }: { p: SquadRow }) {
  return (
    <>
      {p.injury && (
        <span
          className="tag st alert"
          title={`${p.injury.bodyPart} · ${p.injury.severity} · 복귀 예상 ${p.injury.expectedReturn}`}
        >
          부상
        </span>
      )}
      {p.suspended > 0 && <span className="tag st alert">정지 {p.suspended}</span>}
      {p.hasIssue && <span className="tag st alert">불만</span>}
      {p.transferListed !== null && (
        <span className="tag st note" title={`호가 ${money(p.transferListed)}`}>
          이적 리스트
        </span>
      )}
    </>
  );
}

/**
 * 전술 패널 — **접히면 지금 값, 펼치면 눈금.**
 *
 * 판을 보는 동안 필요한 건 "지금 어떻게 서 있나"까지고, 그건 여섯 낱말로 다 적힌다.
 * 눈금 서른 칸은 고칠 때만 쓰는 것이라 늘 펼쳐 둘 이유가 없다 — 접혀 있는 동안
 * 그 높이(229px)는 전술판이 갖는다.
 *
 * 읽기 모드(경기 중 잠김)에서도 접힌다. 펼쳤을 때 눈금 대신 게이지가 나올 뿐이다.
 */
function TacticsPanel({
  tactics,
  editing,
  onChange,
}: {
  tactics: TacticsView;
  editing: boolean;
  onChange: (patch: Partial<TacticsView>) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tactics-panel${open ? " open" : ""}`} data-testid="tactics-panel">
      {/* 팀 총합 적응도는 두지 않는다 — 그런 값은 없다. 적응도는 **선수마다** 다르고
          여기 있던 숫자는 선발 11인의 평균일 뿐이었다. 누가 이 전술을 아직 못 따라오는지는
          오른쪽 명단이 선수별로 말한다 */}
      <button
        className="tactics-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="tactics-toggle"
      >
        <b>전술</b>
        {/* 접혔을 때만 — 펼치면 축마다 같은 낱말이 옆에 서므로 두 번 적는 셈이 된다.
            값 앞에 축 이름을 붙인다: "맹렬히"만으로는 압박인지 템포인지 모른다 */}
        {!open && (
          <span className="tactics-brief">
            {TACTIC_AXES.map((axis) => (
              <span key={axis.key} title={axis.label}>
                <i>{axis.brief}</i>
                {axis.values[tactics[axis.key] - 1]}
              </span>
            ))}
          </span>
        )}
        <IconChevron size={13} />
      </button>
      {open && (
        <div className="tactics-grid">
          {TACTIC_AXES.map((axis) => {
            const value = tactics[axis.key];
            return (
              <div className="tactic-row" key={axis.key}>
                <span className="tactic-label">{axis.label}</span>
                {editing ? (
                  <div className="tactic-steps" role="group" aria-label={axis.label}>
                    {axis.values.map((label, i) => (
                      <button
                        key={label}
                        className={`tactic-step${value === i + 1 ? " on" : ""}`}
                        onClick={() => onChange({ [axis.key]: i + 1 } as Partial<TacticsView>)}
                        title={label}
                        data-testid={`tactic-${axis.key}-${i + 1}`}
                      >
                        {i + 1}
                      </button>
                    ))}
                    <span className="tactic-value">{axis.values[value - 1]}</span>
                  </div>
                ) : (
                  <span className="tactic-value read">
                    <span className="tactic-meter">
                      <span style={{ width: `${(value / 5) * 100}%` }} />
                    </span>
                    {axis.values[value - 1]}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 선택한 선수 상세 — 그 자리 적응도와 강점 5축 */
/**
 * 두 발 숙련도를 **발 아이콘 두 개**로 — 숫자 두 개보다 한눈에 읽힌다.
 * 진하기가 곧 등급이고(1~5), 더 잘 쓰는 발만 색이 붙는다. 정확한 숫자는 툴팁에.
 */
function FootMarks({ foot }: { foot: SquadRow["foot"] }) {
  /**
   * 배치는 **(왼 숫자)(왼발)(오른발)(오른 숫자)** — 숫자를 바깥으로 빼면 두 발이
   * 가운데서 마주 보게 되고, 아치가 서로를 향해 굽어 어느 쪽이 어느 발인지가
   * 글자 없이 읽힌다. 숫자를 발 오른쪽에 붙여 두었을 땐 두 아이콘이 같은 방향을
   * 보는 것처럼 보여 매번 헷갈렸다.
   */
  return (
    <span className="foot-marks" title={`${footLabel(foot)} (좌우 분화 자리의 적응도를 가른다)`}>
      <b className={`foot-num w${foot.left}`}>{foot.left}</b>
      {(["L", "R"] as const).map((side) => {
        const rating = side === "L" ? foot.left : foot.right;
        return (
          <span className="foot-pair" key={side}>
            <svg
              /* 색이 곧 등급이다 — 1(빨강) ~ 5(초록). 적응도 게이지와 같은 척도를 쓴다 */
              className={`foot-mark w${rating}`}
              viewBox="0 0 24 34"
              aria-hidden
            >
              {/**
               * 발자국 하나를 좌우 반전해 반대 발로 쓴다 — 엄지발가락과 아치가
               * 방향을 만든다.
               *
               * ⚠️ **원본 도형은 오른발이다.** 발가락이 큰 것(cx 6.6)부터 작은 것
               * (cx 20.8)으로 왼쪽→오른쪽으로 놓여 있는데, 위에서 내려다본 발은
               * 엄지가 **안쪽**을 향한다. 엄지가 왼쪽이면 그 안쪽은 왼편 —
               * 오른발이다. 예전엔 이걸 거꾸로 붙여 좌우가 서로 바뀌어 있었다.
               */}
              <g transform={side === "L" ? "translate(24,0) scale(-1,1)" : undefined}>
                <path d="M6.2 13.2c4.3-1.7 10-1.3 12.6 1.5 1.9 2 1.5 4.7.3 6.9-1 1.9-2.1 3.3-2.1 5.4 0 3.2-2.2 5.4-5.2 5.4s-5.3-2.2-5.3-5.4c0-2.1.8-3.5 1.3-5.1.6-1.9.3-3.3-1-4.5-1.4-1.2-1.6-3.5-.6-4.2z" />
                <ellipse cx="6.6" cy="7.2" rx="3.1" ry="3.6" />
                <ellipse cx="12.4" cy="5" rx="2.4" ry="2.7" />
                <ellipse cx="17" cy="5.6" rx="2.1" ry="2.4" />
                <ellipse cx="20.8" cy="7.6" rx="1.8" ry="2" />
              </g>
            </svg>
          </span>
        );
      })}
      <b className={`foot-num w${foot.right}`}>{foot.right}</b>
    </span>
  );
}

/** 칸 → CSS 클래스 이름 (행의 **왼쪽 선 색**이 칸을 말한다 — 배지 열을 없앤 자리) */
const TIER_SLUG: Record<Tier, string> = {
  선발: "start",
  벤치: "bench",
  예비: "squad",
  "2군": "reserve",
};

/**
 * 신원이 고정된 콜백 — 항상 **최신 클로저**를 부른다.
 *
 * 드래그 중에는 프레임마다 렌더가 도는데, 명단에 넘기는 콜백이 매번 새 함수면
 * `useMemo`가 무조건 깨져 43행을 다시 그린다. 그렇다고 의존성에서 빼면 옛 상태를
 * 붙든 콜백이 남는다. 참조로 최신 함수를 가리키면 둘 다 피할 수 있다.
 */
function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

/** 추정 폭을 말로 — 같은 "잠재력 78~86"도 확신의 정도가 다르다 */
function potentialHint(band: SquadRow["potential"]): string {
  if (!band) return "성장 여력을 짐작할 근거가 없습니다";
  const confidence =
    band.margin <= 3 ? "거의 확실" : band.margin <= 6 ? "대체로 신뢰" : "대강 짐작";
  return `추정 폭 ±${band.margin} — ${confidence}. 함께 뛴 경기가 쌓이면 좁아집니다`;
}

function PlayerDetail({
  p,
  slotCode,
  action,
  onRole,
  roleId,
}: {
  p: SquadRow;
  slotCode: string | null;
  /** 이 선수에게 거는 조작 — 1·2군 이동. **선수 옆에 둔다** */
  action?: React.ReactNode;
  /** 세부 역할 선택 (배치가 없거나 경기 중이면 없다) */
  onRole?: (roleId: string) => void;
  /**
   * 지금 켜져 있는 역할 — **아직 저장되지 않은 선택까지 포함한다.**
   * `p.roleId`만 보면 서버 왕복이 끝나기 전까지 방금 고른 역할이 안 켜져서,
   * 눌렀는데 아무 일도 일어나지 않은 것처럼 보인다.
   */
  roleId?: string | null;
}) {
  const axes = p as unknown as Record<string, number>;
  /**
   * 포지션 칩 — 보유 목록에 **지금 맡은 자리**를 합친다.
   *
   * 예전엔 목록에 없는 자리를 "추정치(?)"로 따로 붙였는데, 적응도는
   * `positionProficiency`가 결정적으로 내는 값이라 추정도 안개도 아니다.
   * 물음표는 "이 숫자를 믿지 말라"는 뜻인데 믿어도 되는 숫자였다.
   */
  /**
   * `known`은 **선수의 포지션 목록에 있는가**다. 지금 서 있는 자리가 목록에 없을 수
   * 있는데(감독이 생소한 자리에 세웠다) 그걸 "소화 가능"과 같은 색으로 두면
   * 무리한 배치라는 사실이 화면에서 사라진다.
   */
  const chips: Array<{ position: string; isNatural?: boolean; known: boolean }> =
    slotCode && !p.positions.some((x) => x.position === slotCode)
      ? [
          ...p.positions.map((x) => ({ ...x, known: true })),
          { position: slotCode, isNatural: false, known: false },
        ]
      : p.positions.map((x) => ({ ...x, known: true }));
  /**
   * **선호 포지션은 여럿이다.** 주 포지션 자체가 여럿일 수 있고(두 자리를 다 자기
   * 자리로 삼는 선수), 하나여도 좌우 분화(`CB`↔`LCB`↔`RCB`)는 같은 자리다.
   * 판정은 도메인의 `isNaturalAt` 하나가 갖는다 — 화면이 따로 계산하면 대표 자리
   * 하나만 보고 나머지 주 포지션을 "소화 가능"으로 밀어내기 쉽다.
   */
  const preferred = (code: string) => isNaturalAt(p, code);
  return (
    <div className="player-detail" data-testid="player-detail">
      {/* 지금 심경 한 줄 — 아래 숫자들이 왜 그런지 */}
      <p className="pd-mood" data-testid="player-mood">
        {p.mood}
      </p>

      {/* 상태 요약 — 이름·나이·OVR은 바로 위 행과 겹치므로 표에 없는 것만 앞에 둔다 */}
      {/* 상태 요약 — 박스로 쪼개지 않고 한 줄로 훑는다 */}
      <div className="pd-summary">
        {/**
         * **이 선수를 얼마나 아는가** — 아래 열다섯 숫자 전부에 걸리는 단서다.
         * 명단의 `±N`은 종합값 하나에 붙지만, 상세는 축을 펼쳐 놓은 자리라
         * "이 화면의 숫자들이 어느 정도 정확한가"를 먼저 밝혀야 한다.
         * 정확히 아는 선수(대부분)에게는 아무것도 그리지 않는다.
         */}
        {p.observation.margin > 0 && (
          <span title={`아래 능력치는 ±${p.observation.margin} 안에서만 정확합니다`}>
            정보{" "}
            <b>
              {p.observation.label} ±{p.observation.margin}
            </b>
          </span>
        )}
        {/* 잠재력은 숫자 하나가 아니라 **구간**이다 — 우리 선수도 단정할 수 없다.
            폭이 좁을수록 확신이 크고, 근거가 없으면 "미지" (scouting.ts §잠재력) */}
        <span title={potentialHint(p.potential)}>
          잠재력 <b>{p.potential ? `${p.potential.low}~${p.potential.high}` : "미지"}</b>
        </span>
        {/* 체력은 여기 두지 않는다 — 바로 위 명단 행에 바가 있고, 왜 그런지는
            맨 위 심경 한 줄이 말한다. 같은 값을 두 번 쓰면 상세가 표의 복사본이 된다 */}
        <span>
          폼{" "}
          <b>
            <FormArrow p={p} />
          </b>
        </span>
        {p.role !== "스쿼드" && (
          <span>
            적응{" "}
            <b>
              <FitGauge value={p.adaptation} />
            </b>
          </span>
        )}
        {/* **없는 기록은 적지 않는다.** 개막 전에는 스물일곱 명 전원이 "0경기 ·
            평점 — · 최근 기록 없음"이라, 빈 값을 자리 잡아 두면 줄이 그만큼 길어지고
            그 폭이 표의 열 계산에 얹혀 행을 펼칠 때마다 명단이 흔들렸다 */}
        {p.seasonApps > 0 && (
          <>
            <span>
              시즌{" "}
              <b>
                {p.seasonApps}경기 {p.seasonGoals}골 {p.seasonAssists}도움
              </b>
            </span>
            {typeof p.seasonRating === "number" && (
              <span>
                평점 <b>{p.seasonRating.toFixed(2)}</b>
              </span>
            )}
            {/* 폼의 시간 축 — 최근 경기가 오른쪽 */}
            {p.recentRatings.length > 0 && (
              <span className="pd-trend">
                최근 <RatingTrend ratings={p.recentRatings} />
              </span>
            )}
          </>
        )}
        {p.height !== null && p.weight !== null && (
          <span>
            체격 <b>{physiqueLabel(p.height, p.weight)}</b>
          </span>
        )}
        <FootMarks foot={p.foot} />
        {p.contractUntil && (
          <span>
            계약 <b>{p.contractUntil}</b>
          </span>
        )}
        <StatusBadges p={p} />
        {/* 조작은 대상 옆에 — 예전엔 명단 머리글에 있었다. 선수를 고를 때마다
            버튼이 나타나 정원 숫자를 가운데로 밀어내 머리글이 들썩였고, 무엇보다
            "누구를" 옮기는 버튼인지가 화면상 멀었다 */}
        {action && <span className="pd-action">{action}</span>}
      </div>

      <div className="pd-body">
        {/* 소화 포지션 — **선호와 가능만** 말한다. 자리마다 숫자를 세우면 "포지션
            적응도"라는 두 번째 축이 화면에 되살아난다. 어디에 세울지는 전술판의
            자리 전력과 명단의 적응도가 답한다 */}
        {/* 포지션·역할은 **능력치 위에 가로로** 눕는다. 오른쪽 좁은 열에 세워 두면
            역할 이름(인버티드 윙백)이 한 줄에 하나씩 쌓여 상세가 세로로 길어지고,
            그 열이 요구하는 폭이 표의 열 계산에까지 얹혀 행을 펼칠 때마다 명단이
            흔들렸다 */}
        <div className="pd-side">
          {/* 포지션은 **읽는 것**이고 역할은 **고르는 것**이다. 둘 다 알약 모양이던
              때는 눌러도 아무 일이 없는 포지션과 눌리는 역할이 똑같이 생겨서,
              감독이 CB를 눌러 보고 고장인 줄 알았다. 그래서 포지션은 테두리를
              벗겨 글자로 눕히고, 역할만 눌리는 물건의 생김새를 갖는다 */}
          <div className="pd-positions">
            <span className="pd-axis-group-name">포지션</span>
            <div className="pd-pos-list">
              {chips.map((x) => (
                <span
                  className={
                    `pd-pos` +
                    (x.position === slotCode ? " here" : "") +
                    (preferred(x.position) ? " natural" : x.known ? "" : " foreign")
                  }
                  key={x.position}
                  title={
                    (preferred(x.position)
                      ? "선호 포지션"
                      : x.known
                        ? "소화 가능"
                        : "익숙하지 않은 자리") +
                    (x.position === slotCode ? " · 지금 맡고 있는 자리" : "")
                  }
                >
                  {x.position}
                </span>
              ))}
            </div>
          </div>

          {/* 세부 역할 — **자리 위에 얹히는 축**이다. 같은 센터백이라도 노넌센스와
            볼 플레잉은 요구 역량이 다르고, 그 차이는 옆의 자리 전력이 곧바로 답한다.
            자리를 옮기면 목록이 통째로 바뀐다 (그 자리에 없는 역할은 고를 수 없다) */}
          {p.roleOptions.length > 1 && (
            <div className="pd-roles">
              <span className="pd-axis-group-name">역할</span>
              <div className="pd-role-list">
                {p.roleOptions.map((r) => (
                  <button
                    className={`pd-role${r.id === (roleId ?? p.roleId) ? " on" : ""}`}
                    key={r.id}
                    type="button"
                    title={r.desc}
                    disabled={!onRole}
                    onClick={(e) => {
                      // 상세는 행 안에 있다 — 막지 않으면 행 토글로 새어 나가 접힌다
                      e.stopPropagation();
                      onRole?.(r.id);
                    }}
                  >
                    {r.ko}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 능력치 15축 — 묶음별 한 줄, 값은 세로로 줄 맞춰 훑기 쉽게 */}
        <div className="pd-axis-groups">
          {AXIS_GROUP_ORDER.map((group) => (
            <div className="pd-axis-group" key={group}>
              <span className="pd-axis-group-name">{AXIS_GROUP_KO[group]}</span>
              <div className="pd-axes">
                {AXIS_GROUPS[group].map((a) => (
                  <span className="pd-axis" key={a}>
                    <span className="pd-axis-label">{AXIS_KO[a]}</span>
                    <b>{axes[a] ?? 0}</b>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {p.instruction && <p className="pd-foot">개인 지시 “{p.instruction}”</p>}
    </div>
  );
}

/**
 * 전술판 작업 사본 — 서버 배치에서 씨를 받아 로컬에서 조작하고, 손이 멈추면 자동 저장된다.
 * 편집 모드를 두지 않으므로 화면에 보이는 게 곧 편집 대상이다.
 */
interface BoardState {
  /** 자리 좌표 11개 — 포지션 코드는 `positionAtPoint`의 파생 */
  points: BoardPoint[];
  /** points[i]에 앉은 선수 */
  occupants: string[];
  /** 매치데이 벤치 지정 (나머지 1군 비선발은 예비) */
  bench: string[];
  /** 2군 — 라인업에 넣으려면 먼저 1군으로 올라와야 한다 */
  reserve: string[];
  /**
   * 감독이 고른 세부 역할 (playerId → roleId) — **서버와 다른 것만 저장에 실린다.**
   * 알약을 누를 때마다 API를 부르면 결정 하나에 요청이 여러 번 가고, 그때마다
   * 서버가 대가를 매길 빌미가 된다. 자동 저장이 정해진 값 하나를 보낸다.
   */
  roles: Record<string, string>;
  tactics: TacticsView;
}

/** 선수가 지금 속한 칸 — 화살표 교체는 이 둘을 맞바꾸는 일이다 */
type Tier = "선발" | "벤치" | "예비" | "2군";

const MAX_BENCH = 9;
/**
 * 조작이 멈춘 뒤 이만큼 지나면 저장한다 — 연속 드래그·슬라이더 연타·역할 선택을
 * 한 번으로 묶는다. **판을 짜는 일은 한 번의 조작으로 끝나지 않는다**: 자리를
 * 옮기고 역할을 고르고 벤치를 바꾸는 것이 하나의 결정이라, 창을 짧게 잡으면
 * 그 결정이 요청 여러 개로 쪼개진다. 저장을 놓칠 걱정은 없다 — 탭을 떠날 때
 * 예약된 저장을 흘려보낸다.
 */
const AUTOSAVE_MS = 3000;

/** 골키퍼 자리 수 — 정확히 1이 아니면 서버가 반려하므로 저장을 보류한다 */
const gkCountOf = (b: BoardState) => b.points.filter((p) => positionAtPoint(p) === "GK").length;

function lineupBody(
  b: BoardState,
  serverReserve: ReadonlySet<string>,
  serverRoles: ReadonlyMap<string, string>,
) {
  const { formation: _formation, ...axes } = b.tactics;
  void _formation;
  return {
    // v6: 선발은 {playerId, point}로 보낸다 — 서버가 좌표에서 포지션 코드를 다시 정한다
    starting: b.occupants.map((id, i) => ({
      playerId: id,
      point: b.points[i]!,
      position: positionAtPoint(b.points[i]!),
    })),
    bench: b.bench.map((id) => ({ playerId: id })),
    // 서버와 달라진 1·2군만 보낸다 (승격/강등은 라우트가 라인업과 한 요청으로 처리)
    squadLevels: [
      ...b.reserve
        .filter((id) => !serverReserve.has(id))
        .map((id) => ({ playerId: id, level: "reserve" as const })),
      ...[...serverReserve]
        .filter((id) => !b.reserve.includes(id))
        .map((id) => ({ playerId: id, level: "first" as const })),
    ],
    // 서버와 달라진 역할만 (자동 저장 한 번에 실린다 — 클릭마다 부르지 않는다)
    roles: Object.entries(b.roles)
      .filter(([id, role]) => serverRoles.get(id) !== role)
      .map(([playerId, role]) => ({ playerId, role })),
    // 포메이션(프리셋)은 보내지 않는다 — 전술판은 좌표만 바꾸고, 프리셋 교체는
    // 채팅의 set_tactics가 맡는다. 여기서 함께 보내면 매 저장이 전술 변경으로 읽힌다.
    tactics: axes,
  };
}

export function SquadView({
  game,
  onUpdate,
  onGoToChat,
  onOrder,
  boardOpen = true,
  onToggleBoard,
}: {
  game: GamePayload;
  onUpdate: (payload: GamePayload) => void;
  onGoToChat: () => void;
  /**
   * 전술판을 펼쳐 두었나 — **접으면 명단만 남는다.**
   *
   * 채팅 옆에 나란히 설 때 스쿼드가 통째로 들어오면 전술판이 200px로 눌려 아무
   * 쓸모가 없다. 감독이 채팅을 보며 곁눈질하는 것은 대개 **명단**이고(누가 부상인가,
   * 누가 폼이 좋은가), 판을 만지는 것은 그 자체로 하나의 일이다. 그래서 명단이 먼저
   * 오른쪽에 서고, 판을 펼치면 그때 화면을 통째로 쓴다.
   */
  boardOpen?: boolean;
  /** 펼침을 뒤집는다 — 주지 않으면 손잡이를 그리지 않는다(경기 중 전술판 탭) */
  onToggleBoard?: () => void;
  /**
   * 경기 중 조작 — **지시로 보낸다.**
   *
   * 경기 중 라인업·전술은 감독이 직접 저장하는 값이 아니다(교체 횟수·적응도
   * 대가·상대 반응이 걸려 있다). 그래서 전술판을 잠가 뒀는데, 그러면 감독이
   * 손에 쥔 판을 두고 채팅에 "손흥민 빼고 이강인"이라고 타이핑해야 했다.
   * 지금은 판에서 조작하면 그것이 **오퍼레이터 지시**가 되어 GM이 받는다 —
   * 시간 이동 손잡이와 같은 경로다.
   */
  onOrder?: (text: string) => void;
}) {
  const squad = game.views.squad;
  const players = squad.players;
  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const boardRef = useRef<HTMLDivElement>(null);
  /** 직접 저장할 수 있는가 — 경기 중에는 아니다 */
  const live = squad.editable;
  /** 경기 중이지만 **판으로 지시할 수는 있다** */
  const advisory = !live && onOrder !== undefined;
  /** 판을 만질 수 있는가 — 저장이든 지시든 */
  const usable = live || advisory;

  // 서버가 준 배치 — 이 값이 바뀌면(저장 완료·채팅 지시) 작업 사본을 다시 맞춘다
  const serverBoard = useMemo<BoardState>(() => {
    const starters = players.filter((p) => p.role === "선발");
    return {
      points: starters.map((p) => p.assignedPoint ?? anchorOf(p.assignedPosition ?? "CM")),
      occupants: starters.map((p) => p.id),
      bench: players.filter((p) => p.role === "벤치").map((p) => p.id),
      reserve: players.filter((p) => p.squadLevel === "reserve").map((p) => p.id),
      roles: Object.fromEntries(
        players.filter((p) => p.roleId !== null).map((p) => [p.id, p.roleId!]),
      ),
      tactics: squad.tactics,
    };
  }, [players, squad.tactics]);

  const [board, setBoard] = useState<BoardState>(serverBoard);
  // 끌고 있는 칩 — 놓기 전까지는 좌표를 건드리지 않고 미리보기만 옮긴다
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragPoint, setDragPoint] = useState<BoardPoint | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [squadFilter, setSquadFilter] = useState<"first" | "reserve">("first");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "role", desc: false });

  // 자동 저장 — rev는 로컬 변경 번호. 저장된 번호보다 앞서 있으면 아직 서버에 안 갔다
  const revRef = useRef(0);
  const savedRevRef = useRef(0);
  const pendingRef = useRef<BoardState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = revRef.current !== savedRevRef.current;
  /** 서버가 아는 2군 명단 — 저장할 때 "무엇이 달라졌는지"의 기준점 */
  const serverReserveRef = useRef<Set<string>>(new Set(serverBoard.reserve));
  serverReserveRef.current = new Set(serverBoard.reserve);
  const serverRolesRef = useRef<Map<string, string>>(new Map(Object.entries(serverBoard.roles)));
  serverRolesRef.current = new Map(Object.entries(serverBoard.roles));

  const post = useCallback(
    (snapshot: BoardState) =>
      fetch(`/api/games/${game.id}/lineup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          lineupBody(snapshot, serverReserveRef.current, serverRolesRef.current),
        ),
      }),
    [game.id],
  );

  const flush = useCallback(async () => {
    timerRef.current = null;
    const snapshot = pendingRef.current;
    // 골키퍼가 어긋난 배치는 서버가 반려한다 — 배너로 알리고 고칠 때까지 보류
    if (!snapshot || gkCountOf(snapshot) !== 1) return;
    pendingRef.current = null;
    const rev = revRef.current;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await post(snapshot);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "저장 실패");
      savedRevRef.current = rev;
      onUpdate(data);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [onUpdate, post]);

  /** 로컬 변경을 반영하고 저장을 예약한다 — 모든 전술판 조작이 이 문을 지난다 */
  /**
   * 편집 하나를 확정하고 자동 저장을 예약한다.
   *
   * 기본은 **선택 해제**다 — 배치를 바꾸면 고른 선수가 방금 다른 자리로 갔으므로
   * 그 선택을 들고 있을 이유가 없다. 다만 `keepSelection`을 주면 유지한다:
   * **세부 역할처럼 그 선수를 계속 보면서 고르는 조작**이 있다. 이걸 구분하지
   * 않던 때는 역할 알약을 누르는 순간 상세가 접혀서, 저장은 되는데 아무 일도
   * 일어나지 않은 것처럼 보였다.
   */
  const commit = useCallback(
    (next: BoardState, opts?: { keepSelection?: boolean }) => {
      revRef.current += 1;
      setBoard(next);
      if (opts?.keepSelection !== true) setSelection(null);
      pendingRef.current = next;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void flush(), AUTOSAVE_MS);
    },
    [flush],
  );

  // 서버 값이 바뀌면 작업 사본을 맞춘다. 저장 안 된 로컬 변경이 있으면 덮지 않는다
  // (드래그 중에 이전 저장의 응답이 도착하는 경우)
  useEffect(() => {
    if (revRef.current !== savedRevRef.current) return;
    setBoard(serverBoard);
  }, [serverBoard]);

  // 탭을 떠나 언마운트될 때 예약된 저장을 흘려보낸다 (마지막 조작을 잃지 않게)
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const snapshot = pendingRef.current;
      if (snapshot && gkCountOf(snapshot) === 1) void post(snapshot);
    },
    [post],
  );

  const boardSlots: BoardSlot[] = board.points.map((point, i) => {
    const playerId = board.occupants[i];
    return playerId ? { playerId, point } : null;
  });
  // 실제 배치에서 읽어낸 포메이션 숫자 (드래그 중에도 즉시 갱신된다)
  const shape = shapeOf(board.points);
  const onPitch = new Set(board.occupants);
  // 로컬 편집 기준 — 방금 올린 2군 선수가 저장 전까지 2군 탭에 남아 있으면 안 된다
  const localReserve = new Set(board.reserve);
  const benchPlayers = players.filter((p) => !localReserve.has(p.id) && !onPitch.has(p.id));
  const benchSet = new Set(board.bench.filter((id) => !onPitch.has(id)));
  const benchDesignated = benchPlayers.filter((p) => benchSet.has(p.id));
  // Set·배열은 매 렌더 새 객체라 메모 의존성으로 못 쓴다 — 내용으로 만든 키를 쓴다
  const localReserveKey = board.reserve.join(",");
  const benchKey = [...benchSet].join(",");
  /**
   * 지금 화면의 역할 — **아직 저장되지 않은 선택까지 포함한다.**
   *
   * 칩·명단·상세가 저마다 `p.roleId`(서버 값)를 보던 때는 알약을 눌러도 숫자가
   * 자동 저장 왕복(3초)이 끝난 뒤에야 따라왔다. 감독이 "이 역할로 바꾸면 얼마가
   * 되나"를 손으로 더듬어 볼 수가 없다.
   */
  const roleOf = (p: SquadRow): string | undefined => board.roles[p.id] ?? p.roleId ?? undefined;

  /**
   * 명단에 넘길 행 — **지금 화면의 배치·역할로 다시 맞춘 사본.**
   *
   * 서버가 준 `slotOverall`·`assignedPosition`·`adaptation`은 저장된 배치 기준이라
   * 자동 저장(3초)과 왕복이 끝나야 바뀐다. 칩은 이미 좌표에서 즉시 계산하고 있었고,
   * 명단만 한 박자 늦어 같은 선수의 두 숫자가 잠시 어긋나 보였다.
   *
   * ⚠️ 값은 `slotOverallOf` 하나가 낸다 — **전술판 칩과 같은 함수다.** 두 곳이
   * 따로 계산하던 때는 같은 선수의 OVR이 왼쪽과 오른쪽에서 다르게 보였다.
   */
  const localRows = useMemo(
    () =>
      players.map((p) => {
        const idx = board.occupants.indexOf(p.id);
        const code = idx >= 0 ? positionAtPoint(board.points[idx]!) : null;
        const role = board.roles[p.id] ?? p.roleId ?? undefined;
        if (code === p.assignedPosition && role === (p.roleId ?? undefined)) return p;
        const fit = code ? positionProficiency(p.positions, code, p.foot) : p.positionFit;
        return {
          ...p,
          assignedPosition: code,
          slotOverall: slotOverallOf(p, code, role),
          positionFit: fit,
          adaptation: adaptationOf(fit, p.familiarity),
        };
      }),
    [players, board.occupants, board.points, board.roles],
  );

  /** 감독이 고른 세부 역할의 지문 — 명단 표를 다시 그릴지 가리는 값 */
  const rolesKey = Object.entries(board.roles)
    .map(([id, role]) => `${id}:${role}`)
    .sort()
    .join(",");
  const onPitchKey = board.occupants.join(",");

  /** 비선발 선수를 매치데이 벤치(최대 9)로 지정/해제 — 나머지는 예비 스쿼드 */
  function toggleBench(id: string) {
    if (!live) return;
    const next = benchSet.has(id)
      ? board.bench.filter((x) => x !== id)
      : benchSet.size >= MAX_BENCH
        ? board.bench
        : [...board.bench, id];
    commit({ ...board, bench: next });
  }

  function changeTactics(patch: Partial<TacticsView>) {
    if (advisory) {
      // 경기 중 — 축 하나를 바꾸면 그 한 줄이 곧 지시다
      const [key, value] = Object.entries(patch)[0] ?? [];
      const axis = TACTIC_AXES.find((a) => a.key === key);
      if (!axis || typeof value !== "number") return;
      return onOrder?.(`전술 변경 — ${axis.label} ${axis.values[value - 1] ?? value}`);
    }
    if (!live) return;
    commit({ ...board, tactics: { ...board.tactics, ...patch } });
  }

  /**
   * 선택-스왑: 자리↔자리는 선수 교환(좌표는 그대로), 자리↔명단은 선수 교체.
   *
   * 이미 선발인 선수를 명단에서 골라 다른 자리에 넣으면 같은 선수가 두 자리에 앉는다.
   * 그 경로는 자리 교환으로 돌린다.
   */
  function applySwap(a: Selection, b: Selection) {
    if (!a || !b || !live) return;
    if (a.kind === "bench" && b.kind === "bench") return;
    if (a.kind === "bench") {
      const already = board.occupants.indexOf(a.id);
      if (already >= 0) return applySwap({ kind: "slot", index: already }, b);
    }
    if (b.kind === "bench") {
      const already = board.occupants.indexOf(b.id);
      if (already >= 0) return applySwap(a, { kind: "slot", index: already });
    }

    const occupants = [...board.occupants];
    let bench = [...board.bench];
    if (a.kind === "slot" && b.kind === "slot") {
      const tmp = occupants[a.index]!;
      occupants[a.index] = occupants[b.index]!;
      occupants[b.index] = tmp;
    } else {
      const slot = (a.kind === "slot" ? a : b) as { kind: "slot"; index: number };
      const incoming = (a.kind === "bench" ? a : b) as { kind: "bench"; id: string };
      // 2군 선수는 승격 전에는 라인업에 넣을 수 없다 (서버도 반려한다)
      if (byId.get(incoming.id)?.squadLevel === "reserve") return setSelection(null);
      const outgoing = occupants[slot.index]!;
      occupants[slot.index] = incoming.id;
      // 올라간 선수는 벤치 지정에서 빼고, 내려온 선수를 벤치에 넣는다
      bench = bench.filter((x) => x !== incoming.id);
      if (bench.length < MAX_BENCH) bench.push(outgoing);
    }
    commit({ ...board, occupants, bench });
  }

  /**
   * 자유 배치 — 한 자리의 좌표만 옮기고, 옮긴 자리를 고정한 채 나머지를 비켜세운다.
   * 격자에 맞춰(snapToBoard) 손으로 놓은 자리도 줄이 맞는다.
   */
  function repositionSlot(index: number, point: BoardPoint) {
    const points = [...board.points];
    points[index] = snapToBoard(point);
    commit({ ...board, points: separateBoardPoints(points, index) });
  }

  /**
   * 전술판 칩을 누른다 — **고르기만 한다.** 누른다고 자리가 바뀌지 않는다.
   * 자리끼리 맞바꾸는 건 드래그뿐이고(칩을 끌어 다른 칩 위에), 명단에서 데려오는 건
   * 그 행의 화살표 버튼뿐이다. 같은 칩을 다시 누르면 선택이 풀린다.
   */
  function clickSlot(index: number) {
    const here: Selection = { kind: "slot", index };
    if (!usable) return setSelection(board.occupants[index] ? here : null);
    const same = selection?.kind === "slot" && selection.index === index;
    setSelection(same ? null : here);
  }

  /**
   * 명단에서 선수를 누른다 — **상세 보기뿐이다. 라인업은 절대 건드리지 않는다.**
   * 목록을 훑다가 선수 정보를 열었을 뿐인데 배치가 바뀌면 안 된다 —
   * 교체는 자리를 고른 뒤 그 행의 화살표 버튼으로만 일어난다.
   */
  function clickRoster(id: string) {
    const onBoardIndex = board.occupants.indexOf(id);
    const here: Selection =
      onBoardIndex >= 0 ? { kind: "slot", index: onBoardIndex } : { kind: "bench", id };
    const same =
      (selection?.kind === "slot" && selection.index === onBoardIndex) ||
      (selection?.kind === "bench" && selection.id === id);
    setSelection(same ? null : here);
  }

  /** 이 선수가 지금 속한 칸 */
  function tierOf(id: string): Tier {
    if (board.occupants.includes(id)) return "선발";
    if (board.reserve.includes(id)) return "2군";
    return board.bench.includes(id) ? "벤치" : "예비";
  }

  /**
   * 고른 선수와 이 행의 선수가 **칸을 맞바꾼다** — 명단 화살표가 부르는 유일한 경로.
   *
   * 선발·벤치·예비·2군 어떤 조합이든 성립한다: 둘이 서로의 자리를 그대로 넘겨받는다.
   * 2군이 끼면 승격·강등이 함께 일어나므로 1군 인원수는 변하지 않는다(한 명 올라오고
   * 한 명 내려간다) — 라우트가 승격→배치→강등 순으로 한 요청에 처리한다.
   */
  function swapWithRow(rowId: string) {
    if (advisory) {
      const aId = selection?.kind === "slot" ? board.occupants[selection.index] : selection?.id;
      if (!aId || aId === rowId) return;
      // 경기 중에 뜻이 있는 맞바꿈은 **그라운드 ↔ 벤치** 하나뿐이다
      const [outId, inId] = board.occupants.includes(aId) ? [aId, rowId] : [rowId, aId];
      if (!board.occupants.includes(outId) || board.occupants.includes(inId)) return;
      setSelection(null);
      return onOrder?.(
        `교체 — ${byId.get(outId)?.name ?? outId} → ${byId.get(inId)?.name ?? inId}`,
      );
    }
    if (!live || !selection) return;
    const aId = selection.kind === "slot" ? board.occupants[selection.index] : selection.id;
    if (!aId || aId === rowId) return;
    const [ta, tb] = [tierOf(aId), tierOf(rowId)];
    if (ta === tb) return; // 같은 칸끼리는 바꿀 게 없다 (선발 자리 교환은 드래그)

    const occupants = [...board.occupants];
    const ia = occupants.indexOf(aId);
    const ib = occupants.indexOf(rowId);
    // 선발 자리는 상대에게 그대로 넘어간다
    if (ia >= 0) occupants[ia] = rowId;
    if (ib >= 0) occupants[ib] = aId;

    const moveTo = (id: string, tier: Tier, list: string[]) =>
      tier === "벤치" || tier === "2군"
        ? [...list.filter((x) => x !== id), id]
        : list.filter((x) => x !== id);
    let bench = board.bench.filter((x) => x !== aId && x !== rowId);
    let reserve = board.reserve.filter((x) => x !== aId && x !== rowId);
    // 서로의 칸을 넘겨받는다 (a는 b가 있던 칸으로, b는 a가 있던 칸으로)
    bench = moveTo(aId, tb, bench);
    bench = moveTo(rowId, ta, bench);
    reserve = moveTo(aId, tb === "2군" ? "2군" : "예비", reserve);
    reserve = moveTo(rowId, ta === "2군" ? "2군" : "예비", reserve);

    commit({ ...board, occupants, bench: bench.slice(0, MAX_BENCH), reserve });
  }

  /** 화면 좌표 → 전술판 좌표(%) */
  function pointFromClient(clientX: number, clientY: number): BoardPoint | null {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * 100,
      y: ((clientY - rect.top) / rect.height) * 100,
    };
  }

  /**
   * 전술판 칩 끌기 — HTML5 드래그가 아니라 포인터 이벤트로 직접 처리한다.
   * 칩이 손가락을 실시간으로 따라오고(미리보기), 놓는 순간의 자리가 곧 결과다.
   * 움직임이 임계값 미만이면 드래그가 아니라 탭으로 보고 선택-스왑에 넘긴다.
   */
  const DRAG_THRESHOLD_PX = 4;

  function onSlotPointerDown(index: number, e: React.PointerEvent) {
    if (!live || e.button !== 0 || !board.occupants[index]) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const origin = board.points[index]!;
    const from = pointFromClient(startX, startY);
    // 칩 중심과 커서의 차이 — 잡은 지점을 유지해야 칩이 튀지 않는다
    const grabOffset = from ? { x: origin.x - from.x, y: origin.y - from.y } : { x: 0, y: 0 };
    let dragging = false;
    let pending: BoardPoint | null = null;
    let frame: number | null = null;
    e.currentTarget.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      if (!dragging) {
        const far =
          Math.abs(ev.clientX - startX) > DRAG_THRESHOLD_PX ||
          Math.abs(ev.clientY - startY) > DRAG_THRESHOLD_PX;
        if (!far) return;
        dragging = true;
        setDragIndex(index);
      }
      const p = pointFromClient(ev.clientX, ev.clientY);
      if (!p) return;
      const next = clampToBoard({ x: p.x + grabOffset.x, y: p.y + grabOffset.y });
      /**
       * 좌표 갱신을 **프레임에 한 번으로 합친다.** 포인터는 화면보다 자주 쏘는데
       * (120·240Hz 트랙패드) 매 이벤트마다 상태를 바꾸면 같은 프레임 안에서 화면을
       * 여러 번 그리게 된다 — 손은 빨라지지 않고 드래그만 무거워진다.
       */
      pending = next;
      if (frame === null) {
        frame = requestAnimationFrame(() => {
          frame = null;
          if (pending) setDragPoint(pending);
        });
      }
    };

    const up = (ev: PointerEvent) => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setDragIndex(null);
      setDragPoint(null);
      if (!dragging) return clickSlot(index);
      const p = pointFromClient(ev.clientX, ev.clientY);
      if (!p) return;
      const dropPoint = clampToBoard({ x: p.x + grabOffset.x, y: p.y + grabOffset.y });
      // 다른 칩 위에 놓으면 자리 교환, 빈 곳이면 그 자리로 이동
      const onto = board.points.findIndex(
        (q, i) =>
          i !== index &&
          board.occupants[i] &&
          Math.abs(q.x - dropPoint.x) < CHIP_SIZE.w / 2 &&
          Math.abs(q.y - dropPoint.y) < CHIP_SIZE.h / 2,
      );
      if (onto >= 0) applySwap({ kind: "slot", index }, { kind: "slot", index: onto });
      else repositionSlot(index, dropPoint);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  const gkCount = gkCountOf(board);
  const gkIssue = live && gkCount !== 1;
  const gkSlotIdx = board.points.findIndex((p) => positionAtPoint(p) === "GK");
  const gkOccupant = gkSlotIdx >= 0 ? byId.get(board.occupants[gkSlotIdx] ?? "") : undefined;
  const gkWarning = live && gkOccupant && gkOccupant.positionGroup !== "GK";
  const xi = board.occupants
    .map((id) => byId.get(id))
    .filter((p): p is SquadRow => p !== undefined);
  const unavailableInXI = xi.filter((p) => !p.available);
  const unavailableOnBench = benchDesignated.filter((p) => !p.available);
  /**
   * 선발 평균 — **각자 그 자리에서 내는 값**의 평균이다 (칩에 쓰인 숫자 그대로).
   * `overall`로 재면 센터백을 윙에 세워도 평균이 꿈쩍하지 않아, 판을 잘못 짠 것이
   * 머리 요약에서만 멀쩡해 보인다.
   */
  const xiRating =
    xi.length > 0
      ? Math.round(
          xi.reduce((s, p, i) => {
            const point = board.points[board.occupants.indexOf(p.id)] ?? board.points[i];
            const code = point ? positionAtPoint(point) : null;
            return s + (slotOverallOf(p, code, roleOf(p)) ?? p.overall);
          }, 0) / xi.length,
        )
      : 0;
  const misfits = board.points
    .map((point, i) => ({ p: byId.get(board.occupants[i] ?? ""), code: positionAtPoint(point) }))
    .filter((x) => x.p && fitAt(x.p, x.code).value < 50);

  const selectedPlayer =
    selection?.kind === "slot"
      ? byId.get(board.occupants[selection.index] ?? "")
      : selection?.kind === "bench"
        ? byId.get(selection.id)
        : undefined;
  const selectedSlotCode =
    selection?.kind === "slot" && board.points[selection.index]
      ? positionAtPoint(board.points[selection.index]!)
      : null;
  // 자리를 고르면 명단이 "이 자리에 넣을 선수 고르기" 모드가 된다
  /**
   * 교체 짝 — 고른 선수 하나가 정해지면 **칸이 다른** 모든 행에 화살표가 뜬다.
   * 선발·벤치·예비·2군 어느 조합이든 열린다 (같은 칸끼리만 닫힌다 — 선발 자리
   * 맞바꾸기는 드래그의 몫이라서다).
   */
  const swapPair = (() => {
    if (!usable || !selection) return null;
    const id = selection.kind === "slot" ? (board.occupants[selection.index] ?? "") : selection.id;
    if (!id) return null;
    return { id, name: byId.get(id)?.name ?? "", tier: tierOf(id), slotCode: selectedSlotCode };
  })();
  /** 행마다의 칸 — 로컬 편집 반영 (뷰의 role·squadLevel은 저장 전까지 옛 값이다) */
  const tierById = useStable((id: string): Tier => tierOf(id));
  // 명단에 넘기는 콜백은 전부 신원을 고정한다 (위 useStable 주석 참고)
  const onSelectRow = useStable(clickRoster);
  const onToggleBenchRow = useStable(toggleBench);
  const onSwapInRow = useStable(swapWithRow);
  const onRoleRow = useStable(chooseRole);
  const onMoveSquadRow = useStable(moveSquad);
  // 새 기준은 큰 값부터 보는 게 자연스럽다 — 칸 순(기본)만 위에서 아래로 읽는다
  const onSortRow = useStable((key: SortKey) =>
    setSort((prev) => ({ key, desc: prev.key === key ? !prev.desc : key !== "role" })),
  );

  async function moveSquad(playerId: string, level: "first" | "reserve") {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/games/${game.id}/squad`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId, level }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "스쿼드 이동 실패");
      onUpdate(data);
      setSelection(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  /**
   * 역할 선택 — **다른 조작과 같은 문을 지난다.**
   * 알약을 누를 때마다 요청을 보내면 결정 하나가 요청 여럿이 되고, 감독이
   * 고르는 동안 서버가 계속 값을 매긴다. 정해진 값 하나만 자동 저장에 실린다.
   */
  function chooseRole(playerId: string, role: string) {
    if (advisory) {
      const name = byId.get(playerId)?.name ?? playerId;
      const code = board.occupants.includes(playerId)
        ? positionAtPoint(board.points[board.occupants.indexOf(playerId)]!)
        : null;
      const label = rolesFor(code ?? "CM").find((r) => r.id === role)?.ko ?? role;
      return onOrder?.(`역할 — ${name}을(를) ${label}로`);
    }
    if (!live) return;
    // 상세를 열어 둔 채 고른다 — 역할은 비교하며 바꾸는 값이다
    commit({ ...board, roles: { ...board.roles, [playerId]: role } }, { keepSelection: true });
  }

  /**
   * 칩의 클래스 — **자리의 색과 상태의 테두리는 다른 채널이다.**
   *
   * 색(배경)은 "이 자리가 무슨 자리인가"를 말한다: 최전방 붉게 · 중원 초록 ·
   * 수비 파랑 · 골키퍼 노랑. 판을 훑을 때 라인이 색 띠로 먼저 읽힌다.
   * 테두리는 **상태**가 이미 쓰고 있다(선택=초록, 못 뛰는 선수=빨강) — 여기에
   * 자리 색까지 얹으면 초록 테두리가 "고른 것"인지 "미드필더"인지 알 수 없다.
   *
   * 색의 근거는 선수의 주 포지션군이 아니라 **지금 서 있는 자리**다. 센터백을
   * 윙에 세우면 그 칩은 최전방 색이어야 판이 실제 배치대로 읽힌다.
   */
  const chipClass = (p: SquadRow | undefined, selected: boolean, code: string | null) => {
    const group = code ? (positionGroupOf(code) ?? null) : null;
    return (
      `pitch-chip${group ? ` g-${group.toLowerCase()}` : ""}` +
      `${selected ? " selected" : ""}${p && !p.available ? " unavailable" : ""}`
    );
  };

  /**
   * 명단은 **드래그 프레임마다 다시 그리지 않는다.** 43행 × (게이지·상태바·화살표
   * SVG)를 초당 60번 새로 만들면 정작 손에 붙어야 할 칩이 늦어진다. 드래그가 바꾸는
   * 건 칩 좌표뿐이고 명단은 그와 무관하므로, 드래그 상태를 뺀 값들로만 메모한다.
   */
  const rosterTable = useMemo(
    () => (
      <SquadTable
        players={localRows.filter((p) =>
          squadFilter === "reserve" ? localReserve.has(p.id) : !localReserve.has(p.id),
        )}
        sort={sort}
        onSort={onSortRow}
        selectedId={selectedPlayer?.id ?? null}
        onSelect={onSelectRow}
        swapPair={swapPair}
        tierOf={tierById}
        tierKey={`${onPitchKey}|${benchKey}|${localReserveKey}`}
        onSwapIn={onSwapInRow}
        renderDetail={(p) => (
          <PlayerDetail
            p={p}
            slotCode={p.id === selectedPlayer?.id ? selectedSlotCode : null}
            onRole={usable ? (role) => onRoleRow(p.id, role) : undefined}
            roleId={board.roles[p.id] ?? p.roleId}
            action={
              <>
                {/* 벤치 지정 — 명단의 배지 열을 없앤 뒤 이 조작이 여기로 왔다.
                비선발 1군에게만 뜻이 있다 (선발은 이미 나가고, 2군은 승격이 먼저) */}
                {live && !onPitch.has(p.id) && !localReserve.has(p.id) && (
                  <button
                    className="ghost-btn"
                    disabled={saving}
                    data-testid={`benchtoggle-${p.id}`}
                    onClick={() => onToggleBenchRow(p.id)}
                  >
                    {benchSet.has(p.id) ? "벤치에서 빼기" : "매치데이 벤치로"}
                  </button>
                )}
                <button
                  className="ghost-btn"
                  disabled={saving || !live}
                  title={live ? undefined : "경기 중에는 1·2군을 옮길 수 없습니다"}
                  onClick={() => onMoveSquadRow(p.id, localReserve.has(p.id) ? "first" : "reserve")}
                >
                  {localReserve.has(p.id) ? "1군 승격" : "2군 강등"}
                </button>
              </>
            }
          />
        )}
      />
    ),
    [
      localRows,
      squadFilter,
      localReserveKey,
      sort,
      // 감독이 고른 세부 역할 — 이게 없으면 알약을 눌러도 표가 다시 그려지지 않아
      // 선택이 화면에 안 나타난다(저장은 되는데 아무 일도 안 일어난 것처럼 보인다)
      rolesKey,
      selectedPlayer?.id,
      selectedSlotCode,
      benchKey,
      onPitchKey,
      live,
      saving,
      swapPair?.id,
      swapPair?.tier,
      swapPair?.slotCode,
      onSelectRow,
      onToggleBenchRow,
      onSwapInRow,
      onRoleRow,
      onMoveSquadRow,
      onSortRow,
      tierById,
    ],
  );

  return (
    /*
     * 저장 상태는 **글자가 아니라 속성**으로만 남긴다. 화면에 "저장됨"을 띄우면
     * 자동 저장이라 늘 켜져 있는 등이 되지만, 테스트는 저장이 끝났는지를
     * 결정적으로 기다릴 수 있어야 한다.
     */
    <div
      className={`squad-view${boardOpen ? "" : " folded"}`}
      data-testid="view-squad"
      data-save={!live ? "locked" : saving ? "saving" : dirty ? "dirty" : "saved"}
    >
      <div className="squad-head">
        <div className="squad-summary">
          <span>
            {/* 이름은 실제 배치에서 읽는다 — 칩을 옮기면 숫자가 바로 따라 바뀐다 */}
            <b data-testid="shape">{shape}</b> · 선발 평균 <b>{xiRating}</b>
          </span>
          {/* 1군·2군 인원은 오른쪽 명단 탭이 이미 세어 준다 — 여기선 매치데이 인원만 */}
          <span className="muted">매치데이 {xi.length + benchDesignated.length}인</span>
          {/* 등록 명단 — 영입·승격의 진짜 벽이라 늘 보여야 한다 (U21은 명단 밖) */}
          <span
            className={`reg-chip${squad.registration.issues.length > 0 ? " over" : ""}`}
            data-testid="registration"
            title={
              squad.registration.issues.length > 0
                ? squad.registration.issues.join(" / ")
                : `21세 초과 ${squad.registration.limit}명까지 · 그중 홈그로운 ${squad.registration.homegrownMin}명 이상 · U21 ${squad.registration.under21}명은 명단 밖`
            }
          >
            등록 <b>{squad.registration.listed}</b>/{squad.registration.limit} · HG{" "}
            <b>{squad.registration.homegrown}</b>/{squad.registration.homegrownMin}
          </span>
          {/**
           * 전술판 손잡이 — **글자가 아니라 상태로 알린다.**
           *
           * 눌린 채로 남는 버튼이라 지금 펼쳐져 있는지가 모양에 드러난다. 안내
           * 문구를 붙이지 않는 것도 같은 이유다 — 누르면 판이 열리는 것을 보면 안다.
           * 요약 줄 안에 두는 이유는 머리글이 **두 칸짜리 격자**이기 때문이다:
           * 세 번째 칸으로 세우면 책갈피가 명단에서 한 줄 떨어진다.
           */}
          {onToggleBoard && (
            <button
              className={`board-toggle${boardOpen ? " on" : ""}`}
              onClick={onToggleBoard}
              aria-pressed={boardOpen}
              data-testid="board-toggle"
              title="전술판"
            >
              <IconBoard />
              전술판
            </button>
          )}
        </div>
        {/*
         * 저장 상태는 적지 않는다 — 자동 저장이라 "저장됨"은 늘 켜져 있는 등이고,
         * 늘 켜진 등은 아무것도 알리지 않으면서 머리글 오른쪽을 차지한다.
         * **실패했을 때만** 아래 경고 줄이 말한다.
         */}
        {/*
         * 명단 머리(책갈피 + 정원)는 **위 요약 줄의 오른쪽 칸**에 선다.
         *
         * 명단 열 안에 두면 그 줄 높이(31px)만큼 표가 전술판보다 내려가 두 열의
         * 윗변이 어긋난다. 이 줄이 `squad-layout`과 **같은 그리드**를 쓰므로
         * 책갈피는 여전히 명단 바로 위에 서고, 표와도 이어진다.
         */}
        <div className="roster-head">
          {/* 책갈피 — 고른 쪽이 아래 명단과 한 장으로 이어진다 */}
          <div className="roster-tabs" role="tablist">
            {(
              [
                ["first", "1군", players.length - localReserve.size],
                ["reserve", "2군", localReserve.size],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                role="tab"
                aria-selected={squadFilter === key}
                className={`roster-tab${squadFilter === key ? " on" : ""}`}
                onClick={() => setSquadFilter(key)}
              >
                {label}
                <span className="roster-tab-n">{count}</span>
              </button>
            ))}
          </div>
          {/* 조작법 대신 숫자만 — 벤치 정원이 몇 자리 남았는지가 유일하게 필요한 정보다 */}
          <span className="roster-counts" data-testid="bench-count">
            벤치 {benchDesignated.length}/{MAX_BENCH} · 예비{" "}
            {benchPlayers.length - benchDesignated.length}
          </span>
        </div>
        {!live && !advisory && (
          <button className="ghost-btn" onClick={onGoToChat}>
            경기 중 — 채팅으로
          </button>
        )}
      </div>

      {(gkIssue ||
        gkWarning ||
        unavailableInXI.length > 0 ||
        unavailableOnBench.length > 0 ||
        misfits.length > 0 ||
        saveError) && (
        <div className="lineup-status warn" data-testid="lineup-status">
          {/* 경고는 사실만 — "교체하세요" 같은 지시나 규칙 설명은 붙이지 않는다.
              저장이 멈추는 GK 문제만 이유를 밝힌다 (안 그러면 왜 안 되는지 모른다) */}
          {gkIssue && <div>⚠ GK 자리 {gkCount}곳 — 한 명이 될 때까지 저장이 보류됩니다.</div>}
          {gkWarning && <div>⚠ GK 자리에 필드 플레이어</div>}
          {unavailableInXI.length > 0 && (
            <div>⚠ 선발 불가(부상·정지): {unavailableInXI.map((p) => p.name).join(", ")}</div>
          )}
          {unavailableOnBench.length > 0 && (
            <div>⚠ 벤치에 출전 불가: {unavailableOnBench.map((p) => p.name).join(", ")}</div>
          )}
          {misfits.length > 0 && (
            <div>⚠ 낯선 자리: {misfits.map((x) => `${x.p!.name}(${x.code})`).join(", ")}</div>
          )}
          {saveError && <div data-testid="lineup-error">{saveError}</div>}
        </div>
      )}

      {/* 왼쪽 전술판 · 오른쪽 명단 — 한 화면에서 보고 바로 조작한다.
          접으면 명단만 남아 채팅 옆에 설 수 있다 */}
      <div className="squad-layout">
        {/* 접힘은 **CSS가 정한다** — 채팅이 옆에 설 만큼 넓을 때만 뜻이 있고,
            좁은 화면에서는 접어도 남는 자리를 명단이 늘어나 채울 뿐이다 */}
        <div className="squad-board-col">
          {/* 포메이션 프리셋 선택도, 조작법 안내도 두지 않는다 — 자리는 칩을 끌어
              만들고(보면 안다), "4-4-2로 가자" 같은 프리셋 교체는 채팅(set_tactics)이
              맡는다. 잠긴 상태만 이유를 밝힌다 */}
          {!live && !advisory && (
            <p className="hint" data-testid="board-hint">
              경기 중에는 전술판이 잠깁니다 — 교체는 채팅으로 지시하세요.
            </p>
          )}

          {/**
           * 판과 전술 줄은 **한 덩어리다** — 채팅 위에 얹힐 때 둘이 한 장으로 붙는다.
           * 평소 레이아웃에서는 `display: contents`라 이 래퍼가 없는 것과 같다.
           */}
          <div className="board-stack">
            {/* 전술판은 남는 높이에 맞춰 줄어든다 — 감싸는 칸이 그 높이를 알려 준다 */}
            <div className="pitch-wrap">
              <div
                ref={boardRef}
                className={`pitch-board${usable ? " editing" : ""}`}
                data-testid="pitch-board"
              >
                <div className="pitch-lines" />
                <div className="pitch-box top" />
                <div className="pitch-box small top" />
                <div className="pitch-box bottom" />
                <div className="pitch-box small bottom" />
                <PitchTactics tactics={board.tactics} />
                <span className="pitch-zone" style={{ top: "6%" }}>
                  공격
                </span>
                <span className="pitch-zone" style={{ top: "46%" }}>
                  중원
                </span>
                <span className="pitch-zone" style={{ top: "84%" }}>
                  수비
                </span>
                {boardSlots.map((slot, i) => {
                  const p = slot ? byId.get(slot.playerId) : undefined;
                  // 끌고 있는 칩은 미리보기 좌표로 그린다 (놓기 전엔 실제 배치를 안 바꾼다)
                  const dragging = dragIndex === i;
                  const point = dragging && dragPoint ? dragPoint : slot?.point;
                  const code = point ? positionAtPoint(point) : null;
                  /**
                   * 칩의 전력은 **좌표에서 즉시** 나온다 — 서버가 준 값은 저장된 배치
                   * 기준이라 자동 저장(600ms 디바운스)과 왕복이 끝나야 바뀌는데, 끌어
                   * 놓고 한 박자 뒤에 숫자가 따라오면 "이 자리로 옮기면 얼마가 되나"를
                   * 손으로 더듬어 볼 수가 없다.
                   *
                   * ⚠️ 계산은 **명단과 같은 함수**(`slotOverallOf`)다. 여기서만 `roleFit`을
                   * 다시 굴리던 때는 같은 선수의 OVR이 칩과 명단에서 달랐다.
                   */
                  const liveOverall = p ? slotOverallOf(p, code, roleOf(p)) : null;
                  const selected = selection?.kind === "slot" && selection.index === i;
                  /**
                   * 맡은 역할 — **기본 역할이 아닐 때만** 칩에 뜬다.
                   * 전원에게 붙이면 열한 칩이 다 같은 말(센터백·풀백·윙어)을 달고 있어
                   * 읽히지 않는다. 감독이 실제로 **고른** 것만 보이면 판을 훑을 때
                   * 그 선택이 눈에 남는다. 표기는 FM 약칭(BPD·IWB·RGA)이다 —
                   * 칩에 들어갈 만큼 짧으면서 감독이 이미 아는 말이다.
                   */
                  const liveRole = p ? roleOf(p) : undefined;
                  const roleTag =
                    p && code && liveRole && liveRole !== defaultRoleOf(code)
                      ? (rolesFor(code).find((r) => r.id === liveRole) ?? null)
                      : null;
                  if (!point) return null;
                  return (
                    <button
                      key={i}
                      className={`pitch-slot ${chipClass(p, selected, code)}${dragging ? " dragging" : ""}`}
                      style={{ left: `${point.x}%`, top: `${point.y}%` }}
                      onPointerDown={(e) => onSlotPointerDown(i, e)}
                      onClick={() => {
                        // 경기 중(비활성)엔 포인터 드래그를 걸지 않으므로 여기서 상세를 연다
                        if (!live) clickSlot(i);
                      }}
                      data-testid={`slot-${i}`}
                      title={
                        p
                          ? // 명단 OVR 칸의 툴팁과 **같은 두 줄**이다 — 같은 숫자를
                            // 두 화면에서 다른 말로 설명하면 규칙이 없어 보인다
                            [
                              `${p.name}`,
                              `${code} 자리 기준 ${liveOverall ?? p.overall} — 경기에서 쓰이는 값입니다`,
                              liveOverall !== null && liveOverall !== p.overall
                                ? `주 포지션(${p.position}) 기준 ${p.overall}`
                                : null,
                            ]
                              .filter(Boolean)
                              .join("\n")
                          : (code ?? "")
                      }
                    >
                      <span className="slot-pos">
                        {code}
                        {roleTag && (
                          <em className="slot-role" title={`${roleTag.ko} — ${roleTag.desc}`}>
                            {roleTag.abbr}
                          </em>
                        )}
                      </span>
                      <span className="slot-name">
                        {p?.isCaptain ? "Ⓒ" : ""}
                        {p ? chipName(p.name) : "—"}
                      </span>
                      <span className="slot-meta">
                        {/* 칩은 "그 자리에 선 선수"라 주 포지션 값이 아니라 자리 값이 맞다.
                          자리를 못 보는 선수라는 사실은 옆의 적응도 게이지가 이미 말하므로
                          숫자에 따로 표식을 붙이지 않는다 — 툴팁이 주 포지션 값을 갖는다. */}
                        {/* 이 자리에서 내는 전력 하나만 둔다. 자리가 안 맞으면 이 숫자가
                          이미 낮다 — 옆에 "포지션 적응도"를 따로 세우면 감독이 두 축을
                          머리로 합쳐야 한다 (적응도는 하나다) */}
                        <b>{p ? (liveOverall ?? p.overall) : ""}</b>
                        {p && <Margin observation={p.observation} />}
                        {p && !p.available && <span className="slot-flag">✖</span>}
                        {p?.hasIssue && <span className="slot-flag warn">!</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <TacticsPanel tactics={board.tactics} editing={usable} onChange={changeTactics} />
          </div>
        </div>

        <div className="squad-side-col">
          <div className="roster-scroll">{rosterTable}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * 정렬 기준 — `role`이 **기본이자 돌아오는 자리**다 (칸 → 라인 → OVR).
 *
 * 이름순은 없앴다. 다른 기준으로 흩어 놓은 명단을 **칸 순으로 되돌릴 손잡이가
 * 없었고**, 스물몇 명짜리 표에서 이름으로 찾는 일은 칸으로 찾는 일보다 드물다 —
 * 첫 칸(선수)이 그 되돌리는 자리를 맡는다.
 */
type SortKey =
  "role" | "position" | "overall" | "age" | "adaptation" | "form" | "condition" | "rating";
const ROLE_ORDER: Record<string, number> = { 선발: 0, 벤치: 1, 스쿼드: 2 };
/**
 * 칸 순서 — 정렬의 기준은 **지금 화면의 칸**이다.
 *
 * `SquadRow.role`은 서버가 아는 값이라 자동 저장이 돌아오기 전까지 예전 칸이다.
 * 그걸로 정렬하면 선수를 벤치로 내려도 명단에서는 한 박자 뒤에야 자리를 옮긴다.
 */
const TIER_ORDER: Record<Tier, number> = { 선발: 0, 벤치: 1, 예비: 2, "2군": 3 };
const GROUP_ORDER: Record<string, number> = { GK: 0, DF: 1, MF: 2, FW: 3 };

/** 명단 표 — 열 머리를 눌러 정렬한다. 기본은 역할 → 포지션 라인 → OVR */
function SquadTable({
  players,
  sort,
  onSort,
  selectedId,
  onSelect,
  renderDetail,
  swapPair,
  tierOf,
  tierKey,
  onSwapIn,
}: {
  players: SquadRow[];
  sort: { key: SortKey; desc: boolean };
  onSort: (key: SortKey) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 선택한 선수의 상세 — 그 행 바로 아래에 펼친다 (별도 패널로 시선을 옮기지 않는다) */
  renderDetail?: (p: SquadRow) => React.ReactNode;
  /**
   * 고른 선수 — 있으면 **반대편**(선발↔비선발) 행에 화살표 버튼이 뜬다.
   * 행 클릭은 상세 보기뿐이고, 라인업 변경은 이 버튼으로만 일어난다.
   */
  swapPair?: { id: string; name: string; tier: Tier; slotCode: string | null } | null;
  /** 이 선수가 지금 속한 칸 (로컬 편집 반영 — role·squadLevel은 저장 전까지 옛 값이다) */
  tierOf?: (id: string) => Tier;
  /**
   * 칸 배치의 지문 — **정렬을 다시 계산할지 가리는 값**이다.
   *
   * `tierOf`는 신원이 고정된 콜백이라(useStable) 칸이 바뀌어도 참조가 그대로다.
   * 그것만 의존성에 두면 선수를 벤치로 내려도 명단은 저장 왕복이 끝날 때까지
   * 예전 순서를 들고 있다.
   */
  tierKey?: string;
  onSwapIn?: (id: string) => void;
}) {
  const rows = useMemo(() => {
    const dir = sort.desc ? -1 : 1;
    const value = (p: SquadRow): number | string => {
      switch (sort.key) {
        case "adaptation":
          // 배치가 없는 선수(스쿼드)에겐 적응도가 없다 — 0이 아니라 맨 아래다
          return p.role === "스쿼드" ? -1 : p.adaptation;
        case "position":
          return (GROUP_ORDER[p.positionGroup] ?? 9) * 100 + p.overall;
        case "overall":
          return p.overall;
        case "age":
          return p.age;
        case "form":
          return p.form;
        case "condition":
          return p.condition;
        case "rating":
          // 기록 없는 선수는 정렬 맨 아래로 — 0.00과 "아직 없음"은 다르다
          return p.seasonRating ?? -1;
        default:
          return (
            (tierOf ? TIER_ORDER[tierOf(p.id)] : (ROLE_ORDER[p.role] ?? 9)) * 1000 +
            (GROUP_ORDER[p.positionGroup] ?? 9) * 100 -
            p.overall
          );
      }
    };
    return [...players].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      if (typeof x === "string" || typeof y === "string")
        return String(x).localeCompare(String(y)) * dir;
      return (x - y) * dir;
    });
  }, [players, sort, tierOf, tierKey]);

  const th = (key: SortKey, label: string, className?: string, title?: string) => (
    <th
      className={`sortable ${className ?? ""}${sort.key === key ? " sorted" : ""}`}
      onClick={() => onSort(key)}
      title={title}
    >
      {label}
      {sort.key === key && <span className="sort-mark">{sort.desc ? "▼" : "▲"}</span>}
    </th>
  );

  return (
    <table className="squad-table" data-testid="squad-table">
      <thead>
        <tr>
          {/* 첫 칸이 **기본 정렬로 돌아오는 자리**다 — 흩어 놓은 명단을 칸 순으로 되돌린다 */}
          {th("role", "선수", undefined, "칸 순으로 (선발 → 벤치 → 예비)")}
          {th("position", "포지션")}
          {th("age", "나이", "hide-sm")}
          {th("overall", "OVR")}
          {th("adaptation", "적응", "hide-sm", "지금 맡은 자리에서 이 전술을 얼마나 소화하는가")}
          {th("form", "폼")}
          {th("condition", "체력")}
          {th("rating", "평점", "hide-sm")}
        </tr>
      </thead>
      <tbody>
        {rows.map((p, i) => (
          <Fragment key={p.id}>
            {/*
             * 칸이 바뀌는 자리에 **선 하나**를 긋는다 — 이름은 적지 않는다.
             *
             * "선발·벤치·예비"를 글자로 세우면 표 안에 소제목이 셋 생겨 이름을
             * 훑는 눈이 매번 걸린다. 어느 칸인지는 행의 왼쪽 선 색이 이미 말하고,
             * 여기 필요한 건 **경계가 어디인가**뿐이다.
             * **칸 순으로 정렬했을 때만** 성립하므로(다른 기준이면 칸이 흩어진다)
             * 그때만 그린다.
             */}
            {tierOf &&
              sort.key === "role" &&
              i > 0 &&
              tierOf(p.id) !== tierOf(rows[i - 1]?.id ?? "") && (
                /* 색은 `data-tier`가 고른다 — `t-*`를 쓰면 "그 칸의 **행**"을
                 가리키는 셀렉터에 머리까지 걸려 첫 선수 대신 머리가 잡힌다.
                 첫 칸에는 긋지 않는다 — 표 머리 바로 아래에 선이 하나 더 서는 꼴이다 */
                <tr className="tier-head" data-tier={TIER_SLUG[tierOf(p.id)]} aria-hidden>
                  <td colSpan={8} />
                </tr>
              )}
            <tr
              /* 칸은 **왼쪽 선 색**이 말한다 — 별도 배지 열을 두지 않는다 */
              className={`row-tier t-${tierOf ? TIER_SLUG[tierOf(p.id)] : "squad"}${
                selectedId === p.id ? " picked" : ""
              }`}
              onClick={() => onSelect(p.id)}
              data-testid={`squad-row-${p.id}`}
            >
              <td className="squad-name">
                {/* 교체 화살표는 이름 앞에 — 별도 열을 만들면 고를 때마다 표가 흔들린다.
                    자리는 **선택 여부와 무관하게 비워 둔다** (열 폭이 안 흔들리게) */}
                {onSwapIn && tierOf && (
                  <span className="swap-slot">
                    {(() => {
                      // 칸이 다르면 무엇이든 맞바꿀 수 있다 — 선발·벤치·예비·2군 전부.
                      // 같은 칸끼리만 닫는다 (선발 자리 교환은 드래그가 맡는다).
                      if (!swapPair || p.id === swapPair.id) return null;
                      const rowTier = tierOf(p.id);
                      if (rowTier === swapPair.tier) return null;
                      // 전술판(선발) 쪽으로 올라오면 ←, 내려가면 →
                      const RANK: Record<Tier, number> = { 선발: 3, 벤치: 2, 예비: 1, "2군": 0 };
                      const rowGoesUp = RANK[swapPair.tier] > RANK[rowTier];
                      return (
                        <button
                          className="swap-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSwapIn(p.id);
                          }}
                          data-testid={`swapin-${p.id}`}
                          title={`${p.name}(${rowTier}) ↔ ${swapPair.name}(${swapPair.tier}) 맞바꾸기`}
                        >
                          {rowGoesUp ? "←" : "→"}
                        </button>
                      );
                    })()}
                  </span>
                )}
                {/* 이름은 자체 요소로 — 같은 칸에 화살표·표식·배지가 함께 서므로
                    "이 행의 선수 이름"을 읽을 자리가 하나 있어야 한다 */}
                <span className="row-name">
                  {p.isCaptain ? "Ⓒ " : ""}
                  {p.name}
                </span>
                {/* 등록 명단을 읽는 두 표식 — 홈그로운은 8명 조건을 채우고, U21은 명단 밖이다 */}
                {p.homegrown && (
                  <span className="tag hg" title="홈그로운 — 등록 명단의 8명 조건을 채운다">
                    HG
                  </span>
                )}
                {!p.occupiesList && (
                  <span className="tag u21" title="U21 — 등록 명단을 차지하지 않는다">
                    U21
                  </span>
                )}
                <StatusBadges p={p} />
              </td>
              {/* 지금 맡고 있는 자리를 그대로 보여준다 — 전술판에 RWB로 저장돼 있으면 RWB.
                "주 포지션과 다르다"는 표시는 하지 않는다 (적합도는 전술판의 적응도 숫자로 읽는다) */}
              <td>{p.assignedPosition ?? p.position}</td>
              <td className="hide-sm">{p.age}</td>
              {/**
               * OVR은 **지금 맡은 자리·역할에서 내는 전력**이다 — 경기에서 실제로
               * 쓰이는 값이 그것이기 때문이다. 예전엔 주 포지션 기준값만 보여줘서,
               * 자리를 옮기거나 역할을 바꿔도 명단의 숫자가 꿈쩍하지 않았다.
               * 값도 문구도 **전술판 칩과 같다**(`slotOverallOf`) — 같은 선수의
               * OVR이 왼쪽과 오른쪽에서 다르면 규칙이 없어 보인다.
               */}
              <td title={ovrTitle(p)}>
                {p.slotOverall ?? p.overall}
                <Margin observation={p.observation} />
              </td>
              {/* 적응 — **하나의 값**이다. 예전엔 툴팁으로 "자리 적응 N · 전술 적응 N"을
                  분해해 보여줬는데, 그러면 감독은 결국 두 축을 머리로 합쳐야 한다 */}
              <td
                className="hide-sm"
                title={`${p.assignedPosition ?? p.position} 자리에서의 적응도`}
              >
                {p.role === "스쿼드" ? "—" : <FitGauge value={p.adaptation} label="적응도" />}
              </td>
              <td>
                <FormArrow p={p} />
              </td>
              {/* 사기·피로를 하나로 합친 값 — 왜 이 값인지는 행을 펼치면 한 문장으로 나온다 */}
              <td title={`${conditionLabel(p.condition)} · ${p.mood}`}>
                <StatBar value={p.condition} kind="condition" />
              </td>
              {/* 골 대신 평점 — 골 수는 행을 펼치면 시즌 기록에 그대로 있다 */}
              <td
                className="hide-sm"
                title={`${p.seasonApps}경기 ${p.seasonGoals}골 ${p.seasonAssists}도움`}
              >
                {typeof p.seasonRating === "number" ? p.seasonRating.toFixed(2) : "—"}
              </td>
            </tr>
            {/* 선택한 선수의 상세를 그 행 바로 아래에 붙인다 — 시선이 명단을 떠나지 않는다 */}
            {selectedId === p.id && renderDetail && (
              /* 상세도 그 선수의 행이다 — 칸 색 선이 끊기면 안 된다 */
              <tr
                className={`detail-row row-tier t-${tierOf ? TIER_SLUG[tierOf(p.id)] : "squad"}`}
                data-testid={`squad-detail-${p.id}`}
              >
                <td colSpan={8}>{renderDetail(p)}</td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

// ── 달력 (일정 축: 경기·훈련·이적창 + 일자 상세) ─────────────
function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type CalEntry = OfficeViews["calendar"]["entries"][number];
type CalEvent = OfficeViews["calendar"]["events"][string][number];

/**
 * 일지 아이콘 — **도형으로 그린다.**
 *
 * 예전엔 이모지(🏋️ 📈 🩹…)를 문자열 앞에 붙였다. 플랫폼마다 모양·너비·색이 달라
 * 줄이 흔들리고, 흑백 UI 위에서 혼자 알록달록해 시선을 뺏는다. 같은 굵기의 선으로
 * 그리면 글자와 함께 읽히고, 색은 뜻이 있을 때만(경고·퇴장·부상) 쓴다.
 */
function EventIcon({ kind }: { kind: CalEvent["kind"] }) {
  const line = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const shapes: Record<CalEvent["kind"], React.ReactNode> = {
    match: (
      <>
        <circle cx="8" cy="8" r="5.6" {...line} />
        <path d="M8 4.6 10.6 6.5 9.6 9.6H6.4L5.4 6.5Z" {...line} />
      </>
    ),
    training: (
      <>
        <path d="M4 8h8" {...line} />
        <path d="M3 5.6v4.8M13 5.6v4.8" {...line} />
      </>
    ),
    rest: <path d="M10.8 3.6a4.7 4.7 0 1 0 1.7 7.8A5.3 5.3 0 0 1 10.8 3.6Z" {...line} />,
    growth: (
      <>
        <path d="M3.4 11.6 6.6 8.4l2 2 4-4" {...line} />
        <path d="M9.9 6.4h2.7v2.7" {...line} />
      </>
    ),
    injury: <path d="M8 4v8M4 8h8" {...line} />,
    return: <path d="M3.8 8.4 6.6 11l5.6-6" {...line} />,
    yellow: <rect x="5.2" y="3.4" width="5.6" height="9.2" rx="1" fill="currentColor" />,
    red: <rect x="5.2" y="3.4" width="5.6" height="9.2" rx="1" fill="currentColor" />,
    transfer: (
      <>
        <path d="M3 6.2h8.6M9.3 4 11.6 6.2 9.3 8.4" {...line} />
        <path d="M13 10.2H4.4M6.7 8 4.4 10.2 6.7 12.4" {...line} />
      </>
    ),
    window: (
      <>
        <rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1.4" {...line} />
        <path d="M8 3.6v8.8" {...line} />
      </>
    ),
  };
  return (
    <svg className={`ev-icon ev-${kind}`} viewBox="0 0 16 16" aria-hidden>
      {shapes[kind]}
    </svg>
  );
}

/** 일지 한 줄 — 상세가 있으면 눌러서 펼친다 (성장처럼 스무 줄이 나오는 기록) */
function EventLine({ event }: { event: CalEvent }) {
  const [open, setOpen] = useState(false);
  const details = event.details ?? [];
  return (
    <div className="cal-detail-line">
      <button
        className={`ev-row${details.length > 0 ? " expandable" : ""}${open ? " open" : ""}`}
        type="button"
        disabled={details.length === 0}
        onClick={() => setOpen((v) => !v)}
      >
        <EventIcon kind={event.kind} />
        <span className="ev-text">{event.text}</span>
        {details.length > 0 && <span className="ev-count">{details.length}</span>}
      </button>
      {open && (
        <div className="ev-details">
          {details.map((d, i) => (
            <div key={i}>{d}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CalendarView({ calendar }: { calendar: OfficeViews["calendar"] }) {
  const [selected, setSelected] = useState<string | null>(null);

  // 날짜 → 일정 엔트리 목록 (한 날에 여러 개 가능: 훈련 오전/오후 + 경기)
  const byDate = useMemo(() => {
    const map = new Map<string, CalEntry[]>();
    for (const e of calendar.entries) {
      const list = map.get(e.date) ?? [];
      list.push(e);
      map.set(e.date, list);
    }
    return map;
  }, [calendar.entries]);

  // 달력 범위 — 프리시즌 시작(7/1)부터 시즌 마지막 경기까지
  const start = new Date(`${calendar.preseasonStart}T00:00:00Z`);
  const end = new Date(`${calendar.seasonEnd}T00:00:00Z`);
  const months: Array<{ year: number; month: number }> = [];
  let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const stop = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cur <= stop) {
    months.push({ year: cur.getUTCFullYear(), month: cur.getUTCMonth() });
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
  }

  const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
  const dowOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
  const matchOf = (iso: string) => byDate.get(iso)?.find((e) => e.type === "match");
  const trainingOf = (iso: string) => (byDate.get(iso) ?? []).filter((e) => e.type === "training");
  // 아직 추첨 전인 컵 라운드 — 상대는 몰라도 **날짜는 공표돼 있다**.
  // 그 주의 로테이션을 계획하려면 점이 아니라 칸에 보여야 한다.
  const pendingRoundOf = (iso: string) => byDate.get(iso)?.find((e) => e.type === "cup-round");
  // 훈련도 경기도 아닌 일정(추첨·이적창) — 칸에는 점 하나로만 오른다
  const otherOf = (iso: string) =>
    (byDate.get(iso) ?? []).filter(
      (e) => e.type !== "training" && e.type !== "match" && e.type !== "cup-round",
    );

  const detail = selected
    ? {
        iso: selected,
        dow: dowOf(selected),
        entries: byDate.get(selected) ?? [],
        events: calendar.events[selected] ?? [],
        isPast: selected < calendar.today,
      }
    : null;

  const openWindow = calendar.windows.find((w) => w.open);

  // 상세는 고른 날이 있는 **그 달 카드 안**에 펼친다 — 화면 맨 위에 두면
  // 3월 칸을 눌러도 패널이 시야 밖에서 열려 아무 일도 안 난 것처럼 보인다
  const detailPanel = detail && (
    <div className="cal-detail" data-testid="cal-detail">
      <div className="cal-detail-head">
        <b>
          {detail.iso} ({WEEK[detail.dow]})
        </b>
        <button className="ghost-btn" onClick={() => setSelected(null)}>
          닫기
        </button>
      </div>

      {detail.entries.length > 0 && (
        <div className="cal-detail-block">
          <div className="cal-detail-title">일정</div>
          {detail.entries.map((e) => (
            <div className="cal-detail-sub" key={e.id}>
              {e.time} · {e.title}
              {e.detail ? ` — ${e.detail}` : ""}
              {/* 훈련 성과는 아래 "기록"이 접었다 펼치며 말한다 — 여기서 또 쓰면
                  같은 화면이 같은 말을 두 번 한다. 경기 스코어는 여기가 유일하다 */}
              {e.result && e.type !== "training" ? ` · ${e.result}` : ""}
            </div>
          ))}
        </div>
      )}

      {detail.events.length > 0 && (
        <div className="cal-detail-block">
          <div className="cal-detail-title">기록</div>
          {detail.events.map((e, i) => (
            <EventLine event={e} key={i} />
          ))}
        </div>
      )}

      {detail.entries.length === 0 && detail.events.length === 0 && (
        <div className="cal-detail-sub">일정 없음</div>
      )}
    </div>
  );

  return (
    <div data-testid="view-calendar">
      <div className="cal-legend">
        <span className="section-title">시즌 일정</span>
        {/* 이적창 상태만 — 훈련 지시 안내는 빈 날 상세에서만 말한다 */}
        <span className="cal-focus">
          {openWindow
            ? `${openWindow.kind} 이적시장 열림 (~${openWindow.closesOn})`
            : "이적시장 닫힘"}
        </span>
      </div>

      <div className="cal-months">
        {months.map(({ year, month }) => {
          const first = new Date(Date.UTC(year, month, 1));
          const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
          const lead = first.getUTCDay();
          const cells: Array<{ day: number; iso: string } | null> = [];
          for (let i = 0; i < lead; i++) cells.push(null);
          for (let d = 1; d <= daysInMonth; d++) {
            cells.push({ day: d, iso: isoOf(new Date(Date.UTC(year, month, d))) });
          }
          const hasDetail = detail !== null && detail.iso.slice(0, 7) === isoOf(first).slice(0, 7);
          return (
            <div className="cal-month" key={`${year}-${month}`}>
              <div className="cal-month-title">
                {year}년 {month + 1}월
              </div>
              <div className="cal-grid">
                {WEEK.map((w) => (
                  <div className="cal-dow" key={w}>
                    {w}
                  </div>
                ))}
                {cells.map((cell, i) => {
                  if (!cell) return <div className="cal-cell empty" key={i} />;
                  const mt = matchOf(cell.iso);
                  const win = mt?.win ?? null;
                  const isToday = cell.iso === calendar.today;
                  // 훈련과 휴식은 뜻이 반대라 점을 나눈다 — 같은 노랑이면 감독이
                  // 비워 둔 주를 달력에서 훑을 수 없다.
                  // **소화한 훈련도 그대로 남긴다** — 예전엔 scheduled만 그려서 지난
                  // 훈련이 달력에서 통째로 사라졌다. 훈련한 주와 쉰 주를 되돌아볼 수
                  // 없으면 달력이 계획표일 뿐 기록이 아니게 된다.
                  const sessions = trainingOf(cell.iso);
                  const trainings = sessions.filter((e) => !e.rest);
                  const rests = sessions.filter((e) => e.rest);
                  // 그날 결산이 남긴 성과 — 있으면 점을 채워 구분한다
                  const gained = trainings.some((e) => e.result !== null);
                  const others = otherOf(cell.iso);
                  const pending = pendingRoundOf(cell.iso);
                  const dow = dowOf(cell.iso);
                  return (
                    <button
                      className={[
                        "cal-cell",
                        isToday ? "today" : "",
                        selected === cell.iso ? "selected" : "",
                        mt ? "has-match" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      key={i}
                      onClick={() => setSelected(cell.iso)}
                      data-testid={mt ? `cal-fixture-${cell.iso}` : `cal-day-${cell.iso}`}
                      title={
                        (byDate.get(cell.iso) ?? []).map((e) => e.title).join(" · ") || undefined
                      }
                    >
                      <div className={`cal-day${dow === 0 ? " sun" : dow === 6 ? " sat" : ""}`}>
                        {cell.day}
                      </div>
                      {/* 미진행 경기엔 "예정"을 적지 않는다 — 스코어가 비어 있는 게 곧 예정이다 */}
                      {mt?.match && (
                        <div
                          className={`cal-fx${win ? ` r-${win}` : ""}${mt.isNext ? " next" : ""}`}
                        >
                          {mt.match.competition && (
                            <span className="cal-fx-comp">{mt.match.competition}</span>
                          )}
                          {/* 좁은 칸이라 상대는 약칭(LIV), 홈·원정은 한 글자(홈/원/중).
                              풀네임과 "원정"이라는 말은 툴팁·상세 패널에 있다 */}
                          <span className="cal-fx-opp">
                            <span className={`cal-fx-venue ${mt.match.venue}`}>
                              {mt.match.venue === "home"
                                ? "홈"
                                : mt.match.venue === "away"
                                  ? "원"
                                  : "중"}
                            </span>
                            {mt.match.opponent}
                          </span>
                          {mt.match.score && <span className="cal-fx-score">{mt.match.score}</span>}
                        </div>
                      )}
                      {/* 추첨 전이라 상대는 비어 있지만 라운드 날짜는 이미 안다 */}
                      {!mt && pending?.cup && (
                        <div className="cal-fx pending" data-testid={`cal-round-${cell.iso}`}>
                          <span className="cal-fx-comp">{pending.cup.competition}</span>
                          <span className="cal-fx-opp">{pending.cup.stage}</span>
                        </div>
                      )}
                      {/* 표식은 "달력에서 알아야 할 것"만 — 매일 쌓이는 기록 점은
                          정보가 아니라 얼룩이라 상세 패널에만 둔다.
                          훈련은 노란 점, 추첨은 보라 점, 그 밖(이적창)은 파란 점 —
                          무슨 일정인지는 툴팁과 칸을 눌러 여는 상세가 말한다 */}
                      <div className="cal-marks">
                        {trainings.length > 0 && (
                          <span
                            className={`cal-mark train${gained ? " gained" : ""}`}
                            title={trainings
                              .map((e) => (e.result ? `${e.title} — ${e.result}` : e.title))
                              .join("\n")}
                            data-testid={`cal-train-${cell.iso}`}
                          />
                        )}
                        {rests.length > 0 && (
                          <span
                            className="cal-mark rest"
                            title={rests.map((e) => e.title).join(" · ")}
                            data-testid={`cal-rest-${cell.iso}`}
                          />
                        )}
                        {others.map((e) => (
                          <span
                            className={`cal-mark ${e.type === "draw" ? "draw" : "event"}`}
                            key={e.id}
                            title={e.title}
                            data-testid={
                              e.type === "draw" ? `cal-draw-${cell.iso}` : `cal-event-${cell.iso}`
                            }
                          />
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
              {hasDetail && detailPanel}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── 재정 (요약 카드 + 실시간 활동 + 월간 보고서) ─────────────
type FinanceMonth = OfficeViews["finance"]["current"];

const signed = (v: number) => `${v >= 0 ? "+" : "−"}${money(Math.abs(v))}`;

/** 한 달 — 마감된 보고서와 진행 중인 이번 달이 같은 모양을 쓴다 */
function FinanceMonthCard({ month }: { month: FinanceMonth }) {
  return (
    <div className="fin-month" data-testid={`fin-month-${month.month}`}>
      <div className="fin-month-head">
        <b>
          {month.month}
          {!month.closed && <span className="fin-tag">진행 중</span>}
        </b>
        <span className={month.cashNet >= 0 ? "fin-net plus" : "fin-net minus"}>
          {signed(month.cashNet)}
        </span>
      </div>
      <div className="fin-meta">
        장부 손익 {signed(month.pnlNet)} · 급여 비중{" "}
        <b className={month.wageRatio >= 0.75 ? "danger" : month.wageRatio >= 0.65 ? "warn" : ""}>
          {Math.round(month.wageRatio * 100)}%
        </b>
      </div>
      <div className="fin-cols">
        <div className="fin-col">
          <div className="fin-col-title income">수입 {money(month.incomeTotal)}</div>
          {month.income.map((item) => (
            <div className="fin-line" key={item.category}>
              <span>{item.label}</span>
              <span>{money(item.amount)}</span>
            </div>
          ))}
          {month.income.length === 0 && <div className="fin-line muted">수입 없음</div>}
        </div>
        <div className="fin-col">
          <div className="fin-col-title expense">지출 {money(month.expenseTotal)}</div>
          {month.expense.map((item) => (
            <div className="fin-line" key={item.category}>
              <span>
                {item.label}
                {item.category === "amortisation" && <span className="fin-tag">장부</span>}
              </span>
              <span>{money(item.amount)}</span>
            </div>
          ))}
          {month.expense.length === 0 && <div className="fin-line muted">지출 없음</div>}
        </div>
      </div>
      {month.notes.map((note) => (
        <div className="fin-note" key={note}>
          {note}
        </div>
      ))}
    </div>
  );
}

export function FinanceView({ finance }: { finance: OfficeViews["finance"] }) {
  return (
    <div data-testid="view-finance">
      <div className="finance-cards">
        <div className="finance-card">
          <div className="label">구단 잔고</div>
          <div className="value">{money(finance.balance)}</div>
        </div>
        <div className="finance-card">
          <div className="label">주간 주급</div>
          <div className="value">{money(finance.weeklyWages)}</div>
        </div>
        <div className="finance-card">
          <div className="label">이적 예산</div>
          <div className="value">
            {money(finance.transferBudget)}
            {finance.budgetFrozen && <span className="fin-tag danger">동결</span>}
          </div>
        </div>
        <div className="finance-card">
          <div className="label">시즌 급여 비중</div>
          <div className="value">
            {Math.round(finance.wageRatio * 100)}%
            <span className="fin-sub">
              {finance.stadium.name} {finance.stadium.capacity.toLocaleString("en-US")}석
            </span>
          </div>
        </div>
      </div>

      {finance.psr && (
        <div className="fin-psr" data-testid="fin-psr">
          <span>PSR (3시즌 누적 손익)</span>
          <span>
            {signed(finance.psr.rolling3Season)} · 여유{" "}
            <b className={finance.psr.headroom < 0 ? "danger" : ""}>
              {money(finance.psr.headroom)}
            </b>
          </span>
        </div>
      )}
      <div className="fin-board">보드 평가: {finance.boardExpectation}</div>

      <div className="section-title">재정 활동</div>
      {finance.feed.length === 0 && <div className="empty">아직 기록이 없습니다</div>}
      {finance.feed.length > 0 && (
        <div className="fin-feed" data-testid="fin-feed">
          {finance.feed.map((entry) => (
            <div className="fin-feed-row" key={entry.id}>
              <span className="date">{entry.date.slice(5)}</span>
              <span className="cat">{entry.categoryLabel}</span>
              <span className="label">{entry.label}</span>
              <span className={entry.kind === "income" ? "amt plus" : "amt minus"}>
                {entry.kind === "income" ? "+" : "−"}
                {money(entry.amount)}
                {entry.noncash && <span className="fin-tag">장부</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="section-title">월간 재정 보고서</div>
      <FinanceMonthCard month={finance.current} />
      {finance.reports.map((month) => (
        <FinanceMonthCard month={month} key={month.month} />
      ))}
    </div>
  );
}

// ── 대회 — 대회별 탭 · 순위표 · 라운드별 일정 ──────────────
type Competition = OfficeViews["competitions"]["list"][number];

/** 순위표 — 리그는 그대로, 대항전은 통과 경계선을 긋는다 */
function StandingsTable({ competition, teamName }: { competition: Competition; teamName: string }) {
  // 순위표를 갖는 대회는 리그와 대항전 리그 페이즈뿐이다 (국내 컵은 브래킷을 본다)
  const europe = competition.europe;
  const zones = competition.zones;
  // 순위 → 그 순위가 속한 구역 (없으면 아무 뜻도 없는 자리)
  const zoneAt = (rank: number) => zones.find((z) => rank <= z.through) ?? null;
  return (
    <table data-testid={europe ? "europe-standings" : "standings"}>
      <thead>
        <tr>
          <th>#</th>
          <th>팀</th>
          <th>경기</th>
          <th>승</th>
          <th>무</th>
          <th>패</th>
          <th>득실</th>
          <th>승점</th>
        </tr>
      </thead>
      <tbody>
        {competition.standings.map((row, i) => {
          const zone = zoneAt(i + 1);
          return (
            <tr
              key={row.teamId}
              className={[
                row.name === teamName ? "me" : "",
                zone ? `zone zone-${zone.kind}` : "",
                // 구역의 마지막 행 아래에 선을 긋는다 — 4위와 5위의 차이가 한 계단이 아니다
                zone && zone.through === i + 1 ? "cut" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-testid={zone ? `standing-zone-${zone.kind}` : undefined}
            >
              {/* 순위 앞의 색 띠가 구역이다 — 무슨 구역인지는 툴팁과 표 아래 범례에 있다 */}
              <td title={zone?.label}>{i + 1}</td>
              <td className="team-cell">{row.name}</td>
              <td>{row.played}</td>
              <td>{row.wins}</td>
              <td>{row.draws}</td>
              <td>{row.losses}</td>
              <td>{row.goalDiff > 0 ? `+${row.goalDiff}` : row.goalDiff}</td>
              <td>
                <b>{row.points}</b>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * 구역 범례 — 색만으로는 "몇 위까지가 챔스인지" 알 수 없다.
 * 조작 안내가 아니라 데이터라서 화면에 둔다 (색 · 이름 · 순위 범위).
 */
function ZoneLegend({ zones }: { zones: Competition["zones"] }) {
  if (zones.length === 0) return null;
  return (
    <div className="zone-legend" data-testid="zone-legend">
      {zones.map((z, i) => {
        const from = i === 0 ? 1 : (zones[i - 1]?.through ?? 0) + 1;
        return (
          <span className={`zone-key zone-${z.kind}`} key={z.kind}>
            {z.label} {from === z.through ? `${from}위` : `${from}~${z.through}위`}
          </span>
        );
      })}
    </div>
  );
}

/** 라운드 하나의 경기 목록 — 라운드 선택기로 오간다 */
function RoundFixtures({ competition }: { competition: Competition }) {
  const rounds = competition.rounds;
  const currentIndex = Math.max(
    0,
    rounds.findIndex((r) => r.current),
  );
  const [picked, setPicked] = useState<number | null>(null);
  // 대회를 바꾸면 선택을 놓아 그 대회의 현재 라운드로 돌아간다
  const [ownerId, setOwnerId] = useState(competition.id);
  if (ownerId !== competition.id) {
    setOwnerId(competition.id);
    setPicked(null);
  }
  const index = Math.min(picked ?? currentIndex, rounds.length - 1);
  const round = rounds[index];
  if (!round) return <div className="empty">아직 편성된 일정이 없습니다</div>;

  return (
    <div data-testid="round-fixtures">
      <div className="round-nav">
        <button
          onClick={() => setPicked(Math.max(0, index - 1))}
          disabled={index === 0}
          aria-label="이전 라운드"
        >
          ◀
        </button>
        <select
          value={index}
          onChange={(e) => setPicked(Number(e.target.value))}
          data-testid="round-select"
        >
          {rounds.map((r, i) => (
            <option value={i} key={r.key}>
              {r.label}
              {r.current ? " (현재)" : ""}
            </option>
          ))}
        </select>
        <button
          onClick={() => setPicked(Math.min(rounds.length - 1, index + 1))}
          disabled={index === rounds.length - 1}
          aria-label="다음 라운드"
        >
          ▶
        </button>
      </div>
      <div className="fixture-list">
        {round.matches.map((m) => (
          <div className={`fixture${m.ours ? " ours" : ""}`} key={m.id}>
            <span className="when">
              {m.date.slice(5)} <span className="hide-sm">{m.time}</span>
            </span>
            <span className="side home">{m.homeName}</span>
            <span className={`mid${m.score ? " played" : ""}`}>
              {m.score ?? "vs"}
              {m.win && <b className={`wdl ${m.win}`}>{m.win}</b>}
            </span>
            <span className="side away">{m.awayName}</span>
            {m.neutral && <span className="fin-tag">중립</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 다음 경기 한 칸 — **경기 중에는 달력 대신 이것만 본다.**
 *
 * 90분 안에 감독이 일정에서 궁금한 것은 하나뿐이다: 이 경기가 끝나면 다음은
 * 언제 누구인가. 달력을 통째로 세우면 그 한 줄을 찾으러 스크롤해야 한다.
 *
 * **며칠 남았는지를 크게 적는다** — 체력이 자리마다 다르게 깎이고 회복이 며칠에
 * 걸리므로(match-sim §2.1.1) "사흘 뒤"는 곧 로테이션 판단이다. 날짜만 적으면
 * 감독이 오늘 날짜와 빼서 세야 한다.
 */
function NextFixture({ next }: { next: OfficeViews["competitions"]["nextMatch"] }) {
  if (!next) return null;
  const venue = next.venue === "home" ? "홈" : next.venue === "away" ? "원정" : "중립";
  return (
    <div className="next-fixture" data-testid="next-fixture">
      <span className="nf-when">
        <b>{next.inDays === 0 ? "오늘" : `${next.inDays}일 뒤`}</b>
        <i>
          {next.date} {next.time}
        </i>
      </span>
      <span className="nf-what">
        <b>
          <em className={`nf-venue ${next.venue}`}>{venue}</em> {next.opponent}
        </b>
        <i>{next.label}</i>
      </span>
    </div>
  );
}

export function CompetitionsView({
  competitions,
  teamName,
}: {
  competitions: OfficeViews["competitions"];
  teamName: string;
}) {
  const list = competitions.list;
  const [activeId, setActiveId] = useState(list[0]?.id ?? "");
  const active = list.find((c) => c.id === activeId) ?? list[0];

  return (
    <div data-testid="view-competitions">
      {list.length > 1 && (
        <div className="comp-tabs" data-testid="comp-tabs">
          {list.map((c) => (
            <button
              key={c.id}
              className={active?.id === c.id ? "active" : ""}
              onClick={() => setActiveId(c.id)}
              data-testid={`comp-tab-${c.id}`}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      {!active && <div className="empty">참가 중인 대회가 없습니다</div>}
      {active && (
        <>
          <div className="comp-head">
            <b>{active.name}</b>
            <span>
              {/* 국내 컵은 순위표가 없다 — 순위 대신 어디까지 갔는지를 말한다 */}
              {active.standings.length === 0
                ? cupProgress(active)
                : active.userPosition > 0
                  ? `${active.europe ? "리그 페이즈 " : ""}${active.userPosition}위`
                  : "순위 없음"}
              {/* 추첨 전이면 "남은 경기 없음"이 아니라 아직 시작을 안 한 것이다 */}
              {active.next
                ? ` · 다음 ${active.next}`
                : active.bracket.length === 0 && active.standings.length === 0
                  ? ""
                  : " · 남은 경기 없음"}
            </span>
          </div>

          {/* 순수 녹아웃(국내 컵)엔 순위표가 없다 — 브래킷이 그 자리를 대신한다 */}
          {active.standings.length > 0 && (
            <>
              <div className="section-title">순위</div>
              <StandingsTable competition={active} teamName={teamName} />
              <ZoneLegend zones={active.zones} />
            </>
          )}

          {active.bracket.length > 0 && <BracketSection bracket={active.bracket} />}
          {active.bracket.length === 0 && active.standings.length === 0 && (
            <div className="empty">대진 추첨을 기다리는 중입니다</div>
          )}

          {/* 순수 녹아웃은 브래킷이 곧 일정표다 — 같은 대진을 두 번 늘어놓지 않는다.
              리그·대항전은 브래킷이 못 담는 라운드(리그 페이즈)가 있어 따로 둔다 */}
          {active.standings.length > 0 && (
            <>
              <div className="section-title">일정</div>
              <RoundFixtures competition={active} />
            </>
          )}

          {competitions.recentResults.length > 0 && (
            <>
              <div className="section-title">최근 결과</div>
              {competitions.recentResults.map((r, i) => (
                <div className="recent-line" key={i}>
                  {r}
                </div>
              ))}
            </>
          )}
        </>
      )}

      {/* 다음 경기는 **맨 아래**다 — 이 화면에 온 이유는 순위표이고, 다음 상대는
          다 읽고 나서 "그래서 언제 누구지"로 이어지는 자리다 */}
      {competitions.nextMatch && (
        <>
          <div className="section-title">다음 경기</div>
          <NextFixture next={competitions.nextMatch} />
        </>
      )}
    </div>
  );
}

/**
 * 컵에서 우리가 어디까지 갔는가 — 순위표가 없는 대회의 "현재 위치".
 * 브래킷에서 우리 대진이 마지막으로 나온 단계를 읽는다.
 */
function cupProgress(competition: Competition): string {
  const ours = competition.bracket.filter((stage) => stage.ties.some((t) => t.ours));
  const last = ours[ours.length - 1];
  if (!last) return competition.bracket.length === 0 ? "추첨 전" : "탈락";
  const tie = last.ties.find((t) => t.ours)!;
  if (tie.won === false) return `${last.label} 탈락`;
  if (tie.won === true && last.stage === "final") return "우승";
  return `${last.label} 진출`;
}

/** 녹아웃 브래킷 — 단계별 대진 (2차전 합계는 엔진이 계산해 넘긴다) */
function BracketSection({ bracket }: { bracket: Competition["bracket"] }) {
  return (
    <div data-testid="europe">
      {bracket.map((stage) => (
        <div key={stage.stage} className="euro-stage">
          <div className="section-title">{stage.label}</div>
          {stage.ties.map((tie, i) => (
            <div
              key={i}
              className={`euro-tie${tie.ours ? " ours" : ""}`}
              data-testid={tie.ours ? "euro-tie-ours" : undefined}
            >
              <span className="euro-when">{tie.date.slice(5)}</span>
              <span className="euro-teams">
                {tie.home} vs {tie.away}
              </span>
              <span className="euro-score">
                {tie.score ?? "예정"}
                {tie.won === true && " ✓"}
                {tie.won === false && " ✕"}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── 커리어 ──────────────────────────────────────────────
export function CareerView({
  squad,
  career,
}: {
  squad: OfficeViews["squad"];
  career: OfficeViews["career"];
}) {
  return (
    <div data-testid="view-career">
      {/**
       * 감독 — **상자에 담지 않는다.**
       *
       * 카드로 두면 이 화면에서 유일하게 배경을 가진 덩어리가 되어 "여기가 제일
       * 중요하다"고 말하는데, 커리어 화면의 주인은 트로피·업적·시즌 기록이다.
       * 게다가 카드는 폭을 다 쓰든 좁히든 어느 쪽이든 어색했다 — 넓히면 가운데가
       * 비고, 좁히면 아래 섹션과 왼쪽 끝이 어긋났다. 상자를 걷으면 그 문제가
       * 아예 없다: 이름·배경·평판은 그냥 페이지의 머리글이다.
       */}
      <div className="mgr-head">
        <div className="mgr-info">
          <h3>{squad.manager.name} 감독</h3>
          <div className="bg">{squad.manager.background}</div>
          {/**
           * 평판 — 감독의 능력이 아니라 **세계가 그를 보는 눈**이라 오각형과 같은
           * 무게로 그리지 않는다. 다만 셋을 견주는 값이라 막대가 읽기 편하다:
           * **짧은 막대 셋을 한 줄로** 눕혀 눈금은 주되 자리는 덜 차지한다.
           */}
          <div className="mgr-rep">
            <div className="mgr-rep-title">평판</div>
            <div className="mgr-rep-items">
              {(
                [
                  ["보드", squad.manager.reputation.board],
                  ["언론", squad.manager.reputation.media],
                  ["선수단", squad.manager.reputation.squad],
                ] as const
              ).map(([label, value]) => (
                <span className="rep-item" key={label}>
                  <span className="rep-label">{label}</span>
                  <span className="rep-bar">
                    <i style={{ width: `${value}%` }} />
                  </span>
                  <b>{value}</b>
                </span>
              ))}
            </div>
          </div>
        </div>
        <ManagerRadar attributes={squad.manager.attributes} />
      </div>

      <div className="section-title">트로피 보관함</div>
      <div className="trophy-list">
        {career.trophies.length === 0 && <div className="empty">아직 트로피가 없습니다</div>}
        {career.trophies.map((t, i) => (
          <div className="trophy" key={i}>
            🏆 {t.competition} — 시즌 {t.season} ({t.teamName})
          </div>
        ))}
      </div>

      <div className="section-title">업적</div>
      <div className="trophy-list">
        {career.achievements.length === 0 && <div className="empty">달성한 업적이 없습니다</div>}
        {career.achievements.map((a, i) => (
          <div className="achv" key={i}>
            <div>{a.name}</div>
            <div className="desc">
              시즌 {a.season} — {a.description}
            </div>
          </div>
        ))}
      </div>

      <div className="section-title">시즌 기록</div>
      {career.seasons.length === 0 ? (
        <div className="empty">첫 시즌 진행 중</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>시즌</th>
              <th>팀</th>
              <th>순위</th>
              <th>전적</th>
            </tr>
          </thead>
          <tbody>
            {career.seasons.map((s) => (
              <tr key={s.season}>
                <td>{s.season}</td>
                <td>{s.teamName}</td>
                <td>{s.position}위</td>
                <td>{s.record}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
