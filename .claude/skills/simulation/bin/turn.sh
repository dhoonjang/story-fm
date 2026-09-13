#!/bin/bash
# 턴 하나를 보내고 **끝날 때까지 기다린다.** 한 번에 하나 — 병렬 호출 금지 (SKILL.md §3).
# usage: turn.sh '<json body>'
#   body: {"message":"…"} | {"operation":{"kind":"skip_days","days":1}}
#         | {"operation":{"kind":"skip_to_next_match","date":"YYYY-MM-DD"}}
#         | {"operation":{"kind":"advance_match"}}
#   message에 orders를 함께 실을 수 있다: {"message":"…","orders":[{"kind":"substitution","out":"id","in":"id"}]}
# env: SIM_GAME(게임 id) · SIM_DIR(작업 폴더) · SIM_HOST(기본 http://localhost:3000)
set -uo pipefail
: "${SIM_GAME:?SIM_GAME이 비었다}" "${SIM_DIR:?SIM_DIR이 비었다}"
HOST="${SIM_HOST:-http://localhost:3000}"
RAW="$SIM_DIR/raw.ndjson"
mkdir -p "$SIM_DIR"
printf '%s\n' "$1" > "$SIM_DIR/last-request.json"

curl -N -s -m 900 -X POST "$HOST/api/games/$SIM_GAME/turn/stream" \
  -H 'content-type: application/json' -d "$1" > "$RAW"
CURL=$?

echo "=== 서사 ==="
jq -j 'select(.type=="delta") | .text' "$RAW" 2>/dev/null
echo
ERR=$(jq -c 'select(.type=="error")' "$RAW" 2>/dev/null)
if [ -n "$ERR" ]; then echo "=== 오류 === $ERR"; fi
if [ "$CURL" -ne 0 ]; then echo "=== curl 종료 코드 $CURL (연결·시간 초과) ==="; fi

jq 'select(.type=="done") | .payload' "$RAW" > "$SIM_DIR/state.json.tmp" 2>/dev/null
if [ -s "$SIM_DIR/state.json.tmp" ]; then
  mv "$SIM_DIR/state.json.tmp" "$SIM_DIR/state.json"
  echo "=== 이번 턴의 도구 ==="
  jq -r '.chat[-2:][] | select(.toolCalls != null) | .toolCalls[] | "· \(.name): \(.summary)"' "$SIM_DIR/state.json" 2>/dev/null
  echo "=== 상태 ==="
  jq -r '
    "\(.date) \(.timeOfDay) · 시즌 \(.season) · phase \(.phase)",
    (if (.views.attention|length) > 0
       then "안건: " + ([.views.attention[] | "\(.kind)\(if .count>1 then "×"+(.count|tostring) else "" end)\(if .daysLeft!=null then " D-"+(.daysLeft|tostring) else "" end)\(if .name!=null then " "+.name else "" end)"] | join(" · "))
       else "안건: 없음" end),
    ("다음 경기: " + (([.views.calendar.entries[] | select(.isNext)][0] // {date:"-",title:"-"}) | "\(.date) \(.title)")),
    (if .views.match != null then "경기: \(.views.match.minute)분 \(.views.match.home.short) \(.views.match.score.home)-\(.views.match.score.away) \(.views.match.away.short) · 교체 홈 \(.views.match.subs.home.used)/\(.views.match.subs.limit.subs) 원정 \(.views.match.subs.away.used)/\(.views.match.subs.limit.subs)" else empty end)
  ' "$SIM_DIR/state.json"
else
  rm -f "$SIM_DIR/state.json.tmp"
  echo "!!! done 페이로드 없음 — 상태는 갱신되지 않았다. raw 꼬리:"
  tail -c 1500 "$RAW"; echo
  echo "!!! 서버가 턴을 끝까지 돌렸을 수 있다 — state.sh --fetch brief 로 다시 읽고 나서 판단한다"
fi
