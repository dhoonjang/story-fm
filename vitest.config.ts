import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "apps/web"),
    },
  },
  test: {
    // 시뮬 코어(장부·패킷)는 LLM 없이 단위 테스트한다 (AGENTS.md 5장)
    // apps/web/test는 API 통합 테스트 (mock GM 모드)
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    /**
     * ⚠️ 시즌 완주형 테스트는 단독 20초·병렬 부하에서 그 몇 배를 쓴다 — 타임아웃
     * 실패는 전부 이 부류였고 단정 실패가 아니었다. 느린 테스트에 시간을 주는 것.
     */
    testTimeout: 120_000,
    /**
     * `pool`·`isolate`·`maxWorkers`는 손대지 않는다 — 재 봤고, 줄지 않는다.
     *
     * 이 스위트는 CPU에 묶여 있다. 잰 값(12코어 맥, `--maxWorkers=8`이 8코어
     * 러너와 같은 자리에 선다 — 로컬 185초 · CI 216초):
     *
     *   pool=forks(기본) 185초 · pool=threads 184초 — 차이가 노이즈 안이다
     *   isolate=false     199초, import CPU는 15% 줄지만 `apps/web/test/api.test.ts`가
     *                     깨진다. 카탈로그와 세이브 저장소가 모듈 전역이라 파일
     *                     사이로 샌다 — 격리를 끄면 그 전제가 무너진다
     *   maxWorkers 6/8/12/16/24 → 222/185/183/191/184초. 여덟에서 이미 평평하다
     *
     * import이 전체 CPU의 30%지만 그건 파일마다 엔진 모듈 그래프를 다시 **평가**하는
     * 비용이고, 격리를 꺼도 4%밖에 줄지 않았다.
     *
     * 가장 느린 두 파일(euro-knockout 68초 · training-plan 54초)을 쪼개는 것도 답이
     * 아니다 — 둘을 통째로 빼도 185→178초다. 꼬리가 아니라 총 CPU가 벽이라,
     * 같은 일을 파일 여럿으로 나누면 그 자리에 다른 파일이 설 뿐이다.
     */
  },
});
