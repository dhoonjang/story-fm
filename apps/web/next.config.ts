import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
};

export default nextConfig;
