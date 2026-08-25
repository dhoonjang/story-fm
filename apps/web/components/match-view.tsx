"use client";

import { Fragment } from "react";
import type { OfficeViews } from "@story-fm/engine";
import {
  TACTIC_AXES,
  anchorOf,
  positionGroupOf,
  separateBoardPoints,
  tacticWord,
} from "@story-fm/domain";
import { pitchPointOf, spreadMarkers, type PitchPoint } from "@/lib/pitch-layout";
import { IconBoard } from "@/components/icons";
import { ConditionBar } from "@/components/condition-bar";
import { PitchChip, PitchGround } from "./pitch";

type Match = NonNullable<OfficeViews["match"]>;
type MatchPlayer = Match["onPitch"]["home"][number];
type MatchTotals = Match["totals"]["home"];
type Shootout = NonNullable<Match["shootout"]>;

/**
 * 경기 화면 — **중계 채팅 밖에서도 판세가 보여야 한다.**
 *
 * 채팅은 흘러간다. 감독이 정지점에서 알고 싶은 건 셋이다 —
 * ① 어디가 밀리나(존) ② 무엇이 통하고 있나(상성) ③ 누구를 빼야 하나(체력).
 * 화면은 그 순서로 읽힌다. 전부 코어가 이미 계산한 값이라 여기서 셈하지 않는다.
 */
/**
 * 판세 — **어디가 밀리나 · 왜 · 내 지시가 먹혔나.**
 *
 * 셋은 한 질문의 세 면이다: 격자가 "왼쪽 중원이 밀린다"를 말하고, 키포인트가 "왜"를
 * 말하고, 공략·노트가 "그래서 내가 시킨 것이 지금 걸려 있나"를 말한다. 탭을 갈라
 * 뒀을 때는 감독이 밀리는 걸 보고 이유를 찾으러 옆 탭으로 건너가 다시 읽어야 했다 —
 * 정지점마다 그러기엔 길이 멀다.
 *
 * **전술 6축은 여기 두지 않는다** — 판을 만지는 자리(전술판)에 이미 있고, 거기서는
 * 읽는 김에 고칠 수도 있다. 두 곳에 같은 값을 세우면 어느 쪽이 진짜인지 흐려진다.
 */
