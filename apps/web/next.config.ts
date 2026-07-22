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
};

export default nextConfig;
