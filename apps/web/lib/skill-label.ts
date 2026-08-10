/**
 * 스킬 이름 → **사람이 읽는 이름** (`set_player_tactic` → `선수 전술`).
 *
 * 채팅의 칩이 쓴다 — 감독에게 영문 식별자를 읽히지 않는다.
 *
 * ⚠️ 카탈로그(`@story-fm/agents`)에서 직접 가져오지 않는 이유는 그 패키지가
 * `node:path`를 끌어와 **클라이언트 번들이 깨지기** 때문이다. 표시 이름은 UI의
 * 것이므로 여기 두되, 카탈로그와 어긋나지 않는지는 테스트가 지킨다
 * (`skill-label.test.ts` — 새 스킬이 라벨 없이 들어오면 실패한다).
 * 없는 이름은 그대로 보여주므로 누락돼도 화면이 깨지지는 않는다.
 */
export const SKILL_LABEL: Record<string, string> = {
  start_match: "경기 시작",
  set_lineup: "라인업",
  set_captain: "주장 지정",
  set_tactics: "팀 전술 변경",
  set_player_tactic: "선수 전술",
  set_training: "훈련 지정",
  exploit_point: "약점 공략",
  team_talk: "팀 토크",
  talk_to_player: "선수 면담",
  respond_to_media: "기자회견 대응",
  substitute: "선수 교체",
  advance_match: "경기 진행",
  apply_narrative_event: "서사 상태 반영",
  apply_finance_event: "재정 이벤트",
  adjust_transfer_budget: "이적 예산 조정",
  search_players: "선수 검색",
  get_squad: "스쿼드·라인업 조회",
  get_team: "팀 조회",
  get_league: "리그·일정 조회",
  get_career: "커리어 조회",
  get_finance: "재정 조회",
  scout_player: "스카우트 파견",
  deal_odds: "딜 성공 확률",
  list_negotiations: "협상 목록",
  send_offer: "오퍼",
  respond_offer: "오퍼 판정",
  accept_deal: "계약 확정",
  set_transfer_list: "이적 리스트",
  withdraw_offer: "협상 철회",
  release_player: "계약 해지",
  recall_loan: "임대 복귀",
  open_renewal: "재계약 제안",
};
