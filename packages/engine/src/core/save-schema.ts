import { z } from "zod";
import {
  AchievementSchema,
  BookingSchema,
  CharacterMemorySchema,
  ContractSchema,
  IncidentSchema,
  DeferredScoutSchema,
  ScoutMissionSchema,
  DismissalSchema,
  FinanceReportSchema,
  GamePlayerSchema,
  GameTeamSchema,
  GrowthEntrySchema,
  HistoryDigestSchema,
  InjurySchema,
  ManagerOfferSchema,
  ManagerPoolEntrySchema,
  ManagerSchema,
  ManagerVacancySchema,
  MatchRecordSchema,
  MentoringSchema,
  NarrativeArcSchema,
  OpeningSchema,
  NarrativeNoteSchema,
  DelegationSchema,
  NegotiationSchema,
  PaymentScheduleSchema,
  PersonaSchema,
  StaffPoolEntrySchema,
  PlayerIssueSchema,
  ManagerPromiseSchema,
  PlayerTrainingSchema,
  ApproachPressureSchema,
  ApproachSchema,
  BoardDemandSchema,
  ClubVisionSchema,
  BoardRequestSchema,
  PressConferenceSchema,
  PressLeakSchema,
  PressSackingSchema,
  MediaFactSchema,
  SeasonPredictionSchema,
  RelationSchema,
  ReserveTrainingPolicySchema,
  RetiredPlayerSchema,
  YouthCandidateSchema,
  CallUpSchema,
  RoleMemorySchema,
  ScheduleEntrySchema,
  ScoutReportSchema,
  MilestoneSchema,
  SeasonAwardSchema,
  SeasonHistorySchema,
  SeasonRecordSchema,
  SeasonStatSchema,
  SettlingEventSchema,
  SuspensionSchema,
  TeamFinanceSchema,
  TeamTacticsSchema,
  TrainingReportSchema,
  TrainingSessionSchema,
  TransferListingSchema,
  TransferRequestSchema,
  CompetingBidSchema,
  InterestSchema,
  TransferSchema,
  TransferWindowSchema,
  TrophySchema,
} from "@story-fm/domain";

/**
 * **세이브가 통과해야 하는 문** — 로드의 두 번째 걸음이자 유일한 검사
 * (→ [docs/data/game-state.md](../../../../docs/data/game-state.md) §6).
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
export const SaveSchema = z
  .object({
    // 필수 테이블 — 없으면 앞 걸음(형태 검사)이 이미 손상으로 답한다
    players: z.array(GamePlayerSchema),
    teams: z.array(GameTeamSchema),
    tactics: z.array(TeamTacticsSchema),
    finances: z.array(TeamFinanceSchema),
    contracts: z.array(ContractSchema),
    schedule: z.array(ScheduleEntrySchema),
    matches: z.array(MatchRecordSchema),
    windows: z.array(TransferWindowSchema),
    manager: ManagerSchema,
    // 목록·이력 — `createGame`이 빈 배열로 세우고, 비어 있는 것이 곧 유효한 상태다
    trainingSessions: z.array(TrainingSessionSchema),
    negotiations: z.array(NegotiationSchema),
    injuries: z.array(InjurySchema),
    bookings: z.array(BookingSchema),
    suspensions: z.array(SuspensionSchema),
    transfers: z.array(TransferSchema),
    growthLog: z.array(GrowthEntrySchema),
    seasonStats: z.array(SeasonStatSchema),
    issues: z.array(PlayerIssueSchema),
    promises: z.array(ManagerPromiseSchema),
    seasonRecords: z.array(SeasonRecordSchema),
    trophies: z.array(TrophySchema),
    achievements: z.array(AchievementSchema),
    awards: z.array(SeasonAwardSchema),
    milestones: z.array(MilestoneSchema),
    narrative: z.array(NarrativeNoteSchema),
    scoutReports: z.array(ScoutReportSchema),
    deferredScouts: z.array(DeferredScoutSchema),
    scoutMissions: z.array(ScoutMissionSchema),
    settlingEvents: z.array(SettlingEventSchema),
    transferList: z.array(TransferListingSchema),
    transferRequests: z.array(TransferRequestSchema),
    interests: z.array(InterestSchema),
    competingBids: z.array(CompetingBidSchema),
    delegations: z.array(DelegationSchema),
    playerTraining: z.array(PlayerTrainingSchema),
    trainingReports: z.array(TrainingReportSchema),
    developmentFocus: z.array(z.string()),
    mentoring: z.array(MentoringSchema),
    roleMemory: z.array(RoleMemorySchema),
    pressConferences: z.array(PressConferenceSchema),
    approaches: z.array(ApproachSchema),
    approachPressure: z.array(ApproachPressureSchema),
    pressLeaks: z.array(PressLeakSchema),
    pressSackings: z.array(PressSackingSchema),
    predictions: z.array(SeasonPredictionSchema),
    media: z.array(MediaFactSchema),
    financeReports: z.array(FinanceReportSchema),
    history: z.array(SeasonHistorySchema),
    retired: z.array(RetiredPlayerSchema),
    youthCandidates: z.array(YouthCandidateSchema),
    callUps: z.array(CallUpSchema),
    personas: z.array(PersonaSchema),
    characterMemories: z.array(CharacterMemorySchema),
    incidents: z.array(IncidentSchema),
    relations: z.array(RelationSchema),
    arcs: z.array(NarrativeArcSchema),
    openings: z.array(OpeningSchema),
    paymentSchedules: z.array(PaymentScheduleSchema),
    boardDemands: z.array(BoardDemandSchema),
    boardRequests: z.array(BoardRequestSchema),
    dismissals: z.array(DismissalSchema),
    managerOffers: z.array(ManagerOfferSchema),
    managerVacancies: z.array(ManagerVacancySchema),
    managerPool: z.array(ManagerPoolEntrySchema),
    // 없음이 뜻인 것 — 로드가 채우지 않는다
    /** 경질 카드 — 없으면 감독은 재직 중이다 (career.md §5.1) */
    dismissal: DismissalSchema.optional(),
    /**
     * 무직 스태프 풀 — 없으면 그해의 결정적 추첨이 답하고, 빈 배열은 「다 데려갔다」다
     * (people.md §2-2 · `staffPoolOf`)
     */
    staffPool: z.array(StaffPoolEntrySchema).optional(),
    /** 클럽 비전 — 없으면 구단주가 아직 다년 계획을 걸지 않았다 (career.md §5) */
    clubVision: ClubVisionSchema.optional(),
    /** 이력 압축의 자국 — 없으면 아직 한 번도 접지 않았다 (agents.md §5-1) */
    historyDigest: HistoryDigestSchema.optional(),
    /** 2군 훈련 방침 — 없으면 감독이 고르지 않은 것이고 `balanced`로 읽는다 */
    reserveTraining: ReserveTrainingPolicySchema.optional(),
  })
  .passthrough();
