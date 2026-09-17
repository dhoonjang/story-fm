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
  DEAL_TERM_KO,
  DEAL_TERM_NOTE_MAX,
  ESCALATOR_PCT_MAX,
  ESCALATOR_PCT_MIN,
  ESCALATOR_TRIGGERS,
  ESCALATOR_TRIGGER_KO,
  MAX_PAYMENT_YEARS,
  MAX_TABLED_TERMS,
  POSITION_CODES,
  PROPOSAL_KIND_KO,
  PROPOSAL_YEARS_MAX,
  SQUAD_NUMBER_MAX,
  SQUAD_NUMBER_MIN,
  SQUAD_STATUSES,
  SQUAD_STATUS_KO,
  dealTermLabel,
  formatMoney,
  type DealTerm,
  type DealTermKind,
  type ProposalInput,
  type ProposalPrefill,
  type SquadStatus,
} from "@story-fm/domain";
import type { PlayerCardView, ProposalView } from "@story-fm/engine";
import { IconClose } from "@/components/icons";

/**
 * **제안 폼** — 값과 조건을 정확한 숫자로 내는 자리 (transfer.md §12-3).
 *
 * 채팅이 유일한 인터페이스지만 「£38.5M에 4년, 주급 £120k, 바이아웃 £80M」을 타이핑으로
 * 정확히 부르기는 어렵다. 그래서 폼이 구조체를 만들고 서버가 그것을 손잡이로 받아 코어
 * 명령으로 먼저 건다 — 전술판과 같은 길이라 채팅으로 낸 제안과 같은 문을 지난다.
 *
 * 폼이 미리 채우는 값은 전부 **코어가 낸 자**(`PlayerCardView.proposal`)다. 화면은 값을
 * 다시 재지 않는다 — 요구가·기대 주급·예산·주급 여력이 여기서 오고, 감독이 고친다.
 */

export interface ProposalHandle {
  /** 폼을 연다 — 카드에서 열 때는 그 카드의 조건을 미리 채운다 */
  open: (playerId: string, prefill?: ProposalPrefill) => void;
}

const ProposalContext = createContext<ProposalHandle | null>(null);

/** 폼을 보내는 자리 — 실패면 코어가 돌려준 이유 한 줄, 성공이면 null */
export type ProposalSubmit = (proposal: ProposalInput, message?: string) => Promise<string | null>;

