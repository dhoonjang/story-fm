import path from "node:path";
import type { NextConfig } from "next";

/**
 * dev 서버를 로컬 밖에서 열 때 — 터널이나 같은 LAN의 다른 기기 — Next는 `/_next/*`
 * 요청의 Origin을 이 목록과 대조한다.
 *
 * ⚠️ 목록이 **없으면** 경고만 하고 통과시키지만, 두는 순간 목록에 없는 오리진은
 * 403이 된다. 그래서 여기엔 실제로 쓰는 통로가 다 들어 있어야 한다 — 하나가 빠지면
 * 그 통로로 들어온 브라우저의 HMR 소켓이 끊긴다. (`localhost`는 Next가 이미 넣는다.)
 */
const DEV_ORIGINS = [
  "127.0.0.1",
  "*.local", // Bonjour — `my-mac.local:3000`
  "10.*.*.*",
  "172.*.*.*",
  "192.168.*.*",
  "*.trycloudflare.com",
];

/** 그 밖의 통로 — `ALLOWED_DEV_ORIGINS=a.example.com,b.example.com pnpm dev` */
const extraDevOrigins = (process.env.ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  allowedDevOrigins: [...DEV_ORIGINS, ...extraDevOrigins],
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
};

export default nextConfig;
