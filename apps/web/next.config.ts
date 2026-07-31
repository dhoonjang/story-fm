import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