export function MatchOverview({ match }: { match: Match }) {
  const ours = match.home.ours ? "home" : "away";
  return (
    <div className="match-view" data-testid="view-match">
      <ZoneBars match={match} />
      <KeyPoints points={match.keyPoints} />
      <Orders exploiting={match.exploiting} notes={match.tactics[ours].notes} />
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
 * 다른 것은 **아는 것뿐**이다. 적응·폼은 남의 팀에서 읽을 수 없으니 열이 없고,
 * 전력은 오차를 달고(`±`) 체력은 값이 아니라 구간이다. 등번호·나이·시즌 평점은
 * 안개 밖의 공개 사실이라 우리 표와 같이 선다. 조작도 없다 — 상대 판은 읽는
 * 것이지 고치는 것이 아니다.
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
  return (
    <div
      className={`squad-view opponent${boardOpen ? "" : " folded"}`}
      data-testid="view-match-opponent"
    >
      <div className="squad-head">
        <div className="squad-summary">
          <span>
            {/* 선발 평균은 뷰가 낸다 — 상대 쪽은 안개를 지난 값이라 화면이 다시 평균
                내면 우리 쪽 요약과 다른 자로 잰 값이 된다 */}
            <b data-testid="opp-shape">{tactics.formation}</b> · 선발 평균{" "}
            <b>{match.xiRating[them]}</b>
          </span>
          <span className="muted">
            교체 {subs.used}/{match.subs.limit.subs} · 기회 {subs.windows}/
            {match.subs.limit.windows}
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
          <TeamTotals totals={match.totals[them]} />
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
 * 경기 시계 — **상단 띠의 날짜 자리**에 선다.
 *
 * 경기 중에 감독이 알아야 할 시각은 달력의 날짜가 아니라 **몇 분인가**이고,
 * 그 옆에 대회·라운드가 붙으면 "이게 무슨 경기인지"까지 한 줄로 읽힌다.
 */
export function MatchClock({ match }: { match: Match }) {
  return (
    <span className="match-clock" data-testid="match-clock">
      {/* 좁아지면 대회·라운드가 접힌다 — 그때 급한 건 **몇 분인가**이고, 무슨
          경기인지는 바로 아래 스코어보드가 두 팀 이름으로 이미 말한다 */}
      {/* 단계가 없는 경기(친선)는 이름만 선다 — 빈 단계가 공백으로 남지 않게 */}
      <span className="abbr">{[match.competition, match.stage].filter(Boolean).join(" ")} · </span>
      <b>{match.minute}′</b> {match.phase}
    </span>
  );
}

/**
 * 경기 머리 — **스코어·시계·득점자.**
 *
 * ⚠️ 경기 화면의 상단 띠에 선다. 어느 탭을 보든 사라지지 않아야 하는 하나이고,
 * 나머지 탭은 전부 "왜 그 스코어인가"를 설명하는 것들이다.
 */
export function MatchHeadline({ match }: { match: Match }) {
  return (
    <div className="match-headline">
      <Scoreboard match={match} />
      <GoalLog goals={match.goals} />
      <ShootoutLog shootout={match.shootout} />
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
      {/* 칩이 어느 쪽이 홈인지 말한다 — 이름만으로는 매번 헷갈린다.
          칩은 줄의 **바깥쪽** 끝에 서고, 안쪽은 이름과 스코어가 붙어 읽힌다 */}
      <span className={`mv-team ${match.home.ours ? "ours" : ""}`}>
        <i className="mv-ground">Home</i>
        {match.home.name}
      </span>
      <b className="mv-goals">
        {match.score.home} : {match.score.away}
      </b>
      <span className={`mv-team away ${match.away.ours ? "ours" : ""}`}>
        {match.away.name}
        <i className="mv-ground">Away</i>
      </span>
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
 * 왼쪽에서 오른쪽으로 그리는 순서 — **자리는 홈 기준**이라 왼쪽이 홈 골문이다.
 * 그 줄이 누구의 진영인지는 뷰의 `zones[].label`이 이미 말한다.
 */
const BANDS = ["defense", "midfield", "attack"] as const;
/** 위에서 아래로 — 우리가 공격 방향을 바라볼 때의 왼쪽·가운데·오른쪽 */
const LANES = [
  { key: "left", label: "좌" },
  { key: "center", label: "중" },
  { key: "right", label: "우" },
] as const;

/**
 * 우열을 색으로 — **문턱은 화면에 없다.**
 *
 * 어느 쪽이 이기고 있는지(`edge`)와 얼마나 벌어졌는지(`size`)는 코어가 매치업
 * 문장과 같은 자리에서 정해 실어 보낸 값이다(`sim`의 `edgeOf`). 화면이 비율을
 * 다시 재면 한쪽만 손봤을 때 같은 판이 GM의 말과 다른 색으로 보인다.
 */
function edgeClass(v: { edge: "ours" | "theirs" | "even"; size: "slight" | "clear" | "big" }) {
  if (v.edge === "even") return "even";
  return `${v.edge === "ours" ? "up" : "down"} ${v.size}`;
}

/** 벌어진 폭을 부르는 말 — 코어의 `size`에 화면이 주는 이름 */
const SIZE_KO = { slight: "근소한", clear: "뚜렷한", big: "압도적인" } as const;

/** 그 줄·그 칸을 한 줄로 읽어 주는 말 — 마우스를 얹으면 나온다 */
function edgeTitle(v: {
  ours: number;
  theirs: number;
  edge: "ours" | "theirs" | "even";
  size: "slight" | "clear" | "big";
}) {
  const gap =
    v.edge === "even" ? "팽팽하다" : `${SIZE_KO[v.size]} ${v.edge === "ours" ? "우위" : "열세"}`;
  return `우리 ${Math.round(v.ours)} vs 상대 ${Math.round(v.theirs)} — ${gap}`;
}

/**
 * 스물두 명의 자리 — **두 팀을 한 번에 놓는다.**
 *
 * 팀별로 따로 놓으면 홈 최전방과 원정 최종 수비가 같은 자리에 겹친다(둘은 실제로
 * 같은 곳에서 맞선다). 한 배열로 모아 밀어내야 상대와도 겹치지 않는다.
 *
 * 팀 안의 겹침(코드만 보면 센터백 둘이 한 점)은 전술판과 **같은 방식**으로 먼저
 * 푼다 — `separateBoardPoints`. 마커 숫자는 실제 등번호를 쓰고, 공식 번호가 아직
 * 없는 선수만 자리 순번으로 폴백한다.
 */
function placeBothSides(match: Match): {
  player: MatchPlayer;
  no: number;
  at: PitchPoint;
}[] {
  const sides = (["home", "away"] as const).flatMap((side) => {
    const players = match.onPitch[side];
    const board = separateBoardPoints(players.map((p) => p.point ?? anchorOf(p.position)));
    return players
      .map((player, i) => ({ player, point: board[i]! }))
      .sort((a, b) => b.point.y - a.point.y || a.point.x - b.point.x)
      .map((e, i) => ({
        player: e.player,
        no: e.player.squadNumber ?? i + 1,
        at: pitchPointOf(e.point, side),
      }));
  });
  const spread = spreadMarkers(sides.map((s) => s.at));
  return sides.map((s, i) => ({ ...s, at: spread[i]! }));
}

/**
 * 판세 — **경기장 위의 아홉 칸과 스물두 명.**
 *
 * 세 전선을 막대 셋으로만 보여주면 "중원이 밀린다"까지만 읽힌다. 그런데 감독이
 * 손보는 것은 자리다: 밀리는 게 왼쪽인지 가운데인지에 따라 뺄 선수도 내릴 지시도
 * 다르다. 그래서 판세를 **경기장 모양 그대로** 펼치고, 그 위에 두 팀의 배치를
 * 얹는다 — 밀리는 칸에 누가 서 있는지가 한 화면에서 읽힌다.
 *
 * **홈이 왼쪽**이다. 우리 편 기준으로 돌리면 스코어보드·득점과 좌우가 어긋나
 * 0:1이 어느 쪽 골인지 다시 따져야 한다. 대신 색이 편을 말한다.
 *
 * 아홉 칸은 새 수치가 아니라 존 전력을 좌·중·우로 **나눈 것**이다
 * (sim `zone-grid.ts`) — 화면에만 있고 결과에 닿지 않는 숫자는 감독을 속인다.
 */
function ZoneBars({ match }: { match: Match }) {
  const cellOf = (band: string, lane: string) =>
    match.grid.find((c) => c.band === band && c.lane === lane);
  /** 그 전선 전체의 판정 — 코어가 매치업으로 이미 매겨 보낸 줄이다 */
  const zoneOf = (band: string) => match.zones.find((z) => z.zone === band);
  return (
    <div className="mv-zones" data-testid="match-zones">
      {/* 기대 득점 — 판세의 결론이라 판 위에 크게 선다. 순서는 스코어와 같은 홈 : 원정 */}
      <div className="mv-xg">
        <span className="mv-xg-label">기대 득점</span>
        <span className="mv-xg-score">
          <b className={match.expectedGoals.home >= match.expectedGoals.away ? "lead" : ""}>
            {match.expectedGoals.home.toFixed(2)}
          </b>
          <i>:</i>
          <b className={match.expectedGoals.away > match.expectedGoals.home ? "lead" : ""}>
            {match.expectedGoals.away.toFixed(2)}
          </b>
        </span>
      </div>
      <div className="mv-pitch">
        {/* 줄 이름과 그 줄의 우열 — 격자를 읽는 눈금이라 그림 쪽이다 */}
        <div className="mv-pitch-head" aria-hidden>
          {BANDS.map((band) => {
            const z = zoneOf(band);
            if (!z) return <span key={band} />;
            return (
              <span className={`mv-band ${edgeClass(z)}`} key={band} title={edgeTitle(z)}>
                {z.label}
              </span>
            );
          })}
        </div>
        <div className="mv-pitch-field">
          {LANES.map((lane) =>
            BANDS.map((band) => {
              const c = cellOf(band, lane.key);
              if (!c) return null;
              const diff = Math.round(c.ours - c.theirs);
              return (
                <span
                  className={`mv-cell ${edgeClass(c)}`}
                  key={`${band}:${lane.key}`}
                  title={`${zoneOf(band)?.label ?? ""} ${lane.label} — ${edgeTitle(c)}`}
                >
                  {diff > 0 ? `+${diff}` : diff}
                </span>
              );
            }),
          )}
          {/* 경기장 선 — 읽는 값이 아니라 자리를 알려주는 그림이다 */}
          <span className="mv-pitch-lines" aria-hidden />
          {/* 배치 — 밀리는 칸에 누가 서 있는지 */}
          <div className="mv-pitch-players">
            {placeBothSides(match).map(({ player, no, at }) => (
              <span
                className={`mv-marker${player.ours ? " ours" : ""}${player.gassed ? " gassed" : ""}`}
                key={player.id}
                style={{ left: `${at.left}%`, top: `${at.top}%` }}
                title={`${player.squadNumber === null ? "임시 " : ""}${no}번 · ${player.name} (${player.position}) — 전력 ${player.effective}${player.gassed ? " · 다리가 멈췄다" : ""}`}
                /**
                 * **읽는 값이지 조작 대상이 아니다.** 눌러서 열리는 것이 없는데도
                 * 탭 정지점이었던 탓에, 판 하나를 지나려면 스물두 번을 눌러야 했고
                 * 멈춘 자리마다 포커스 링만 떴다. 탭 순서에서 빼고 `role="img"`로
                 * 세워 이름은 `aria-label`이 갖는다 — 번호만 읽히면 누구인지 모른다.
                 * 다리가 멈춘 것도 여기 싣는다: 판에서는 빨간 테두리뿐이라 색을
                 * 못 보면 교체 신호가 통째로 사라진다.
                 */
                role="img"
                aria-label={`${no}번 ${player.name}, ${player.position}, 전력 ${player.effective}${player.gassed ? ", 다리가 멈췄다" : ""}`}
              >
                {no}
              </span>
            ))}
          </div>
        </div>
        <div className="mv-pitch-foot" aria-hidden>
          <span>{match.home.short} 골문</span>
          <span>{match.away.short} 골문</span>
        </div>
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
function KeyPoints({ points }: { points: Match["keyPoints"] }) {
  if (points.length === 0) return null;
  return (
    <div className="mv-keys" data-testid="match-keys">
      {points.map((p, i) => (
        /**
         * 우리에게 이로운 줄은 파랑, 불리한 줄은 빨강 — **누구 얘기인지는 코어가
         * 정한다.** 예전엔 문장에 "구멍"이 들었는지로 갈랐는데, 그 구멍이 우리
         * 것인지 상대 것인지는 문장만 봐선 알 수 없었다.
         */
        <div className={`mv-key${p.ours === null ? "" : p.ours ? " good" : " bad"}`} key={i}>
          {p.text}
        </div>
      ))}
    </div>
  );
}

/**
 * 지시가 판에 닿았나 — **공략 중과 전술 노트.**
 *
 * 공략(match.md §1.6)과 지역 플랜(§1.7)은 경기 중에만 부를 수 있고 장부에 흔적을
 * 남기지 않아 레일 말풍선이 없다(overview §5). 그래서 이 자리가 유일한 증거다:
 * 걸린 공략은 감독이 읽은 그 표적 이름 그대로 서고, 걸리지 않았거나 버려진 것과
 * 개인 지시의 결과는 노트 한 줄로 선다 — 노트가 없으면 감독은 걸리지 않은 공략을
 * 걸린 줄 안다.
 */
function Orders({ exploiting, notes }: { exploiting: string[]; notes: string[] }) {
  if (exploiting.length === 0 && notes.length === 0) return null;
  return (
    <div className="mv-orders" data-testid="match-orders">
      {exploiting.length > 0 && (
        <div className="mv-exploits" data-testid="match-exploiting">
          <b>공략 중</b>
          {exploiting.map((target, i) => (
            <span className="mv-exploit" key={i}>
              {target}
            </span>
          ))}
        </div>
      )}
      {notes.map((note, i) => (
        <div className="mv-note" key={i}>
          {note}
        </div>
      ))}
    </div>
  );
}

/**
 * 상대 전술 6축 — **읽기 전용.**
 *
 * 우리 쪽 6축은 전술판(`TacticsPanel`)이 갖고 거기서 고칠 수도 있다. 여기는
 * 상대의 것이라 고칠 수 없고, 그래서 모양도 다르다 — 누를 수 있는 것과 읽는 것은
 * 생김새가 달라야 한다. 지시의 방향은 **점의 기울기**로 한눈에 읽힌다.
 *
 * ⚠️ 전술은 안개를 지나지 않는다. 90분 동안 눈앞에서 라인이 올라가고 압박이
 * 들어오는 것은 감독이 그냥 보는 사실이다 — 흐릴 것은 선수의 수치이지 팀의 성향이
 * 아니다 (player.md §9와 같은 경계).
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
      {TACTIC_AXES.map((axis) => {
        const v = tactics[axis.key];
        return (
          <div className="mv-tac-row one" key={axis.key}>
            <span className="mv-tac-axis">{axis.label}</span>
            <Dots value={v} align="left" title={`${axis.label} ${v}`} />
            <span className="mv-tac-word">{tacticWord(axis.key, v)}</span>
          </div>
        );
      })}
      {/* 상대 벤치가 지금 하고 있는 일 — 6축이 말하지 않는 것(공략·개인 지시)이 여기
          남는다. 문장이 흐린 것은 그가 못 본 수치가 노트로 새지 않게 코어가 그렇게
          쓴 것이다 (match.md §1.6) */}
      {tactics.notes.length > 0 && (
        <div className="mv-tac-notes" data-testid="opp-tactic-notes">
          {tactics.notes.map((note, i) => (
            <span className="mv-note" key={i}>
              {note}
            </span>
          ))}
        </div>
      )}
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
    /* 상대도 같은 그라운드에 같은 칩으로 선다 — 두 판이 한 컴포넌트를 쓰므로
       한쪽만 손질돼 서로 다른 모양이 되는 일이 없다 (pitch.tsx) */
    <PitchGround testId="opponent-board" tactics={tactics}>
      {players.map((p, i) => {
        const point = points[i]!;
        const group = positionGroupOf(p.position);
        return (
          <PitchChip
            key={p.id}
            variant={`theirs${group ? ` g-${group.toLowerCase()}` : ""}${p.gassed ? " gassed" : ""}`}
            style={{ left: `${point.x}%`, top: `${point.y}%` }}
            testId={`opp-slot-${p.id}`}
            title={[
              p.name,
              `${p.position} 자리 기준 ${p.effective}${p.margin > 0 ? ` (±${p.margin})` : ""}`,
              `${p.condition.label} — 체력 ${p.condition.low}~${p.condition.high}`,
            ].join("\n")}
            code={p.position}
            squadNumber={p.squadNumber}
            name={p.name}
            ovr={p.effective}
            metaExtra={p.margin > 0 && <i className="slot-margin">±{p.margin}</i>}
          />
        );
      })}
    </PitchGround>
  );
}

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

/** 킥 하나의 결말 — 골키퍼가 막았으면 누가 막았는지까지 (막은 사람도 사건이다) */
function kickOutcome(kick: Shootout["kicks"][number]): string {
  if (kick.outcome === "scored") return "성공";
  if (kick.outcome === "saved") return kick.keeper ? `${kick.keeper} 선방` : "선방";
  return "실축";
}

/**
 * 승부차기 — **합계와 킥 하나하나가 찬 순서대로 선다** (match.md §8).
 *
 * 득점 기록과 같은 자리·같은 모양이다: 스코어 아래 한 줄로 흐르고 우리 킥은 색으로
 * 갈린다. 감독이 다음 키커를 정하려면 누가 찼고 들어갔는지 막혔는지가 보여야 한다.
 * 성공 확률은 그리지 않는다 — 화면이 게임 내부 수치를 입에 담지 않는다.
 */
function ShootoutLog({ shootout }: { shootout: Match["shootout"] }) {
  if (!shootout) return null;
  return (
    <div className="mv-goals-log" data-testid="match-shootout">
      <span className="mv-goal">
        <i>승부차기</i>
        {shootout.tally.home} : {shootout.tally.away}
      </span>
      {shootout.kicks.map((kick, i) => (
        <span key={i} className={`mv-goal${kick.ours ? " ours" : ""}`}>
          <i>
            {kick.round}R {kick.team}
          </i>
          {kick.taker}
          <em> {kickOutcome(kick)}</em>
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
    t.scoringExpectation > 0 ? `기대득점 ${t.scoringExpectation.toFixed(2)}` : null,
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
function TeamTotals({ totals }: { totals: MatchTotals }) {
  // 접는 것은 뷰가 한다 — 화면이 같은 행들을 다시 더하면 선수별과 팀 합계가 갈린다
  if (totals.passes === 0 && totals.shots === 0) return null;
  return (
    <div className="mv-totals" data-testid="match-totals">
      <span>
        패스 <b>{totals.passes}</b>
      </span>
      <span>
        전진 <b>{totals.progressive}</b>
      </span>
      <span>
        슛 <b>{totals.shots}</b>
      </span>
      <span title="이 경기에서 만든 기회의 질 — 팀 합계">
        xG <b>{totals.xg.toFixed(2)}</b>
      </span>
      <span>
        결정력 반영 <b>{totals.scoringExpectation.toFixed(2)}</b>
      </span>
      <span>
        선방 <b>{totals.saves}</b>
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
 * 없는 열은 **모르는 것**뿐이다 — 적응·폼은 남의 팀에서 읽을 수 없다. 등번호·
 * 나이·시즌 평점은 90분 동안 보이는 공개 사실이라 우리 표와 같은 자리·같은
 * 표기로 선다. 우리 표에서 나이·평점은 `hide-sm`으로 좁을 때 접히는 열이라,
 * 좁은 화면에서는 두 표가 같은 열을 세운다.
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
          <th className="hide-sm">나이</th>
          <th>OVR</th>
          <th>체력</th>
          <th className="hide-sm">평점</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g, gi) => (
          <Fragment key={g.slug}>
            {/* 칸이 갈리는 자리는 **선 하나** — 우리 표와 같다(이름은 왼쪽 선 색이 말한다) */}
            {gi > 0 && (
              <tr className="tier-head" data-tier={g.slug} aria-hidden>
                <td colSpan={6} />
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
                  {/* 등번호는 이름 앞에 — 우리 명단·전술판 칩과 같은 자리·같은 모양 */}
                  <span className="row-name">
                    {p.squadNumber !== null && (
                      <i className="shirt-no" title={`${p.squadNumber}번`}>
                        {p.squadNumber}
                      </i>
                    )}
                    {p.name}
                  </span>
                  {/* 다리가 멈춘 선수 — 우리 표의 상태 표식(부상·정지)과 같은 자리·같은 모양 */}
                  {p.gassed && (
                    <span className="tag st alert" title="다리가 멈췄다 — 이 자리에 구멍이 나 있다">
                      구멍
                    </span>
                  )}
                  <Tally t={p.tally} />
                </td>
                <td>{p.position}</td>
                <td className="hide-sm">{p.age}</td>
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
                  <ConditionBar c={p.condition} />
                </td>
                {/* 시즌 평점 — 공개 기록이라 우리 명단과 같은 숫자·같은 소수 자리다 */}
                <td className="hide-sm">
                  {typeof p.seasonRating === "number" ? p.seasonRating.toFixed(2) : "—"}
                </td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
