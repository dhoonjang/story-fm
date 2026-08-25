// @story-fm/engine 공개 API — 폴더가 도메인이다.

// core — 난수·경로·날짜·게임 상태·저장·시간 진행
export * from "./core/rng";
export * from "./core/paths";
export * from "./core/dates";
export * from "./core/name-match";
export * from "./core/state";
export * from "./core/history-window";
export * from "./core/player-ref";
export * from "./core/league-shape";
export * from "./core/club-tier";
export * from "./core/persistence";
export * from "./core/save-lock";
export * from "./core/tick";

// data — 카탈로그·시드 (불변 초기치)
export * from "./data/names";
export * from "./data/team-catalog";
export * from "./data/coach-seeds";
export * from "./data/owner-seeds";
export * from "./data/league-catalog";
export * from "./data/cup-catalog";
export * from "./data/domestic-cup-catalog";
export * from "./data/super-cup-catalog";
export * from "./data/club-profile";
export * from "./data/pseudonym";
export * from "./data/league-economy";
export * from "./data/catalog-source";
export * from "./data/team-override";
export * from "./data/cup-override";

// world — 새 게임의 세계 구축 (능력치 파생·카탈로그 빌드·생성·주급·인물)
export * from "./world/attributes";
export * from "./world/player-id";
export * from "./world/catalog";
export * from "./world/persona";
export * from "./world/player-persona";
export * from "./world/character-book";
export * from "./world/relations";
export * from "./world/arcs";
export * from "./world/generate";
export * from "./world/wages";
export * from "./world/onboarding";
export * from "./world/admin";
export * from "./world/admin-team";
export * from "./world/admin-competition";
export * from "./world/catalog-invariants";
export * from "./world/scope";

// competition — 시즌 달력·리그·컵·유럽 대항전
export * from "./competition/calendar";
export * from "./competition/fixtures";
export * from "./competition/friendly";
export * from "./competition/reserve";
export * from "./competition/season";
export * from "./competition/europe";
export * from "./competition/euro-knockout";
export * from "./competition/euro-prize";
export * from "./competition/shootout";
export * from "./competition/extra-time";
export * from "./competition/promotion";
export * from "./competition/club-tier-recompute";
export * from "./competition/domestic-cup";
export * from "./competition/super-cup";
export * from "./competition/draw-schedule";
export * from "./competition/reschedule";

// match — 경기 진행·간이 시뮬·평점·징계
export * from "./match/match-flow";
export * from "./match/quick-sim";
export * from "./match/ratings";

// squad — 선수단 상태(폼·심경·부상·정착)와 성장·훈련·스카우팅
export * from "./squad/depth";
export * from "./squad/hierarchy";
export * from "./squad/form";
export * from "./squad/slump";
export * from "./squad/other-clubs";
export * from "./squad/mood";
export * from "./squad/cues";
export * from "./squad/coach-cues";
export * from "./squad/settling";
export * from "./squad/injury";
export * from "./squad/development";
export * from "./squad/registration";
export * from "./squad/demotion";
export * from "./squad/scouting";
export * from "./squad/training-plan";
export * from "./squad/training-report";
export * from "./squad/numbers";
export * from "./squad/career";

// market — 이적 시장·협상·메디컬·감독 시장
export * from "./market/market";
export * from "./market/negotiation";
export * from "./market/counter-bounds";
export * from "./market/counterparty";
export * from "./market/clauses";
export * from "./market/ai-market";
export * from "./market/medical";
export * from "./market/departures";
export * from "./market/manager-market";
export * from "./market/persuasion";

// club — 구단 재정·기자회견
export * from "./club/finance";
export * from "./club/press";
export * from "./club/approach";
export * from "./club/board-demand";
export * from "./club/board-request";
export * from "./club/manager-wallet";

// skills — 감독 지시(GM 도구)의 실행부
export * from "./skills";

// views — 오피스 뷰·읽기 전용 조회
export * from "./views/views";
export * from "./views/lookup";
