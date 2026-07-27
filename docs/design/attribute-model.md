# 능력치 모델 (Attribute Model)

> 🚧 **초안 v0.3** · 2026-07-28 · [game-overview §6–7](./game-overview.md)의 심화
> — 15축 능력치 · 포지션 가중치 · 관측 가능성 · 상태 보정 · 성장/쇠퇴 · 감독 능력치

**한 줄 요약: base 능력치(느린 변화) × 상태 보정(빠른 변화) = 유효 능력치.
포지션 가중치가 그 값을 "이 자리에서의 전력"으로 번역한다.
변하는 경로는 훈련·경기·나이뿐이다 (결정 #7).**

---

## 1. Base 능력치 — 15축

스케일 0~99 (전 축 공통). **모든 선수가 15축 전부를 갖는다** — 포지션별 예외
분기는 두지 않는다 (goalkeeping도 전 선수 보유, ERD v5의 원칙 유지). 어떤 축이
그 선수에게 의미 있는지는 **포지션 가중치**(§2)가 정한다.

### 신체 (4)

| 코드 | 표시 | 정의 | 시뮬·서사에서 하는 일 |
| --- | --- | --- | --- |
| `pace` | 스피드 | 가속·최고속 | 뒷공간 침투, 역습, `pace_mismatch` |
| `stamina` | 체력 | 90분 유지·회복력 | 후반 전력 감쇠, 피로 축적/회복 속도, 연전 로테이션 판단 |
| `strength` | 몸싸움 | 지상 경합·홀딩 | 경합 승률, 태클 저항, 부상 저항 |
| `aerial` | 공중볼 | 점프·헤더 | 코너·크로스 공수, 세트피스 이벤트 |

### 기술 (5)

| 코드 | 표시 | 정의 | 시뮬·서사에서 하는 일 |
| --- | --- | --- | --- |
| `finishing` | 결정력 | 찬스 마무리 | 슈팅 → 골 전환 |
| `dribbling` | 드리블 | 볼 컨트롤·1대1 돌파 | 압박 탈출, 개인 찬스 창출 |
| `passing` | 패스 | 근거리 패스 정확도 | 점유 판정, 빌드업 |
| `kicking` | 킥력 | 롱패스·킥 궤적·파워 | 사이드 전환, GK 배급, 세트피스 키커, 장거리 슛 |
| `tackling` | 태클 | 볼 탈취 기술 | 수비 존 전력, 파울 확률(→ `aggression`과 곱) |

### 정신 (5)

| 코드 | 표시 | 정의 | 시뮬·서사에서 하는 일 |
| --- | --- | --- | --- |
| `vision` | 시야 | 킬패스·창의성 | 찬스 **창출**(정확도 `passing`과 분리) |
| `positioning` | 위치선정 | 오프더볼 움직임 + 수비 커버 | 찬스 발생 위치, 실점 원인 태그 |
| `composure` | 침착성 | 압박 하 판단 | 페널티, 큰 경기(더비·대항전), 리드 지키기, 실책 확률 |
| `aggression` | 적극성 | 경합에 몸을 던지는 성향 | 압박 지시 소화 강도, 파울·경고·퇴장, 라이벌전 도발 |
| `leadership` | 리더십 | 동료를 끌어올리는 힘 | 주장 적합도, 팀토크 전파율(감독 리더십 × 주장 리더십), 라커룸 이슈 억제, 어린 선수 성장 보조 |

### GK (1)

| 코드 | 표시 | 정의 | 시뮬·서사에서 하는 일 |
| --- | --- | --- | --- |
| `goalkeeping` | 골키핑 | 선방 종합 | GK 존 전력 |

GK의 개성은 이 한 축이 아니라 **공유 축과의 조합**에서 나온다 —
`aerial`(공중 장악) · `kicking`(롱킥 배급) · `passing`(발밑) ·
`composure`(압박 하 처리) · `positioning`(커맨드).

### 부속 필드

- `overall` — 파생 캐시. §2의 가중 합 (FM의 CA에 대응).
- `potential` — 성장 상한. 우리 팀 선수만 안다 (§3 노출).
- 나이는 저장하지 않고 `birthdate`에서 계산 (`ageOf`).

### 성격·히든 레이어를 두지 않는다 (결정)

FM은 Consistency·Determination·Professionalism 같은 축을 **숨겨서** 재미를
만들지만, 우리는 축을 숨기지 않는다. 같은 재미를 **§3 관측 가능성**으로 낸다 —
축은 전부 존재하고, 다만 **밖에서 알아내기 어려운 축이 있을 뿐이다**.
축이 하나뿐인 단일 진실을 유지하면 장부·서사·조회 도구가 모두 같은 값을 본다.

### 능력치 ≠ 포지션 적응도 ≠ 전술 적응도 (별개 축 3개)

혼동하기 쉬운데, 선수의 "할 수 있음"은 세 층으로 나뉘고 서로 독립이다.

| 층 | 저장 위치 | 스케일 | 뜻 | 변하는 경로 |
| --- | --- | --- | --- | --- |
| **능력치** | `GAME_PLAYER.attributes` | 15축 0~99 | 이 선수가 가진 역량 | 훈련·경기·나이 (§5) |
| **포지션 적응도** | `PLAYER_POSITION.proficiency` (+`isNatural`) | 포지션별 0~99 | **그 자리를** 얼마나 소화하는가 | 그 자리 출전·포지션 전환 훈련 |
| **전술 적응도** | `TACTIC_ASSIGNMENT.familiarity` | 0~99 (기준 60) | **이 전술 안에서의** 손발 | 전술 유지·훈련 (전술 바꾸면 리셋 압력) |

같은 15축을 가진 선수도 자리에 따라 다르게 쓰인다 — 포지션 **가중치**(§2)가
"이 자리에서 어떤 축이 중요한가"를, 포지션 **적응도**가 "그 자리에 익숙한가"를
따로 결정한다. 가중치는 자리의 성질(전 선수 공통)이고, 적응도는 선수의 이력이다.

```
zoneScore = roleFit(15축, 그 자리 가중치) × 상태보정 × profFactor(포지션 적응도)
                                                    × 팀 전술 적응도 팩터
```

적응도는 §3 안개의 대상이 아니다 — 상대 선수가 어느 자리에서 뛰는지는 출전
기록으로 드러나고(관측형에 준함), 전술 적응도는 배치된 우리 선수만 갖는 값이다.
좌우·중앙 분화만 다른 자리(CB↔RCB/LCB 등)는 적응도를 거의 공유한다
(`POSITION_CLUSTERS`).

---

## 2. 포지션 가중치 — 단일 테이블

능력치 값은 **가중치 테이블 하나를 통해서만** 전력이 된다. `overall`(종합),
`roleFit`(자리 적합도), 시뮬 존 점수가 전부 같은 소스에서 파생된다.

```
POSITION_WEIGHTS[포지션][축] → 0 ‥ 3
overall(선수)        = Σ(축값 × w) / Σ(w)     ← 주 포지션 가중치 기준
roleFit(선수, 자리)   = Σ(축값 × w) / Σ(w)     ← 그 자리 가중치 기준
zoneScore(sim)       = roleFit × 상태보정 × 포지션적응도팩터
```

같은 15개 값이 자리마다 다른 결론을 낸다 — 라이스를 DM에 두면
`tackling`·`positioning`이 3배로 잡히고, AM에 올리면 `vision`·`dribbling`이
지배한다. [POSITION_CLUSTERS](../../packages/domain/src/player.ts)(CB↔RCB/LCB
등 사실상 같은 자리)는 가중치를 공유한다.

### 포지션 지문 (초안 — `balance.md`에서 튜닝)

3=핵심 · 2=중요 · 1=보조 · 0=무관

| 자리 | 3 (핵심) | 2 (중요) | 1 (보조) |
| --- | --- | --- | --- |
| GK | goalkeeping, composure, positioning | aerial, kicking, passing | strength, leadership |
| CB | strength, aerial, tackling, positioning | pace, passing, composure, aggression | stamina, dribbling, kicking, leadership |
| LB/RB | pace, stamina | strength, dribbling, passing, kicking, tackling, positioning | aerial, vision, composure, aggression |
| DM | passing, kicking, tackling, positioning | stamina, strength, aerial, vision, composure, aggression | pace, dribbling, leadership |
| CM | passing, stamina, vision | pace, strength, dribbling, kicking, tackling, positioning, composure | aerial, finishing, aggression, leadership |
| AM | vision, dribbling, passing | pace, stamina, finishing, kicking, positioning, composure | strength, aggression |
| RW/LW | pace, dribbling | stamina, finishing, passing, vision, positioning | strength, kicking, composure, aggression |
| ST | pace, finishing, positioning, composure | strength, aerial, dribbling, stamina | passing, kicking, vision, aggression |

### 전력 가중치 ≠ 기능적 영향

`aggression`·`leadership`은 어느 자리에서도 가중치가 낮다 — **전력(overall)에는
거의 기여하지 않지만 게임에는 크게 작용한다.** 파울·퇴장, 주장 지명, 팀토크
전파, 라커룸 이슈는 가중치와 무관한 별도 경로다. FM이 세트피스 축을 CA
최하위로 두고도 경기에 쓰는 것과 같은 구조다.

---

## 3. 관측 가능성 — 히든 레이어의 대체물

지식 수준(선수 단위 **5단계** — [scouting.ts](../../packages/engine/src/scouting.ts))에
**축마다 좁힐 수 있는 한계**를 곱한다.

| 계층 | 축 | own | **adapting** | scouted | seen | rumoured |
| --- | --- | --- | --- | --- | --- | --- |
| **관측형** — 몸과 발로 실행하는 것 | pace, stamina, strength, aerial, dribbling, passing, kicking, tackling, aggression, goalkeeping | 0 | **±1** | ±1 | ±3 | ±6 |
| **분석형** — 머리와 마음으로 판단하는 것 | finishing, vision, positioning, composure, leadership | 0 | **±3** | ±3 | ±6 | ±10 |
| `potential` | — | 공개 | **공개** | 미지 | 미지 | 미지 |

종합(`overall`)은 판단 계열 축을 포함하는 합성값이므로 **분석형** 오차를 쓴다 —
종합 평가가 실행 계열보다 정확할 수는 없다.

두 가지가 이 표의 요점이다.

1. **스카우팅은 완벽하지 않다** — 관측형도 `scouted`에서 ±1이 남는다. 스카우트
   리포트는 "정답 공개"가 아니라 오차를 좁히는 행위다.
2. **분석형은 좁혀도 넓게 남는다**(±3) — 경계선은 *실행 vs 판단*이다. 패스
   성공률·파울 수는 한 경기에도 드러나지만(관측형), 결정력은 경기당 유효 슈팅이
   2~3회뿐이어서 표본이 모자라고, 위치선정·시야는 화면 밖(off-ball)에서 일어나며,
   침착성·리더십은 큰 경기와 라커룸에서만 확인된다. 그래서 "데려와 봐야 확실히
   아는 선수"가 생기고 이적이 도박이 된다 — 큰 경기에서 얼어붙는 공격수,
   라커룸을 장악하는 백업. 히든 축 없이 같은 서사가 나온다.
   (`goalkeeping`은 관측형이다 — GK는 매 경기 슛을 받으니 표본이 빨리 쌓인다.)

- 오차는 여전히 **결정적** — `(seed, playerId, 축)` 해시. 같은 질문엔 항상 같은 답.
- **표현 계층 전용** — 코어(장부·판정·전력 패킷)는 언제나 참값으로 계산한다.
- 오차가 큰 축은 숫자를 주지 않고 **밴드 라벨**로만 노출한다 (§7).
- 기존 `KNOWLEDGE_MARGIN`(seen ±3 · rumoured ±6)이 그대로 관측형 계층이 된다 —
  분석형만 새로 넓어지고, `scouted`에 ±1/±3이 추가된다.

### adapting — 영입 직후 적응 기간 (6주)

계약서에 사인해도 바로 다 알게 되지는 않는다. **우리 팀에 온 지
`ADAPTATION_DAYS`(42일) 안인 선수는 우리 선수여도 스카우트 수준의 오차가 남는다.**
지식 수준은 `TRANSFER` 원장의 마지막 영입 기록에서 파생하므로(게임 시작 스쿼드는
기록이 없어 처음부터 `own`) 별도 저장이 없다.

- 오피스 스쿼드 뷰도 이 기간엔 **추정치**를 보여준다(행에 "적응 중" 표식) —
  화면이 참값을 흘리면 안개가 무의미해진다.
- **잠재력은 공개**한다 — 메디컬·훈련 데이터는 이미 우리 것이다. 능력치는
  "경기장에서 보이는 것"이지만 성장 여력은 구단이 측정한다.
- 협상 확률·몸값은 흐리지 않는다(`ODDS_MARGIN`) — 계약 조건은 계약서에 적혀 있다.
- 코어(장부·판정·전력 패킷)는 여전히 참값으로 계산한다. 감독만 모른다.

---

## 4. 상태 (보정 계수)

| 상태 | 정의역 | 효과 초안 |
| --- | --- | --- |
| 폼 form | −3 ‥ +3 | 유효치 ±3%/단계 |
| 사기 morale | 0‥100 (기준 60) | ±0.15%/pt → 최대 약 ±6% |
| 피로 fatigue | 0‥100 | 60부터 페널티 가속, 부상 확률 가중. 축적·회복 속도는 `stamina`에 반비례 |
| 부상 | none / minor / major | 출전 불가 (minor 말기는 저성능 출전 허용 검토) |

```
유효 능력치 = base × (1 + formMod + moraleMod − fatigueMod)
```

- 계수는 밸런스 초안 — 시뮬 프로토타입에서 분포 보고 `balance.md`에서 튜닝.
- 페르소나는 이 계수에 직접 손 못 댄다 — 반드시 상태를 거친다 (overview §6).

## 5. 성장·쇠퇴 — 결정 #7: 이 경로가 전부

| 경로 | 규칙 초안 |
| --- | --- |
| 훈련 XP | 주간 포커스 배분 → 해당 축 XP (**15갈래**). **나이 계수** ≤21 ×1.5 · 22–27 ×1.0 · 28–30 ×0.5 · 31+ 0. **potential 캡** 도달 시 정지 |
| 경기 XP | 출전 시간·평점 비례 소량 (훈련의 보조) |
| 포지션 전환 | `set_training_focus`의 개인 트랙 — 포지션 적응도 상승 (능력치와 별개 트랙) |
| 시즌 경계 | 나이 +1. 축별 노화 곡선 롤 (`PRNG(worldSeed, playerId, season)`) |

### 축별 노화 곡선 — 15축 분리의 최대 수확

| 곡선 | 축 |
| --- | --- |
| 이르게 정점, 28+ 급락 | `pace`, `stamina`, `dribbling` |
| 30~32 유지 후 완만한 하락 | `strength`, `aerial`, `finishing`, `tackling`, `goalkeeping` |
| 34+까지 계속 성장 | `vision`, `positioning`, `composure`, `leadership`, `kicking`, `passing` |
| 거의 불변 (성향) | `aggression` |

"다리는 죽었지만 머리로 뛰는 베테랑"이 데이터에서 자동으로 나온다 — 6축
구조에선 만들 수 없던 커리어 서사다.

- 서사 이벤트(`apply_narrative_event`)는 **능력치 접근 불가** — 사기·폼·관계만
  (overview §7). "각성" 없음.

## 6. 부상 모델 (간이)

- **발생**: 경기(시뮬 틱 §match-sim 3-5)·훈련(daily tick) 확률, 피로 가중,
  `strength`·`stamina`가 저항.
- **규모**: minor 3~14일 / major 3~10주 (샘플 분포).
- **회복**: daily tick 감소, recovery조 지정 시 ×1.5 (→ game-loop §4-1).

## 7. 노출 규약 (결정 #2)

- **오피스 뷰**: 우리 선수는 숫자 그대로 — 15축 0~99, 폼 화살표, 피로 바,
  부상 아이콘. 타 팀 선수는 §3 오차를 반영한 관측값.
- **채팅**: GM은 숫자를 읊지 않는다. 밴드로 변환하고, 오차 큰 축은 밴드만 준다:

| 밴드 | 서술 예 |
| --- | --- |
| 90+ | "월드클래스", "리그를 씹어먹는" |
| 85–89 | "리그 최상위권" |
| 80–84 | "리그 정상급" |
| 75–79 | "준수한 주전감" |
| 70–74 | "스쿼드 자원" |
| ≤69 | "유망주" / "백업" (나이 맥락 반영) |

- **조회 도구**(`get_player`)는 15축을 그대로 쏟지 않고 **가중치 상위 축 + 특징
  축**을 요약해 돌려준다 — 컨텍스트 위생 (→ llm-io.md).
- 상대 팀 정보는 스카우트 리포트 경유 — 불확실성 서술("~로 추정") 허용.

## 8. 데이터 파이프라인

현 시드([epl-players.ts](../../packages/engine/src/data/epl-players.ts), 실선수
2,673명)는 **6축 + GK**다. 15축 중 7축은 1:1로 옮겨오고, **8축은 시드값이 없다**.

| 축 | 시드 경로 |
| --- | --- |
| `pace`·`passing`·`dribbling`·`goalkeeping` | 기존 값 그대로 |
| `finishing` ← `shooting` · `tackling` ← `defending` · `strength` ← `physical` | 이름 정리 |
| `stamina`·`aerial`·`kicking`·`vision`·`positioning`·`composure`·`aggression`·`leadership` | **① 파생 시드 → ② 실측 교체** |

- **1단계 (파생)** — 기존 축 + 포지션 + 나이에서 **결정적으로** 파생한다
  (`attributes.ts`의 `DERIVED_AXES`가 부채 목록이다). 게임 메커니즘이 데이터
  작업에 막히지 않게.
  파생값은 두 가지를 지킨다: ① 자리별 지문이 실제로 갈려야 하고(공중볼 CB 76 >
  W 48, 체력 FB 73, 시야 AM 72, 킥력 DM 71), ② **원천 축의 복사본이 아니어야**
  한다. 특히 `aggression`은 성향이므로 능력 종속을 낮게(r≈0.6) 두고 개인 편차를
  크게 잡는다 — "약하지만 거친 선수"가 나와야 축이 의미를 갖는다. `vision`도
  `passing`과 완전히 붙으면(초기 r=0.87) 라이스와 외데고르를 구분하지 못한다.
- **2단계 (실측)** — 기존 시드를 만든 방법(멀티에이전트 + 웹 교차검증)으로
  채워 파생값을 교체한다. 8축 × 2,673명이라 별도 마일스톤.
  `leadership`은 공개 소스가 가장 얇아 마지막까지 파생으로 남을 수 있다.
- 🔴 라이선스 부채는 그대로 ([ADR 0001](../decisions/0001-mvp-real-data-deferred-licensing.md),
  data-sourcing §7) — 출시 전 자체 산정 모델로 교체.

## 9. 감독 능력치 (결정 #13)

유저 캐릭터인 감독도 4축 능력치를 가진다 (0~99 — 선수와 같은 스케일).
구조는 **유저의 플레이 × 능력치 계수**: LLM은 발화·행동의 질을 판정하고,
그 효과가 능력치로 증폭·감쇠된다.

| 축 | 계수가 들어가는 공식 |
| --- | --- |
| 리더십 leadership | `team_talk`·`talk_to_player` 변화량 (→ ai-manager §3) · 선수 순응 — **주장의 선수 `leadership`과 곱해져 전파된다** |
| 전술 tactics | **전술 소화율** — TacticsSpec 보정이 시뮬 존 전력에 반영되는 강도 (→ match-sim §3) · 스카우트/분석 리포트 해상도 |
| 협상 negotiation | 거래형 판정 — 상대의 수락 문턱·역제안 폭 (이적/계약/보드 요구) |
| 미디어 media | `respond_to_media` 효과 · 평판 변동 폭 |

### 성장 — 쓰는 만큼 자란다

| XP 소스 | 축 |
| --- | --- |
| 면담·팀토크 양성 판정 | 리더십 |
| 전술 기인 이벤트 (원인 태그 `wing_overload` 등으로 득점/무실점) | 전술 |
| 협상 성사 (이적·계약·보드 합의) | 협상 |
| 미디어 대응 양성 판정 | 미디어 |

- **성공은 크게, 시도는 소량** — 실패한 팀토크도 경험은 된다.
- 변화량은 코어 공식 — LLM은 개입 불가 (overview §7 가드레일과 동일 원칙).
- 성장 곡선은 수확 체감 (낮을수록 빨리, 높을수록 느리게). 계수는 `balance.md`.
- **초기값은 유저가 직접 입력한 배경을 GM이 해석해 배분** (결정 #11) —
  자유 텍스트 배경 → 4축 배분 (합계 고정, Zod 검증). 예: "K리그에서 뛰다
  은퇴한 수비수" → 리더십·전술↑, "에이전트 출신 협상가" → 협상↑
  (→ game-loop §1).

### 노출

- 오피스(감독 프로필 카드)는 숫자 그대로, 채팅은 서술 — 결정 #2와 동일 규약.
- 성장 순간은 수치 알림 대신 서사로 연출 — *"선수단이 당신의 말에 귀
  기울이기 시작했다."* (→ narrative.md)

## 10. 미해결

- 포지션 가중치 지문·관측 오차 폭 튜닝 (→ `balance.md`, 시뮬 프로토타입 후)
- 스카우트 리포트의 **깊이** — 오래 파견하면 분석형 오차(±3)가 더 좁혀지는가
  (현재 `ScoutReport`는 완료 여부만 갖는다)
- 상태 보정 계수·성장 속도 튜닝
- 자체 능력치 산정 모델 설계 — 라이선스 부채 청산 장치. 별도 문서
  (`rating-model.md`) 승격 후보
- 감독 능력치의 상한 도달 시나리오 (모든 축 90+ 시 게임감 유지 방안)
