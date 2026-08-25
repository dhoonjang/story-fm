"use client";

import { Fragment, useMemo } from "react";
import { ConditionBar } from "@/components/condition-bar";
import { moodSentence } from "@/lib/mood";
import { FitGauge, FormArrow, Margin, StatusBadges, ovrTitle } from "./marks";
import { TIER_SLUG, type SquadRow, type Tier } from "./types";

/**
 * 정렬 기준 — `role`이 **기본이자 돌아오는 자리**다 (칸 → 라인 → OVR).
 *
 * 이름순은 없앴다. 다른 기준으로 흩어 놓은 명단을 **칸 순으로 되돌릴 손잡이가
 * 없었고**, 스물몇 명짜리 표에서 이름으로 찾는 일은 칸으로 찾는 일보다 드물다 —
 * 첫 칸(선수)이 그 되돌리는 자리를 맡는다.
 */
export type SortKey =
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
export function SquadTable({
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
          return p.condition.value;
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
    // `tierKey`는 `tierOf`가 **무엇을 답하는지**를 대신하는 문자열이다 — 함수는
    // 같은 것이 계속 오므로 이게 없으면 자리 이동이 정렬에 반영되지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, sort, tierOf, tierKey]);

  /**
   * 정렬 머리 — **누르는 것은 안쪽 버튼이고, `<th>`는 열 머리로 남는다.**
   *
   * `<th>`에 `role="button"`을 얹으면 열 머리가 아니게 되어 `aria-sort`가 성립하지
   * 않는다. 지금 어느 열로 어느 방향으로 정렬돼 있는지는 화살표(▲▼)와 `aria-sort`가
   * 같은 사실을 말하고, 버튼이라 탭 키로 닿고 Enter·Space로 눌린다.
   */
  const th = (key: SortKey, label: string, className?: string, title?: string) => (
    <th
      className={`sortable ${className ?? ""}${sort.key === key ? " sorted" : ""}`}
      aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}
    >
      <button type="button" className="sort-btn" onClick={() => onSort(key)} title={title}>
        {label}
        {sort.key === key && <span className="sort-mark">{sort.desc ? "▼" : "▲"}</span>}
      </button>
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
              /**
               * 행을 누르면 상세가 펼쳐진다 — 손가락이든 키보드든 같은 조작이다.
               *
               * `role="button"`은 얹지 않는다: 이 행은 안에 제 버튼(교체 화살표)을
               * 품고 있어 버튼 안의 버튼이 되고, 칸들이 표의 칸이 아니게 된다.
               * 열린 상태는 `aria-expanded`가 말한다 — 행(`role="row"`)이 그대로
               * 가질 수 있는 속성이다.
               */
              tabIndex={0}
              aria-expanded={renderDetail ? selectedId === p.id : undefined}
              onClick={() => onSelect(p.id)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(p.id);
                }
              }}
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
                  {p.squadNumber !== null && (
                    <i className="shirt-no" title={`${p.squadNumber}번`}>
                      {p.squadNumber}
                    </i>
                  )}
                  {p.isCaptain ? "Ⓒ " : ""}
                  {p.name}
                </span>
                {/* 국적 — **표식이 아니라 사실**이라 알약이 아니다. 등록 표식(HG·U21)과
                    같은 모양으로 두면 "이 선수가 무엇에 해당한다"로 읽힌다 */}
                {p.nationality !== null && (
                  <span
                    className="nat"
                    title={
                      p.secondNationality === null
                        ? p.nationality
                        : `${p.nationality} · ${p.secondNationality}`
                    }
                  >
                    {p.nationality}
                  </span>
                )}
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
               * 쓰이는 값이 그것이기 때문이다. 주 포지션 기준값으로 두면 자리를
               * 옮기거나 역할을 바꿔도 명단의 숫자가 꿈쩍하지 않는다.
               * 값도 문구도 **전술판 칩과 같다**(`slotOverallOf`) — 같은 선수의
               * OVR이 왼쪽과 오른쪽에서 다르면 규칙이 없어 보인다.
               */}
              <td title={ovrTitle(p)}>
                {p.slotOverall ?? p.overall}
                <Margin observation={p.observation} />
              </td>
              {/* 적응 — **하나의 값**이다. "자리 적응 N · 전술 적응 N"으로
                  분해해 보여주면 감독이 결국 두 축을 머리로 합쳐야 한다 */}
              <td
                className="hide-sm"
                title={`${p.assignedPosition ?? p.position} 자리에서의 적응도`}
              >
                {p.role === "스쿼드" ? "—" : <FitGauge value={p.adaptation} label="적응도" />}
              </td>
              <td>
                <FormArrow p={p} />
              </td>
              {/* 사기·피로를 하나로 합친 값 — 왜 이 값인지는 행을 펼치면 한 문장으로 나온다.
                  경기 중에는 판세 탭과 같은 읽은 값이라 막대에 모르는 폭이 붙는다 */}
              <td title={moodSentence(p.mood)}>
                <ConditionBar c={p.condition} />
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
