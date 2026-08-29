"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { CardMark, ChatTurn, GoalMark, ToolCallRecord } from "@story-fm/engine";
import { cutStamps } from "../lib/scene-stamp";
import { hasRailHint } from "../lib/panel-hints";
import { groupChips, groupPieces, splitStaging, weaveTurn } from "../lib/turn-pieces";
import type { Utterance } from "../lib/turn-pieces";
import { BROADCAST_SPEAKER, formatMoney, normalizeSpeaker } from "@story-fm/domain";
import type { ScoutReportCard } from "@story-fm/domain";
import { MarketCardView, MissionReportCardView } from "@/components/market-card";
import { splitMarketCalls } from "@/lib/market-calls";
import { ratingTone, scoutMargin, scoutValue } from "@/lib/scout-report-display";
import { CALL_LABEL } from "@/lib/call-label";
import type { SpeakerKind, SpeakerRole } from "@story-fm/engine";
import {
  IconBroadcast,
  IconCaptain,
  IconCoach,
  IconJersey,
  IconOwner,
  IconMatch,
  IconPerson,
  IconReporter,
  type IconComponent,
} from "@/components/icons";

/**
 * 자리 → 아이콘 — **모든 화자가 하나씩 갖는다.**
 *
 * 이름만으로는 누가 코치고 누가 선수인지 매번 읽어야 안다. 아이콘이 앞에 서면
 * 대화를 훑을 때 자리가 먼저 눈에 든다. 세이브가 자리를 모르는 화자(기자·에이전트·
 * 남의 팀 사람)에는 **사람 아이콘**이 선다 — 틀린 직책을 다느니 "누군가 말한다"까지만
 * 말한다. 자리는 화면이 추측하지 않는다: `speakerRoles`가 코어에서 정해 실어 보낸다.
 */
const KIND_ICON: Partial<Record<SpeakerKind, IconComponent>> = {
  head_coach: IconCoach,
  owner: IconOwner,
  reporter: IconReporter,
  captain: IconCaptain,
  player: IconJersey,
};

/**
 * *연출* 구간을 <em>으로 렌더 — 나누는 규칙은 `splitStaging`이 갖는다(연속 별표·
 * 짝이 안 맞는 별표·스트리밍 중 열린 채 끝난 `*…`).
 */
function renderStaging(text: string) {
  return splitStaging(text).map((part, i) =>
    part.staging ? <em key={i}>{part.text}</em> : <Fragment key={i}>{part.text}</Fragment>,
  );
}

/** 화자 없는 줄 — 장면 지문 */
function NarrationLines({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((content, i) => (
        <div className="line narration" key={i}>
          {renderStaging(content)}
        </div>
      ))}
    </>
  );
}

/** 한 사람의 발화 묶음 — 이름은 머리에 한 번, 대사는 그 아래로 */
function UtteranceBlock({
  utterance,
  roles,
}: {
  utterance: Utterance;
  roles?: Record<string, SpeakerRole>;
}) {
  const { speaker, lines } = utterance;
  if (speaker === "") return <NarrationLines lines={lines} />;
  const isBroadcast = speaker === BROADCAST_SPEAKER;
  // 직책은 모델이 아니라 세이브가 안다 — 이름만 맞으면 어떤 턴에서도 함께 보인다
  const role = roles?.[normalizeSpeaker(speaker)];
  const Icon = isBroadcast ? IconBroadcast : (role && KIND_ICON[role.kind]) || IconPerson;
  return (
    <div className={`say${isBroadcast ? " broadcast" : ""}`}>
      <div className="say-who">
        <span className="speaker-icon" aria-hidden>
          <Icon />
        </span>
        <span className="speaker">{speaker}</span>
        {/**
         * 직함은 **칩**이다 — 괄호로 묶으면 이름과 같은 줄의 같은 글자라서
         * 어디까지가 이름인지 눈이 한 번 더 짚는다. 테두리가 그 경계를 대신
         * 말하면 이름만 읽고 지나갈 수 있고, 필요할 때만 직함이 눈에 든다.
         */}
        {role?.label && <span className="speaker-role">{role.label}</span>}
      </div>
      {lines.map((content, i) => (
        <div className="line" key={i}>
          {renderStaging(content)}
        </div>
      ))}
    </div>
  );
}

