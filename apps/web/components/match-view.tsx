"use client";

import { Fragment } from "react";
import type { OfficeViews } from "@story-fm/engine";
import { anchorOf, positionGroupOf, separateBoardPoints } from "@story-fm/domain";
import { IconBoard } from "@/components/icons";
import { PitchTactics } from "./office";

type Match = NonNullable<OfficeViews["match"]>;
type MatchPlayer = Match["onPitch"]["home"][number];

/**
 * 경기 화면 — **중계 채팅 밖에서도 판세가 보여야 한다.**
 *
 * 채팅은 흘러간다. 감독이 정지점에서 알고 싶은 건 셋이다 —
 * ① 어디가 밀리나(존) ② 무엇이 통하고 있나(상성) ③ 누구를 빼야 하나(체력).
 * 화면은 그 순서로 읽힌다. 전부 코어가 이미 계산한 값이라 여기서 셈하지 않는다.
 */
/**
 * 판세 — **어디가 밀리나, 그리고 무엇이 통하나.**
 *
 * 존 막대와 키포인트는 한 질문의 두 면이다: 막대가 "중원이 밀린다"를 말하고
 * 키포인트가 "왜"를 말한다. 탭을 갈라 뒀을 때는 감독이 밀리는 걸 보고 이유를
 * 찾으러 옆 탭으로 건너가 다시 읽어야 했다 — 정지점마다 그러기엔 길이 멀다.
 *
 * **전술 6축은 여기 두지 않는다** — 판을 만지는 자리(전술판)에 이미 있고, 거기서는
 * 읽는 김에 고칠 수도 있다. 두 곳에 같은 값을 세우면 어느 쪽이 진짜인지 흐려진다.
 */
export function MatchOverview({ match }: { match: Match }) {
  return (
    <div className="match-view" data-testid="view-match">
      <ZoneBars match={match} />
      <KeyPoints points={match.keyPoints} />
    </div>
  );
}

/**
 * 상대 팀 — **우리 팀 탭과 같은 뼈대, 다른 정확도.**
 *
 * 마크업까지 우리 쪽(`SquadView`)과 같은 것을 쓴다: `squad-head`(요약 · 전술판
 * 손잡이 · 명단 머리) → `squad-layout`(왼쪽 판+전술 · 오른쪽 명단). 예전엔 상대만
 * 따로 짠 표(`mv-side`)를 세워서, 같은 자리에 있어야 할 것들이 두 탭에서 다른
 * 높이·다른 모양으로 서고 접힘도 따로 놀았다.
 *
 * 다른 것은 **아는 것뿐**이다. 나이·적응·폼·평점은 남의 팀에서 알 수 없으니 열이
 * 없고, 전력은 오차를 달고(`±`) 체력은 값이 아니라 구간이다. 조작도 없다 —
 * 상대 판은 읽는 것이지 고치는 것이 아니다.
 */
