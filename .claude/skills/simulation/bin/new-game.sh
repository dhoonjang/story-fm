#!/bin/bash
# 정해진 시나리오로 새 게임을 연다. 성공하면 게임 id를 찍고 $SIM_DIR/game.txt에 적는다.
# env: SIM_TEAM(기본 manutd) · SIM_MANAGER(기본 마이클 캐릭) · SIM_BACKGROUND · SIM_SEED(기본 908121501) · SIM_DIR · SIM_HOST
set -uo pipefail
: "${SIM_DIR:?SIM_DIR이 비었다}"
HOST="${SIM_HOST:-http://localhost:3000}"
TEAM="${SIM_TEAM:-manutd}"
MANAGER="${SIM_MANAGER:-마이클 캐릭}"
BG="${SIM_BACKGROUND:-맨체스터 유나이티드의 미드필더 출신 감독. 저번 시즌 위기의 맨체스터 유나이티드를 중도 부임하여 살리고 챔피언스 리그 진출을 성공시켰다.}"
SEED="${SIM_SEED:-908121501}"
mkdir -p "$SIM_DIR"
BODY=$(jq -cn --arg t "$TEAM" --arg m "$MANAGER" --arg b "$BG" --argjson s "$SEED" '{teamId:$t, managerName:$m, background:$b, seed:$s}')
CODE=$(curl -s -m 600 -o "$SIM_DIR/state.json.tmp" -w '%{http_code}' -X POST "$HOST/api/games" -H 'content-type: application/json' -d "$BODY")
if [ "$CODE" = "200" ] && jq -e '.id' "$SIM_DIR/state.json.tmp" >/dev/null 2>&1; then
  mv "$SIM_DIR/state.json.tmp" "$SIM_DIR/state.json"
  ID=$(jq -r '.id' "$SIM_DIR/state.json"); echo "$ID" > "$SIM_DIR/game.txt"
  echo "게임 $ID · $(jq -r '"\(.date) \(.teamName) / \(.managerName)"' "$SIM_DIR/state.json")"
  echo "=== 첫 장면 ==="; jq -r '.chat[-1].text' "$SIM_DIR/state.json"
else
  echo "!!! 게임을 만들지 못했다 (HTTP $CODE)"; cat "$SIM_DIR/state.json.tmp" 2>/dev/null | head -c 600; rm -f "$SIM_DIR/state.json.tmp"; exit 1
fi
