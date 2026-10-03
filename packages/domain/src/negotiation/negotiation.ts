import { z } from "zod";
import { DateString } from "../common/date-string";
import { InjurySchema } from "../common/health";

const Id = z.string().trim().min(1).max(160);
export const NegotiationStartedPayloadSchema = z
  .object({
    kind: z.literal("negotiation"),
    negotiationId: Id,
    suggestion: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
export type NegotiationStartedPayload = z.infer<typeof NegotiationStartedPayloadSchema>;

const Money = z.number().int().min(0).max(1_000_000_000);
export const NegotiationChannelSchema = z.enum(["club", "player", "internal"]);
export type NegotiationChannel = z.infer<typeof NegotiationChannelSchema>;
export const ProposalTermsSchema = z
  .object({
    scope: z.enum(["club", "player"]),
    fee: Money,
    installments: z.array(z.object({ date: DateString, amount: Money })).max(12),
    weeklyWage: Money,
    signingBonus: Money,
    since: DateString,
    until: DateString,
    promises: z.array(z.string().trim().min(1).max(500)).max(12),
    expiresOn: DateString,
  })
  .strict();
export type ProposalTerms = z.infer<typeof ProposalTermsSchema>;
export const NegotiationProposalSchema = z.object({
  id: Id,
  author: Id,
  sentOn: DateString,
  terms: ProposalTermsSchema,
  acceptedBy: z.array(Id),
  status: z.enum(["open", "superseded", "rejected", "expired"]),
  reason: z.string().max(2000),
});
export type NegotiationProposal = z.infer<typeof NegotiationProposalSchema>;
export const NegotiationMessageSchema = z.object({
  id: Id,
  on: DateString,
  channel: NegotiationChannelSchema,
  author: z.enum(["manager", "gm", "system"]),
  partyId: Id.nullable(),
  text: z.string().min(1).max(20000),
});
export const NegotiationSchema = z.object({
  id: Id,
  playerId: Id,
  buyerId: Id,
  sellerId: Id,
  kind: z.enum(["transfer", "renewal", "free"]),
  openedOn: DateString,
  background: z.string().max(4000),
  sourceContractId: Id.nullable(),
  status: z.enum(["open", "signed", "completed", "withdrawn"]),
  revision: z.number().int().nonnegative(),
  messages: z.array(NegotiationMessageSchema),
  proposals: z.array(NegotiationProposalSchema),
  drafts: z.array(ProposalTermsSchema).max(2),
  digest: z.object({ through: z.number().int().nonnegative(), text: z.string().max(6000) }),
  nextReplyOn: DateString.nullable(),
  lastReadMessage: z.number().int().nonnegative(),
  medical: z
    .object({
      requestedOn: DateString,
      readyOn: DateString,
      examinedOn: DateString.nullable(),
      injuries: z.array(InjurySchema),
      acknowledgedBy: z.array(Id),
    })
    .nullable(),
  signed: z
    .object({
      on: DateString,
      playerProposalId: Id,
      clubProposalId: Id.nullable(),
    })
    .nullable(),
  registration: z.enum(["not_submitted", "pending", "registered"]),
});
export type Negotiation = z.infer<typeof NegotiationSchema>;
export const TransferPaymentSchema = z.object({
  id: Id,
  negotiationId: Id,
  playerId: Id,
  fromTeamId: Id,
  toTeamId: Id.nullable(),
  dueOn: DateString,
  amount: Money,
  paidOn: DateString.nullable(),
  kind: z.enum(["fee", "signing_bonus"]),
});
export type TransferPayment = z.infer<typeof TransferPaymentSchema>;
export const MarketReviewSchema = z.object({
  lastDate: DateString.nullable(),
  clubs: z.array(
    z.object({
      teamId: Id,
      reviewedOn: DateString,
      plan: z.string().max(2000),
      fingerprint: z.string(),
    }),
  ),
});
export const OpenNegotiationSchema = z
  .object({
    playerId: Id,
    buyerId: Id,
    kind: z.enum(["transfer", "renewal", "free"]),
    background: z.string().trim().min(1).max(4000),
  })
  .strict();
export const NegotiationActionSchema = z.discriminatedUnion("kind", [
  z.object({
    ...OpenNegotiationSchema.omit({ kind: true }).shape,
    kind: z.literal("open"),
    negotiationKind: OpenNegotiationSchema.shape.kind,
  }),
  z.object({
    kind: z.literal("message"),
    channel: NegotiationChannelSchema,
    text: z.string().trim().min(1).max(6000),
  }),
  z.object({ kind: z.literal("draft"), terms: ProposalTermsSchema }),
  z.object({ kind: z.literal("send"), terms: ProposalTermsSchema }),
  z.object({ kind: z.literal("accept"), proposalId: Id }),
  z.object({ kind: z.literal("reject"), proposalId: Id, reason: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal("medical") }),
  z.object({ kind: z.literal("acknowledge_medical") }),
  z.object({ kind: z.literal("sign") }),
  z.object({ kind: z.literal("register") }),
  z.object({ kind: z.literal("withdraw"), reason: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal("read") }),
]);
export type NegotiationAction = z.infer<typeof NegotiationActionSchema>;
export const NegotiationRequestSchema = z
  .object({
    requestId: Id,
    negotiationId: Id.nullable(),
    revision: z.number().int().nonnegative(),
    action: NegotiationActionSchema,
  })
  .strict();
export type NegotiationRequest = z.infer<typeof NegotiationRequestSchema>;
export interface NegotiationView {
  teamId: string | null;
  date: string;
  cases: Array<Negotiation & { playerName: string; buyerName: string; sellerName: string }>;
  unread: number;
  payments: TransferPayment[];
  transferList: AgentCenterTransferListing[];
}
export function currentProposal(
  n: Negotiation,
  scope: ProposalTerms["scope"],
): NegotiationProposal | undefined {
  return [...n.proposals].reverse().find((p) => p.terms.scope === scope && p.status === "open");
}
export function proposalParties(n: Negotiation, scope: ProposalTerms["scope"]): string[] {
  return scope === "club" ? [n.buyerId, n.sellerId] : [n.buyerId, n.playerId];
}
export function proposalAgreed(n: Negotiation, p: NegotiationProposal | undefined): boolean {
  return (
    !!p &&
    p.status === "open" &&
    proposalParties(n, p.terms.scope).every((id) => p.acceptedBy.includes(id))
  );
}
export function totalTransferFee(terms: ProposalTerms): number {
  return terms.fee + terms.installments.reduce((sum, p) => sum + p.amount, 0);
}
/** Season game rules: July–August and January; free agents and renewals are exempt. */
export function isTransferWindow(date: string): boolean {
  const month = date.slice(5, 7);
  return month === "01" || month === "07" || month === "08";
}
export const NEGOTIATION_CHANNEL_LABELS: Record<NegotiationChannel, string> = {
  club: "상대 구단",
  player: "선수 측",
  internal: "내부 업무",
};

function contractDate(value: string): Date {
  const date = new Date(`${value}T00:00:00Z`);
  if (
    !DateString.safeParse(value).success ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new RangeError(`Invalid contract date: ${value}`);
  }
  return date;
}

/** Inclusive end date; a leap-day anniversary rolls to March 1 before subtracting a day. */
export function contractEndForYears(since: string, years: number): string {
  if (!Number.isSafeInteger(years) || years < 1)
    throw new RangeError("Contract years must be a positive safe integer");
  const date = contractDate(since);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  date.setUTCDate(date.getUTCDate() - 1);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999)
    throw new RangeError("Contract end date exceeds the supported calendar");
  return date.toISOString().slice(0, 10);
}

export const SetTransferListingSchema = z
  .object({
    playerId: Id,
    listed: z.boolean(),
    askingPrice: Money.optional(),
    note: z.string().trim().max(160).optional(),
  })
  .strict();
export type SetTransferListingInput = z.infer<typeof SetTransferListingSchema>;
export const AgentCenterSearchSchema = z
  .object({
    name: z.string().trim().max(100).optional(),
    club: z.string().trim().max(100).optional(),
    position: z.string().trim().max(20).optional(),
    page: z.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export type AgentCenterSearchInput = z.input<typeof AgentCenterSearchSchema>;
export interface AgentCenterPlayer {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  age: number;
  positions: string[];
  existingNegotiationId: string | null;
  kind: "transfer" | "free";
}
export interface AgentCenterSearchResult {
  players: AgentCenterPlayer[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}
export interface AgentCenterTransferListing {
  playerId: string;
  name: string;
  age: number;
  positions: string[];
  askingPrice?: number;
  listedOn: string;
  note?: string;
  negotiationIds: string[];
}
export interface AgentCenterView {
  teamId: string | null;
  date: string;
  transferList: AgentCenterTransferListing[];
}
