"use client";

import { Fragment, useMemo } from "react";
import {
  INJURY_RISK_CAUSE_KO,
  INJURY_RISK_GRADE_KO,
  PROMISE_KIND_KO,
  SQUAD_STATUS_KO,
  squadStatusRank,
} from "@story-fm/domain";
import type { FatigueBand, InjuryRiskGrade } from "@story-fm/domain";
import { ConditionBar } from "@/components/condition-bar";
import { moodSentence } from "@/lib/mood";
import { Armband, FitGauge, FormArrow, Margin, StatusBadges, ovrTitle } from "./marks";
import { TIER_SLUG, type SquadRow, type Tier } from "./types";

/**
 * 정렬 기준 — `role`이 **기본이자 돌아오는 자리**다 (칸 → 라인 → OVR).
 *
 * 이름순은 없앴다. 다른 기준으로 흩어 놓은 명단을 **칸 순으로 되돌릴 손잡이가
 * 없었고**, 스물몇 명짜리 표에서 이름으로 찾는 일은 칸으로 찾는 일보다 드물다 —
 * 첫 칸(선수)이 그 되돌리는 자리를 맡는다.
 */
export type SortKey =
  | "role"
  | "position"
  | "status"
  | "overall"
  | "age"
  | "adaptation"
  | "form"
  | "condition"
  | "sharpness"
  | "load"
  | "risk"
  | "rating";
const ROLE_ORDER: Record<string, number> = { 선발: 0, 벤치: 1, 스쿼드: 2 };
/**
 * 칸 순서 — 정렬의 기준은 **지금 화면의 칸**이다.
 *
 * `SquadRow.role`은 서버가 아는 값이라 자동 저장이 돌아오기 전까지 예전 칸이다.
 * 그걸로 정렬하면 선수를 벤치로 내려도 명단에서는 한 박자 뒤에야 자리를 옮긴다.
 */
