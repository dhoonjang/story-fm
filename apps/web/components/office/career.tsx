"use client";

import type { OfficeViews } from "@story-fm/engine";
import {
  MANAGER_ATTRIBUTES,
  MANAGER_ATTRIBUTE_KO,
  achievementTitle,
  awardTitle,
  formatMoney,
} from "@story-fm/domain";
import { IconTrophy } from "@/components/icons";

type SeasonRow = OfficeViews["career"]["seasons"][number];
type AchievementRow = OfficeViews["career"]["achievements"][number];
type AwardRow = OfficeViews["career"]["awards"][number];

/**
 * **업적 한 줄을 쓰는 자리** — 코어는 코드와 근거 수치만 넘긴다
 * (docs/overview.md §1 철칙 4 · career.md §6). 옛 세이브의 업적도 여기서 문장을 얻으므로
 * 문구를 고치면 지난 시즌의 업적까지 함께 고쳐진다.
 */
function achievementDetailOf(a: AchievementRow): string {
  if (a.competitionName) return `${a.competitionName} 우승`;
  if (a.playerName && a.goals !== undefined) return `${a.playerName} 시즌 ${a.goals}골`;
  if (a.matches !== undefined) return `${a.matches}경기 무패`;
  if (a.position !== undefined && a.leagueName) return `${a.leagueName} ${a.position}위`;
  return "";
}

/**
 * **시상 한 줄의 근거를 쓰는 자리** — 코어는 코드와 근거 수치만 넘긴다
 * (docs/overview.md §1 철칙 4 · career.md §6). 어느 칸이 그 상의 근거인가는
 * 상마다 다르다: 득점왕은 골, 도움왕은 도움, 올해의 선수는 평점, 영플레이어는
 * 나이와 평점. 출전은 넷 모두의 바탕이라 늘 뒤에 붙는다.
 */
function awardDetailOf(a: AwardRow): string {
  const rating = a.rating === undefined ? null : `평점 ${a.rating.toFixed(2)}`;
  const grounds =
    a.code === "top-scorer"
      ? [`${a.goals}골`]
      : a.code === "top-assister"
        ? [`${a.assists}도움`]
        : a.code === "young-player"
          ? [a.age === undefined ? null : `${a.age}세`, rating]
          : [rating];
  return [...grounds, `${a.apps}경기`].filter((x): x is string => x !== null).join(" · ");
}

/** 전적 한 칸 — 코어는 셋을 세고, `20승 8무 10패`로 잇는 것은 화면이다 */
function recordText({ wins, draws, losses }: SeasonRow["record"]): string {
  return `${wins}승 ${draws}무 ${losses}패`;
}

type CareerView = OfficeViews["career"];

/**
 * **경질 한 줄을 쓰는 자리** — 코어는 등급·순위·기대만 넘긴다
 * (docs/overview.md §1 철칙 4 · career.md §5.1).
 *
 * 같은 17위도 우승을 노리라는 구단에서와 잔류가 기대인 구단에서 다른 사건이라,
 * 순위 혼자로는 왜 잘렸는지가 읽히지 않는다. 옛 세이브는 카드 대신 평가 문장을
 * 들고 있어 그것이 폴백이고, 둘 다 없으면 지어내지 않는다. 무직 카드와 시즌
 * 표의 경질 이력 줄(career.md §6)이 같은 문장을 쓴다.
 */
function dismissalLineOf(d: {
  position: number | null;
  target: number | null;
  expectation: string | null;
  reason?: string | null;
}): string {
  if (d.position === null || d.target === null || d.expectation === null) return d.reason ?? "";
  return `${d.expectation} — 기대 ${d.target}위, 당시 ${d.position}위`;
}

type OfferRow = CareerView["offers"][number];

/**
 * **제안 한 장** — 무직에게 온 자리도, 지금 구단의 재계약도 같은 물건이다
 * (career.md §5.1 · §5.4). 코어가 넘기는 것은 조건과 기한이고 문장은 여기서 쓴다.
 *
 * **읽는 값이다** — 수락도 흥정도 감독이 말로 한다.
 */
function OfferCard({ offer: o }: { offer: OfferRow }) {
  return (
    <div className="offer">
      <div className="offer-head">
        <b>{o.teamName}</b>
        <span className="tier">{o.via === "renewal" ? "재계약" : `${o.tier}티어`}</span>
        <span className="until">{o.expiresOn}까지</span>
      </div>
      <div className="offer-why">
        기대 {o.expectation} ({o.target}위)
        {o.position === null ? "" : ` · 현재 ${o.position}위`}
      </div>
      {o.salary !== null && (
        <div className="offer-why">
          연봉 {formatMoney(o.salary)} · {o.years ?? "-"}년 · 이적 예산 약속{" "}
          {formatMoney(o.budgetPledge ?? 0)}
          {o.counteredOn === null ? "" : " · 흥정 완료"}
        </div>
      )}
    </div>
  );
}