/**
 * 골 카드 — **판을 뒤집은 사실을 문단 밖으로 꺼내 세운다.**
 *
 * 골은 경기에서 유일하게 결과를 바꾸는 사건인데, 중계 문단 한복판에 문장으로만
 * 남으면 다음 턴 두어 개에 밀려 스크롤에 묻힌다. 감독이 나중에 위로 훑을 때
 * 눈이 걸려야 하는 자리이므로 **줄 하나를 통째로** 준다.
 *
 * 카드의 내용은 전부 장부에서 온 사실이다(`ChatTurn.goals`) — 중계 문장을
 * 되읽어 만들지 않는다. 우리 골만 강조색을 갖고 상대 골은 가라앉는다:
 * 둘을 같은 색으로 칠하면 스코어를 읽기 전에는 누가 넣었는지 알 수 없다.
 */
function GoalCard({ goal }: { goal: GoalMark }) {
  return (
    <div className={`goal-card${goal.ours ? " ours" : ""}`} data-testid="goal-card">
      <span className="goal-ball" aria-hidden>
        <IconMatch size={17} />
      </span>
      <b className="goal-minute">{goal.minute}′</b>
      <span className="goal-scorer">{goal.scorer}</span>
      {goal.assist && <span className="goal-assist">도움 {goal.assist}</span>}
      <span className="goal-score">
        {goal.team} {goal.score.home} : {goal.score.away}
      </span>
    </div>
  );
}

/**
 * 호출 칩 — **접힌 채로는 이름과 결, 누르면 상세.**
 *
 * 이름을 그대로 쓰면(`set_player_tactic`) 감독은 자기가 아는 말이 아닌 것을 읽는다.
 * 사람이 읽는 이름은 스킬 카탈로그가 이미 갖고 있으므로 그걸 쓴다.
 *
 * `tone`이 있는 칩(면담·팀토크·기자회견)은 **펼치지 않아도 결이 보인다** — 잘
 * 풀렸는지는 알아야 하지만 사기 ±N을 늘 세우면 대화가 숫자로 읽힌다.
 *
 * **칩 하나가 호출 여럿을 진다** — 연달아 불린 같은 호출은 한 칩이다(`groupChips`).
 * 몇 번인지는 이름 옆의 **수 하나**로 서고, 펼치면 묶인 호출의 상세가 차례로 선다.
 *
 * **상세가 열리는 자리는 갈 화면이 있는지가 정한다.** 장부를 바꾼 호출은 레일
 * 말풍선을 다시 세운다(`onReveal`) — 같은 사실을 칩 아래에 또 펼치면 두 곳에 난다.
 * 레일이 없는 동안(경기 중)에는 그 칩도 제자리에서 펼친다: 부를 말풍선이 없다.
 */
