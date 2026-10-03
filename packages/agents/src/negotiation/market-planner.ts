import { z } from "zod";
import { BoardReviewSchema, OpenNegotiationSchema } from "@story-fm/domain";
import { toToolSchema } from "../common/tool-schema";

export const MarketPlanSchema = z
  .object({
    clubs: z
      .array(
        z.object({ teamId: z.string().min(1), plan: z.string().trim().min(1).max(2000) }).strict(),
      )
      .max(4),
    negotiations: z.array(OpenNegotiationSchema).max(8),
    board: z.array(BoardReviewSchema).max(4),
  })
  .strict();
export const MARKET_PLAN_INPUT = toToolSchema(MarketPlanSchema);
export const MARKET_PLANNER_SYSTEM = `당신은 살아 있는 축구 세계의 구단 의사결정 담당이다. 검토 대상으로 온 구단만 판단한다. 제공된 현재 명단·포지션·부상·계약·자금·미래 지급 의무·현재 감독·실제 감독 후보·경기 결과와 이전 구단 계획을 읽는다.
clubs에는 검토한 모든 구단의 보강·매각·재계약 계획과 이유를 짧게 쓴다. negotiations에는 계획에 필요한 실제 선수와 영입 구단을 골라 협상 시작을 제출한다. 재계약은 자기 소속 선수, 자유계약은 무소속 선수, 이적은 다른 구단 선수다. 중복 협상은 만들지 않는다. 영입 구단의 진행 중인 협상·서명 후 합류 대기·완료 후 등록 대기는 합쳐 두 건을 넘지 않게 계획한다. 필요가 없으면 빈 배열이다. 선수의 포지션·능력·현재 출전 가능 여부·계약 만료·급여·구단의 예산과 실제 대안을 함께 고려한다. registration의 실제 명단 자리·홈그로운·포지션 제한을 읽고 등록할 수 없는 영입을 쌓지 않는다. 실제 transferListing의 명단 등록과 askingPrice는 매각 의향과 희망 가격이며 동의나 거래 확정이 아니다. 보강 필요와 실제 대안에 맞는 명단 선수를 고려한다. 가격·수락은 이 모델이 확정하지 않고 해당 건의 협상 GM이 당사자를 연기한다.
유저 구단의 영입·재계약을 대신 시작하지 않는다. 다른 구단이 유저 선수에게 접근할 수는 있으나 유저 구단 동의와 서명은 직접 조작이다. 부상이나 재정을 생성하지 않는다.
board에는 명확한 성적·기대·재정·인물 맥락으로 실제 경질 또는 공석 선임이 필요할 때만 고용 결정을 제출한다. 선임은 제공된 실제 감독 후보에서 고른다. 유저 감독의 경질도 같은 근거가 있어야 한다. 경질과 후임 선임은 서로 다른 검토다. 요약은 동의·서명을 대신하지 않는다. 과거 날짜의 사건을 새로 작성하지 않는다.`;
