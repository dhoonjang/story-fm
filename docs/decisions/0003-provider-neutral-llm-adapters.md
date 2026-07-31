# 0003. LLM 입력은 공통 계약으로, 원형 대화 이력은 제공자별로 보존

- 상태: 채택
- 날짜: 2026-07-28

## 맥락

프로토타입의 `GameLLM` 인터페이스가 `Anthropic.MessageParam`과
`Anthropic.Tool.InputSchema`를 직접 노출했다. 프롬프트·레퍼런스·이력·현재
턴이라는 논리 구조는 다른 모델에도 적용할 수 있었지만, 모델 ID만 Gemini로
바꾸면 타입·함수 호출·캐시·대화 이력이 모두 깨지는 상태였다.

특히 Gemini 3 계열은 함수 호출 응답에 포함된 thought signature와 call id를
후속 요청에 원형 그대로 돌려줘야 한다. 반대로 이를 억지로 하나의 공통 메시지
포맷으로 평탄화하면 제공자 고유의 재개 정보를 잃는다.

## 결정

1. `GameLLM`은 제공자 중립 `JsonObjectSchema`, 텍스트 이력,
   `StoredLlmHistory`만 노출한다.
2. 원형 이력은 `{version, provider, model, messages}`로 태깅해 저장하며
   `messages`는 어댑터 밖에서 해석하지 않는다.
3. `createGameLLM`이 설정을 보고 Anthropic/Gemini 어댑터를 생성한다.
   agents와 CLI는 구체 SDK를 import하지 않는다.
4. 유저에게 모델 선택 UI는 제공하지 않는다. 코드 기본값은 Anthropic이고
   배포 환경의 `LLM_PROVIDER=google`로 전체 티어를 Gemini로 전환한다.
5. 휘발 상태 스냅샷은 제공자별 채널로 주입하되 반환 이력에서는 반드시 제거한다.
6. 진행 중 경기의 저장 provider/model이 현재 설정과 다르면 원형 이력은 섞지
   않는다. 경기 장부와 전력 패킷으로 재개하고 대화 이력만 새로 시작한다.

## 근거 / 대안

- **하나의 완전 공통 메시지 포맷**은 단순하지만 Anthropic thinking 블록과
  Gemini thought signature를 손실 없이 표현하고 재전송하기 어렵다.
- **서버 측 interaction id만 저장**하면 구현은 간단하지만 외부 보존 기간과
  서비스 상태에 장기 세이브가 종속된다. 게임 세이브가 직접 원형 이력을
  소유하는 방식을 택했다.
- **제공자별 오케스트레이터 복제**는 프롬프트·스킬·장부 로직이 갈라져 동작
  차이를 만든다. 차이는 어댑터 경계에만 둔다.

## 영향

- Anthropic의 명시 캐시 경계와 Gemini의 implicit cache는 서로 다른 구현으로
  남지만, 안정도 순 프리픽스라는 입력 원칙은 공유한다.
- 새 제공자는 공통 도구·턴 계약을 구현하고 factory/config에 한 분기만 추가하면
  된다.
- 태그 도입 전 `unknown[]` 경기 이력은 Anthropic 레거시로 계속 읽는다.
- 모델을 바꾼 직후 진행 중 경기에서는 이전 캐스터의 문장 맥락이 사라질 수
  있지만 점수·시간·사건·라인업 등 결정적 장부는 유지된다.
