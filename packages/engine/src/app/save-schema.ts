import {
  NegotiationSchema,
  TransferListingSchema,
  TransferPaymentSchema,
  MarketReviewSchema,
  LorebookEntrySchema,
  LorebookRevisionSchema,
  LorebookJobSchema,
  RecentFlowSchema,
} from "@story-fm/domain";
import { z } from "zod";
import {
  AchievementSchema,
  BookingSchema,
  ContractSchema,
  DismissalSchema,
  FinanceReportSchema,
  GamePlayerSchema,
  GameTeamSchema,
  GrowthEntrySchema,
  HistoryDigestSchema,
  InjurySchema,
  ManagerSchema,
  ManagerOfferSchema,
  ManagerVacancySchema,
  ManagerPoolEntrySchema,
  MatchRecordSchema,
  StoredPersonaSchema,
  StoredStaffPoolEntrySchema,
  PlayerTrainingSchema,
  ManagerInterviewSchema,
  MediaFactSchema,
  SeasonPredictionSchema,
  RetiredPlayerSchema,
  YouthCandidateSchema,
  CallUpSchema,
  RoleMemorySchema,
  ScheduleEntrySchema,
  MilestoneSchema,
  PlayerMoveSchema,
  BoardRequestSchema,
  SeasonAwardSchema,
  SeasonHistorySchema,
  SeasonRecordSchema,
  SeasonStatSchema,
  SuspensionSchema,
  TeamFinanceSchema,
  TeamTacticsSchema,
  TrainingReportSchema,
  TrainingSessionSchema,
  TrophySchema,
} from "@story-fm/domain";

/**
 * **세이브가 통과해야 하는 문** — 로드의 두 번째 걸음이자 유일한 검사
 * (→ [docs/common/game-state.md](../../../../docs/common/game-state.md) §6).
 *
 * `packages/domain`의 Zod 스키마는 엔티티 정의(`z.infer`)이면서 여기서 로드의
 * 검사가 된다. 상태를 통째로 parse하고 그 결과를 그대로 상태로 쓰므로, `.default()`가
 * 붙은 축은 여기서 채워지고 스키마에 없는 찌꺼기 키는 여기서 떨어진다.
 *
 * **마이그레이션은 없다.** `createGame`이 세우는 테이블은 전부 필수다 — 새 테이블이
 * 서면 여기에도 필수로 서고, 그 앞의 세이브는 `SAVE_VERSION`이 막는다. optional은
 * 「없음이 뜻을 갖는」 필드에만 둔다(아래 주석이 그 뜻이다).
 *
 * `passthrough`인 이유: 스키마가 없는 축(`calendar` · `pendingMatch` · `chat` ·
 * `euroEntrants` …)은 **검사 밖이지 삭제 대상이 아니다.** 여기에 없다고 떨어뜨리면
 * 로드가 세이브를 조용히 깎는다.
 *
 * 값: 선수 5,780 · 계약 5,805 · 경기 2,262짜리 진행 중인 세이브에서 **약 50ms**이고
 * 그중 30ms가 선수 표다 — 그 세이브의 로드 전체가 80ms이니 절반을 조금 넘는다
 * (2026-08 측정, 놀고 있는 기계에서). 깎을 자리를 찾는다면 검사를 줄이는 쪽이
 * 아니라 조각(내용 해시)이 그대로인 표를 건너뛰는 쪽이다.
 */
const PendingMatchFlowSchema = z
  .object({
    live: z
      .object({
        state: z.object({ tick: z.number().int().nonnegative() }).passthrough(),
        flow: RecentFlowSchema,
      })
      .passthrough()
      .superRefine((live, ctx) => {
        if (live.flow.endTick !== live.state.tick)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Recent flow does not end at the committed match tick",
          });
      }),
  })
  .passthrough()
  .nullish();

