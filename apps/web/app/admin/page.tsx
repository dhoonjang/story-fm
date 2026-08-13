"use client";

import { useState } from "react";
import Link from "next/link";
import { CupsPanel } from "./cups-panel";
import { LeaguesPanel } from "./leagues-panel";
import { PlayersPanel } from "./players-panel";
import { TeamsPanel } from "./teams-panel";

/**
 * 어드민 — 게임과 무관한 **초기치 DB(카탈로그)**만 편집한다.
 * 여기서의 변경은 이후 새로 시작하는 게임에 반영되고, 진행 중인 게임은 그대로다.
 *
 * 이 파일은 껍데기다: 탭과 공용 배너만 갖고, 층별 편집은 각 패널이 맡는다.
 */

const TABS = [
  { key: "players", label: "선수" },
  { key: "teams", label: "팀" },
  { key: "leagues", label: "리그" },
  { key: "cups", label: "컵" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function AdminPage() {
  const [tab, setTab] = useState<TabKey>("players");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function go(next: TabKey) {
    // 배너는 방금 한 일에 대한 답이다 — 층을 옮기면 남겨두지 않는다
    setMsg(null);
    setErr(null);
    setTab(next);
  }

  return (
    <main className="admin">
      <div className="admin-head">
        <div>
          <Link href="/" className="back-link">
            ← 게임 목록
          </Link>
          <h1>어드민</h1>
        </div>
      </div>

      <nav className="admin-tabs" role="tablist" aria-label="카탈로그 층">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            id={`admin-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`admin-panel-${t.key}`}
            className="admin-tab"
            onClick={() => go(t.key)}
            data-testid={`admin-tab-${t.key}`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {msg && (
        <div className="admin-msg ok" data-testid="admin-msg">
          {msg}
        </div>
      )}
      {err && (
        <div className="admin-msg err" data-testid="admin-err">
          {err}
        </div>
      )}

      <div role="tabpanel" id={`admin-panel-${tab}`} aria-labelledby={`admin-tab-${tab}`}>
        {tab === "players" && <PlayersPanel onMessage={setMsg} onError={setErr} />}
        {tab === "teams" && <TeamsPanel onMessage={setMsg} onError={setErr} />}
        {tab === "leagues" && <LeaguesPanel onMessage={setMsg} onError={setErr} />}
        {tab === "cups" && <CupsPanel onMessage={setMsg} onError={setErr} />}
      </div>
    </main>
  );
}
