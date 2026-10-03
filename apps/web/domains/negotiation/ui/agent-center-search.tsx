"use client";
import { useEffect, useRef, useState } from "react";
import type { AgentCenterSearchResult } from "@story-fm/domain";
import { PlayerName } from "@/domains/common/ui/player-card";

type Results = AgentCenterSearchResult;
type Candidate = Results["players"][number];
export function AgentCenterSearch({
  gameId,
  refreshKey,
  disabled,
  canInquire,
  onSelect,
  onInquiry,
}: {
  gameId: string;
  refreshKey: string;
  disabled: boolean;
  canInquire: boolean;
  onSelect: (id: string) => void;
  onInquiry: (player: Candidate) => void;
}) {
  const searchRef = useRef<HTMLElement>(null);
  const changePage = (next: number) => {
    setPage(next);
    searchRef.current?.scrollIntoView({ block: "start" });
  };
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState("");
  const [club, setClub] = useState("");
  const [position, setPosition] = useState("");
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasQuery = !!(name.trim() || club.trim() || position.trim());
  useEffect(() => {
    setResults(null);
    setError(null);
    if (!expanded || !hasQuery) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      const query = new URLSearchParams({
        name: name.trim(),
        club: club.trim(),
        position: position.trim(),
        page: String(page),
        pageSize: "10",
      });
      void fetch(`/api/games/${gameId}/agent-center/players?${query}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          const body = (await response.json()) as Results & { error?: string };
          if (!response.ok) throw new Error(body.error ?? "선수를 찾지 못했습니다.");
          if (!controller.signal.aborted) setResults(body);
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted)
            setError(reason instanceof Error ? reason.message : "검색 중 문제가 발생했습니다.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [expanded, gameId, refreshKey, hasQuery, name, club, position, page]);
  return (
    <section ref={searchRef} className="negotiation-overview-section agent-center-search">
      <button
        className="agent-search-toggle"
        data-testid="agent-search-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        선수 찾기 <span>{expanded ? "−" : "+"}</span>
      </button>
      {expanded && (
        <>
          <div className="agent-search-fields">
            {(
              [
                { key: "name", label: "선수 이름", value: name, set: setName, max: 100 },
                { key: "club", label: "구단", value: club, set: setClub, max: 100 },
                { key: "position", label: "포지션", value: position, set: setPosition, max: 20 },
              ] as const
            ).map((field) => (
              <label key={field.key}>
                {field.label}
                <input
                  data-testid={`agent-search-${field.key}`}
                  value={field.value}
                  maxLength={field.max}
                  disabled={disabled}
                  onChange={(event) => {
                    field.set(event.target.value);
                    setPage(1);
                  }}
                />
              </label>
            ))}
          </div>
          <div aria-live="polite" className="agent-search-state">
            {loading
              ? "선수를 찾고 있습니다…"
              : (error ??
                (!hasQuery
                  ? "이름·구단·포지션으로 다른 구단 선수와 자유계약 선수를 찾으세요."
                  : results?.total === 0
                    ? "검색 결과가 없습니다."
                    : results
                      ? `${results.total}명 · ${results.page}페이지`
                      : ""))}
          </div>
          {results?.players.map((player) => (
            <div
              className="negotiation-expiring"
              data-testid="agent-search-result"
              data-player-id={player.id}
              key={player.id}
            >
              <div>
                <PlayerName id={player.id} name={player.name} />
                <span>
                  {player.teamName} · {player.age}세 · {player.positions.join(" · ")}
                </span>
              </div>
              <button
                data-testid="agent-search-inquiry"
                disabled={disabled || (!player.existingNegotiationId && !canInquire)}
                onClick={() =>
                  player.existingNegotiationId
                    ? onSelect(player.existingNegotiationId)
                    : onInquiry(player)
                }
              >
                {player.existingNegotiationId
                  ? "대화 이어가기"
                  : player.kind === "free"
                    ? "계약 문의"
                    : "이적 문의"}
              </button>
            </div>
          ))}
          {results && (page > 1 || results.hasMore) && (
            <nav className="agent-search-pages" aria-label="검색 결과 페이지">
              <button disabled={loading || page === 1} onClick={() => changePage(page - 1)}>
                이전
              </button>
              <span>{page}</span>
              <button disabled={loading || !results.hasMore} onClick={() => changePage(page + 1)}>
                다음
              </button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