export const GameTablesSchema = z.object({
  pendingMatch: z.unknown().superRefine((pending, ctx) => {
    const checked = PendingMatchFlowSchema.safeParse(pending);
    if (!checked.success) for (const issue of checked.error.issues) ctx.addIssue(issue);
  }),
  // 필수 테이블 — 없으면 앞 걸음(형태 검사)이 이미 손상으로 답한다
  lorebook: z.array(LorebookEntrySchema),
  lorebookRevisions: z.array(LorebookRevisionSchema),
  lorebookJobSequence: z.number().int().nonnegative(),
  lorebookJobs: z.array(LorebookJobSchema),
  negotiations: z.array(NegotiationSchema),
  transferListings: z.array(TransferListingSchema),
  transferPayments: z.array(TransferPaymentSchema),
  marketReview: MarketReviewSchema,
  negotiationRequests: z.array(z.string()),
  players: z.array(GamePlayerSchema),
  teams: z.array(GameTeamSchema),
  tactics: z.array(TeamTacticsSchema),
  finances: z.array(TeamFinanceSchema),
  contracts: z.array(ContractSchema),
  schedule: z.array(ScheduleEntrySchema),
  matches: z.array(MatchRecordSchema),
  manager: ManagerSchema,
  // 목록·이력 — `createGame`이 빈 배열로 세우고, 비어 있는 것이 곧 유효한 상태다
  trainingSessions: z.array(TrainingSessionSchema),
  injuries: z.array(InjurySchema),
  bookings: z.array(BookingSchema),
  suspensions: z.array(SuspensionSchema),
  moves: z.array(PlayerMoveSchema),
  growthLog: z.array(GrowthEntrySchema),
  seasonStats: z.array(SeasonStatSchema),
  seasonRecords: z.array(SeasonRecordSchema),
  trophies: z.array(TrophySchema),
  achievements: z.array(AchievementSchema),
  awards: z.array(SeasonAwardSchema),
  milestones: z.array(MilestoneSchema),
  playerTraining: z.array(PlayerTrainingSchema),
  trainingReports: z.array(TrainingReportSchema),
  developmentFocus: z.array(z.string()),
  roleMemory: z.array(RoleMemorySchema),
  dismissals: z.array(DismissalSchema),
  managerOffers: z.array(ManagerOfferSchema),
  managerVacancies: z.array(ManagerVacancySchema),
  managerPool: z.array(ManagerPoolEntrySchema),
  managerInterviews: z.array(ManagerInterviewSchema),
  predictions: z.array(SeasonPredictionSchema),
  media: z.array(MediaFactSchema),
  financeReports: z.array(FinanceReportSchema),
  history: z.array(SeasonHistorySchema),
  retired: z.array(RetiredPlayerSchema),
  youthCandidates: z.array(YouthCandidateSchema),
  callUps: z.array(CallUpSchema),
  personas: z.array(StoredPersonaSchema),
  boardRequests: z.array(BoardRequestSchema),
  // 없음이 뜻인 것 — 로드가 채우지 않는다
  /** 경질 카드 — 없으면 감독은 재직 중이다 (career.md §5.1) */
  dismissal: DismissalSchema.optional(),
  /**
   * 무직 스태프 풀 — 생성 시 확정하며, 빈 배열은 「다 데려갔다」다
   * (people.md §2-2 · `staffPoolOf`)
   */
  staffPool: z.array(StoredStaffPoolEntrySchema),
  /** 이력 압축의 자국 — 없으면 아직 한 번도 접지 않았다 (agents.md §5-1) */
  historyDigest: HistoryDigestSchema.optional(),
});

export type GameTables = z.infer<typeof GameTablesSchema>;
export const SaveSchema = GameTablesSchema.passthrough().superRefine((state, ctx) => {
  const books = new Map(state.lorebook.map((entry) => [entry.id, entry]));
  if (books.size !== state.lorebook.length)
    ctx.addIssue({ code: "custom", path: ["lorebook"], message: "로어북 id 중복" });
  for (const table of ["personas", "staffPool"] as const)
    state[table].forEach((person, index) => {
      const book = books.get(person.lorebookId);
      if (!book || book.kind === "team" || book.name !== person.name)
        ctx.addIssue({
          code: "custom",
          path: [table, index, "lorebookId"],
          message: "인물 로어북 참조 불일치",
        });
    });
});