export function ProposalProvider({
  gameId,
  busy,
  onSubmit,
  children,
}: {
  gameId: string;
  /** 턴이 도는 동안은 보낼 수 없다 — 전송 버튼과 같은 잠금 */
  busy: boolean;
  onSubmit: ProposalSubmit;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<{ playerId: string; prefill?: ProposalPrefill } | null>(
    null,
  );
  const open = useCallback(
    (playerId: string, prefill?: ProposalPrefill) =>
      setTarget({ playerId, ...(prefill ? { prefill } : {}) }),
    [],
  );
  const handle = useMemo<ProposalHandle>(() => ({ open }), [open]);
  return (
    <ProposalContext.Provider value={handle}>
      {children}
      {target !== null && (
        <ProposalDialog
          gameId={gameId}
          playerId={target.playerId}
          prefill={target.prefill}
          busy={busy}
          onSubmit={onSubmit}
          onClose={() => setTarget(null)}
        />
      )}
    </ProposalContext.Provider>
  );
}

/** 이 자리에서 폼을 열 수 있는가 — 감싸는 자리가 없으면 `null`이고 그때 손잡이도 없다 */
export function useProposal(): ProposalHandle | null {
  return useContext(ProposalContext);
}

type OfferKind = "buy" | "loan" | "renew";

/** 값이 딸린 갈래의 자 — 입력 칸의 눈금이다 */
const FEE_STEP = 100_000;
const WAGE_STEP = 1_000;
/**
 * 빠른 조정 칩의 눈금 — 값을 자판으로 치는 대신 한 번에 한 칸씩 옮긴다. 이적료는 백만
 * 단위, 주급은 천 단위 — 협상 자리에서 실제로 오가는 단위다.
 */
const FEE_CHIPS = [-1_000_000, 1_000_000, 5_000_000] as const;
const WAGE_CHIPS = [-5_000, 5_000, 20_000] as const;

function ProposalDialog({
  gameId,
  playerId,
  prefill,
  busy,
  onSubmit,
  onClose,
}: {
  gameId: string;
  playerId: string;
  prefill?: ProposalPrefill;
  busy: boolean;
  onSubmit: ProposalSubmit;
  onClose: () => void;
}) {
  const [card, setCard] = useState<PlayerCardView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    setCard(null);
    setError(null);
    fetch(`/api/games/${gameId}/player/${playerId}`, { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        setCard((await res.json()) as PlayerCardView);
      })
      .catch((e: unknown) => {
        if (abort.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => abort.abort();
  }, [gameId, playerId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="proposal-veil"
      data-testid="proposal-form"
      role="dialog"
      aria-modal="true"
      aria-label="제안"
      onClick={onClose}
    >
      <div className="proposal" onClick={(e) => e.stopPropagation()}>
        {error !== null ? (
          <Blank onClose={onClose}>선수 정보를 불러오지 못했습니다</Blank>
        ) : card === null ? (
          <div className="pf-blank" role="status" aria-label="선수 정보 불러오는 중">
            <span className="skel pf-skel" aria-hidden />
          </div>
        ) : card.proposal === null ? (
          <Blank onClose={onClose}>{card.name}에게 부를 제안이 없습니다</Blank>
        ) : (
          <ProposalBody
            card={card}
            view={card.proposal}
            prefill={prefill}
            busy={busy}
            onSubmit={onSubmit}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}

/** 폼이 서지 못하는 자리 — 사실 한 줄과 닫는 손잡이 */
function Blank({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="pf-blank">
      <span>{children}</span>
      <button type="button" className="pf-ghost" onClick={onClose}>
        닫기
      </button>
    </div>
  );
}

/** 조건 한 줄의 편집 상태 — 갈래와 그 갈래의 값 */
type TermDraft = DealTerm & { id: number };

/** 조정 칩의 글자 — 부호와 자 (`+£1.0M` · `−£5k`) */
function deltaLabel(delta: number): string {
  return `${delta < 0 ? "−" : "+"}${formatMoney(Math.abs(delta))}`;
}

/**
 * 금액의 자 — 화면이 적는 단위다. 이적료는 백만 파운드(`£ 24.2 M`), 주급은 천 파운드
 * (`£ 114 k`) — `formatMoney`가 눈금을 고르는 것과 같은 자리라 카드의 `£24.2M`과 칸의
 * `24.2`가 같은 수다. 상태는 그대로 파운드로 들고, 칸이 읽고 쓸 때만 나눈다.
 */
interface MoneyUnit {
  /** 숫자 뒤에 붙는 눈금 글자 */
  mark: string;
  scale: number;
  /** 칸이 받는 자릿수 — 그 아래는 코어의 눈금(`step`)으로 되돌린다 */
  decimals: number;
}
const MILLIONS: MoneyUnit = { mark: "M", scale: 1_000_000, decimals: 1 };
const THOUSANDS: MoneyUnit = { mark: "k", scale: 1_000, decimals: 1 };
const CURRENCY = "£";

/** 파운드 → 칸에 적는 수 · 칸의 수 → 코어의 눈금으로 되돌린 파운드 */
function shownOf(value: number, unit: MoneyUnit): number {
  return Number((value / unit.scale).toFixed(unit.decimals));
}
function poundsOf(raw: string, unit: MoneyUnit, step: number): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.round((n * unit.scale) / step) * step);
}

/**
 * 돈 칸 하나 — `£ 24.2 M` 꼴로 화폐가 앞에, 눈금이 뒤에 선다. 큰 칸(`hero`)은 금액 카드의
 * 주인이고, 작은 칸은 조건 줄 안에 선다. 폭은 숫자만큼이라 눈금 글자가 숫자에 붙는다.
 */
function MoneyInput({
  value,
  unit,
  step,
  onChange,
  locked,
  label,
  hero = false,
  tail,
  testId,
}: {
  value: number;
  unit: MoneyUnit;
  step: number;
  onChange: (value: number) => void;
  locked: boolean;
  label: string;
  hero?: boolean;
  /** 눈금 뒤에 더 붙는 꼬리 — 주급의 `/주` */
  tail?: string;
  testId?: string;
}) {
  const shown = shownOf(value, unit);
  return (
    <span className={hero ? "pf-money hero" : "pf-money"}>
      <b className="pf-money-cur">{CURRENCY}</b>
      <input
        className="pf-money-input fig"
        type="number"
        inputMode="decimal"
        min={0}
        step={step / unit.scale}
        value={shown}
        // 숫자만큼만 — 눈금 글자가 숫자 옆에 붙어 선다 (소수점은 한 자보다 좁다)
        style={{ width: `calc(${Math.max(1, String(shown).length)}ch + 3px)` }}
        onChange={(e) => {
          const next = poundsOf(e.target.value, unit, step);
          if (next !== null) onChange(next);
        }}
        disabled={locked}
        aria-label={`${label} (${CURRENCY}${unit.mark})`}
        data-testid={testId}
      />
      <b className="pf-money-mark">{unit.mark}</b>
      {tail && <span className="pf-money-tail">{tail}</span>}
    </span>
  );
}

/**
 * 고르는 칩 묶음 — 라디오 묶음이라 고른 것이 색이 아니라 `aria-checked`로도 전해진다.
 * 연수·지위·지급처럼 선택지가 손에 꼽히는 자리는 접힌 목록 대신 전부 펼쳐 둔다 — 지금
 * 값과 옆의 값이 한눈에 견주어진다.
 */
function Chips<T extends string | number>({
  label,
  value,
  options,
  onPick,
  locked,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onPick: (value: T) => void;
  locked: boolean;
}) {
  return (
    <div className="pf-options" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={option.value === value ? "on" : ""}
          onClick={() => onPick(option.value)}
          disabled={locked}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 금액 칸 — **큰 숫자 하나가 칸의 주인이다.** 자판으로 고칠 수 있지만 보통은 아래 칩으로
 * 한 칸씩 옮기고, 코어가 낸 자(요구가·기대 주급)로 한 번에 되돌린다.
 */
function AmountField({
  label,
  value,
  step,
  unit,
  chips,
  anchor,
  anchorLabel,
  tail,
  hint,
  onChange,
  locked,
  testId,
}: {
  label: string;
  /** 파운드 — 상태의 값 그대로 */
  value: number;
  /** 코어의 눈금 — 칸에 적은 값은 이 눈금으로 되돌린다 */
  step: number;
  unit: MoneyUnit;
  chips: readonly number[];
  /** 코어가 낸 자 — 칩 하나가 이 값으로 되돌린다 */
  anchor: number;
  anchorLabel: string;
  tail?: string;
  hint?: string;
  onChange: (value: number) => void;
  locked: boolean;
  testId: string;
}) {
  return (
    <div className="pf-amount">
      <span className="pf-label">{label}</span>
      <MoneyInput
        value={value}
        unit={unit}
        step={step}
        onChange={onChange}
        locked={locked}
        label={label}
        hero
        {...(tail === undefined ? {} : { tail })}
        testId={testId}
      />
      <div className="pf-chips">
        {chips.map((delta) => (
          <button
            key={delta}
            type="button"
            onClick={() => onChange(Math.max(0, value + delta))}
            disabled={locked || (delta < 0 && value <= 0)}
          >
            {deltaLabel(delta)}
          </button>
        ))}
        <button
          type="button"
          className={value === anchor ? "on" : ""}
          onClick={() => onChange(anchor)}
          disabled={locked}
        >
          {anchorLabel} {formatMoney(anchor)}
        </button>
      </div>
      {hint && <span className="pf-hint">{hint}</span>}
    </div>
  );
}

/** 절의 머리 — 이 절이 누구에게 가는가 */
function Recipient({ name, note }: { name: string; note?: string }) {
  return (
    <div className="pf-card-head">
      <span className="pf-to">
        <em>받는 쪽</em>
        <b>{name}</b>
      </span>
      {note && <span className="pf-count">{note}</span>}
    </div>
  );
}

function ProposalBody({
  card,
  view,
  prefill,
  busy,
  onSubmit,
  onClose,
}: {
  card: PlayerCardView;
  view: ProposalView;
  prefill?: ProposalPrefill;
  busy: boolean;
  onSubmit: ProposalSubmit;
  onClose: () => void;
}) {
  const kinds = view.kinds;
  const initialKind: OfferKind =
    prefill?.kind && (kinds as readonly string[]).includes(prefill.kind)
      ? (prefill.kind as OfferKind)
      : kinds[0]!;
  const [kind, setKind] = useState<OfferKind>(initialKind);
  const [fee, setFee] = useState<number>(
    prefill?.fee ?? view.fee[kind === "loan" ? "loan" : "buy"],
  );
  const [paymentYears, setPaymentYears] = useState<number>(prefill?.paymentYears ?? 1);
  const [weeklyWage, setWeeklyWage] = useState<number>(
    prefill?.weeklyWage ??
      (kind === "renew"
        ? (view.renewalWage ?? view.weeklyWage)
        : (view.personal?.weeklyWage ?? view.weeklyWage)),
  );
  const [years, setYears] = useState<number>(
    prefill?.years ??
      (kind === "renew" ? view.years.renew : (view.personal?.contractYears ?? view.years.buy)),
  );
  const [squadStatus, setSquadStatus] = useState<SquadStatus>(
    prefill?.squadStatus ?? view.personal?.squadStatus ?? view.squadStatus,
  );
  const [terms, setTerms] = useState<TermDraft[]>(
    (prefill?.terms ?? []).map((term, i) => ({ ...term, id: i + 1 })),
  );
  const [nextId, setNextId] = useState((prefill?.terms?.length ?? 0) + 1);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  /** 갈래를 바꾸면 자도 바뀐다 — 코어가 낸 그 갈래의 값으로 되돌린다 */
  const pickKind = (next: OfferKind) => {
    setKind(next);
    setFee(view.fee[next === "loan" ? "loan" : "buy"]);
    setWeeklyWage(next === "renew" ? (view.renewalWage ?? view.weeklyWage) : view.weeklyWage);
    setYears(next === "renew" ? view.years.renew : view.years.buy);
  };

  /**
   * **폼의 구성은 건너편이 정한다** (transfer.md §12-1). 구단이 앉아 있으면 이적료·분할의
   * 절이 서고, 선수 쪽이 앉아 있으면 주급·연수·지위·조건의 절이 선다. 무소속은 자유계약이라
   * 구단 절이 없고 값은 0이다. 개인 조건이 이미 합의됐으면 그 절은 굳은 값으로 읽기만 한다 —
   * 합의는 그 값 그대로 실릴 때만 산다 (§12-3).
   */
  const precontract = kind === "buy" && view.precontract && fee === 0;
  const clubSide = kind !== "renew" && !view.freeAgent && view.counterparts.club !== null;
  const agentName = view.counterparts.agent ?? card.name;
  const agreed = view.personal?.agreedOn !== null && view.personal !== null ? view.personal : null;
  const termKinds = view.termKinds[kind === "buy" ? (precontract ? "precontract" : "buy") : kind];
  const countable = terms.filter((t) => t.kind !== "other").length;
  const feeAnchor = view.fee[kind === "loan" ? "loan" : "buy"];
  const wageAnchor = kind === "renew" ? (view.renewalWage ?? view.weeklyWage) : view.weeklyWage;

  const tabled = (termKind: DealTermKind) => terms.find((t) => t.kind === termKind);
  const toggleTerm = (termKind: DealTermKind) => {
    const standing = tabled(termKind);
    if (standing) {
      setTerms(terms.filter((t) => t.id !== standing.id));
      return;
    }
    if (termKind !== "other" && countable >= MAX_TABLED_TERMS) return;
    const base: TermDraft = { kind: termKind, id: nextId };
    setNextId(nextId + 1);
    switch (termKind) {
      case "buyout":
        base.fee = Math.max(FEE_STEP, Math.round((view.marketValue * 1.5) / FEE_STEP) * FEE_STEP);
        break;
      case "bonus":
        base.fee = Math.round((weeklyWage * 12) / WAGE_STEP) * WAGE_STEP;
        break;
      case "escalator":
        base.trigger = "europe";
        base.pct = 20;
        break;
      case "signing":
        base.position = card.position;
        break;
      case "number":
        base.number = 10;
        break;
      case "other":
        base.note = "";
        break;
      default:
        break;
    }
    setTerms([...terms, base]);
  };
  const updateTerm = (id: number, patch: Partial<DealTerm>) =>
    setTerms(terms.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const submit = async () => {
    if (busy || sending) return;
    const cleaned: DealTerm[] = terms.map((draft) => {
      const term: DealTerm & { id?: number } = { ...draft };
      delete term.id;
      return term;
    });
    // 합의된 개인 조건은 그 값 그대로 실린다 — 폼이 다른 값을 부르면 합의가 죽는다 (§12-3)
    const personal = agreed
      ? {
          weeklyWage: agreed.weeklyWage,
          years: agreed.contractYears,
          ...(agreed.squadStatus ? { squadStatus: agreed.squadStatus } : {}),
        }
      : {
          weeklyWage: Math.max(0, Math.round(weeklyWage)),
          years,
          ...(kind !== "loan" ? { squadStatus } : {}),
        };
    const input: ProposalInput = {
      playerId: card.id,
      kind,
      ...(clubSide ? { fee: Math.max(0, Math.round(fee)) } : {}),
      ...(view.freeAgent && kind === "buy" ? { fee: 0 } : {}),
      ...(clubSide && kind === "buy" && paymentYears > 1 ? { paymentYears } : {}),
      ...personal,
      ...(cleaned.length > 0 ? { terms: cleaned } : {}),
    };
    setSending(true);
    setError(null);
    const failed = await onSubmit(input, message.trim() || undefined);
    setSending(false);
    if (failed === null) onClose();
    else setError(failed);
  };

  const locked = busy || sending;
  return (
    <form
      className="pf"
      data-testid="proposal-body"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <header className="pf-head">
        <div className="pf-title">
          <b className="pf-name">{card.name}</b>
          <span className="pf-meta">
            {card.team} · {card.age}세 · {card.position}
            {view.freeAgent && " · 자유계약"}
            {view.loanedFrom !== null && ` · ${view.loanedFrom}에서 임대 중`}
          </span>
        </div>
        <button type="button" className="pf-x" onClick={onClose} aria-label="닫기">
          <IconClose size={16} />
        </button>
      </header>

      {/* 코어가 낸 사실 셋 — 값을 정하기 전에 읽는 자 */}
      <div className="pf-facts">
        <span className="pf-fact">
          <em>이적 예산</em>
          <b>{formatMoney(view.transferBudget)}</b>
        </span>
        <span className="pf-fact">
          <em>주급 여력</em>
          <b>{formatMoney(view.wageRoom)}/주</b>
        </span>
        <span className="pf-fact">
          <em>시장가</em>
          <b>{formatMoney(view.marketValue)}</b>
        </span>
      </div>

      <div className="pf-body">
        {/* 갈래 — 열린 협상이 있으면 그 갈래 하나뿐이다 */}
        {kinds.length > 1 && (
          <div className="pf-seg" role="radiogroup" aria-label="갈래">
            {kinds.map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                className={kind === k ? "on" : ""}
                onClick={() => pickKind(k)}
                disabled={locked}
              >
                {PROPOSAL_KIND_KO[k]}
              </button>
            ))}
          </div>
        )}

        {/* 구단의 절 — 이적료와 지급 */}
        {clubSide && (
          <section className="pf-card" data-testid="proposal-club">
            <Recipient name={view.counterparts.club!} />
            <AmountField
              label={kind === "loan" ? "임대료" : "이적료"}
              value={fee}
              step={FEE_STEP}
              unit={MILLIONS}
              chips={FEE_CHIPS}
              anchor={feeAnchor}
              anchorLabel={kind === "loan" ? "임대료 자" : "요구가"}
              {...(precontract ? { hint: "사전 계약 — 이적료 없이 여름에 합류한다" } : {})}
              onChange={setFee}
              locked={locked}
              testId="proposal-fee"
            />
            {kind === "buy" && (
              <div className="pf-row">
                <span className="pf-row-label">지급</span>
                <Chips
                  label="지급"
                  value={paymentYears}
                  options={Array.from({ length: MAX_PAYMENT_YEARS }, (_, i) => ({
                    value: i + 1,
                    label: i === 0 ? "일시금" : `${i + 1}년 분할`,
                  }))}
                  onPick={setPaymentYears}
                  locked={locked}
                />
              </div>
            )}
          </section>
        )}

        {/* 선수 쪽의 절 — 주급·연수·지위, 그리고 조건. 합의됐으면 굳은 값이다 */}
        <section className="pf-card" data-testid="proposal-agent">
          <Recipient name={agentName} {...(agreed ? { note: "개인 조건 합의" } : {})} />
          {agreed ? (
            <div className="pf-agreed">
              <span>
                <em>주급</em>
                <b>{formatMoney(agreed.weeklyWage)}/주</b>
              </span>
              <span>
                <em>계약</em>
                <b>{agreed.contractYears}년</b>
              </span>
              {agreed.squadStatus && (
                <span>
                  <em>지위</em>
                  <b>{SQUAD_STATUS_KO[agreed.squadStatus]}</b>
                </span>
              )}
            </div>
          ) : (
            <>
              <AmountField
                label="주급"
                value={weeklyWage}
                step={WAGE_STEP}
                unit={THOUSANDS}
                chips={WAGE_CHIPS}
                anchor={wageAnchor}
                anchorLabel="기대 주급"
                tail="/주"
                onChange={setWeeklyWage}
                locked={locked}
                testId="proposal-wage"
              />
              <div className="pf-row">
                <span className="pf-row-label">계약</span>
                <Chips
                  label="계약 연수"
                  value={years}
                  options={Array.from({ length: PROPOSAL_YEARS_MAX }, (_, i) => ({
                    value: i + 1,
                    label: `${i + 1}년`,
                  }))}
                  onPick={setYears}
                  locked={locked}
                />
              </div>
              {kind !== "loan" && (
                <div className="pf-row">
                  <span className="pf-row-label">
                    지위
                    <em>지금 {SQUAD_STATUS_KO[view.squadStatus]}</em>
                  </span>
                  <Chips
                    label="계약 지위"
                    value={squadStatus}
                    options={SQUAD_STATUSES.map((s) => ({ value: s, label: SQUAD_STATUS_KO[s] }))}
                    onPick={setSquadStatus}
                    locked={locked}
                  />
                </div>
              )}
            </>
          )}

          {/* 조건 — 갈래 칩을 켜면 그 줄이 서고, 다시 누르면 내려간다 */}
          {termKinds.length > 0 && (
            <div className="pf-row pf-terms">
              <span className="pf-row-label">
                조건
                <b className="pf-count fig">
                  {countable}/{MAX_TABLED_TERMS}
                </b>
              </span>
              <div
                className="pf-options"
                role="group"
                aria-label="조건"
                data-testid="proposal-add-term"
              >
                {termKinds.map((k) => {
                  const on = tabled(k) !== undefined;
                  return (
                    <button
                      key={k}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      className={on ? "on" : ""}
                      onClick={() => toggleTerm(k)}
                      disabled={locked || (!on && k !== "other" && countable >= MAX_TABLED_TERMS)}
                    >
                      {DEAL_TERM_KO[k]}
                    </button>
                  );
                })}
              </div>
              {terms.map((term) => (
                <TermRow
                  key={term.id}
                  term={term}
                  locked={locked}
                  onChange={(patch) => updateTerm(term.id, patch)}
                  onRemove={() => toggleTerm(term.kind)}
                />
              ))}
            </div>
          )}
        </section>

        <label className="pf-card pf-message">
          <span className="pf-label">한마디</span>
          <textarea
            rows={2}
            maxLength={1000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={locked}
          />
        </label>
      </div>

      <footer className="pf-foot">
        {error !== null && (
          <p className="pf-error" role="alert" data-testid="proposal-error">
            {error}
          </p>
        )}
        <button type="submit" className="pf-submit" disabled={locked} data-testid="proposal-submit">
          {PROPOSAL_KIND_KO[kind]} 제안
        </button>
      </footer>
    </form>
  );
}

/**
 * 조건 한 줄 — 값이 있는 갈래만 줄이 선다 (주장은 칩이 켜진 것으로 끝이다). 갈래 이름과
 * 그 갈래가 요구하는 값의 칸, 오른쪽에 내리는 손잡이.
 */
function TermRow({
  term,
  locked,
  onChange,
  onRemove,
}: {
  term: TermDraft;
  locked: boolean;
  onChange: (patch: Partial<DealTerm>) => void;
  onRemove: () => void;
}) {
  const money = term.kind === "buyout" || term.kind === "bonus";
  const valued =
    money ||
    term.kind === "escalator" ||
    term.kind === "signing" ||
    term.kind === "number" ||
    term.kind === "other";
  if (!valued) return null;
  return (
    <div className="pf-term" data-testid={`proposal-term-${term.kind}`}>
      <div className="pf-term-head">
        <span className="pf-term-kind">{DEAL_TERM_KO[term.kind]}</span>
        <button
          type="button"
          className="pf-remove"
          onClick={onRemove}
          disabled={locked}
          aria-label={`${DEAL_TERM_KO[term.kind]} 조건 지우기`}
        >
          <IconClose size={14} />
        </button>
      </div>
      {money && (
        <MoneyInput
          value={term.fee ?? 0}
          unit={term.kind === "buyout" ? MILLIONS : THOUSANDS}
          step={term.kind === "buyout" ? FEE_STEP : WAGE_STEP}
          onChange={(fee) => onChange({ fee })}
          locked={locked}
          label={`${DEAL_TERM_KO[term.kind]} 금액`}
        />
      )}
      {term.kind === "escalator" && (
        <>
          <Chips
            label="인상 조건"
            value={term.trigger ?? "europe"}
            options={ESCALATOR_TRIGGERS.map((t) => ({ value: t, label: ESCALATOR_TRIGGER_KO[t] }))}
            onPick={(trigger) => onChange({ trigger })}
            locked={locked}
          />
          <span className="pf-money">
            <b className="pf-money-cur">+</b>
            <input
              className="pf-money-input fig"
              type="number"
              inputMode="numeric"
              min={ESCALATOR_PCT_MIN}
              max={ESCALATOR_PCT_MAX}
              step={5}
              value={term.pct ?? 20}
              style={{ width: `calc(${String(term.pct ?? 20).length}ch + 3px)` }}
              onChange={(e) => onChange({ pct: Number(e.target.value) })}
              disabled={locked}
              aria-label="인상 폭 (%)"
            />
            <b className="pf-money-mark">%</b>
          </span>
        </>
      )}
      {term.kind === "signing" && (
        <Chips
          label="데려올 자리"
          value={term.position ?? ""}
          options={POSITION_CODES.map((code) => ({ value: code, label: code }))}
          onPick={(position) => onChange({ position })}
          locked={locked}
        />
      )}
      {term.kind === "number" && (
        <span className="pf-money">
          <input
            className="pf-money-input fig"
            type="number"
            inputMode="numeric"
            min={SQUAD_NUMBER_MIN}
            max={SQUAD_NUMBER_MAX}
            value={term.number ?? 10}
            style={{ width: `calc(${String(term.number ?? 10).length}ch + 3px)` }}
            onChange={(e) => onChange({ number: Number(e.target.value) })}
            disabled={locked}
            aria-label="등번호"
          />
          <b className="pf-money-mark">번</b>
        </span>
      )}
      {term.kind === "other" && (
        <input
          className="pf-term-text"
          type="text"
          maxLength={DEAL_TERM_NOTE_MAX}
          value={term.note ?? ""}
          onChange={(e) => onChange({ note: e.target.value })}
          disabled={locked}
          aria-label="조건 내용"
          placeholder={dealTermLabel({ kind: "other", note: "…" }).replace(/ — .*$/, "")}
        />
      )}
    </div>
  );
}
