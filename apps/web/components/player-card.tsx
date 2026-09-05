"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  PROMISE_KIND_KO,
  SQUAD_STATUS_KO,
  formatMoney,
  injuryHistoryText,
  physiqueLabel,
} from "@story-fm/domain";
import type { PlayerCardView } from "@story-fm/engine";
import { moodSentence } from "@/lib/mood";
import { AxisGrid, CareerBlock, FootMarks } from "@/components/player-facts";
import { RatingTrend } from "@/components/office/squad/marks";
import { buildPlayerNameIndex, splitPlayerNames, type PlayerNameIndex } from "@/lib/player-names";

/**
 * ── 선수 카드 — 이름을 눌러 여는 한 장 (player.md §9.5) ────────
 *
 * 이야기와 장부가 부르는 이름은 누를 수 있다. 그 손잡이가 서는 자리는 화면마다
 * 다르지만(재정 줄·개인 순위·리포트 평점표·채팅 산문) **여는 자리는 하나다** —
 * 채팅 위에 덮이는 이 카드다. 열리는 자리가 화면마다 따로면 감독은 같은 선수를
 * 두 모양으로 보게 된다.
 *
 * 카드는 **열 때 하나씩** 온다 — 매 턴 오는 짐에 실으면 이야기에 설 수 있는 리그
 * 전체가 따라온다. 경기 리포트와 같은 길이다 (match.md §8).
 */

interface PlayerCardHandle {
  open: (playerId: string) => void;
  /** 산문의 이름을 손잡이로 가르는 사전 — 사전 밖 이름은 글자 그대로 남는다 */
  names: PlayerNameIndex;
}

const PlayerCardContext = createContext<PlayerCardHandle | null>(null);

/**
 * 한 번 받은 카드는 여기 남는다 — 닫았다 다시 여는 손잡이가 요청을 다시 쏘지 않게.
 *
 * ⚠️ **경기 리포트와 다르다** — 끝난 경기의 장부는 더 바뀌지 않지만 선수는 매일
 * 바뀐다(폼·체력·기록). 그래서 사본은 **그 턴 안에서만** 산다: 화면이 새 상태를
 * 받으면(`date`가 바뀌면) 통째로 비운다.
 */
const cache = new Map<string, PlayerCardView>();
let cacheStamp = "";

function cachedCard(gameId: string, playerId: string, stamp: string): PlayerCardView | null {
  if (stamp !== cacheStamp) {
    cache.clear();
    cacheStamp = stamp;
  }
  return cache.get(`${gameId}/${playerId}`) ?? null;
}

/**
 * 카드를 열 수 있는 자리 — **무대 전체를 감싼다.** 손잡이는 장부 뷰 깊은 곳(재정
 * 줄·평점표)과 채팅 산문에 함께 서므로, 여는 함수가 그 둘 모두에 닿아야 한다.
 *
 * `stamp`는 화면이 쥔 상태가 얼마나 새것인가다(날짜·턴 수) — 이 값이 바뀌면 사본을
 * 버린다.
 */