function ToolChip({
  calls,
  onReveal,
  revealed = false,
}: {
  /** 이 칩이 진 호출들 — 첫 호출이 이름과 결을 정한다 (묶음은 그 둘이 같아야 선다) */
  calls: readonly ToolCallRecord[];
  onReveal?: (calls: readonly ToolCallRecord[]) => void;
  revealed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const head = calls[0]!;
  const label = CALL_LABEL[head.name] ?? head.name;
  const tone = head.tone ? ` ${head.tone}` : "";
  const toRail = onReveal !== undefined && hasRailHint(head.name);
  const shown = toRail ? revealed : open;
  return (
    <span className="tool-chip-wrap">
      <button
        className={`tool-chip${shown ? " open" : ""}${tone}`}
        onClick={() => (toRail ? onReveal(calls) : setOpen((o) => !o))}
        data-testid={`tool-${head.name}`}
        aria-expanded={shown}
        title={label}
        /* 이 클릭은 말풍선을 닫는 "다른 쪽"이 아니다 — game-screen의 바깥 클릭 감시가 읽는다 */
        data-hint-keep={toRail ? "" : undefined}
      >
        {label}
        {calls.length > 1 && <i className="tool-chip-count">{calls.length}</i>}
      </button>
      {!toRail && open && (
        <div className="tool-detail" data-testid={`tool-detail-${head.name}`}>
          {calls.map((call, i) => (
            // 묶인 호출은 저마다 한 칸 — 셋을 한 덩이로 이으면 어디까지가 한 교체인지 흐려진다
            <div className="tool-detail-call" key={i}>
              <ToolDetail call={call} />
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * 칩을 펼친 속 — **코어가 낸 항목을 그대로 세운다.**
 *
 * 코어가 머리줄과 항목(`brief`)을 내므로 화면은 그것을 받기만 한다. 요약 문자열을
 * 되쪼개 항목을 만들지 않는다 — 문구가 바뀔 때마다 조용히 깨지고, 사실을 내는
 * 것은 코어의 몫이다(AGENTS.md §4). `brief`가 없는 옛 기록은 요약을 그대로 세운다.
 *
 * 입력(JSON)은 더 이상 그리지 않는다 — 감독이 읽을 것이 아니라 디버깅용이었고,
 * 상세가 정돈된 뒤로는 잡음이다.
 */
function ToolDetail({ call }: { call: ToolCallRecord }) {
  const brief = call.brief;
  if (!brief) return <div className="tool-detail-summary">{call.summary}</div>;
  return (
    <>
      <div className="tool-brief-head">{brief.head}</div>
      {brief.items.length > 0 && (
        <div className="tool-lines">
          {brief.items.map((item, i) => (
            // 알약 하나가 항목 하나 — 이름은 흐리게 앞, 값은 또렷하게, 갈래는 뒤에
            <span className="tool-item" key={i}>
              {item.label !== undefined && <em>{item.label}</em>}
              <b>{item.text}</b>
              {item.note !== undefined && <i>{item.note}</i>}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * 경고·퇴장 — **다음 판단의 입력이라 문단 밖에 선다.**
 *
 * 골과 같은 자리를 쓰되 색과 모양이 다르다. 경고를 받은 선수를 계속 두느냐 빼느냐가
 * 곧 교체 결정인데, 중계 문단 한복판에 문장으로만 남으면 두어 턴 뒤 스크롤에
 * 묻힌다. 그때 감독은 "누가 경고였지"를 위로 훑어 찾아야 한다.
 *
 * 우리 선수만 강조된다 — 상대의 경고는 알아 두면 좋은 정보지만 **내가 손볼 자리**는
 * 아니다. 두 번째 경고로 나가는 것과 한 번에 나가는 것은 이야기가 다르므로 갈라 적는다.
 */
function BookingCard({ card }: { card: CardMark }) {
  const label =
    card.kind === "yellow" ? "경고" : card.kind === "second_yellow" ? "경고 누적 퇴장" : "퇴장";
  return (
    <div
      className={`booking-card ${card.kind}${card.ours ? " ours" : ""}`}
      data-testid="booking-card"
    >
      <span className="booking-mark" aria-hidden />
      <b className="booking-minute">{card.minute}′</b>
      <span className="booking-player">{card.player}</span>
      <span className="booking-kind">{label}</span>
      <span className="booking-team">{card.team}</span>
    </div>
  );
}

/**
 * 능력치 막대의 바닥 — 프로 선수의 축은 여기 아래로 잘 내려가지 않는다.
 * 0에서 시작하면 열여섯 줄이 모두 반쯤 차 보여 강점과 약점이 뭉갠다.
 */
const BAR_FLOOR = 25;

const barPct = (value: number) =>
  Math.max(0, Math.min(100, ((value - BAR_FLOOR) / (99 - BAR_FLOOR)) * 100));

/**
 * 스카우팅 보고서 — **며칠을 기다려 얻은 것이므로 한 장으로 편다.**
 *
 * 한 번 읽고 넘어갈 정보가 아니다 —
 * 능력치·주발·잠재력·몸값이 한자리에 있어야 "지금 지를까, 더 볼까"가 판단된다.
 *
 * **안개는 모양으로 드러난다.** 종합과 잠재력은 아예 등급으로 말하고(스카우트가
 * 가져온 숫자에는 늘 ±가 붙는다), 축은 막대 끝이 오차만큼 번진다. 또렷한 숫자
 * 하나로 그리면 감독이 그걸 사실로 읽는다.
 */
function ScoutReport({ report: r }: { report: ScoutReportCard }) {
  const groups = [...new Set(r.attributes.map((a) => a.group))];
  const overall = scoutValue(r.overall);
  const overallMargin = scoutMargin(r.overall);
  const potentialLow = r.potential ? scoutValue(r.potential.low) : null;
  const potentialHigh = r.potential ? scoutValue(r.potential.high) : null;
  return (
    <div className="scout-report" data-testid="scout-report">
      <div className="sr-head">
        <span className="sr-badge">스카우팅 보고서</span>
        <b className="sr-name">{r.name}</b>
        <span className="sr-meta">
          {r.team} · {r.age}세 · {r.position}
        </span>
        <span
          className="sr-ovr"
          data-rating={overall === null ? undefined : ratingTone(overall)}
          title={
            overall === null
              ? undefined
              : overallMargin > 0
                ? `가장 잘 맞는 자리 기준 종합 추정치 ${overall} ±${overallMargin}`
                : `가장 잘 맞는 자리 기준 종합 ${overall}`
          }
        >
          <em>종합</em>
          <b>
            {overall ?? "—"}
            {overallMargin > 0 && <i>±{overallMargin}</i>}
          </b>
        </span>
      </div>

      <div className="sr-facts">
        <span>
          <em>잠재력</em>
          <b title={r.potential ? "잠재력 추정 구간" : "성장 여력을 짐작할 근거가 없다"}>
            {potentialLow !== null && potentialHigh !== null
              ? `${potentialLow}~${potentialHigh}`
              : "미지"}
          </b>
        </span>
        <span>
          <em>주발</em>
          <b>
            {r.foot.left >= r.foot.right ? "왼발" : "오른발"} {r.foot.left}/{r.foot.right}
          </b>
        </span>
        {r.height !== null && (
          <span>
            <em>신체</em>
            <b>
              {r.height}cm{r.weight !== null && ` ${r.weight}kg`}
            </b>
          </span>
        )}
        <span>
          <em>시장가</em>
          <b>{formatMoney(r.marketValue)}</b>
        </span>
        <span>
          <em>기대 주급</em>
          <b>{formatMoney(r.wageExpectation)}</b>
        </span>
        {r.contractUntil && (
          <span>
            <em>계약</em>
            <b>{r.contractUntil}</b>
          </span>
        )}
      </div>

      <div className="sr-positions">
        {r.positions.map((p) => (
          <span className={`sr-pos${p.natural ? " natural" : ""}`} key={p.position}>
            {p.position}
          </span>
        ))}
      </div>

      <div className="sr-groups">
        {groups.map((group) => (
          <div className="sr-group" key={group}>
            <div className="sr-group-name">{group}</div>
            {r.attributes
              .filter((a) => a.group === group)
              .map((a) => (
                <span
                  className={`sr-axis${a.margin > 0 ? " fuzzy" : ""}`}
                  key={a.key}
                  data-rating={ratingTone(a.value)}
                >
                  <em>{a.ko}</em>
                  {/**
                   * 막대는 **확실한 몫까지 채우고 오차만큼 번진다** — 스카우팅을
                   * 마쳐도 관측형 ±1 · 분석형 ±3이 남는다. 단정/추정 둘로만 그리면
                   * "리포트를 받은 선수"와 "소문으로만 아는 선수"가 같아 보인다.
                   */}
                  <span
                    className="sr-bar"
                    aria-hidden
                    style={
                      {
                        "--fill": barPct(a.value - a.margin),
                        "--fog": barPct(a.value + a.margin) - barPct(a.value - a.margin),
                      } as CSSProperties
                    }
                  />
                  <b>
                    {a.value}
                    {a.margin > 0 && <i className="est">±{a.margin}</i>}
                  </b>
                </span>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 선수 id처럼 생긴 토큰 — 사전에 없으면 그대로 둔다 (`store.ts`와 같은 규칙) */
const ID_LIKE = /[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g;

/**
 * 서사에 흘러든 선수 id를 이름으로 — 스트리밍 델타에 id가 흘러든 경우의 안전망.
 *
 * ⚠️ 사전을 순회하지 않는다. 텍스트에서 id 모양을 찾아 사전을 조회해야 비용이
 * 사전 크기가 아니라 텍스트 길이에 비례한다.
 */
function humanize(text: string, names?: Record<string, string>): string {
  if (!names || !text.includes("-")) return text;
  return text.replace(ID_LIKE, (token) => names[token] ?? token);
}

export { partOfDayStamp, turnStamp } from "../lib/scene-stamp";

/** 눌렀다고 치는 시간 — 짧으면 스크롤을 잡는 손에 걸리고, 길면 눌러도 안 열린 줄 안다 */
const LONG_PRESS_MS = 500;
/** 이만큼 움직이면 누른 게 아니라 끄는 것이다 (스크롤·드래그 선택) */
const LONG_PRESS_SLOP = 10;

/**
 * 롱프레스 — 주어졌을 때만 핸들러가 달린다.
 *
 * ⚠️ 채팅에는 이미 누를 것이 있다(호출 칩·접힌 경기 머리). 그 위에서 시작한
 * 눌림은 그 버튼의 몫이라 아예 시계를 걸지 않고, 롱프레스가 성립한 뒤에는
 * 뒤따르는 click과 컨텍스트 메뉴를 삼킨다 — 안 그러면 손을 떼는 순간 다른 것이
 * 함께 열린다.
 */
type PressHandlers = {
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp?: () => void;
  onPointerCancel?: () => void;
  onPointerLeave?: () => void;
  onClickCapture?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
};

function useLongPress(onLongPress?: () => void): PressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };
  useEffect(() => cancel, []);

  if (!onLongPress) return {};
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      if (e.target instanceof Element && e.target.closest("button, a, input, textarea, summary"))
        return;
      fired.current = false;
      origin.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        cancel();
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      const from = origin.current;
      if (!from) return;
      if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > LONG_PRESS_SLOP) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onClickCapture: (e: React.MouseEvent<HTMLDivElement>) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
    onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => {
      if (fired.current) e.preventDefault();
    },
  };
}

export function ChatTurnView({
  turn,
  streaming = false,
  playerNames,
  speakerRoles,
  prevStamp = null,
  onRevealHint,
  revealedCall = null,
  onLongPress,
}: {
  turn: ChatTurn;
  /** 스트리밍 중인 미완성 턴 — 마지막 미완성 줄을 보류해 파싱 깨짐 방지 */
  streaming?: boolean;
  playerNames?: Record<string, string>;
  /** 화자 이름→직책 — `스티브 홀랜드 (수석코치)`처럼 함께 보여 준다 */
  speakerRoles?: Record<string, SpeakerRole>;
  /** 바로 앞 모델 턴의 시각 — 같으면 다시 적지 않는다 */
  prevStamp?: string | null;
  /** 장부 칩을 눌렀다 — 레일 말풍선을 다시 세운다 (레일이 서 있을 때만 온다) */
  onRevealHint?: (calls: readonly ToolCallRecord[]) => void;
  /** 지금 말풍선이 서 있는 호출 — 그 칩만 펼친 모양이 된다 (묶음은 첫 호출이 신원이다) */
  revealedCall?: ToolCallRecord | null;
  /**
   * 이 턴을 길게 눌렀다 — 무엇이 열리는지는 이 컴포넌트가 알지 않는다.
   * 주어지지 않으면 제스처 자체가 없다(프로덕션 · 아직 기록이 없는 턴).
   */
  onLongPress?: () => void;
}) {
  const text = useMemo(() => humanize(turn.text, playerNames), [turn.text, playerNames]);
  const press = useLongPress(onLongPress);

  // 감독의 말은 오른쪽 말풍선이라 그 자체로 갈린다 — 구간 표시는 모델 턴이 맡는다.
  // 다만 문법은 같다: 감독이 쓴 `*…*`도 연출로 서고, 새어 든 id도 이름으로 편다
  if (turn.role === "user") {
    return (
      <div className="turn-user" {...press}>
        {renderStaging(text)}
      </div>
    );
  }

  let lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (streaming && lines.length > 0) {
    // 아직 콜론/닫는 괄호가 도착하지 않은 마지막 줄은 다음 델타까지 보류 —
    // 안 그러면 `@김`이나 `[2026-07-15 AM 9:1`이 한 프레임 날것으로 보인다
    const last = lines[lines.length - 1] ?? "";
    if (/^@[^:]*$/u.test(last) || /^\[[^\]]*$/u.test(last)) lines = lines.slice(0, -1);
  }

  /**
   * 시점 헤더를 걷어내 시각 표시로 세운다 — **첫 줄만이 아니다.** GM이 판정을 몇 줄
   * 적고 나서 장면을 여는 턴에서는 헤더가 본문 한복판에 서고, 그때 걷어내지 않으면
   * `[2026-07-15 AM 9:15]`가 대사 사이에 날것으로 남는다.
   *
   * 시각은 **바뀔 때만** 선다 — 같은 값이 반복되면 시간이 흐른다는 신호가 오히려
   * 죽는다. 이 선이 곧 장면의 경계다. 눈금은 **때**라(`partOfDayStamp`) 오전 내내
   * 벌어진 장면들은 한 덩어리로 묶이고, 오후로 넘어갈 때 다시 선다.
   * 정확한 시각은 상단 띠가 갖는다 — 같은 화면에 시계를 둘 두지 않는다.
   */
  const cut = cutStamps(lines);
  lines = cut.lines;
  let seen = prevStamp;
  const stamps = cut.stamps.filter((s) => {
    if (s.stamp === seen) return false;
    seen = s.stamp;
    return true;
  });
  /**
   * 채팅에 세울 칩 — **감독이 시킨 일은 다 여기 남는다.**
   *
   * 장부를 바꾼 호출도 칩으로 선다: 레일 말풍선은 다음 클릭에 닫히고, 그 뒤에
   * "방금 뭘 바꿨더라"를 되짚을 자리가 채팅뿐이다. 칩을 누르면 그 말풍선이 다시
   * 선다(`onRevealHint`) — 상세를 칩 아래에 또 펼치지는 않는다.
   *
   * `silent`은 도구 호출이 아니라 코어가 한 일이다(시계 이동).
   * ⚠️ 이름 비교가 함께 있는 건 **이미 저장된 턴** 때문이다. 표식이 없던 시절의
   * 기록에는 이름밖에 없어서, 그것만으로는 진행 중인 세이브에서 유령 호출이
   * 계속 보인다. 새 기록은 `silent`로 걸러지므로 이 목록은 자라지 않는다.
   */
  const shownCalls = turn.toolCalls.filter(
    (call) => !call.silent && call.name !== "시간 경과" && call.name !== "advance_time",
  );

  /**
   * 표시는 **벌어진 자리**에 선다 — 칩은 호출 시점의 줄 수, 골·경고는 분으로.
   * 자리를 모르는 기록(옛 세이브)은 예전처럼 맨 앞이다.
   * `cuts`는 시각 표시로 떼어 낸 헤더 줄들 — 칩의 줄 수는 그것까지 세고 저장된다.
   */
  const pieces = weaveTurn(lines, {
    goals: turn.goals,
    cards: turn.cards,
    calls: shownCalls,
    stamps,
    cuts: cut.cuts,
  });
  /** 조각마다의 말 묶음 — 화자가 조각 경계를 넘어 이어지므로 턴 전체를 한 번에 묶는다 */
  const grouped = groupPieces(pieces);

  return (
    <div
      className={`turn-model${streaming ? " streaming" : ""}${turn.inMatch === true ? " in-match" : ""}`}
      data-testid="model-turn"
      {...press}
    >
      {pieces.map((piece, i) => {
        if (!piece.mark) {
          return (
            <div className="says" key={`s${i}`}>
              {grouped[i]?.map((utterance, j) => (
                <UtteranceBlock key={j} utterance={utterance} roles={speakerRoles} />
              ))}
            </div>
          );
        }
        const mark = piece.mark;
        if (mark.kind === "stamp")
          return (
            <div className="scene-stamp" data-testid="scene-stamp" key={mark.key}>
              <span>{mark.stamp}</span>
            </div>
          );
        if (mark.kind === "goal") return <GoalCard goal={mark.goal} key={mark.key} />;
        if (mark.kind === "card") return <BookingCard card={mark.card} key={mark.key} />;
        /**
         * 호출 결과가 서는 길은 둘이다 — **갈 장부가 있으면 칩, 없으면 카드.**
         * 카드를 그리는 호출은 칩을 세우지 않는다: 같은 사실이 두 번 나면 카드가
         * 칩의 부연처럼 읽힌다.
         */
        const { cards, chips } = splitMarketCalls(mark.calls);
        return (
          <Fragment key={mark.key}>
            {/* 같은 자리에서 연달아 불린 호출은 한 줄에 나란히 — 칩마다 문단을 끊지 않는다 */}
            {chips.length > 0 && (
              <div className="tool-chips">
                {groupChips(chips).map((group, j) => (
                  <ToolChip
                    calls={group}
                    key={j}
                    onReveal={onRevealHint}
                    revealed={group[0] === revealedCall}
                  />
                ))}
              </div>
            )}
            {cards.map((card, j) => (
              <MarketCardView card={card} key={j} />
            ))}
          </Fragment>
        );
      })}
      {/* 보고서는 대화 뒤 — 서류는 "이런 게 왔습니다" 다음에 놓인다 */}
      {turn.reports?.map((report) => (
        <ScoutReport report={report} key={report.playerId} />
      ))}
      {/* 임무 보고도 서류다 — 지목 보고와 같은 자리에 선다 */}
      {turn.missions?.map((card) => (
        <MissionReportCardView card={card} key={card.missionId} />
      ))}
    </div>
  );
}
