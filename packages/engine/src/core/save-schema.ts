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
  ManagerSchema,
  ManagerVacancySchema,
  MatchRecordSchema,
  MentoringSchema,
  NarrativeArcSchema,
  OpeningSchema,
  NarrativeNoteSchema,
  NegotiationSchema,
  PaymentScheduleSchema,
  PersonaSchema,
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
 * **세이브가 통과해야 하는 문** — 로드의 세 번째 걸음
 * (→ [docs/data/game-state.md](../../../../docs/data/game-state.md) §6).
 *
 * `packages/domain`의 Zod 스키마는 엔티티 정의(`z.infer`)이면서 여기서 로드의
 * 검사가 된다. 마이그레이션이 끝난 상태를 통째로 parse하고 그 결과를 그대로
 * 상태로 쓰므로, `.default()`가 붙은 축은 여기서 채워지고 스키마에 없는 찌꺼기
 * 키는 여기서 떨어진다.
 *
 * ⚠️ **스키마를 좁히면 옛 세이브가 막힌다.** 필드를 필수로 올리거나 범위를 좁히는
 * 변경은 같은 PR에 마이그레이션(`core/migrations.ts`)을 함께 쓴다.
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
    // 마이그레이션이 채우는 목록·이력 (`fillEmptyTables`)
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
    narrative: z.array(NarrativeNoteSchema),
    scoutReports: z.array(ScoutReportSchema),
    settlingEvents: z.array(SettlingEventSchema),
    transferList: z.array(TransferListingSchema),
    transferRequests: z.array(TransferRequestSchema),
    interests: z.array(InterestSchema),
    playerTraining: z.array(PlayerTrainingSchema),
    roleMemory: z.array(RoleMemorySchema),
    pressConferences: z.array(PressConferenceSchema),
    approaches: z.array(ApproachSchema),
    approachPressure: z.array(ApproachPressureSchema),
    pressLeaks: z.array(PressLeakSchema),
    financeReports: z.array(FinanceReportSchema),
    history: z.array(SeasonHistorySchema),
    // 없을 수 있는 것 — 로드가 채우지 않는다(없는 것이 곧 뜻이다)
    personas: z.array(PersonaSchema).optional(),
    deferredScouts: z.array(DeferredScoutSchema).optional(),
    scoutMissions: z.array(ScoutMissionSchema).optional(),
    dismissal: DismissalSchema.optional(),
    dismissals: z.array(DismissalSchema).optional(),
    managerOffers: z.array(ManagerOfferSchema).optional(),
    managerVacancies: z.array(ManagerVacancySchema).optional(),
    pressSackings: z.array(PressSackingSchema).optional(),
    /** 언론의 시즌 예상 순위 — 소집일에 리그마다 한 줄 (season.md §2). 옛 세이브엔 없다 */
    predictions: z.array(SeasonPredictionSchema).optional(),
    /** 아직 읽지 않은 회견 밖의 기사 (people.md §4-1). 옛 세이브엔 없다 */
    media: z.array(MediaFactSchema).optional(),
    /** 클럽 비전 — 구단주 원형이 건 다년 계획 (career.md §5). 옛 세이브엔 없다 */
    clubVision: ClubVisionSchema.optional(),
    boardDemands: z.array(BoardDemandSchema).optional(),
    competingBids: z.array(CompetingBidSchema).optional(),
    boardRequests: z.array(BoardRequestSchema).optional(),
    historyDigest: HistoryDigestSchema.optional(),
    characterMemories: z.array(CharacterMemorySchema).optional(),
    /** 감독이 말로 만든 사건 (people.md §6 「사건 기록」). 옛 세이브엔 없다 */
    incidents: z.array(IncidentSchema).optional(),
    /** 관계 점수 — 움직인 쌍만 앉는다 (people.md §6). 옛 세이브엔 없다 */
    relations: z.array(RelationSchema).optional(),
    arcs: z.array(NarrativeArcSchema).optional(),
    /** 시작 사건 (career.md §1). 옛 세이브엔 없다 */
    openings: z.array(OpeningSchema).optional(),
    paymentSchedules: z.array(PaymentScheduleSchema).optional(),
    developmentFocus: z.array(z.string()).optional(),
    mentoring: z.array(MentoringSchema).optional(),
    awards: z.array(SeasonAwardSchema).optional(),
    milestones: z.array(MilestoneSchema).optional(),
    retired: z.array(RetiredPlayerSchema).optional(),
    youthCandidates: z.array(YouthCandidateSchema).optional(),
    callUps: z.array(CallUpSchema).optional(),
    trainingReports: z.array(TrainingReportSchema).optional(),
    reserveTraining: ReserveTrainingPolicySchema.optional(),
  })
  .passthrough();