const TIER_ORDER: Record<Tier, number> = { 선발: 0, 벤치: 1, 예비: 2, "2군": 3, 임대: 4 };
const GROUP_ORDER: Record<string, number> = { GK: 0, DF: 1, MF: 2, FW: 3 };
/** 위험 열의 정렬 — 큰 수가 위태롭다. 기본 방향(내림)에서 높음이 맨 위에 선다 */
const RISK_ORDER: Record<InjuryRiskGrade, number> = { low: 0, elevated: 1, high: 2 };
/** 누적 피로 열의 정렬 — 같은 규약. 감독이 찾는 것은 맨 위의 과부하다 */
const LOAD_ORDER: Record<FatigueBand, number> = {
  clear: 0,
  building: 1,
  heavy: 2,
  overloaded: 3,
};

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
        // 서열은 도메인이 갖는다 — 화면이 다시 세우면 흥정의 한 칸과 갈린다
        case "status":
          return squadStatusRank(p.squadStatus) * 100 + p.overall;
        case "overall":
          return p.overall;
        case "age":
          return p.age;
        case "form":
          return p.form;
        case "condition":
          return p.condition.value;
        case "sharpness":
          return p.sharpness;
        // 등급 순 — 큰 수가 무겁다. 기본 방향(내림)에서 과부하가 맨 위에 선다
        case "load":
          return LOAD_ORDER[p.fatigueBand];
        // 등급 순 — 낮음이 맨 아래다. 같은 등급 안의 순서는 OVR이 아니라 안정 정렬이다
        case "risk":
          return RISK_ORDER[p.injuryRisk.grade];
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
          {/* 지위는 **읽는 값**이다 — 바꾸는 길은 협상 테이블이라(transfer.md §1)
              누를 것처럼 세우지 않고 나이·OVR과 같은 층의 글자로 둔다 */}
          {th("status", "지위", "hide-sm", "계약에 적힌 자리 — 기대 선발 비율이 여기서 나온다")}
          {th("age", "나이", "hide-sm")}
          {th("overall", "OVR")}
          {th("adaptation", "적응", "hide-sm", "지금 맡은 자리에서 이 전술을 얼마나 소화하는가")}
          {th("form", "폼")}
          {th("condition", "체력")}
          {/* 체력과 다른 축이다 — 잘 쉬어도 오래 못 뛰면 무뎌진다 (player.md §5.4) */}
          {th(
            "sharpness",
            "감각",
            "hide-sm",
            "경기 감각 — 출전 분이 올리고 결장이 깎는다. 체력과 다른 축이다",
          )}
          {/* 오늘의 몸이 아니라 시즌의 몸이다 — 하루 쉬어서 돌아오지 않는다 (player.md §5.5).
              ⚠️ 머리글이 「피로」가 아닌 이유는 이 화면에 그 낱말의 옛 뜻(= 100 − 체력)이
              있었기 때문이다 — 체력 옆에 나란히 서면 감독이 두 열을 서로의 역수로 읽는다 */}
          {th(
            "load",
            "누적",
            "hide-sm",
            "누적 피로 — 시즌이 쌓아 둔 잔고다. 회복을 늦추고 부상 위험을 올린다. 체력과 다른 축이다",
          )}
          {/* 다치기 전에 서는 유일한 열이다 — 체력 막대와 다른 축이다 (player.md §5.3) */}
          {th(
            "risk",
            "위험",
            "hide-sm",
            "부상 위험 — 경기가 누가 다칠지 고를 때 쓰는 저울이다. 체력·몸싸움·부상 이력이 함께 정한다",
          )}
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
                  <td colSpan={11} />
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
                      // 임대는 맞바꿀 수 있는 칸이 아니다 — 남의 훈련장에 있는 선수라
                      // 판에도 층에도 들어오지 못한다 (서버도 반려한다)
                      if (rowTier === "임대" || swapPair.tier === "임대") return null;
                      // 전술판(선발) 쪽으로 올라오면 ←, 내려가면 →
                      const RANK: Record<Tier, number> = {
                        선발: 3,
                        벤치: 2,
                        예비: 1,
                        "2군": 0,
                        임대: -1,
                      };
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
                  <Armband row={p} />
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
                {/*
                 * 임대는 **표식이 아니라 소속**이라 어디에 언제까지 가 있는지가
                 * 그 자리에 선다 — 상세를 펼쳐야 보이면 탭을 연 뜻이 없다.
                 * 연속 미출전은 툴팁의 사실로만 적는다("불러들이라"는 GM의 몫이다).
                 */}
                {p.loan !== null && (
                  <span
                    className="tag loan"
                    title={
                      `${p.loan.team} 임대 — ${p.loan.until} 복귀` +
                      (p.loan.benchRun > 0 ? ` · 최근 ${p.loan.benchRun}경기 명단 밖` : "") +
                      (p.loan.growth > 0 ? ` · 임대 이후 성장 +${p.loan.growth}` : "")
                    }
                  >
                    {p.loan.team} ~{p.loan.until.slice(2)}
                  </span>
                )}
                <StatusBadges p={p} />
                {/*
                 * 열린 약속 — **감독이 한 말에 기한이 붙어 있다**
                 * (docs/data/people.md §5-2). 적는 것은 갈래와 기한뿐이다: 무슨
                 * 말로 약속했는지는 장면의 것이고 장부는 그것을 들지 않는다.
                 * 임대 표식과 같은 모양인 이유도 같다 — 자격이 아니라 **언제까지
                 * 무엇을 해야 하는가**라, 좁은 화면에서도 이름 옆에 남는다.
                 */}
                {p.promises.map((promise) => (
                  <span
                    key={promise.kind}
                    className="tag st note"
                    title={`${PROMISE_KIND_KO[promise.kind]} 약속 — ${promise.dueOn}까지`}
                  >
                    {PROMISE_KIND_KO[promise.kind]} ~{promise.dueOn.slice(2)}
                  </span>
                ))}
              </td>
              {/* 지금 맡고 있는 자리를 그대로 보여준다 — 전술판에 RWB로 저장돼 있으면 RWB.
                "주 포지션과 다르다"는 표시는 하지 않는다 (적합도는 전술판의 적응도 숫자로 읽는다) */}
              <td>{p.assignedPosition ?? p.position}</td>
              {/* 계약에 적힌 자리 — 없으면 지금 서열에서 파생한 값이다(`squadStatusOf`) */}
              <td className="hide-sm">{SQUAD_STATUS_KO[p.squadStatus]}</td>
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
                {/* 임대 중에는 우리 전술을 익힐 자리가 없다 — 0이 아니라 빈 칸이다 */}
                {p.loan !== null || p.role === "스쿼드" ? (
                  "—"
                ) : (
                  <FitGauge value={p.adaptation} label="적응도" />
                )}
              </td>
              <td>
                <FormArrow p={p} />
              </td>
              {/* 사기·피로를 하나로 합친 값 — 왜 이 값인지는 행을 펼치면 한 문장으로 나온다.
                  경기 중에는 판세 탭과 같은 읽은 값이라 막대에 모르는 폭이 붙는다 */}
              <td title={moodSentence(p.mood)}>
                <ConditionBar c={p.condition} />
              </td>
              {/* 숫자가 아니라 등급이다 — 감독이 읽는 사실은 "최근에 뛰었나"이지 73이 아니다 */}
              <td className="hide-sm">
                <span className={`sharpness ${p.sharpnessBand}`}>{p.sharpnessLabel}</span>
              </td>
              {/* 「가뿐」은 글자를 세우지 않는다 — 위험 열과 같은 이유로, 스물몇 줄이
                  기본값으로 차면 정작 무거운 두 줄이 묻힌다 */}
              <td className="hide-sm">
                {p.fatigueBand === "clear" ? (
                  <span className="load clear">—</span>
                ) : (
                  <span className={`load ${p.fatigueBand}`}>{p.fatigueLabel}</span>
                )}
              </td>
              {/* 낮음은 글자를 세우지 않는다 — 스물몇 줄이 「낮음」으로 차면
                  정작 위태로운 두 줄이 그 안에 묻힌다 */}
              <td className="hide-sm">
                {p.injuryRisk.grade === "low" ? (
                  <span className="injury-risk low">—</span>
                ) : (
                  <span
                    className={`injury-risk ${p.injuryRisk.grade}`}
                    title={p.injuryRisk.causes.map((c) => INJURY_RISK_CAUSE_KO[c]).join(" · ")}
                  >
                    {INJURY_RISK_GRADE_KO[p.injuryRisk.grade]}
                  </span>
                )}
              </td>
              {/* 골 대신 평점 — 골 수는 행을 펼치면 시즌 기록에 그대로 있다 */}
              <td
                className="hide-sm"
                /* 임대 행의 시즌 기록은 **빌린 구단의 장부**다 — 어디서 낸 숫자인지를
                   함께 적지 않으면 우리 경기에서 낸 값으로 읽힌다 */
                title={
                  (p.loan !== null ? `${p.loan.team} · ` : "") +
                  `${p.seasonApps}경기 ${p.seasonGoals}골 ${p.seasonAssists}도움`
                }
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
                <td colSpan={11}>{renderDetail(p)}</td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
