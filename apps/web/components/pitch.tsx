"use client";

import type { CSSProperties, PointerEvent, ReactNode, Ref } from "react";

/**
 * ── 전술판 ────────────────────────────────────────────────
 *
 * **우리 판과 상대 판은 같은 판이다.** 감독은 경기 중 두 화면을 번갈아 보며
 * 견주므로, 칩 한 줄의 구성이 갈리면 같은 것을 두 번 배워야 한다. 예전에는 두
 * 파일이 각자 세 줄을 그렸고, 이름 옆에 등번호를 붙이는 손질이 우리 판에만
 * 들어가 상대 판에서는 이름이 잘린 채로 남았다.
 *
 * 여기가 **구조**를 갖는다 — 그라운드의 선, 칩의 세 줄, 성만 남기는 규칙.
 * 상태(고른 칩·못 뛰는 선수·지친 상대)는 부르는 쪽이 클래스로 얹는다.
 */

/** 칩에는 성만 — 전체 이름은 두 줄로 접혀 판이 어수선해진다 */
export const chipName = (name: string) => name.trim().split(/\s+/).at(-1) ?? name;

/**
 * 눈금은 **기본 배치의 칩 자리에 맞춰** 잡았다 — 보통(3)일 때 수비 라인은 센터백
 * 높이(75%)에, 폭은 윙어 자리(14%/86%)에 선다. 선이 칩과 어긋나 있으면 그림이
 * 배치를 설명하지 못하고 따로 도는 장식이 된다.
 */
const DEF_LINE_TOP = (v: number) => 87 - (v - 1) * 6;
const PRESS_LINE_TOP = (v: number) => 70 - (v - 1) * 11;
const WIDTH_INSET = (v: number) => 24 - (v - 1) * 5;

/** 자리를 뜻하는 세 축 — 판 위에 선으로 앉는 것들 */
export type PitchTacticsAxes = { defensiveLine: number; pressing: number; width: number };

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
function PitchTactics({ tactics }: { tactics: PitchTacticsAxes }) {
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
 * 그라운드 — 선 · 박스 · 전술선 · 라인 이름. 칩은 `children`으로 얹는다.
 *
 * 판을 감싸는 `pitch-wrap`까지 여기서 그린다: 판은 남는 높이에 맞춰 줄어드는데
 * 그 높이를 알려 주는 것이 이 칸이라, 둘이 갈리면 한쪽 판만 넘친다.
 */
export function PitchGround({
  boardRef,
  variant,
  testId,
  tactics,
  children,
}: {
  boardRef?: Ref<HTMLDivElement>;
  /** 판의 상태 클래스 — 편집 중(`editing`) 같은 것 */
  variant?: string;
  testId: string;
  tactics: PitchTacticsAxes;
  children: ReactNode;
}) {
  return (
    <div className="pitch-wrap">
      <div
        ref={boardRef}
        className={`pitch-board${variant ? ` ${variant}` : ""}`}
        data-testid={testId}
      >
        <div className="pitch-lines" />
        <div className="pitch-box top" />
        <div className="pitch-box small top" />
        <div className="pitch-box bottom" />
        <div className="pitch-box small bottom" />
        <PitchTactics tactics={tactics} />
        <span className="pitch-zone" style={{ top: "6%" }}>
          공격
        </span>
        <span className="pitch-zone" style={{ top: "46%" }}>
          중원
        </span>
        <span className="pitch-zone" style={{ top: "84%" }}>
          수비
        </span>
        {children}
      </div>
    </div>
  );
}

/** 역할 약칭 — 감독이 기본값 아닌 역할을 고른 칩에만 붙는다 */
export type PitchRoleTag = { abbr: string; ko: string; desc: string };

type PitchChipProps = {
  /** 만질 수 있는 칩은 버튼이다 — 상대 팀 칩처럼 읽기만 하는 것은 `span` */
  as?: "button" | "span";
  /** 지금 서 있는 자리 (좌표에서 나온 코드) */
  code: string | null;
  squadNumber?: number | null;
  roleTag?: PitchRoleTag | null;
  captain?: boolean;
  /** 전체 이름 — 칩에는 성만 남는다. 빈 자리는 `null` */
  name: string | null;
  /** 이 자리에서 내는 전력 */
  ovr: ReactNode;
  /** 전력 뒤에 서는 표식 — 오차·부상·경고 */
  metaExtra?: ReactNode;
  /** 상태 클래스 (`g-mf` · `selected` · `theirs` …) — 구조는 여기가, 상태는 부르는 쪽이 */
  variant?: string;
  style?: CSSProperties;
  title?: string;
  testId?: string;
  onPointerDown?: (e: PointerEvent<HTMLElement>) => void;
  onClick?: () => void;
};

/**
 * 칩 — **세 줄.** (번호 · 자리 · 역할) / (Ⓒ 이름) / (전력 · 표식)
 *
 * 등번호는 **자리 줄**에 선다. 이름 옆에 붙이던 때는 칩 폭(13cqw)에서 두 글자를
 * 빼앗아 다섯 자짜리 성이 통째로 잘렸다 — 자리 줄은 세 글자뿐이라 번호를 앉힐
 * 자리가 있다. 순서(번호 → 자리)는 명단 표와 같다.
 */
export function PitchChip({
  as = "span",
  code,
  squadNumber,
  roleTag,
  captain,
  name,
  ovr,
  metaExtra,
  variant,
  style,
  title,
  testId,
  onPointerDown,
  onClick,
}: PitchChipProps) {
  const body = (
    <>
      <span className="slot-pos">
        {squadNumber !== null && squadNumber !== undefined && (
          <i className="shirt-no">{squadNumber}</i>
        )}
        {/* 자리 코드는 자기 요소를 갖는다 — 한 줄에 번호·역할이 함께 서므로
            "이 칩의 자리"를 가리킬 자리가 하나 있어야 한다 */}
        <span className="slot-code">{code}</span>
        {roleTag && (
          <em className="slot-role" title={`${roleTag.ko} — ${roleTag.desc}`}>
            {roleTag.abbr}
          </em>
        )}
      </span>
      <span className="slot-name">
        {captain && <b className="slot-cap">Ⓒ</b>}
        {name ? chipName(name) : "—"}
      </span>
      <span className="slot-meta">
        <b>{ovr}</b>
        {metaExtra}
      </span>
    </>
  );
  const className = `pitch-slot pitch-chip${variant ? ` ${variant}` : ""}`;
  if (as === "button")
    return (
      <button
        className={className}
        style={style}
        title={title}
        data-testid={testId}
        onPointerDown={onPointerDown}
        onClick={onClick}
      >
        {body}
      </button>
    );
  return (
    <span className={className} style={style} title={title} data-testid={testId}>
      {body}
    </span>
  );
}
