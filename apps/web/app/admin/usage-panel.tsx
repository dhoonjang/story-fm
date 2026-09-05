"use client";

import { useCallback, useEffect, useState } from "react";
import type { UsageAgentRow, UsageResponse } from "./types";

/**
 * 계측 패널 — LLM 세션 장부를 세운다 (docs/llm/models.md §5-1).
 *
 * **여기서 계산하는 값은 없다.** 히트율도 예산 비율도 「프리픽스가 깨진 것으로
 * 보인다」도 라우트가 내고, 이 파일이 하는 일은 숫자에 자리를 주고 눈금을 붙이는
 * 것뿐이다 (docs/overview.md §5).
 *
 * 카탈로그 세 층과 달리 **여기 값은 서버 쪽에서 저 혼자 움직인다** — 감독이 턴을
 * 한 번 돌 때마다 늘어난다. 그래서 이 패널만 제 손으로 받고, 다시 받는 손잡이를
 * 함께 갖는다.
 */

const NUMBER = new Intl.NumberFormat("ko-KR");

function tokens(n: number): string {
  return NUMBER.format(Math.round(n));
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}초`;
}

/**
 * 히트율 칸 — **문턱 아래는 비율 대신 그렇게 적는다** (models.md §4).
 * 0%로 적으면 캐시가 애초에 안 걸리는 짧은 호출과 깨진 프리픽스가 한 모양이 된다.
 */
function CacheCell({ row }: { row: UsageAgentRow }) {
  if (row.calls === 0) return <span className="muted">—</span>;
  if (row.cacheHitRate === null) {
    return <span className="muted">문턱 아래 ({tokens(row.minCacheableInput)}↑)</span>;
  }
  return (
    <span className={row.cacheAlert ? "usage-alert" : undefined}>
      {percent(row.cacheHitRate)}
      {row.cacheAlert ? " ⚠️" : ""}
    </span>
  );
}

export function UsagePanel({ onError }: { onError: (e: string | null) => void }) {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/usage");
      if (!res.ok) throw new Error(`계측을 받지 못했습니다 (${res.status})`);
      setUsage((await res.json()) as UsageResponse);
      onError(null);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!usage) return <div className="admin-note">{busy ? "" : "계측을 받지 못했다"}</div>;

  const { totals, budget } = usage;
  return (
    <>
      <div className="admin-toolbar">
        <div className="usage-head">
          <span className="usage-chip">{usage.mode === "mock" ? "모의 GM" : "실모드"}</span>
          <span className="usage-chip">{usage.gameId ?? "열린 세이브 없음"}</span>
          <span className="usage-chip">
            호출 {NUMBER.format(totals.calls)}
            {totals.skipped > 0 ? ` · 건너뜀 ${NUMBER.format(totals.skipped)}` : ""}
          </span>
          <span className="usage-chip">누적 {tokens(totals.billed)} 토큰</span>
          <span className={`usage-chip${budget.over ? " usage-alert" : ""}`}>
            {budget.limit === null
              ? "예산 무제한"
              : `예산 ${tokens(budget.used)} / ${tokens(budget.limit)} (${percent(budget.ratio)})`}
          </span>
        </div>
        <div className="admin-toolbar-right">
          <button className="mini-btn" onClick={() => void load()} disabled={busy}>
            다시 받기
          </button>
        </div>
      </div>

      <div className="admin-list-wrap">
        <table className="admin-list usage-list">
          <thead>
            <tr>
              <th>에이전트</th>
              <th>제공자 · 모델</th>
              <th className="num">호출</th>
              <th className="num">입력</th>
              <th className="num">출력</th>
              <th className="num">캐시 읽기</th>
              <th className="num">캐시 쓰기</th>
              <th className="num">평균 입력</th>
              <th>캐시 히트율</th>
              <th className="num">시한</th>
              <th className="num">출력 상한</th>
              <th>사고</th>
            </tr>
          </thead>
          <tbody>
            {usage.agents.map((row) => (
              <tr key={row.agent}>
                <td>{row.agent}</td>
                <td className="admin-name">
                  {row.provider} <span className="muted">{row.model}</span>
                </td>
                <td className="num">
                  {NUMBER.format(row.calls)}
                  {row.skipped > 0 ? <span className="muted"> +{row.skipped}</span> : null}
                </td>
                <td className="num">{tokens(row.inputTokens)}</td>
                <td className="num">{tokens(row.outputTokens)}</td>
                <td className="num">{tokens(row.cacheReadTokens)}</td>
                <td className="num">{tokens(row.cacheWriteTokens)}</td>
                <td className="num">{row.avgInput === null ? "—" : tokens(row.avgInput)}</td>
                <td>
                  <CacheCell row={row} />
                </td>
                <td className="num">{seconds(row.timeoutMs)}</td>
                <td className="num">{NUMBER.format(row.maxTokens)}</td>
                <td>{row.thinkingLevel ?? <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/*
        빈 장부를 고장으로 읽지 않게 한다 — mock 모드의 대본 어댑터는 계측을 붙이는 문
        (`createGameLLM`)을 지나지 않고, 애초에 모델을 부르지 않는다 (models.md §2-1).
      */}
      {usage.mode === "mock" && totals.calls === 0 && (
        <p className="admin-note">
          모의 GM은 모델을 부르지 않는다 — 장부가 비어 있는 것이 이 모드의 정상이다.
        </p>
      )}

      {/*
        제공자마다 캐시가 걸리기 시작하는 프리픽스가 달라 히트율을 그대로 비교할 수
        없다 (models.md §4) — 그 사실은 표가 스스로 말하지 못하므로 여기 한 줄로 선다.
      */}
      <p className="admin-note">
        캐시 히트율은 제공자마다 적중 조건이 달라 그대로 비교되지 않는다 — 평균 입력이 그 자리
        제공자의 최소 프리픽스를 넘은 행끼리만 같은 뜻이다.
      </p>
    </>
  );
}