/**
 * **재직 중에 서는 제안은 재계약 하나다** (career.md §5.4) — 보드가 만료 90일 전에
 * 건 다음 임기다. 경질 카드가 서 있는 동안에는 이 자리가 무직 카드로 대체된다.
 */
function Renewal({ career }: { career: CareerView }) {
  if (career.dismissal) return null;
  const offers = career.offers.filter((o) => o.via === "renewal");
  if (offers.length === 0) return null;
  return (
    <div className="mgr-outofwork">
      <div className="offer-list" data-testid="renewal-offers">
        {offers.map((o) => (
          <OfferCard offer={o} key={o.id} />
        ))}
      </div>
    </div>
  );
}

/**
 * **무직 — 경질 카드와 지금 열린 감독직 제안.**
 *
 * 커리어 화면의 맨 위에 선다. 잘린 뒤 시계는 계속 흐르므로(career.md §5.1) 이
 * 화면이 "왜 맡은 팀이 없는가"와 "무엇이 걸려 있는가"를 한자리에서 말해야 한다.
 * 제안은 **읽는 값이다** — 수락은 감독이 말로 한다.
 */
/** 지갑 아래에 세우는 지출 줄 수 — 그 위는 커리어 표가 아니라 가계부가 된다 */
const SPENDING_SHOWN = 3;

/** 자리를 잃은 갈래의 이름 — 코드가 사실이고 문장은 화면이 만든다 (career.md §5.4) */
const LEAVE_KO = { expired: "계약 만료", resigned: "사임", sacked: "경질" } as const;

