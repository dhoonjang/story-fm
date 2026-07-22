"use client";

import { useState } from "react";
import type { OfficeViews } from "@story-fm/engine";

const TABS = ["스쿼드", "재정", "일정·순위", "커리어"] as const;
type Tab = (typeof TABS)[number];

const money = (n: number) => `£${(n / 1e6).toFixed(1)}M`;

function AttrBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="attr-row">
      <span>{label}</span>
      <div className="attr-bar">
        <div style={{ width: `${value}%` }} />
      </div>
      <span>{value}</span>
    </div>
  );
}

export function Office({ views, teamName }: { views: OfficeViews; teamName: string }) {
  const [tab, setTab] = useState<Tab>("스쿼드");

  return (
    <aside className="office">
      <div className="office-tabs">
        {TABS.map((t) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
            data-testid={`tab-${t}`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="office-body">
        {tab === "스쿼드" && (
          <div data-testid="view-squad">
            <table>
              <thead>
                <tr>
                  <th>선수</th>
                  <th>포지션</th>
                  <th>OVR</th>
                  <th>폼</th>
                  <th>사기</th>
                  <th>피로</th>
                  <th>골</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {views.squad.players.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.isCaptain ? "Ⓒ " : ""}
                      {p.name}
                    </td>
                    <td>{p.position}</td>
                    <td>{p.overall}</td>
                    <td>{p.form > 0 ? `+${p.form}` : p.form}</td>
                    <td>{p.morale}</td>
                    <td>{p.fatigue}</td>
                    <td>{p.seasonGoals}</td>
                    <td>
                      {p.injury !== "none" && <span className="badge warn">부상</span>}
                      {p.hasIssue && <span className="badge warn">불만</span>}
                      <span className="badge">{p.role}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "재정" && (
          <div className="finance-cards" data-testid="view-finance">
            <div className="finance-card">
              <div className="label">구단 잔고</div>
              <div className="value">{money(views.finance.balance)}</div>
            </div>
            <div className="finance-card">
              <div className="label">주급 총액 (주)</div>
              <div className="value">{money(views.finance.weeklyWages)}</div>
            </div>
            <div className="finance-card">
              <div className="label">이적 예산</div>
              <div className="value">{money(views.finance.transferBudget)}</div>
            </div>
            <div className="finance-card">
              <div className="label">보드 평가</div>
              <div className="value" style={{ fontSize: 13 }}>
                {views.finance.boardExpectation}
              </div>
            </div>
          </div>
        )}

        {tab === "일정·순위" && (
          <div data-testid="view-schedule">
            {views.schedule.next && (
              <div className="manager-card">
                <div className="bg">다음 경기</div>
                <div>{views.schedule.next}</div>
              </div>
            )}
            {views.schedule.recentResults.length > 0 && (
              <>
                <div className="section-title">최근 결과</div>
                {views.schedule.recentResults.map((r, i) => (
                  <div key={i} style={{ fontSize: 12.5, padding: "2px 0" }}>
                    {r}
                  </div>
                ))}
              </>
            )}
            <div className="section-title">리그 순위</div>
            <table data-testid="standings">
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
                {views.schedule.standings.map((row, i) => (
                  <tr key={row.teamId} className={row.name === teamName ? "me" : ""}>
                    <td>{i + 1}</td>
                    <td>{row.shortName}</td>
                    <td>{row.played}</td>
                    <td>{row.wins}</td>
                    <td>{row.draws}</td>
                    <td>{row.losses}</td>
                    <td>{row.goalDiff > 0 ? `+${row.goalDiff}` : row.goalDiff}</td>
                    <td>
                      <b>{row.points}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "커리어" && (
          <div data-testid="view-career">
            <div className="manager-card">
              <h3>{views.squad.manager.name} 감독</h3>
              <div className="bg">{views.squad.manager.background}</div>
              <AttrBar label="리더십" value={views.squad.manager.attributes.leadership ?? 0} />
              <AttrBar label="전술" value={views.squad.manager.attributes.tactics ?? 0} />
              <AttrBar label="협상" value={views.squad.manager.attributes.negotiation ?? 0} />
              <AttrBar label="미디어" value={views.squad.manager.attributes.media ?? 0} />
              <div className="section-title">
                평판 — 보드 {views.squad.manager.reputation.board} · 언론{" "}
                {views.squad.manager.reputation.media} · 선수단{" "}
                {views.squad.manager.reputation.squad}
              </div>
            </div>

            <div className="section-title">🏆 트로피 보관함</div>
            <div className="trophy-list">
              {views.career.trophies.length === 0 && (
                <div className="empty">아직 트로피가 없다 — 역사는 지금부터다</div>
              )}
              {views.career.trophies.map((t, i) => (
                <div className="trophy" key={i}>
                  🏆 {t.name} — 시즌 {t.season}
                </div>
              ))}
            </div>

            <div className="section-title">업적</div>
            <div className="trophy-list">
              {views.career.achievements.length === 0 && (
                <div className="empty">달성한 업적이 없다</div>
              )}
              {views.career.achievements.map((a, i) => (
                <div className="achv" key={i}>
                  <div>{a.name}</div>
                  <div className="desc">
                    시즌 {a.season} — {a.description}
                  </div>
                </div>
              ))}
            </div>

            <div className="section-title">시즌 기록</div>
            {views.career.seasons.length === 0 ? (
              <div className="empty">첫 시즌 진행 중</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>시즌</th>
                    <th>순위</th>
                    <th>전적</th>
                  </tr>
                </thead>
                <tbody>
                  {views.career.seasons.map((s) => (
                    <tr key={s.season}>
                      <td>{s.season}</td>
                      <td>{s.position}위</td>
                      <td>{s.record}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
