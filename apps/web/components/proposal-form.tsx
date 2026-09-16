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
  type ProposalKind,
  type ProposalPrefill,
  type SquadStatus,
} from "@story-fm/domain";
import type { PlayerCardView, ProposalView } from "@story-fm/engine";

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
          <div className="pf-blank">선수 정보를 불러오지 못했습니다</div>
        ) : card === null ? (
          <div className="pf-blank" role="status" aria-label="선수 정보 불러오는 중">
            <span className="skel pf-skel" aria-hidden />
          </div>
        ) : card.proposal === null ? (
          <div className="pf-blank">{card.name}에게 부를 제안이 없습니다</div>
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
        {(card === null || card.proposal === null || error !== null) && (
          <button className="pf-close" type="button" onClick={onClose}>
            닫기
          </button>
        )}
      </div>
    </div>
  );
}

/** 조건 한 줄의 편집 상태 — 갈래와 그 갈래의 값 */
type TermDraft = DealTerm & { id: number };

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
  /** 이적료 없이 개인 조건만 먼저 — 영입·임대에서만 (transfer.md §12-3) */
  const [personalOnly, setPersonalOnly] = useState(prefill?.kind === "personal");
  /** 값은 그대로 두고 조건만 올린다 — 열린 협상이 있을 때만 */
  const [termsOnly, setTermsOnly] = useState(prefill?.kind === "terms");
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
    if (next === "renew" || next === "loan") setPersonalOnly(false);
  };

  const effective: ProposalKind = termsOnly ? "terms" : personalOnly ? "personal" : kind;
  const precontract = kind === "buy" && view.precontract && fee === 0 && !personalOnly;
  const termKinds = view.termKinds[kind === "buy" ? (precontract ? "precontract" : "buy") : kind];
  const usedKinds = new Set(terms.filter((t) => t.kind !== "other").map((t) => t.kind));
  const addable = termKinds.filter((k) => k === "other" || !usedKinds.has(k));
  const countable = terms.filter((t) => t.kind !== "other").length;
  // 무소속은 자유계약이다 — 이적료 칸이 없고 0이 실린다
  const hasFee = (effective === "buy" || effective === "loan") && !termsOnly && !view.freeAgent;
  const hasPersonal = effective !== "terms";

  const addTerm = (termKind: DealTermKind) => {
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
  const removeTerm = (id: number) => setTerms(terms.filter((t) => t.id !== id));

  const submit = async () => {
    if (busy || sending) return;
    const cleaned: DealTerm[] = terms.map((draft) => {
      const term: DealTerm & { id?: number } = { ...draft };
      delete term.id;
      return term;
    });
    const input: ProposalInput = {
      playerId: card.id,
      kind: effective,
      ...(hasFee ? { fee: Math.max(0, Math.round(fee)) } : {}),
      ...(view.freeAgent && effective === "buy" ? { fee: 0 } : {}),
      ...(hasFee && kind === "buy" && paymentYears > 1 ? { paymentYears } : {}),
      ...(hasPersonal ? { weeklyWage: Math.max(0, Math.round(weeklyWage)), years } : {}),
      ...(hasPersonal && kind !== "loan" ? { squadStatus } : {}),
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
        <b className="pf-name">{card.name}</b>
        <span className="pf-meta">
          {card.team} · {card.age}세 · {card.position}
          {view.freeAgent && " · 자유계약"}
          {view.loanedFrom !== null && ` · ${view.loanedFrom}에서 임대 중`}
        </span>
      </header>

      {/* 갈래 — 열린 협상이 있으면 그 갈래 하나뿐이다 */}
      <div className="pf-kinds" role="radiogroup" aria-label="갈래">
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
        {kind !== "renew" && !view.freeAgent && (
          <label className="pf-toggle">
            <input
              type="checkbox"
              checked={personalOnly}
              onChange={(e) => {
                setPersonalOnly(e.target.checked);
                if (e.target.checked) setTermsOnly(false);
              }}
              disabled={locked || termsOnly}
            />
            개인 조건만 먼저
          </label>
        )}
        {view.negotiationId !== null && (
          <label className="pf-toggle">
            <input
              type="checkbox"
              checked={termsOnly}
              onChange={(e) => {
                setTermsOnly(e.target.checked);
                if (e.target.checked) setPersonalOnly(false);
              }}
              disabled={locked}
            />
            조건만 올린다
          </label>
        )}
      </div>

      <div className="pf-grid">
        {hasFee && (
          <label className="pf-field">
            <span className="pf-label">{kind === "loan" ? "임대료" : "이적료"}</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              step={FEE_STEP}
              value={fee}
              onChange={(e) => setFee(Number(e.target.value))}
              disabled={locked}
              data-testid="proposal-fee"
            />
            <span className="pf-hint">
              {formatMoney(fee)} · {kind === "loan" ? "임대료 자" : "요구가"}{" "}
              {formatMoney(view.fee[kind === "loan" ? "loan" : "buy"])}
              {precontract && " · 사전 계약"}
            </span>
          </label>
        )}
        {hasFee && kind === "buy" && (
          <label className="pf-field">
            <span className="pf-label">지급</span>
            <select
              value={paymentYears}
              onChange={(e) => setPaymentYears(Number(e.target.value))}
              disabled={locked}
            >
              {Array.from({ length: MAX_PAYMENT_YEARS }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? "일시금" : `${n}년 분할`}
                </option>
              ))}
            </select>
          </label>
        )}
        {hasPersonal && (
          <label className="pf-field">
            <span className="pf-label">주급</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              step={WAGE_STEP}
              value={weeklyWage}
              onChange={(e) => setWeeklyWage(Number(e.target.value))}
              disabled={locked}
              data-testid="proposal-wage"
            />
            <span className="pf-hint">
              {formatMoney(weeklyWage)}/주 · 기대{" "}
              {formatMoney(
                kind === "renew" ? (view.renewalWage ?? view.weeklyWage) : view.weeklyWage,
              )}
              {view.personal?.agreedOn && " · 개인 조건 합의"}
            </span>
          </label>
        )}
        {hasPersonal && (
          <label className="pf-field">
            <span className="pf-label">계약 연수</span>
            <select
              value={years}
              onChange={(e) => setYears(Number(e.target.value))}
              disabled={locked}
            >
              {Array.from({ length: PROPOSAL_YEARS_MAX }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}년
                </option>
              ))}
            </select>
          </label>
        )}
        {hasPersonal && kind !== "loan" && (
          <label className="pf-field">
            <span className="pf-label">계약 지위</span>
            <select
              value={squadStatus}
              onChange={(e) => setSquadStatus(e.target.value as SquadStatus)}
              disabled={locked}
            >
              {SQUAD_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {SQUAD_STATUS_KO[s]}
                </option>
              ))}
            </select>
            <span className="pf-hint">지금 자리 {SQUAD_STATUS_KO[view.squadStatus]}</span>
          </label>
        )}
      </div>

      {/* 조건서 — 갈래를 고르고 그 갈래의 값을 적는다 */}
      <div className="pf-terms">
        <span className="pf-section">
          조건 {countable}/{MAX_TABLED_TERMS}
        </span>
        {terms.map((term) => (
          <TermRow
            key={term.id}
            term={term}
            locked={locked}
            onChange={(patch) => updateTerm(term.id, patch)}
            onRemove={() => removeTerm(term.id)}
          />
        ))}
        {addable.length > 0 && (
          <select
            className="pf-add"
            value=""
            onChange={(e) => {
              if (e.target.value) addTerm(e.target.value as DealTermKind);
            }}
            disabled={locked}
            aria-label="조건 추가"
            data-testid="proposal-add-term"
          >
            <option value="">조건 추가</option>
            {addable.map((k) => (
              <option key={k} value={k} disabled={k !== "other" && countable >= MAX_TABLED_TERMS}>
                {DEAL_TERM_KO[k]}
              </option>
            ))}
          </select>
        )}
      </div>

      <label className="pf-field pf-message">
        <span className="pf-label">한마디</span>
        <textarea
          rows={2}
          maxLength={1000}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={locked}
        />
      </label>

      <div className="pf-foot">
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
      {error !== null && (
        <p className="pf-error" role="alert" data-testid="proposal-error">
          {error}
        </p>
      )}
      <div className="pf-actions">
        <button type="button" className="pf-close" onClick={onClose} disabled={sending}>
          닫기
        </button>
        <button type="submit" className="pf-submit" disabled={locked} data-testid="proposal-submit">
          제안
        </button>
      </div>
    </form>
  );
}

