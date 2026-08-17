import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * 모노레포 루트를 못 박는다 — 상위 디렉터리에 다른 lockfile이 있으면 Next가
   * 그쪽을 워크스페이스 루트로 추론해 파일 트레이싱 범위를 잘못 잡는다.
   */
  outputFileTracingRoot: path.join(__dirname, "../.."),
  /**
   * 빌드 산출물 위치 — e2e는 `NEXT_DIST_DIR`로 따로 쓴다.
   * 개발 서버와 e2e 서버가 같은 `.next`를 공유하면 한쪽이 재컴파일할 때 다른 쪽이
   * 읽던 청크가 사라져(ENOENT / PageNotFoundError) 테스트가 무작위로 깨진다.
   */
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // 워크스페이스 패키지는 TS 소스를 그대로 export 하므로 Next가 트랜스파일한다
  transpilePackages: [
    "@story-fm/domain",
    "@story-fm/sim",
    "@story-fm/engine",
    "@story-fm/llm",
    "@story-fm/agents",
  ],
  /**
   * dev 표시기를 끈다 — 이 배지가 화면 왼쪽 위(20,20 · 36×36)에 떠서 topbar의
   * story-fm 로고(게임 목록으로 나가는 링크)를 덮고 클릭을 가로챈다.
   * `devIndicators.position`으로 옮겨지지 않아(15.5에서 무시됨) 끄는 편이 낫다.
   * 프로덕션 빌드에는 애초에 없는 요소다.
   */
  devIndicators: false,
  /**
   * 빌드는 검사하지 않는다 — 검사의 자리는 `pnpm typecheck`와 `pnpm lint`다.
   *
   * e2e가 CI에서 이 빌드를 물고 서므로(playwright.config.ts) 여기서 tsc와 eslint를
   * 한 번 더 돌리면 게이트가 이미 낸 값을 e2e 잡이 다시 낸다.
   *
   * ⚠️ 다만 루트 `tsconfig.json`의 include는 앱의 src 아래만 훑어, `app/`과
   * `components/`로 나뉜 이 앱을 하나도 덮지 않는다. 즉 지금 apps/web은 **어느
   * 쪽에서도** 타입 검사를 받지 않고, `tsc -p apps/web/tsconfig.json`을 직접
   * 돌리면 오류가 여덟 개 남아 있다. 그 구멍은 이 파일이 아니라 루트 include가
   * 메워야 한다.
   */
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
