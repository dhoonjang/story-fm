"use client";

import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { DomesticCupModal, EuroCupModal } from "./cup-modal";
import {
  DRAW_STYLE_KO,
  EUROPEAN_TICKET_KO,
  STAGE_KO,
  type CupCatalogEntry,
  type CupCatalogResponse,
  type DomesticCupEntry,
  type LeagueCatalogResponse,
} from "./types";

/**
 * 컵 카탈로그 패널 — 유럽 대항전과 국내 컵을 **갈라서** 보여준다.
 * 두 대회군은 필드가 아예 달라(리그 페이즈 vs 순수 녹아웃) 한 표에 담으면
 * 절반이 빈 칸이 된다. 오버라이드 파일은 하나라 리셋만 함께 움직인다.
 */

type ModalTarget =
  | { kind: "euro"; cup: CupCatalogEntry }
  | { kind: "domestic"; cup: DomesticCupEntry };

/** 리그별 티켓 합 — 참가 팀 수와 어긋나면 그 대회는 편성되지 않는다 */
function slotSum(cup: CupCatalogEntry): number {
  return Object.values(cup.slots).reduce((sum, n) => sum + n, 0);
}

export function CupsPanel({
  onMessage,
  onError,
}: {
  onMessage: (m: string | null) => void;
  onError: (e: string | null) => void;
}) {
  const [europe, setEurope] = useState<CupCatalogEntry[]>([]);
  const [domestic, setDomestic] = useState<DomesticCupEntry[]>([]);
  const [leagues, setLeagues] = useState<Array<{ id: string; name: string; playable: boolean }>>([]);
  const [edited, setEdited] = useState(false);
  const [target, setTarget] = useState<ModalTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const applyResponse = useCallback((data: CupCatalogResponse) => {
    setEurope(data.europe ?? []);
    setDomestic(data.domestic ?? []);
    if (data.edited !== undefined) setEdited(data.edited);
  }, []);

  useEffect(() => {
    fetch("/api/admin/catalog/cup")
      .then((r) => r.json())
      .then((d: CupCatalogResponse) => {
        if (d.error) onError(d.error);
        else applyResponse(d);
        setLoaded(true);
      })
      .catch(() => {
        onError("컵 카탈로그를 불러오지 못했습니다");
        setLoaded(true);
      });
    fetch("/api/admin/catalog/league")
      .then((r) => r.json())
      .then((d: LeagueCatalogResponse) => {
        setLeagues(
          (d.leagues ?? []).map((l) => ({ id: l.id, name: l.name, playable: l.kind === "playable" })),
        );
      })
      .catch(() => onError("리그 목록을 불러오지 못했습니다"));
  }, [applyResponse, onError]);

  async function resetCups() {
    if (!window.confirm("컵 편집을 모두 취소하고 시드 기본값으로 되돌릴까요? (대항전·국내 컵 함께)")) {
      return;
    }
    setBusy(true);
    onError(null);
    onMessage(null);
    try {
      const res = await fetch("/api/admin/catalog/cup", { method: "DELETE" });
      const data: CupCatalogResponse = await res.json();
      if (!res.ok) throw new Error(data.error ?? "되돌리기 실패");
      applyResponse(data);
      onMessage(data.message ?? null);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function open(next: ModalTarget) {
    onMessage(null);
    onError(null);
    setTarget(next);
  }

  /** 행은 곧 편집 손잡이다 — 선수·팀 탭과 같은 조작(클릭·Enter·Space) */
  function rowProps(next: ModalTarget, label: string) {
    return {
      "data-testid": `cup-row-${next.cup.id}`,
      tabIndex: 0,
      role: "button" as const,
      "aria-label": `${label} 편집`,
      onClick: () => open(next),
      onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open(next);
        }
      },
    };
  }

  return (
    <section className="admin-panel">
      <p className="hint admin-note">
        편집 결과는 <b>이후 새로 시작하는 게임</b>에만 반영됩니다 — 진행 중인 게임은 시작 시 복사한
        값으로 계속 돕니다. 규모·티켓은 구조 필드라, 세계가 성립하지 않는 편집은 저장할 때 막힙니다.
      </p>

      <div className="admin-toolbar">
        <span className="admin-count" data-testid="admin-cup-count">
          대항전 {europe.length}개 · 국내 컵 {domestic.length}개
        </span>
        <div className="admin-toolbar-right">
          {edited && (
            <span className="badge warn" data-testid="cups-edited">
              편집됨
            </span>
          )}
          <button
            className="ghost-btn"
            onClick={() => void resetCups()}
            disabled={busy || !edited}
            data-testid="cups-reset"
          >
            시드 기본값으로
          </button>
        </div>
      </div>

      <section className="admin-cup-group">
        <div className="admin-section-head">
          <b className="admin-section-title">유럽 대항전</b>
          <span className="admin-section-note">리그 페이즈 + 플레이오프 + 녹아웃</span>
        </div>
        <div className="admin-list-wrap">
          <table className="admin-list">
            <thead>
              <tr>
                <th>이름</th>
                <th className="num">참가</th>
                <th className="num">팀당 경기</th>
                <th className="num">티켓 합</th>
                <th className="num">직행</th>
                <th className="num">PO</th>
                <th className="num">우승 상금</th>
              </tr>
            </thead>
            <tbody>
              {europe.map((cup) => {
                const sum = slotSum(cup);
                return (
                  <tr key={cup.id} {...rowProps({ kind: "euro", cup }, cup.name)}>
                    <td className="admin-name">
                      {cup.name}
                      <span className="muted">{cup.short}</span>
                    </td>
                    <td className="num admin-ovr">{cup.size}</td>
                    <td className="num">{cup.matchesPerTeam}</td>
                    <td className={sum === cup.size ? "num" : "num admin-cell-warn"}>{sum}</td>
                    <td className="num">{cup.directSlots}</td>
                    <td className="num">{cup.playoffSlots}</td>
                    <td className="num">£{cup.prize.winner.toLocaleString()}</td>
                  </tr>
                );
              })}
              {europe.length === 0 && (
                <tr className="admin-list-empty">
                  <td colSpan={7}>{loaded ? "대항전이 없습니다" : "컵 카탈로그를 불러오는 중…"}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-cup-group">
        <div className="admin-section-head">
          <b className="admin-section-title">국내 컵</b>
          <span className="admin-section-note">순수 녹아웃 — 그 나라 1·2부 32클럽이 참가</span>
        </div>
        <div className="admin-list-wrap">
          <table className="admin-list">
            <thead>
              <tr>
                <th>이름</th>
                <th>나라</th>
                <th className="num">명성</th>
                <th className="hide-sm">2차전제</th>
                <th className="hide-sm">추첨</th>
                <th>유럽 진출권</th>
                <th className="num">우승 상금</th>
              </tr>
            </thead>
            <tbody>
              {domestic.map((cup) => (
                <tr key={cup.id} {...rowProps({ kind: "domestic", cup }, cup.name)}>
                  <td className="admin-name">
                    {cup.name}
                    <span className="muted">{cup.short}</span>
                  </td>
                  <td>{cup.country}</td>
                  <td className="num admin-ovr">{cup.prestige}</td>
                  <td className="hide-sm">
                    {cup.twoLegged.length === 0
                      ? "—"
                      : cup.twoLegged.map((s) => STAGE_KO[s]).join("·")}
                  </td>
                  <td className="hide-sm">{DRAW_STYLE_KO[cup.drawStyle]}</td>
                  <td>{EUROPEAN_TICKET_KO[cup.europeanTicket]}</td>
                  <td className="num">£{cup.prize.winner.toLocaleString()}</td>
                </tr>
              ))}
              {domestic.length === 0 && (
                <tr className="admin-list-empty">
                  <td colSpan={7}>{loaded ? "국내 컵이 없습니다" : "컵 카탈로그를 불러오는 중…"}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {target?.kind === "euro" && (
        <EuroCupModal
          cup={target.cup}
          leagues={leagues}
          onSaved={(data) => {
            applyResponse(data);
            onMessage(data.message ?? null);
            setTarget(null);
          }}
          onClose={() => setTarget(null)}
        />
      )}
      {target?.kind === "domestic" && (
        <DomesticCupModal
          cup={target.cup}
          onSaved={(data) => {
            applyResponse(data);
            onMessage(data.message ?? null);
            setTarget(null);
          }}
          onClose={() => setTarget(null)}
        />
      )}
    </section>
  );
}
