#!/bin/bash
# 전술판 저장 — 선발 11·벤치 ≤9·전술을 **결정적으로** 박는다 (경기 중에는 409 — 그때는 turn.sh의 orders를 쓴다).
# usage: lineup.sh <body.json>      body: {"starting":[{"playerId":"…","position":"GK"},…11개],"bench":[{"playerId":"…"},…],"tactics":{"mentality":3,…}}
#        lineup.sh --dump           지금 선발·벤치를 body 꼴로 찍는다 (고쳐서 다시 넣는 출발점)
set -uo pipefail
: "${SIM_GAME:?SIM_GAME이 비었다}" "${SIM_DIR:?SIM_DIR이 비었다}"
HOST="${SIM_HOST:-http://localhost:3000}"
S="$SIM_DIR/state.json"
if [ "${1:-}" = "--dump" ]; then
  jq '{starting: [.views.squad.players[] | select(.role=="선발") | {playerId: .id, position: .assignedPosition}],
       bench: [.views.squad.players[] | select(.role=="벤치") | {playerId: .id}],
       tactics: (.views.squad.tactics | {mentality, defensiveLine, pressing, tempo, width, passStyle} | with_entries(select(.value != null)))}' "$S"
  exit 0
fi
BODY="$1"
jq -e '(.starting|length)==11 and (.bench|length)<=9' "$BODY" >/dev/null || { echo "!!! 선발 11명·벤치 9명 이하가 아니다"; exit 2; }
CODE=$(curl -s -m 60 -o "$SIM_DIR/lineup.out" -w '%{http_code}' -X POST "$HOST/api/games/$SIM_GAME/lineup" -H 'content-type: application/json' --data-binary "@$BODY")
echo "HTTP $CODE"
if [ "$CODE" = "200" ] && jq -e '.views' "$SIM_DIR/lineup.out" >/dev/null 2>&1; then
  cp "$SIM_DIR/lineup.out" "$S"
  jq -r '"포메이션 \(.views.squad.formation)"' "$S"
  jq -r '.views.squad.players[] | select(.role=="선발") | "\(.assignedPosition // "?")\t\(.name)\t체력\(.condition.value)"' "$S"
else
  cat "$SIM_DIR/lineup.out"; echo
fi
