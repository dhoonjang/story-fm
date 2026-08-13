"use client";

import { useState } from "react";
import { Modal } from "./modal";
import type { CatalogPlayer, CatalogResponse, CatalogTeam } from "./types";

/**
 * 팀 명단 창 — 팀 목록의 스쿼드 칸에서 열린다.
 *
 * 팀 편집 창(team-modal)과 나눠 두는 이유: 명단은 팀 카탈로그가 아니라 **선수
 * 카탈로그**를 고치고(`/api/admin/catalog/player/:id`), 한 번에 여러 명을 옮기게
 * 되므로 창이 저장으로 닫히면 안 된다. 그래서 결과도 패널 배너가 아니라 이 창
 * 안에서 말한다 — 창 뒤의 배너는 지금 보이지 않는다.
 */

export function SquadModal({
  team,
  catalog,
  loaded,
  onMoved,
  onClose,
}: {
  team: { id: string; name: string; leagueName: string };
  /** 선수 카탈로그 — 팀 목록(`/api/admin/catalog/team`)과 다른 엔드포인트에서 온다 */
  catalog: CatalogTeam[];
  loaded: boolean;
  onMoved: (data: CatalogResponse) => void;
  onClose: () => void;
}) {
  const [moving, setMoving] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const players: CatalogPlayer[] = catalog.find((t) => t.teamId === team.id)?.players ?? [];

  async function move(player: CatalogPlayer, teamId: string) {
    setMoving(player.id);
    setMsg(null);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/catalog/player/${player.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId }),
      });
      const data: CatalogResponse = await res.json();
      if (!res.ok) throw new Error(data.error ?? "이동 실패");
      onMoved(data);
      setMsg(data.message ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setMoving(null);
    }
  }

  return (
    <Modal
      wide
      testId="squad-modal"
      title={`${team.name} 명단`}
      subtitle={`${team.leagueName} · ${loaded ? `${players.length}명` : "…"}`}
      onClose={onClose}
      footer={
        <button className="ghost-btn" onClick={onClose}>
          닫기
        </button>
      }
    >
      {msg && (
        <div className="admin-msg ok" data-testid="squad-modal-msg">
          {msg}
        </div>
      )}
      {err && (
        <div className="admin-msg err" data-testid="squad-modal-err">
          {err}
        </div>
      )}

      <div className="admin-squad-rows">
        {players.map((p) => (
          <div className="admin-squad-row" key={p.id} data-testid={`squad-row-${p.id}`}>
            <span className="admin-squad-name">
              {p.nameKo}
              <span className="muted">{p.nameEn}</span>
            </span>
            <span className="admin-pos">{p.position}</span>
            <span className="admin-squad-vals">
              {p.age}세 · OVR {p.overall}
            </span>
            <select
              value={team.id}
              disabled={moving !== null}
              onChange={(e) => void move(p, e.target.value)}
              aria-label={`${p.nameKo} 소속 팀`}
              data-testid={`squad-move-${p.id}`}
            >
              {catalog.map((t) => (
                <option key={t.teamId} value={t.teamId}>
                  {t.teamName}
                </option>
              ))}
            </select>
          </div>
        ))}
        {players.length === 0 && (
          // 아직 못 불러온 것과 없는 것은 다르다 — 5천 명을 받는 동안 "비었다"고 하지 않는다
          <p className="admin-squad-empty">{loaded ? "명단이 비어 있습니다" : "명단을 불러오는 중…"}</p>
        )}
      </div>
    </Modal>
  );
}