function OutOfWork({ career }: { career: CareerView }) {
  const d = career.dismissal;
  if (!d) return null;
  return (
    <div className="mgr-outofwork" data-testid="dismissal">
      <div className="dismissed">
        <div className="dismissed-head">
          <b>{d.teamName}</b>
          <span className="when">
            {d.on} {LEAVE_KO[d.kind]}
          </span>
        </div>
        <div className="dismissed-why">{dismissalLineOf(d)}</div>
        {d.severance !== null && (
          <div className="dismissed-why">
            위약금 {formatMoney(d.severance)}
            {/* 누가 물었는지는 갈래가 안다 — 사임만 감독이 지갑에서 문다 (career.md §5.4) */}
            {d.kind === "resigned" ? " (감독 부담)" : ""}
          </div>
        )}
      </div>
      <div className="offer-list" data-testid="manager-offers">
        {career.offers.length === 0 ? (
          <div className="empty">들어온 감독직 제안이 없습니다</div>
        ) : (
          career.offers.map((o) => <OfferCard offer={o} key={o.id} />)
        )}
      </div>
      {/**
       * 공석 명부 — **제안이 아니라 문이다** (career.md §5.1). 제안 카드의 강조
       * 테두리를 물려받으면 답을 기다리는 것처럼 읽히므로 가라앉은 테두리로 가른다.
       * 지원은 감독이 말로 한다 — 화면은 어느 문이 열려 있는지만 세운다.
       */}
      {career.vacancies.length > 0 && (
        <div className="offer-list" data-testid="manager-vacancies">
          {career.vacancies.map((v, i) => (
            <div className="offer vacant" key={i}>
              <div className="offer-head">
                <b>{v.teamName}</b>
                <span className="tier">{v.tier}티어</span>
                <span className="until">{v.on} 공석</span>
              </div>
              {v.position !== null && <div className="offer-why">현재 {v.position}위</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * **보드 평가 한 줄을 쓰는 자리** — 코어는 등급과 근거 수치만 넘긴다
 * (docs/overview.md §1 철칙 4 · career.md §6).
 *
 * 옛 세이브는 카드 대신 평가 문장을 들고 있어 그것이 폴백이다. 둘 다 없으면
 * 지어내지 않고 빈 칸으로 둔다.
 */
function boardVerdictOf(s: SeasonRow): string {
  if (s.board) {
    const met = s.board.grade === "met";
    return `${s.board.expectation} — ${met ? "달성" : `미달 (기대 ${s.board.target}위)`}`;
  }
  return s.boardVerdict ?? "—";
}

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
type DismissalRow = CareerView["dismissals"][number];

export function CareerView({
  squad,
  career,
}: {
  squad: OfficeViews["squad"];
  career: OfficeViews["career"];
}) {
  /**
   * 시즌 기록과 경질 이력이 **한 표에 선다** (career.md §6) — 잘린 시즌은 시즌
   * 기록이 없으므로 경질 줄이 그 해를 채운다. 같은 시즌 안에서는 경질(시즌 중)이
   * 시즌 결산(시즌 끝)보다 앞이라, 결산 줄에는 끝의 날짜를 세워 정렬한다.
   */
  const seasonRows: Array<
    | { kind: "season"; season: number; at: string; s: SeasonRow }
    | { kind: "dismissal"; season: number; at: string; d: DismissalRow }
  > = [
    ...career.seasons.map((s) => ({ kind: "season" as const, season: s.season, at: "9999", s })),
    ...career.dismissals.map((d) => ({
      kind: "dismissal" as const,
      season: d.season,
      at: d.on,
      d,
    })),
  ].sort((a, b) => a.season - b.season || a.at.localeCompare(b.at));
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
            {/**
             * 계약 — 평판·경고와 같은 단의 세 번째 사실이다 (career.md §5.1).
             * 옛 세이브엔 계약이 없어 그때는 칸 자체가 서지 않는다.
             */}
            {career.contract && (
              <div className="mgr-warn">
                <div className="mgr-rep-title">계약</div>
                <div className="mgr-contract">
                  연봉 {formatMoney(career.contract.salary)} · {career.contract.until}까지 (
                  {career.contract.daysLeft}일)
                  {career.contract.renewal === "declined" && (
                    <b className="mgr-nonrenewal"> 재계약 없음</b>
                  )}
                </div>
              </div>
            )}
            {/**
             * 지갑 — **구단 잔고와 다른 돈이다** (career.md §5.4). 계약 옆에 서야
             * 연봉과 위약금이 어디로 갔는지가 그 자리에서 읽힌다.
             */}
            <div className="mgr-warn">
              <div className="mgr-rep-title">지갑</div>
              <div className="mgr-contract">
                {formatMoney(career.wallet)}
                {career.transferFundRoom > 0 && (
                  <span className="mgr-fund-room">
                    사재 출연 여력 {formatMoney(career.transferFundRoom)}
                  </span>
                )}
              </div>
              {career.spending.length > 0 && (
                <div className="mgr-spending">
                  {career.spending.slice(0, SPENDING_SHOWN).map((s, i) => (
                    <div className="mgr-spend" key={i}>
                      <span className="when">{s.on}</span>
                      <span>
                        {s.kind}
                        {s.playerName ? ` — ${s.playerName}` : ""}
                      </span>
                      <b>−{formatMoney(s.amount)}</b>
                    </div>
                  ))}
                </div>
              )}
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

      <Renewal career={career} />
      <OutOfWork career={career} />

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
        {career.achievements.map((a, i) => {
          const detail = achievementDetailOf(a);
          return (
            <div className="achv" key={i}>
              <div>{achievementTitle(a.code)}</div>
              <div className="desc">
                시즌 {a.season}
                {detail && ` — ${detail}`}
              </div>
            </div>
          );
        })}
      </div>

      {/**
       * 시상 — **감독의 상이 아니라 선수의 상이다** (career.md §6). 코어가 내려
       * 주는 것은 코드와 근거 수치뿐이라 상의 이름도 근거 문장도 여기서 쓴다.
       */}
      <div className="section-title">시상</div>
      <div className="trophy-list">
        {career.awards.length === 0 && <div className="empty">받은 시상이 없습니다</div>}
        {career.awards.map((a, i) => (
          <div className="achv" key={i}>
            <div>{awardTitle(a.code)}</div>
            <div className="desc">
              시즌 {a.season} · {a.leagueName} — {a.playerName} ({a.teamName}) · {awardDetailOf(a)}
            </div>
          </div>
        ))}
      </div>

      <div className="section-title">시즌 기록</div>
      {seasonRows.length === 0 ? (
        <div className="empty">첫 시즌 진행 중</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>시즌</th>
              <th>팀</th>
              <th>순위</th>
              <th>전적</th>
              <th>보드</th>
            </tr>
          </thead>
          <tbody>
            {seasonRows.map((r) =>
              r.kind === "season" ? (
                <tr key={`season-${r.s.season}`}>
                  <td>{r.s.season}</td>
                  <td>{r.s.teamName}</td>
                  <td>{r.s.position}위</td>
                  <td>{recordText(r.s.record)}</td>
                  {/* 순위와 전적이 말하지 않는 것 — 같은 4위가 어느 구단에서는 성공이고
                      어느 구단에서는 실패다. 코어는 등급과 기대 순위만 넘기고 문장은
                      여기서 쓴다 (docs/overview.md §1 철칙 4) */}
                  <td className="career-verdict">{boardVerdictOf(r.s)}</td>
                </tr>
              ) : (
                <tr key={`dismissal-${r.d.on}`} data-testid="career-dismissal">
                  <td>{r.d.season}</td>
                  <td>{r.d.teamName}</td>
                  <td>—</td>
                  <td className="career-sacked">
                    {r.d.on} {LEAVE_KO[r.d.kind]}
                  </td>
                  <td className="career-verdict">{dismissalLineOf(r.d)}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
