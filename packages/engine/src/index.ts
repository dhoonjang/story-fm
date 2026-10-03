// @story-fm/engine 공개 API — 폴더가 도메인이다.

// core — 난수·경로·날짜·게임 상태·저장·시간 진행
export * from "./common/core/rng";
export * from "./common/core/paths";
export * from "./common/core/dates";
export * from "./common/core/name-match";
export * from "./common/core/state";
export * from "./common/core/history-window";
export * from "./common/people/lorebook";
export * from "./app/workflows/story/lorebook";
export * from "./common/core/turn-facts";
export * from "./common/core/journal";
export * from "./common/core/player-ref";
export * from "./common/core/team-ref";
export * from "./common/core/league-shape";
export * from "./common/core/club-tier";
export * from "./app/persistence";
export * from "./common/core/save-lock";
export * from "./app/tick";
export * from "./match/squad/simulation";

// data — 카탈로그·시드 (불변 초기치)
export * from "./common/data/names";
export * from "./common/data/team-catalog";
export * from "./common/data/coach-seeds";
export * from "./common/data/owner-seeds";
export * from "./common/data/league-catalog";
export * from "./common/data/cup-catalog";
export * from "./common/data/discipline-catalog";
export * from "./common/data/domestic-cup-catalog";
export * from "./common/data/super-cup-catalog";
export * from "./common/data/club-profile";
export * from "./common/data/pseudonym";
export * from "./common/data/league-economy";
export * from "./common/data/catalog-source";
export * from "./common/data/team-override";
export * from "./common/data/cup-override";

// world — 새 게임의 세계 구축 (능력치 파생·카탈로그 빌드·생성·주급·인물)
export * from "./common/world/attributes";
export * from "./common/world/player-id";
export * from "./common/world/catalog";
export * from "./common/people/persona";
export * from "./common/people/player-persona";
export * from "./common/world/generate";
export * from "./common/finance/wages";
export * from "./app/admin/admin";
export * from "./app/admin/admin-team";
export * from "./app/admin/admin-persona";
export * from "./common/people/persona-catalog";
export * from "./app/admin/admin-competition";
export * from "./app/catalog-invariants";
export * from "./common/world/scope";
export * from "./common/players/player-pool";

// competition — 시즌 달력·리그·컵·유럽 대항전
export * from "./match/competition/calendar";
export * from "./match/competition/pairings";
export * from "./common/core/international-breaks";
export * from "./common/core/calendar";
export * from "./match/competition/fixtures";
export * from "./match/competition/friendly";
export * from "./common/core/match-kinds";
export * from "./match/competition/reserve";
export * from "./common/views/standings";
export * from "./app/season";
export * from "./common/players/career";
export * from "./match/competition/leaderboard";
export * from "./match/competition/records";
export * from "./common/views/manager-career";
export * from "./match/competition/europe";
export * from "./common/views/europe";
export * from "./match/competition/euro-knockout";
export * from "./app/workflows/match/competition/euro-knockout";
export * from "./app/workflows/match/competition/euro-prize";
export * from "./match/competition/shootout";
export * from "./match/competition/extra-time";
export * from "./app/workflows/match/competition/extra-time";
export * from "./match/competition/promotion";
export * from "./app/workflows/match/competition/promotion";
export * from "./common/core/league-membership";
export * from "./match/competition/prediction";
export * from "./common/views/prediction";
export * from "./match/competition/international";
export * from "./app/workflows/match/competition/international";
export * from "./common/players/international";
export * from "./match/competition/club-tier-recompute";
export * from "./match/competition/domestic-cup";
export * from "./app/workflows/match/competition/domestic-cup";
export * from "./common/views/cup-entrants";
export * from "./match/competition/super-cup";
export * from "./app/workflows/match/competition/super-cup";
export * from "./match/competition/draw-schedule";
export * from "./match/competition/reschedule";

// match — 경기 진행·간이 시뮬·평점·징계
export * from "./match/flow/match-flow";
export * from "./app/workflows/match/flow/match-flow";
export * from "./match/flow/preview";
export * from "./match/flow/quick-sim";
export * from "./match/flow/ratings";

// squad — 선수단 상태(폼·심경·부상)와 성장·훈련
export * from "./common/players/squad-depth";
export * from "./common/players/hierarchy";
export * from "./common/players/form";
export * from "./story/players/slump";
export * from "./match/squad/other-clubs";
export * from "./story/players/coach-cues";
export * from "./app/workflows/story/players/coach-cues";
export * from "./common/players/injury";
export * from "./story/players/development";
export * from "./common/players/registration";
export * from "./common/players/contract-status";
export * from "./common/players/observation";
export * from "./common/players/observation-view";
export * from "./story/players/training-plan";
export * from "./story/players/training-report";
export * from "./app/workflows/story/players/training-report";
export * from "./common/players/attribute-growth";
export * from "./common/players/numbers";
export * from "./story/players/career";

// market — 이적 시장·협상·메디컬·감독 시장

// club — 구단 재정·기자회견
export * from "./story/world/media";
export * from "./app/workflows/story/world/board";

// commands — 감독 지시(도구·해석기)가 닿는 코어 명령의 실행부
export * from "./app/commands";

// views — 오피스 뷰·읽기 전용 조회
export * from "./app/calendar-view";
export * from "./common/views/finance";
export * from "./match/views/live";
export * from "./app/views/squad";
export * from "./app/views/career";
export * from "./match/views/competition";
export * from "./app/views";
export * from "./common/views/observation";
export * from "./common/views/colours";
export * from "./match/views/report";
export * from "./app/player-card";
export * from "./app/lookup";
export * from "./common/views/finance-outlook";

export * from "./app/create-game";
export * from "./match/squad/selection";

export * from "./app/workflows/match/health/injury";

export * from "./common/finance/finance";
export * from "./common/finance/request-board";
export * from "./common/finance/board-request";

export * from "./story/world/manager-employment";
export * from "./app/workflows/story/world/manager-employment";
export * from "./story/people/staff-employment";

export * from "./common/players/free-agency";

export * from "./app/workflows/story/world/interview";

export * from "./negotiation/negotiation";
export { repairNegotiationSquads } from "./app/workflows/negotiation-squad";
