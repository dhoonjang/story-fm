#!/bin/bash
# 상태 요약 — 마지막 턴의 페이로드($SIM_DIR/state.json)를 읽는다. --fetch면 서버에서 다시 받는다.
# usage: state.sh [--fetch] brief|attention|first|reserve|xi|calendar|contracts|finance|table|match|youth|windows|registration|reputation|chat [N]
set -uo pipefail
: "${SIM_GAME:?SIM_GAME이 비었다}" "${SIM_DIR:?SIM_DIR이 비었다}"
HOST="${SIM_HOST:-http://localhost:3000}"
S="$SIM_DIR/state.json"
if [ "${1:-}" = "--fetch" ]; then
  shift
  curl -s -m 60 "$HOST/api/games/$SIM_GAME?settled=1" -o "$S.tmp" && jq -e '.views' "$S.tmp" >/dev/null 2>&1 && mv "$S.tmp" "$S" || { echo "!!! 상태를 받지 못했다"; cat "$S.tmp" 2>/dev/null | head -c 400; rm -f "$S.tmp"; exit 1; }
fi
[ -s "$S" ] || { echo "!!! $S 가 없다 — 먼저 state.sh --fetch brief"; exit 1; }
WHAT="${1:-brief}"
ROW='[.id, .name, (.age|tostring)+"세", .position, (.positions|map(.position // .code // .)|join("/")), (.overall|tostring), .role, (.assignedPosition // "-"), "체력"+(.condition.value|tostring), .fatigueBand, .formLabel, (if .injury then "부상~"+.injury.expectedReturn else "" end), (if .suspended>0 then "정지"+(.suspended|tostring) else "" end), (.seasonApps|tostring)+"경기 "+(.seasonMinutes|tostring)+"분", (.contractUntil // "-"), (.promises|map(.kind+"~"+.dueOn)|join(",")), (if .isCaptain then "C" elif .isViceCaptain then "VC" else "" end)] | @tsv'
case "$WHAT" in
  brief)
    jq -r '"\(.date) \(.timeOfDay) · 시즌 \(.season) · phase \(.phase) · \(.teamName) / \(.managerName)",
      ("안건: " + (if (.views.attention|length)>0 then ([.views.attention[] | "\(.kind)\(if .count>1 then "×"+(.count|tostring) else "" end)\(if .daysLeft!=null then " D-"+(.daysLeft|tostring) else "" end)\(if .name!=null then " "+.name else "" end)"]|join(" · ")) else "없음" end)),
      ("다음 경기: " + (([.views.calendar.entries[] | select(.isNext)][0] // {date:"-",title:"-"}) | "\(.date) \(.title)")),
      ("재정: 잔고 £\(.views.finance.balance/1e6|floor)M · 주급 £\(.views.finance.weeklyWages/1e3|floor)k/주 · 이적예산 £\(.views.finance.transferBudget/1e6|floor)M\(if .views.finance.budgetFrozen then " (동결)" else "" end)"),
      ("평판: " + (.views.squad.manager.reputation|to_entries|map("\(.key) \(.value)")|join(" · "))),
      ("1군 \(.views.squad.firstTeamCount) · 2군 \(.views.squad.reserveCount) · 등록 \(.views.squad.registration.listed)/\(.views.squad.registration.limit) 홈그로운 \(.views.squad.registration.homegrown)/\(.views.squad.registration.homegrownMin)" + (if (.views.squad.registration.issues|length)>0 then " ⚠ " + (.views.squad.registration.issues|join(" / ")) else "" end)),
      ("리그: " + ((.views.competitions.list[] | select(.kind=="league") | "\(.userPosition)위") // "-"))' "$S" ;;
  attention) jq -r '.views.attention[] | "\(.kind)\t\(.label)\t\(.name // "")\t\(if .daysLeft!=null then "D-"+(.daysLeft|tostring) else "" end)\t×\(.count)"' "$S" ;;
  first) jq -r ".views.squad.players[] | select(.squadLevel==\"first\") | $ROW" "$S" ;;
  reserve) jq -r ".views.squad.players[] | select(.squadLevel==\"reserve\") | $ROW" "$S" ;;
  xi)
    jq -r '"--- 선발 · 포메이션 \(.views.squad.formation) · 전술 \(.views.squad.tactics|tostring)"' "$S"
    jq -r '.views.squad.players[] | select(.role=="선발") | "\(.assignedPosition // "?")\t\(.name)\t\(.id)\t체력\(.condition.value)\t\(.fatigueBand)\t\(.formLabel)\(if .injury then " 부상" else "" end)\(if .suspended>0 then " 정지" else "" end)"' "$S"
    echo "--- 벤치"; jq -r '.views.squad.players[] | select(.role=="벤치") | "\(.position)\t\(.name)\t\(.id)\t체력\(.condition.value)\t\(.fatigueBand)"' "$S" ;;
  calendar) jq -r '.views.calendar.entries[] | select(.status=="scheduled") | "\(.date) \(.time)\t\(.title)\(if .isNext then "\t← 다음" else "" end)"' "$S" | head -${2:-10} ;;
  contracts) jq -r '.views.finance.expiringContracts[] | "\(.until)\tD-\(.daysLeft)\t\(.name)\t\(.age)세\t£\(.weeklyWage)/주\t\(.playerId)\(if .openToPrecontract then "\t(사전계약 가능)" else "" end)"' "$S" ;;
  finance) jq '.views.finance | {balance, weeklyWages, transferBudget, budgetFrozen, wageRoom, wageRatio, board: .board.request}' "$S" ;;
  table) jq -r '.views.competitions.list[] | select(.kind=="league") | .standings[] | "\(.name)\t\(.played)경기\t\(.points)점\t\(.goalDiff)\(if .ours then "\t← 우리" else "" end)"' "$S" ;;
  match)
    jq -e '.views.match' "$S" >/dev/null || { echo "경기 중이 아니다"; exit 0; }
    jq -r '.views.match | "\(.minute)분 \(.home.short) \(.score.home)-\(.score.away) \(.away.short) · phase \(.phase) · 교체 홈 \(.subs.home.used)/\(.subs.limit.subs)(창 \(.subs.home.windows)/\(.subs.limit.windows)) 원정 \(.subs.away.used)/\(.subs.limit.subs)\(if (.sentOff|length)>0 then " · 퇴장 "+(.sentOff|join(",")) else "" end)"' "$S"
    echo "--- 우리 온필드"; jq -r '.views.match | (.onPitch.home + .onPitch.away)[] | select(.ours) | "\(.position)\t\(.name)\t\(.id)\t체력\(.condition.value)\(if .gassed then " 지침!" else "" end)\t경고\(.tally.yellows)\(if .tally.red then " 퇴장" else "" end)\tG\(.tally.goals) A\(.tally.assists)"' "$S"
    echo "--- 우리 벤치"; jq -r '.views.match | (.bench.home + .bench.away)[] | select(.ours) | "\(.position)\t\(.name)\t\(.id)\t체력\(.condition.value)"' "$S"
    echo "--- 키포인트"; jq -r '.views.match.keyPoints[-4:][] | "· \(.text)"' "$S" 2>/dev/null ;;
  youth) jq -r '.views.squad.youthIntake | if . == null then "후보 없음" else ("마감 " + .deadline), (.candidates[] | "\(.name)\t\(.age)세\t\(.position)\t종합\(.overall)\t잠재\(.potential.low)-\(.potential.high)\t£\(.weeklyWage)×\(.years)년\t\(.id)\(if .autoSign then "\t(방치 시 자동 계약)" else "" end)") end' "$S" ;;
  windows) jq -r '.views.calendar.windows[] | "\(.kind)\t\(.opensOn) ~ \(.closesOn)\t\(if .open then "열림" else "닫힘" end)"' "$S" ;;
  registration) jq '.views.squad.registration' "$S" ;;
  reputation) jq '.views.squad.manager | {reputation, attributes}' "$S" ;;
  chat) jq -r ".chat[-${2:-4}:][] | \"[\\(.at) \\(.role)] \\(.text|.[0:400]|gsub(\"\\n\";\" \"))\" + (if .toolCalls then \"\\n    \" + (.toolCalls|map(\"· \"+.name+\": \"+.summary)|join(\"\\n    \")) else \"\" end)" "$S" ;;
  *) echo "모르는 갈래: $WHAT"; exit 2 ;;
esac
