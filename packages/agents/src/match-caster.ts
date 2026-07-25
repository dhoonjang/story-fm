import { z } from "zod";
import { MatchEventSchema, type MatchEvent, type StrengthPacket } from "@story-fm/domain";
import type { GameToolSpec } from "@story-fm/llm";

/**
 * 매치 캐스터 — 경기 장면의 GM (매치 티어). 프롬프트는 코드처럼 버전
 * 관리한다 (AGENTS.md 6-5). 규약 근거: game-overview §2.1·§4, match-sim.md.
 */
export const MATCH_CASTER_SYSTEM = `당신은 story-fm의 경기 마스터다. 축구 경기를 "이야기하면서 동시에 결정"한다 —
중계, 연출, 벤치 대화, 사건 기록이 당신의 한 턴에서 함께 나온다.

# 출력 문법 (반드시 준수)
- 화자 발화는 \`@중계:\` \`@수석코치:\` \`@손흥민:\` 으로 시작한다.
  선수 화자는 반드시 한글 이름 — id 금지.
- 화자 없는 내레이션·장면 연출은 \`@:\` 로 시작한다.
- 행동·연출은 *별표*로 감싼다. 그 외는 대사다.
- 모든 텍스트 줄은 @로 시작한다. 문법 밖 텍스트를 쓰지 마라.
- 중계·대사에서 선수는 항상 이름으로 부른다. 선수 id는 log_match_events의
  actors 입력에만 쓴다 (장부의 "id(이름)" 목록 참고).

# 경기 규칙
1. 전력 분석 패킷이 유일한 판단 근거다. 패킷에 없는 우열을 지어내지 마라.
   사건의 causes에는 패킷의 매치업·키포인트 표현을 인용하라.
2. 서사에 등장한 모든 주요 사건(골·슛·세이브·카드·교체·부상·하프타임·종료)은
   반드시 log_match_events 도구로 기록하라. 기록하지 않은 사건은 일어나지
   않은 것이다. 도구 기록과 중계 내용이 일치해야 한다.
3. 시간은 앞으로만 흐른다 — 장부의 현재 분(分) 이후만 기록할 수 있다.
4. 도구가 오류를 돌려주면 그 이유에 맞게 사건을 수정해 다시 기록하라.
5. 우위는 확률적 경향이지 확정이 아니다 — 약팀의 반란도 가능하다
   (upsetChance 참고). 단 흐름의 근거는 항상 패킷에서 찾아라.
6. 골 남발 금지 — 실제 축구의 리듬을 지켜라 (경기당 2~4골이 보통).

# 진행 방식
- 한 턴에 "다음 정지점"까지만 진행한다. 정지점: 골, 퇴장, 부상, PK,
  하프타임, 경기 종료, 흐름이 크게 바뀌는 순간.
- 정지점에서 멈추고 @수석코치의 한마디(관찰 또는 제안)로 감독에게 마이크를
  넘겨라. 다음 지시를 기다린다.
- 하프타임(45′ 이후)에는 half_time, 종료(90′ 이후)에는 full_time 이벤트를
  반드시 기록하라.
- 5~25분 단위로 유연하게 진행하고, 조용한 구간은 요약하라.

# 대화 규칙 (경기 중)
- 감독과 대화 가능한 상대: 수석코치, 벤치 선수. 그라운드 위 선수와 대화는
  불가 — 감독의 외침은 연출로만 전달된다.
- 수석코치의 조언은 패킷과 장부를 근거로 한다. 사실을 왜곡하지 않는다.
- 감독이 교체를 지시하면 substitution 이벤트(actors: [나가는 선수 id,
  들어오는 선수 id])로 기록하고, 전술 변경 의도는 이후 흐름에 반영하라.

# 언어
한국어. 국내 축구 중계의 관용 표현을 쓴다. 하이라이트 위주로 리듬감 있게.
능력치 숫자를 읊지 않는다 — "pace 88" 대신 "리그 최고 수준의 스피드"처럼
서술하라 (결정 #2). 패킷의 숫자는 판단 근거이지 대사가 아니다.`;

/** 킥오프 턴 유저 메시지 — 패킷 + 감독의 사전 지시 */
export function buildKickoffMessage(packet: StrengthPacket, managerNote?: string): string {
  const note = managerNote ? `\n\n[감독의 경기 전 지시]\n${managerNote}` : "";
  return (
    `아래 전력 분석 패킷을 근거로 경기를 시작하라. 킥오프부터 첫 정지점까지 진행한다.` +
    `\n\n[전력 분석 패킷]\n${JSON.stringify(packet, null, 2)}${note}`
  );
}

/** 진행 턴 유저 메시지 — 장부 스냅샷 + 감독 발화 */
export function buildContinueMessage(ledgerSummary: string, managerInput: string): string {
  return `${ledgerSummary}\n\n[감독]\n${managerInput}`;
}

const LogEventsInputSchema = z.object({
  events: z.array(MatchEventSchema).min(1),
});

/**
 * log_match_events 도구 — 창발형 스킬 (overview §5.2).
 * apply 콜백이 경기 장부 검증·기록을 수행한다.
 */
export function makeLogMatchEventsTool(
  apply: (events: MatchEvent[]) => { ok: boolean; message: string },
): GameToolSpec {
  return {
    name: "log_match_events",
    description:
      "경기에서 일어난 사건들을 시간순으로 장부에 기록한다. 중계에 등장한 주요 사건은 반드시 이 도구로 기록해야 한다. substitution의 actors는 [나가는 선수 id, 들어오는 선수 id].",
    inputSchema: {
      type: "object" as const,
      properties: {
        events: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              minute: { type: "integer", minimum: 0, maximum: 130 },
              type: {
                type: "string",
                enum: [
                  "kickoff",
                  "goal",
                  "shot",
                  "save",
                  "chance",
                  "foul",
                  "yellow_card",
                  "red_card",
                  "substitution",
                  "injury",
                  "half_time",
                  "full_time",
                ],
              },
              team: { type: "string", enum: ["home", "away"] },
              actors: {
                type: "array",
                items: { type: "string" },
                description: "관련 선수 id (패킷의 lineup/bench id 사용)",
              },
              causes: {
                type: "array",
                items: { type: "string" },
                description: "원인 태그 — 전력 분석 패킷의 매치업/키포인트 인용",
              },
              detail: { type: "string" },
            },
            required: ["minute", "type"],
          },
        },
      },
      required: ["events"],
    },
    handle(input: unknown) {
      const parsed = LogEventsInputSchema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(" / ");
        return { ok: false, message: `이벤트 형식 오류 — ${issues}` };
      }
      return apply(parsed.data.events);
    },
  };
}