export function PlayerCardProvider({
  gameId,
  playerNames,
  stamp,
  children,
}: {
  gameId: string;
  /** 서버가 고른 사전 — 우리 선수단과 이야기가 부른 선수 (`namesForChat`) */
  playerNames: Record<string, string>;
  stamp: string;
  children: ReactNode;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const names = useMemo(() => buildPlayerNameIndex(playerNames), [playerNames]);
  const open = useCallback((playerId: string) => setOpenId(playerId), []);
  const handle = useMemo<PlayerCardHandle>(() => ({ open, names }), [open, names]);
  return (
    <PlayerCardContext.Provider value={handle}>
      {children}
      {openId !== null && (
        <PlayerCardOverlay
          gameId={gameId}
          playerId={openId}
          stamp={stamp}
          onClose={() => setOpenId(null)}
        />
      )}
    </PlayerCardContext.Provider>
  );
}

/**
 * 이 자리에서 카드를 열 수 있는가 — 감싸는 자리가 없으면 `null`이다.
 *
 * `null`을 되돌리는 것이 규약이다: 손잡이 컴포넌트가 그때 **글자로 선다**. 오프라인
 * 렌더러(테스트·관리자 화면)가 선수 이름을 그리는 자리마다 무대를 세울 이유는 없다.
 */
function usePlayerCard(): PlayerCardHandle | null {
  return useContext(PlayerCardContext);
}

/**
 * **선수 이름 한 손잡이** — 카드를 열 수 있으면 버튼, 아니면 글자다.
 *
 * 읽는 값과 조작 대상은 생김새가 다르다(overview.md §5) — 그래서 이 이름만 밑줄과
 * 포커스 링을 갖는다. `id`가 없는 자리(옛 뷰 행)는 글자로 남는다: 누를 수 없는 것을
 * 누를 수 있는 모양으로 두면 감독은 고장으로 읽는다.
 */
export function PlayerName({
  id,
  name,
  className,
}: {
  id: string | null | undefined;
  name: string;
  className?: string;
}) {
  const card = usePlayerCard();
  if (!card || !id) return <span className={className}>{name}</span>;
  return (
    <button
      type="button"
      className={`player-name${className ? ` ${className}` : ""}`}
      onClick={(e) => {
        // 행 전체가 접히거나 펼쳐지는 자리 안에 서므로, 이 눌림은 여기서 끝난다
        e.stopPropagation();
        card.open(id);
      }}
      title={`${name} — 선수 카드`}
    >
      {name}
    </button>
  );
}

/**
 * 산문 한 조각을 손잡이 섞인 노드로 — 사전에 없는 이름은 글자 그대로다.
 *
 * 채팅은 이 함수를 문장마다 부르므로 사전은 **한 번 지어 둔 것**을 쓴다
 * (`PlayerNameIndex`). 감싸는 자리가 없으면 문자열을 그대로 돌려준다.
 */
export function useProseNames(): (text: string, key: string) => ReactNode {
  const card = usePlayerCard();
  return useCallback(
    (text: string, key: string) => {
      if (!card) return text;
      const pieces = splitPlayerNames(text, card.names);
      if (pieces.length === 1 && pieces[0]!.playerId === undefined) return text;
      return pieces.map((piece, i) =>
        piece.playerId === undefined ? (
          <span key={`${key}-${i}`}>{piece.text}</span>
        ) : (
          <PlayerName id={piece.playerId} name={piece.text} key={`${key}-${i}`} />
        ),
      );
    },
    [card],
  );
}

/** 카드 한 장을 받아 오는 자리 — 받는 동안에도 골격이 서 있다 */
function PlayerCardOverlay({
  gameId,
  playerId,
  stamp,
  onClose,
}: {
  gameId: string;
  playerId: string;
  stamp: string;
  onClose: () => void;
}) {
  const [card, setCard] = useState<PlayerCardView | null>(() =>
    cachedCard(gameId, playerId, stamp),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hit = cachedCard(gameId, playerId, stamp);
    setError(null);
    setCard(hit);
    if (hit) return;
    const abort = new AbortController();
    fetch(`/api/games/${gameId}/player/${playerId}`, { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        const data = (await res.json()) as PlayerCardView;
        cache.set(`${gameId}/${playerId}`, data);
        setCard(data);
      })
      .catch((e: unknown) => {
        if (abort.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => abort.abort();
  }, [gameId, playerId, stamp]);

  // 카드는 읽는 자리다 — 되돌아가는 길이 손 가까이 있어야 한다 (Esc·바깥 클릭·닫기)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="player-card-veil"
      data-testid="player-card"
      role="dialog"
      aria-modal="true"
      aria-label="선수 카드"
      onClick={onClose}
    >
      {/* 카드 안의 눌림은 카드의 것이다 — 베일까지 새어 나가면 읽다가 닫힌다 */}
      <div className="player-card" onClick={(e) => e.stopPropagation()}>
        {error !== null ? (
          <div className="pc-blank" data-testid="player-card-error">
            선수 카드를 불러오지 못했다
          </div>
        ) : card === null ? (
          <div className="pc-blank" role="status" aria-label="선수 카드 불러오는 중">
            <span className="skel pc-skel" aria-hidden />
            <span className="skel pc-skel short" aria-hidden />
          </div>
        ) : (
          <PlayerCardBody card={card} />
        )}
        <button
          className="pc-close"
          type="button"
          onClick={onClose}
          data-testid="player-card-close"
        >
          닫기
        </button>
      </div>
    </div>
  );
}

/** 사실 한 칸 — 이름표와 값. 값이 없으면 칸 자체가 서지 않는다 */
function Fact({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <span className="pc-fact" title={title}>
      <em>{label}</em>
      <b>{children}</b>
    </span>
  );
}

/**
 * 카드 한 장 — **머리 · 사실 줄 · 자리 · 16축 · 기록 · 커리어**.
 *
 * 남의 선수에게 없는 칸은 아예 서지 않는다(`card.ours`가 null이다) — 「모름」으로
 * 채우면 없는 자리를 있는 것처럼 그린다 (player.md §9.5).
 */
function PlayerCardBody({ card }: { card: PlayerCardView }) {
  const ours = card.ours;
  const season = card.season;
  /**
   * 커리어 표를 세울까 — **시즌 행이 하나뿐이고 그게 이번 시즌이면 세우지 않는다.**
   * 아래 「시즌」 줄이 이미 같은 수를 말했고, 같은 값을 표로 다시 그리면 카드가
   * 제 요약의 사본이 된다 (명단 상세와 같은 기준).
   */
  const showCareer =
    card.career.seasons.length > 1 || (card.career.seasons.length === 1 && season.apps === 0);
  return (
    <div className="pc" data-testid="player-card-body">
      <header className="pc-head">
        <div className="pc-who">
          <b className="pc-name">{card.name}</b>
          {ours && ours.squadNumber !== null && <i className="pc-number">{ours.squadNumber}</i>}
          <span className="pc-meta">
            {card.team} · {card.age}세 · {card.position}
            {card.nationality && ` · ${card.nationality}`}
            {card.secondNationality && `/${card.secondNationality}`}
          </span>
        </div>
        <span className="pc-ovr" title={`가장 잘 맞는 자리 기준 종합 (${card.knowledgeLabel})`}>
          <em>종합</em>
          <b>
            {card.overall}
            {card.overallMargin > 0 && <i className="est">±{card.overallMargin}</i>}
          </b>
        </span>
      </header>

      {/**
       * **무엇까지 아는가** — 아래 숫자 전부에 걸리는 단서라 맨 위에 선다.
       * 정확히 아는 선수(우리 선수 대부분)에게는 아무것도 그리지 않는다.
       */}
      {card.overallMargin > 0 && <p className="pc-note">{card.note}</p>}
      {/* 지금 심경 한 줄 — 아래 숫자들이 왜 그런지 (우리 선수만 아는 사실이다) */}
      {ours && <p className="pc-mood">{moodSentence(ours.mood)}</p>}

      <div className="pc-facts">
        <Fact
          label="잠재력"
          title={
            card.potential
              ? `추정 폭 ±${card.potential.margin} — ${card.potential.confidence}`
              : "성장 여력을 짐작할 근거가 없습니다"
          }
        >
          {card.potential ? `${card.potential.low}~${card.potential.high}` : "미지"}
        </Fact>
        <Fact
          label="시장가"
          title={
            card.ours
              ? "우리 계약이라 흐림 폭이 0이다"
              : "관측 시장가 — 지식 수준만큼 흐리다 (player.md §9)"
          }
        >
          {formatMoney(card.marketValue)}
        </Fact>
        {card.weeklyWage !== null && <Fact label="주급">{formatMoney(card.weeklyWage)}/주</Fact>}
        {card.contractUntil !== null && <Fact label="계약">{card.contractUntil}</Fact>}
        {card.transferListed !== null && (
          <Fact label="이적 리스트">{formatMoney(card.transferListed)}</Fact>
        )}
        {ours && (
          <>
            <Fact label="폼">{ours.formLabel}</Fact>
            <Fact label="체력">
              {ours.condition.value}
              {ours.condition.margin > 0 && <i className="est">±{ours.condition.margin}</i>}
            </Fact>
            {ours.fatigueBand !== "clear" && (
              <Fact
                label="누적"
                title="누적 피로 — 시즌이 쌓아 둔 잔고다. 회복을 늦추고 부상 위험을 올린다"
              >
                <span className={`load ${ours.fatigueBand}`}>{ours.fatigueLabel}</span>
              </Fact>
            )}
            {/* 계약에 적힌 자리 — 코드는 장부의 것이고 표기는 도메인이 갖는다 */}
            <Fact label="지위">{SQUAD_STATUS_KO[ours.squadStatus]}</Fact>
          </>
        )}
        {card.caps > 0 && (
          <Fact label="A매치">
            {card.caps}경기{card.internationalGoals > 0 && ` ${card.internationalGoals}골`}
          </Fact>
        )}
        {card.height !== null && card.weight !== null && (
          <Fact label="체격">{physiqueLabel(card.height, card.weight)}</Fact>
        )}
        {card.injuryHistory.count > 0 && (
          <Fact label="부상 이력">{injuryHistoryText(card.injuryHistory)}</Fact>
        )}
        <FootMarks foot={card.foot} />
      </div>

      {/* 지금 못 뛰는 사실들 — 부상·정지·임대·소집은 공개 기록이라 두 얼굴이 같다 */}
      <div className="pc-marks">
        {card.injury && (
          <span className="pc-mark out">
            {card.injury.bodyPart} {card.injury.severity} · ~{card.injury.expectedReturn}
          </span>
        )}
        {card.suspended > 0 && <span className="pc-mark out">출장 정지 {card.suspended}경기</span>}
        {ours?.loan && (
          <span className="pc-mark">
            임대 {ours.loan.team} ~{ours.loan.until} · 출전 {ours.loan.apps}/득점 {ours.loan.goals}
            {ours.loan.benchRun > 0 && ` · 최근 ${ours.loan.benchRun}경기 명단 밖`}
          </span>
        )}
        {ours?.away && (
          <span className="pc-mark">
            {ours.away.reason === "call-up"
              ? `${ours.away.countryName ?? "대표팀"} 소집 중`
              : "여름 대회 참가 중"}{" "}
            · {ours.away.returnsOn} 복귀
          </span>
        )}
        {ours && ours.settling !== null && <span className="pc-mark">정착 {ours.settling}%</span>}
        {ours?.assignment && (
          <span className="pc-mark">
            {ours.assignment.tier} {ours.assignment.position}
            {ours.assignment.role && ` (${ours.assignment.role.ko})`} · 전술적응{" "}
            {ours.assignment.familiarity}
          </span>
        )}
        {ours && ours.leaderRank !== null && (
          <span className="pc-mark" title="라커룸 서열 — 리더 그룹 안의 순위 (people.md §5-1)">
            라커룸 {ours.leaderRank}위
          </span>
        )}
        {ours?.homegrown && (
          <span className="pc-mark" title="등록 명단의 홈그로운 8명을 채우는 선수">
            홈그로운
          </span>
        )}
        {ours?.isCaptain && <span className="pc-mark">주장</span>}
        {ours?.isViceCaptain && <span className="pc-mark">부주장</span>}
        {/* 감독이 한 말 — **갈래와 기한뿐이다**. 무슨 말로 약속했는지는 장면의 것이다
            (people.md §5-2). 기한이 지난 약속은 코어가 이미 걷어 낸다 */}
        {ours?.promises.map((promise) => (
          <span className="pc-mark" key={`${promise.kind}-${promise.dueOn}`}>
            {PROMISE_KIND_KO[promise.kind]} 약속 ~{promise.dueOn}
          </span>
        ))}
      </div>

      {/* 소화 포지션 — **읽는 값이다.** 자리를 바꾸는 손잡이는 전술판 하나뿐이라
          알약 모양을 갖지 않는다 (overview.md §5) */}
      <div className="pc-positions">
        {card.positions.map((x) => (
          <span
            className={`pd-pos${x.isNatural ? " natural" : ""}`}
            key={x.position}
            title={`${x.isNatural ? "선호 포지션" : "소화 가능"} · 그 자리 전력 ${x.overall}`}
          >
            {x.position}
          </span>
        ))}
      </div>

      <AxisGrid
        axes={Object.fromEntries(card.attributes.map((a) => [a.key, a.value]))}
        margins={Object.fromEntries(card.attributes.map((a) => [a.key, a.margin]))}
      />

      {/* 기록은 안개 밖이다 (player.md §10) — 남의 선수도 참값 그대로 선다.
          없는 기록은 적지 않는다: 개막 전에 0으로 늘어선 줄은 정보가 아니다 */}
      {season.apps > 0 && (
        <div className="pc-facts">
          <Fact label="시즌">
            {season.apps}경기 {season.goals}골 {season.assists}도움
          </Fact>
          {season.rating !== null && <Fact label="평점">{season.rating.toFixed(2)}</Fact>}
          {season.minutes > 0 && <Fact label="출전">{season.minutes}분</Fact>}
          {season.shots > 0 && <Fact label="슛">{season.shots}</Fact>}
          {season.xg > 0 && <Fact label="xG">{season.xg.toFixed(2)}</Fact>}
          {season.saves > 0 && <Fact label="선방">{season.saves}</Fact>}
          {season.cleanSheets > 0 && <Fact label="클린시트">{season.cleanSheets}</Fact>}
          {(season.yellows > 0 || season.reds > 0) && (
            <Fact label="카드">
              {season.yellows > 0 && `경고 ${season.yellows}`}
              {season.yellows > 0 && season.reds > 0 && " · "}
              {season.reds > 0 && `퇴장 ${season.reds}`}
            </Fact>
          )}
          {/* 폼의 시간 축 — 최근 경기가 오른쪽. 평점은 우리 팀 경기에만 남는다 */}
          {ours && ours.recentRatings.length > 0 && (
            <Fact label="최근">
              <RatingTrend ratings={ours.recentRatings} />
            </Fact>
          )}
          {/* 대회별 — 위 「시즌」은 대회 합이라 "리그에서 몇 골"을 말하지 못한다 */}
          {card.seasonByCompetition.map((c) => (
            <Fact label={c.name} key={c.competitionId}>
              {c.apps}경기 {c.goals}골
            </Fact>
          ))}
        </div>
      )}

      <CareerBlock
        seasons={card.career.seasons}
        totals={card.career.totals}
        milestones={ours?.milestones ?? []}
        showTable={showCareer}
      />
    </div>
  );
}
