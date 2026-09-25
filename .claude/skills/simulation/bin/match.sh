#!/bin/bash
# 경기를 다음 정지점까지 굴린다 — 브라우저의 실행기와 같은 일을 화면 없이 한다.
# 정지점(골 · 경고 · 퇴장 · 부상 · 교체 · 상대 벤치의 전술 전환 · 하프의 끝)이 확정되면 멈추고 정지점 턴(match_stop)을 연다 —
# 판독기가 판을 다시 읽고 매치 GM이 그 사건을 중계한다. 종료 휘슬 뒤에는 마감 턴을 연다.
# usage: match.sh            다음 정지점까지
#        match.sh --resume   휴식(하프타임 · 연장 개시)을 끝내고 다음 정지점까지
#        match.sh --shootout 승부차기 한 발
# env: SIM_GAME · SIM_DIR · SIM_HOST (turn.sh와 같다)
set -uo pipefail
: "${SIM_GAME:?SIM_GAME이 비었다}" "${SIM_DIR:?SIM_DIR이 비었다}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
SIM_HOST="${SIM_HOST:-http://localhost:3000}" SIM_GAME="$SIM_GAME" \
  pnpm --silent --dir "$ROOT/apps/match-cli" exec tsx src/client.ts "$@"
CODE=$?
case $CODE in
  0 | 20) "$HERE/turn.sh" '{"operation":{"kind":"match_stop"}}' ;;
  10) echo "=== 휴식 — 라커룸의 말을 한 턴 보내고 match.sh --resume ===" ;;
  *) echo "=== 실행기 오류 (종료 코드 $CODE) ===" ;;
esac
