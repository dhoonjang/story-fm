"use client";

import type { OfficeViews } from "@story-fm/engine";
import { MANAGER_ATTRIBUTES, MANAGER_ATTRIBUTE_KO } from "@story-fm/domain";
import { IconTrophy } from "@/components/icons";

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

/**
 * 축 라벨 아래에 눕는 XP 자국의 크기 — 라벨 글자 폭(두 자 + 값)보다 짧게 잡아
 * 꼭짓점마다 선이 아니라 **자국**으로 보이게 한다.
 */
const XP_BAR_W = 26;
const XP_BAR_H = 2.4;

function ManagerRadar({
  attributes,
  xp,
  xpPerLevel,
  attrCap,
}: {
  attributes: Record<string, number | undefined>;
  /** 축별 누적 XP — `xpPerLevel`이 차면 축이 한 칸 오른다 */
  xp: Record<string, number | undefined>;
  xpPerLevel: number;
  attrCap: number;
}) {
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
          /**
           * 다음 칸까지의 진행 — **숫자를 하나 더 늘어놓지 않는다.** 축값 옆에
           * 87처럼 적으면 능력치와 XP가 같은 종류로 읽혀 다섯 축이 열 개의 숫자가
           * 된다. 라벨 아래에 눕는 자국이 얼마나 찼는지가 곧 "자라는 중"이다.
           * 상한(`attrCap`)에 닿은 축은 더 자라지 않으므로 자국을 그리지 않는다.
           */
          const value = values[i] ?? 0;
          const grows = value < attrCap;
          const progress = Math.max(0, Math.min(1, (xp[a] ?? 0) / xpPerLevel));
          const barX =
            anchor === "middle" ? x - XP_BAR_W / 2 : anchor === "start" ? x : x - XP_BAR_W;
          return (
            <g key={a}>
              <text className="axis-label" x={x} y={y} textAnchor={anchor}>
                <tspan>{MANAGER_ATTRIBUTE_KO[a]}</tspan>
                <tspan className="axis-value" dx="5">
                  {value}
                </tspan>
              </text>
              {grows && (
                <>
                  <rect
                    className="xp-track"
                    x={barX}
                    y={y + 8}
                    width={XP_BAR_W}
                    height={XP_BAR_H}
                    rx={XP_BAR_H / 2}
                  />
                  {progress > 0 && (
                    <rect
                      className="xp-fill"
                      x={barX}
                      y={y + 8}
                      width={XP_BAR_W * progress}
                      height={XP_BAR_H}
                      rx={XP_BAR_H / 2}
                    />
                  )}
                </>
              )}
            </g>
          );
        })}
      </svg>
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
           * 감독에게 **딸린 수치 묶음** 둘이 한 줄에 선다 — 세계가 그를 보는 눈(평판)과
           * 자리에 남은 목숨(보드 경고). 둘 다 이름·배경보다 아래 단이고 서로는 같은 단이다.
           */}
          <div className="mgr-meters">
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
            {/**
             * 보드 경고 — 평판과 **같은 무게로, 다른 물건으로** 그린다. 경질은 이
             * 세이브가 끝나는 유일한 길이라 카운터가 화면에 없으면 끝이 예고 없이
             * 온다. 평판은 0~100 사이를 오가는 눈금이지만 경고는 **세는 것**이라
             * 막대가 아니라 칸이다 — 찬 칸이 받은 경고고, 마지막 칸이 차면 붉다.
             */}
            <div className="mgr-warn">
              <div className="mgr-rep-title">보드 경고</div>
              <div
                className="mgr-warn-cells"
                data-testid="board-warnings"
                role="img"
                aria-label={`보드 경고 ${squad.manager.boardWarnings}/${squad.manager.warningLimit}${
                  squad.manager.lastWarnedOn ? ` · 마지막 ${squad.manager.lastWarnedOn}` : ""
                }`}
                title={
                  squad.manager.lastWarnedOn
                    ? `마지막 경고 ${squad.manager.lastWarnedOn}`
                    : undefined
                }
              >
                {Array.from({ length: squad.manager.warningLimit }, (_, i) => (
                  <i
                    key={i}
                    className={
                      i < squad.manager.boardWarnings
                        ? i === squad.manager.warningLimit - 1
                          ? "on last"
                          : "on"
                        : ""
                    }
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
        <ManagerRadar
          attributes={squad.manager.attributes}
          xp={squad.manager.xp}
          xpPerLevel={squad.manager.xpPerLevel}
          attrCap={squad.manager.attrCap}
        />
      </div>

      <div className="section-title">트로피 보관함</div>
      <div className="trophy-list">
        {career.trophies.length === 0 && <div className="empty">아직 트로피가 없습니다</div>}
        {career.trophies.map((t, i) => (
          <div className="trophy" key={i}>
            <IconTrophy size={16} />
            <span>
              {t.competition} — 시즌 {t.season} ({t.teamName})
            </span>
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