export function MatchOpponent({
  match,
  boardOpen = true,
  onToggleBoard,
}: {
  match: Match;
  /** 전술판이 펼쳐져 있나 — 우리 팀 탭과 **같은 손잡이·같은 상태**를 쓴다 */
  boardOpen?: boolean;
  onToggleBoard?: () => void;
}) {
  const ourSide = match.home.ours ? "home" : "away";
  const them = ourSide === "home" ? "away" : "home";
  const players = match.onPitch[them];
  const bench = match.bench[them];
  const subs = match.subs[them];
  const tactics = match.tactics[them];
  /** 선발 평균 — 우리 쪽 요약과 같은 숫자다. 다만 이 값들은 안개를 지난 추정이다 */
  const xiRating = players.length
    ? Math.round(players.reduce((s, p) => s + p.effective, 0) / players.length)
    : 0;
  return (
    <div
      className={`squad-view opponent${boardOpen ? "" : " folded"}`}
      data-testid="view-match-opponent"
    >
      <div className="squad-head">
        <div className="squad-summary">
          <span>
            <b data-testid="opp-shape">{tactics.formation}</b> · 선발 평균 <b>{xiRating}</b>
          </span>
          <span className="muted">
            교체 {subs.used}/5 · 기회 {subs.windows}/3
          </span>
          {onToggleBoard && (
            <button
              className={`board-toggle${boardOpen ? " on" : ""}`}
              onClick={onToggleBoard}
              aria-pressed={boardOpen}
              data-testid="opp-board-toggle"
              title="전술판"
            >
              <IconBoard />
              전술판
            </button>
          )}
        </div>
        <div className="roster-head">
          {/* 우리 쪽 1군·2군 책갈피가 서는 자리 — 상대는 나눌 명단이 하나라 이름표다.
              누르는 것이 아니므로 button이 아니다 */}
          <div className="roster-tabs">
            <span className="roster-tab on">
              {match[them].name}
              <span className="roster-tab-n">{players.length + bench.length}</span>
            </span>
          </div>
          <TeamTotals players={players} />
        </div>
      </div>
      <div className="squad-layout">
        <div className="squad-board-col">
          {/* 우리 쪽과 같은 덩어리 — 판과 전술이 한 장으로 붙는다 (SquadView 참고) */}
          <div className="board-stack">
            <OpponentBoard players={players} tactics={tactics} />
            <SideTactics tactics={tactics} />
          </div>
        </div>
        <div className="squad-side-col">
          <div className="roster-scroll">
            <OpponentTable players={players} bench={bench} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 경기 머리 — **스코어·시계·득점자.**
 *
 * 경기 화면의 상단 띠로 올라간다. 어느 탭을 보든 사라지지 않아야 하는 하나이고,
 * 나머지 탭은 전부 "왜 그 스코어인가"를 설명하는 것들이다. 예전엔 판세 스크롤
 * 안에 sticky로 붙어 있어 다른 탭으로 옮기면 시야에서 사라졌다.
 */
/**
 * 경기 시계 — **상단 띠의 날짜 자리**에 선다.
 *
 * 경기 중에 감독이 알아야 할 시각은 달력의 날짜가 아니라 **몇 분인가**이고,
 * 그 옆에 대회·라운드가 붙으면 "이게 무슨 경기인지"까지 한 줄로 읽힌다.
 */
export function MatchClock({ match }: { match: Match }) {
  return (
    <span className="match-clock" data-testid="match-clock">
      {match.competition} {match.stage} · <b>{match.minute}′</b> {match.phase}
    </span>
  );
}

export function MatchHeadline({ match }: { match: Match }) {
  return (
    <div className="match-headline">
      <Scoreboard match={match} />
      <GoalLog goals={match.goals} />
    </div>
  );
}

/**
 * 스코어보드 — **스코어와 두 팀 이름뿐.**
 *
 * 대회·라운드·시계는 상단 띠(`MatchClock`)로 올라갔다. 셋을 한 덩어리에 쌓으면
 * 정작 커야 할 스코어가 작아지고, 그것들은 "지금 몇 분 몇 대 몇"이라는 한 줄로
 * 상단에서 읽히는 편이 낫다.
 */
function Scoreboard({ match }: { match: Match }) {
  return (
    <div className="mv-score" data-testid="match-score">
      <span className={`mv-team ${match.home.ours ? "ours" : ""}`}>{match.home.name}</span>
      <b className="mv-goals">
        {match.score.home} : {match.score.away}
      </b>
      <span className={`mv-team away ${match.away.ours ? "ours" : ""}`}>{match.away.name}</span>
      {/* 퇴장 — 인원이 왜 줄었는지 화면이 설명해야 한다. 표에서 사라진 이름을
          감독이 스스로 추리하게 두면 안 된다 */}
      {match.sentOff.length > 0 && (
        <span className="mv-sentoff" data-testid="match-sentoff">
          퇴장 {match.sentOff.join(" · ")}
        </span>
      )}
    </div>
  );
}

/**
 * 존 막대 — 세 전선의 우열을 **길이로** 견준다.
 *
 * 숫자를 나란히 두면 어느 쪽이 큰지 세어야 한다. 막대는 한눈에 읽힌다.
 * 기대 득점은 그 판세의 요약이라 아래에 한 줄로 붙인다.
 */
function ZoneBars({ match }: { match: Match }) {
  return (
    <div className="mv-zones" data-testid="match-zones">
      {match.zones.map((z) => {
        const total = z.home + z.away || 1;
        const homePct = (z.home / total) * 100;
        return (
          <div className="mv-zone" key={z.zone}>
            <span className="mv-zone-name">{z.label}</span>
            {/* 막대 길이는 참값의 비율로 긋고, 읽는 숫자만 반올림한다 */}
            <span className="mv-bar" title={`${Math.round(z.home)} vs ${Math.round(z.away)}`}>
              <span
                className={`mv-bar-home ${z.edge === "home" ? "lead" : ""}`}
                style={{ width: `${homePct}%` }}
              />
              <span className={`mv-bar-away ${z.edge === "away" ? "lead" : ""}`} />
            </span>
            <span className="mv-zone-edge">
              {z.edge === "even" ? "팽팽" : `${z.edge === "home" ? "홈" : "원정"} ${z.size}`}
            </span>
          </div>
        );
      })}
      <div className="mv-xg">
        기대 득점 <b>{match.expectedGoals.home}</b> : <b>{match.expectedGoals.away}</b>
      </div>
    </div>
  );
}

/**
 * 지금 벌어지는 일 — 발동한 전술 상성·구멍·미스매치.
 *
 * 코어가 조건을 확인해 발동한 것만 온다(`tactical-counters.ts`). 감독이 손볼
 * 자리가 여기 있으므로 화면에서 가장 눈에 띄어야 한다.
 */
function KeyPoints({ points }: { points: string[] }) {
  if (points.length === 0) return null;
  return (
    <div className="mv-keys" data-testid="match-keys">
      {points.map((p, i) => (
        <div className={`mv-key ${p.includes("구멍") ? "gap" : ""}`} key={i}>
          {p}
        </div>
      ))}
    </div>
  );
}

const AXES = [
  { key: "mentality", label: "멘탈리티", low: "수비적", high: "공격적" },
  { key: "defensiveLine", label: "수비 라인", low: "낮게", high: "높게" },
  { key: "pressing", label: "압박", low: "최소", high: "맹렬" },
  { key: "tempo", label: "템포", low: "느리게", high: "빠르게" },
  { key: "width", label: "폭", low: "좁게", high: "넓게" },
  { key: "passStyle", label: "패스", low: "짧게", high: "길게" },
] as const;

/**
 * 상대 전술 6축 — **읽기 전용.**
 *
 * 우리 쪽 6축은 전술판(`TacticsPanel`)이 갖고 거기서 고칠 수도 있다. 여기는
 * 상대의 것이라 고칠 수 없고, 그래서 모양도 다르다 — 누를 수 있는 것과 읽는 것은
 * 생김새가 달라야 한다. 지시의 방향은 **점의 기울기**로 한눈에 읽힌다.
 *
 * ⚠️ 전술은 안개를 지나지 않는다. 90분 동안 눈앞에서 라인이 올라가고 압박이
 * 들어오는 것은 감독이 그냥 보는 사실이다 — 흐릴 것은 선수의 수치이지 팀의 성향이
 * 아니다 (attribute-model §3.2와 같은 경계).
 */
function SideTactics({ tactics }: { tactics: Match["tactics"]["home"] }) {
  return (
    <div className="mv-tactics one" data-testid="match-tactics">
      <div className="mv-tac-head">
        <b>전술</b>
        <span>
          <i>{tactics.formation}</i> · 소화 {Math.round(tactics.uptake * 100)}%
        </span>
      </div>
      {AXES.map((axis) => {
        const v = tactics[axis.key];
        return (
          <div className="mv-tac-row one" key={axis.key}>
            <span className="mv-tac-axis">{axis.label}</span>
            <Dots value={v} align="left" title={`${axis.label} ${v}`} />
            <span className="mv-tac-word">{v >= 4 ? axis.high : v <= 2 ? axis.low : "보통"}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 1~5 눈금을 점으로 — 숫자보다 기울기가 먼저 읽힌다 */
function Dots({ value, align, title }: { value: number; align: "left" | "right"; title: string }) {
  const dots = [1, 2, 3, 4, 5];
  return (
    <span className={`mv-dots ${align}`} title={title}>
      {(align === "right" ? [...dots].reverse() : dots).map((n) => (
        <span className={`mv-dot ${n <= value ? "on" : ""}`} key={n} />
      ))}
    </span>
  );
}

/**
 * 상대 전술판 — **자리와 이름만.**
 *
 * 우리 판과 같은 그라운드 위에 같은 칩으로 서므로 두 화면이 한 눈금으로 읽힌다.
 * 다만 좌표는 상대가 실제로 찍어 둔 점이 아니라 **포지션 코드의 기본 자리**다
 * (`anchorOf`) — 남의 팀 전술판을 훔쳐볼 수는 없고, 감독이 경기를 보며 아는 것도
 * "누가 어느 자리에 서 있다"까지다. 미세 조정까지 보여 주면 없는 정보를 지어낸다.
 *
 * 숫자는 전력 하나뿐이고 그마저 흐리다 — 옆의 오차 표식이 얼마나 못 미더운지 말한다.
 *
 * ⚠️ 기본 자리를 그대로 쓰면 **칩이 서로를 가린다** — 같은 라인에 세 명이 서는
 * 백3나 이름이 붙은 중앙 자리(CB·RCB)가 겹친다. 우리 판이 쓰는 것과 **같은
 * 분리 함수**(`separateBoardPoints`)를 지나게 해서 라인을 넘지 않는 선에서
 * 좌우로만 벌린다.
 */
function OpponentBoard({
  players,
  tactics,
}: {
  players: MatchPlayer[];
  tactics: Match["tactics"]["home"];
}) {
  const points = separateBoardPoints(players.map((p) => anchorOf(p.position)));
  return (
    <div className="pitch-wrap">
      <div className="pitch-board" data-testid="opponent-board">
        <div className="pitch-lines" />
        <div className="pitch-box top" />
        <div className="pitch-box small top" />
        <div className="pitch-box bottom" />
        <div className="pitch-box small bottom" />
        {/* 상대도 같은 선을 긋는다 — 어디까지 내려서고 어디서부터 쫓는지가 판에 보인다 */}
        <PitchTactics tactics={tactics} />
        <span className="pitch-zone" style={{ top: "6%" }}>
          공격
        </span>
        <span className="pitch-zone" style={{ top: "46%" }}>
          중원
        </span>
        <span className="pitch-zone" style={{ top: "84%" }}>
          수비
        </span>
        {players.map((p, i) => {
          const point = points[i]!;
          const group = positionGroupOf(p.position);
          return (
            <span
              key={p.id}
              // 우리 판의 칩과 **같은 클래스**를 쓴다 — 크기·색·포지션군 구분이
              // 두 화면에서 갈리면 나란히 견줄 수가 없다
              className={`pitch-slot pitch-chip theirs${group ? ` g-${group.toLowerCase()}` : ""}${p.gassed ? " gassed" : ""}`}
              style={{ left: `${point.x}%`, top: `${point.y}%` }}
              data-testid={`opp-slot-${p.id}`}
              title={[
                p.name,
                `${p.position} 자리 기준 ${p.effective}${p.margin > 0 ? ` (±${p.margin})` : ""}`,
                `${p.condition.label} — 체력 ${p.condition.low}~${p.condition.high}`,
              ].join("\n")}
            >
              <span className="slot-pos">{p.position}</span>
              <span className="slot-name">{chipName(p.name)}</span>
              <span className="slot-meta">
                <b>{p.effective}</b>
                {p.margin > 0 && <i className="slot-margin">±{p.margin}</i>}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** 칩에는 성만 — 전체 이름은 두 줄로 접혀 판이 어수선해진다 */
const chipName = (name: string) => name.trim().split(/\s+/).at(-1) ?? name;

/**
 * 득점 기록 — **스코어 옆에 이름이 선다.**
 *
 * 숫자만 두면 누가 넣었는지 중계를 거슬러 올라가 찾아야 한다. 한 줄에 분·득점자·
 * 도움이면 충분하고, 우리 골은 색으로 갈린다. 없으면 아무것도 그리지 않는다.
 */
function GoalLog({ goals }: { goals: Match["goals"] }) {
  if (goals.length === 0) return null;
  return (
    <div className="mv-goals-log" data-testid="match-goal-log">
      {goals.map((g, i) => (
        <span key={i} className={`mv-goal${g.ours ? " ours" : ""}`}>
          <i>{g.minute}′</i> {g.scorer}
          {g.assist && <em> ({g.assist})</em>}
        </span>
      ))}
    </div>
  );
}

/**
 * 그 선수가 이 경기에서 한 일 — **눈에 띌 것만 칩으로.**
 *
 * 골·도움·카드는 판단이 걸린 사실이라 자리를 준다(카드는 교체를 앞당길 이유다).
 * 슛·선방은 흐름을 읽는 값이라 툴팁이 갖는다 — 열한 행에 다 세우면 표가 숫자밭이
 * 되어 정작 골이 안 보인다.
 */
function Tally({ t }: { t: MatchPlayer["tally"] }) {
  const detail = statLine(t);
  return (
    <span className="mv-tally" title={detail || undefined}>
      {t.goals > 0 && <b className="tl goal">{t.goals > 1 ? `골 ${t.goals}` : "골"}</b>}
      {t.assists > 0 && <b className="tl assist">{t.assists > 1 ? `도움 ${t.assists}` : "도움"}</b>}
      {t.red ? (
        <b className="tl red">퇴장</b>
      ) : (
        t.yellows > 0 && <b className="tl yellow">경고{t.yellows > 1 ? ` ${t.yellows}` : ""}</b>
      )}
    </span>
  );
}

/** 그 선수의 기록을 한 줄로 — 행 툴팁과 상세가 함께 쓴다 */
function statLine(t: MatchPlayer["tally"]): string {
  return [
    t.goals > 0 ? `골 ${t.goals}` : null,
    t.assists > 0 ? `도움 ${t.assists}` : null,
    t.shots > 0 ? `슛 ${t.shots}` : null,
    t.xg > 0 ? `xG ${t.xg.toFixed(2)}` : null,
    t.saves > 0 ? `선방 ${t.saves}` : null,
    `패스 ${t.passes}`,
    `전진 ${t.progressive}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * 팀 합계 — **표에 열을 더 세우지 않는다.**
 *
 * 열한 행에 패스·전진·슛·xG를 다 세우면 숫자밭이 되어 정작 골이 안 보인다.
 * 그런데 팀 단위로는 그 숫자들이 곧 판세다("우리가 더 만졌는데 슛이 없다").
 * 그래서 **선수별은 툴팁, 팀별은 한 줄**로 가른다.
 */
function TeamTotals({ players }: { players: MatchPlayer[] }) {
  const sum = players.reduce(
    (acc, p) => ({
      passes: acc.passes + p.tally.passes,
      progressive: acc.progressive + p.tally.progressive,
      shots: acc.shots + p.tally.shots,
      xg: acc.xg + p.tally.xg,
      saves: acc.saves + p.tally.saves,
    }),
    { passes: 0, progressive: 0, shots: 0, xg: 0, saves: 0 },
  );
  if (sum.passes === 0 && sum.shots === 0) return null;
  return (
    <div className="mv-totals" data-testid="match-totals">
      <span>
        패스 <b>{sum.passes}</b>
      </span>
      <span>
        전진 <b>{sum.progressive}</b>
      </span>
      <span>
        슛 <b>{sum.shots}</b>
      </span>
      <span title="이 경기에서 만든 기회의 질 — 팀 합계">
        xG <b>{sum.xg.toFixed(2)}</b>
      </span>
      <span>
        선방 <b>{sum.saves}</b>
      </span>
    </div>
  );
}

/**
 * 상대 명단 — **우리 명단(`SquadTable`)과 같은 표**다.
 *
 * 같은 클래스를 쓰므로 행 높이·구역 머리·왼쪽 칸 색 띠가 두 탭에서 정확히 겹친다.
 * 정렬 손잡이는 없다 — 상대 명단은 훑는 것이지 다루는 것이 아니고, 자리 순으로
 * 서 있어야 왼쪽 판과 같은 순서로 읽힌다.
 *
 * 열이 넷뿐인 것은 아는 것이 넷뿐이기 때문이다. 우리 표에서 나이·적응·폼·평점은
 * `hide-sm`으로 좁을 때 접히는 열이라, 좁은 화면에서는 두 표가 같은 열을 세운다.
 */
function OpponentTable({ players, bench }: { players: MatchPlayer[]; bench: MatchPlayer[] }) {
  const groups = [
    { slug: "start", rows: players },
    { slug: "bench", rows: bench },
  ].filter((g) => g.rows.length > 0);
  return (
    <table className="squad-table" data-testid="opponent-table">
      <thead>
        <tr>
          <th>선수</th>
          <th>포지션</th>
          <th>OVR</th>
          <th>체력</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g, gi) => (
          <Fragment key={g.slug}>
            {/* 칸이 갈리는 자리는 **선 하나** — 우리 표와 같다(이름은 왼쪽 선 색이 말한다) */}
            {gi > 0 && (
              <tr className="tier-head" data-tier={g.slug} aria-hidden>
                <td colSpan={4} />
              </tr>
            )}
            {g.rows.map((p) => (
              <tr
                key={p.id}
                className={`row-tier t-${g.slug}${p.gassed ? " gassed" : ""}`}
                data-testid={`mv-player-${p.id}`}
                title={statLine(p.tally)}
              >
                <td className="squad-name">
                  <span className="row-name">{p.name}</span>
                  {/* 다리가 멈춘 선수 — 우리 표의 상태 표식(부상·정지)과 같은 자리·같은 모양 */}
                  {p.gassed && (
                    <span className="tag st alert" title="다리가 멈췄다 — 이 자리에 구멍이 나 있다">
                      구멍
                    </span>
                  )}
                  <Tally t={p.tally} />
                </td>
                <td>{p.position}</td>
                {/* 전력 옆의 ± — 이 숫자를 얼마나 믿을 수 있나. 우리 선수는 붙지 않는다 */}
                <td
                  title={
                    p.margin > 0
                      ? `지금 이 자리에서 내는 전력 — ±${p.margin} 오차 (스카우팅하면 좁아진다)`
                      : "지금 이 자리에서 내는 전력"
                  }
                >
                  {p.effective}
                  {p.margin > 0 && <i className="mv-eff-margin">±{p.margin}</i>}
                </td>
                <td>
                  <ConditionBar c={p.condition} gassed={p.gassed} />
                </td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

/**
 * 체력 막대 — **값이 아니라 구간이다.**
 *
 * 경기 중 남은 다리는 아무도 실시간으로 재지 못한다(scouting.ts §체력). 흐린
 * 숫자를 또렷한 막대로 그리면 감독은 그걸 사실로 읽으므로, 확실한 만큼만 채우고
 * 그 위로 **모르는 폭**을 흐리게 얹는다 — 막대의 끝이 어디인지 모른다는 사실이
 * 모양으로 드러난다. 안내 문구는 두지 않는다.
 *
 * 우리 선수의 꼬리는 짧고 상대는 길며, 둘 다 후반으로 갈수록 길어진다.
 * 폭 자체가 "지금 이걸 얼마나 믿을 수 있나"를 말한다.
 */
function ConditionBar({ c, gassed }: { c: MatchPlayer["condition"]; gassed: boolean }) {
  // 명단(office)의 체력 막대와 같은 문턱 — 화면마다 색이 다르면 눈금이 흔들린다
  const tone = gassed ? "spent" : c.value < 50 ? "tired" : "";
  return (
    <span className="mv-cond-bar" title={`${c.label} — 체력 ${c.low}~${c.high}`}>
      <span className={`mv-cond-sure ${tone}`} style={{ width: `${c.low}%` }} />
      <span
        className={`mv-cond-fog ${tone}`}
        style={{ left: `${c.low}%`, width: `${c.high - c.low}%` }}
      />
    </span>
  );
}