/** 조건 한 줄 — 갈래의 이름과 그 갈래가 요구하는 값의 칸 */
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
  return (
    <div className="pf-term" data-testid={`proposal-term-${term.kind}`}>
      <span className="pf-term-kind">{DEAL_TERM_KO[term.kind]}</span>
      {(term.kind === "buyout" || term.kind === "bonus") && (
        <>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={term.kind === "buyout" ? FEE_STEP : WAGE_STEP}
            value={term.fee ?? 0}
            onChange={(e) => onChange({ fee: Number(e.target.value) })}
            disabled={locked}
            aria-label={`${DEAL_TERM_KO[term.kind]} 금액`}
          />
          <span className="pf-hint">{formatMoney(term.fee ?? 0)}</span>
        </>
      )}
      {term.kind === "escalator" && (
        <>
          <select
            value={term.trigger ?? "europe"}
            onChange={(e) => onChange({ trigger: e.target.value as DealTerm["trigger"] })}
            disabled={locked}
            aria-label="인상 조건"
          >
            {ESCALATOR_TRIGGERS.map((t) => (
              <option key={t} value={t}>
                {ESCALATOR_TRIGGER_KO[t]}
              </option>
            ))}
          </select>
          <input
            type="number"
            inputMode="numeric"
            min={ESCALATOR_PCT_MIN}
            max={ESCALATOR_PCT_MAX}
            step={5}
            value={term.pct ?? 20}
            onChange={(e) => onChange({ pct: Number(e.target.value) })}
            disabled={locked}
            aria-label="인상 폭"
          />
          <span className="pf-hint">%</span>
        </>
      )}
      {term.kind === "signing" && (
        <select
          value={term.position ?? ""}
          onChange={(e) => onChange({ position: e.target.value })}
          disabled={locked}
          aria-label="데려올 자리"
        >
          {POSITION_CODES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      )}
      {term.kind === "number" && (
        <input
          type="number"
          inputMode="numeric"
          min={SQUAD_NUMBER_MIN}
          max={SQUAD_NUMBER_MAX}
          value={term.number ?? 10}
          onChange={(e) => onChange({ number: Number(e.target.value) })}
          disabled={locked}
          aria-label="등번호"
        />
      )}
      {term.kind === "other" && (
        <input
          type="text"
          maxLength={DEAL_TERM_NOTE_MAX}
          value={term.note ?? ""}
          onChange={(e) => onChange({ note: e.target.value })}
          disabled={locked}
          aria-label="조건 내용"
          placeholder={dealTermLabel({ kind: "other", note: "…" }).replace(/ — .*$/, "")}
        />
      )}
      <button
        type="button"
        className="pf-remove"
        onClick={onRemove}
        disabled={locked}
        aria-label={`${DEAL_TERM_KO[term.kind]} 조건 지우기`}
      >
        ×
      </button>
    </div>
  );
}
