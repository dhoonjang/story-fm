import { roleFit, type AxisValues } from "@story-fm/domain";
import type { OfficeViews } from "@story-fm/engine";

type SquadRow = OfficeViews["squad"]["players"][number];

/**
 * **이 자리·역할에서 내는 전력 — 명단·전술판·선발 평균이 같은 함수를 쓴다.**
 *
 * 규칙은 하나다: **관측된 축에서 `roleFit`을 내고 관측 오프셋을 얹는다.**
 * 서버도 같은 함수 꼴(`observedFit`)로 계산하므로 어디서 재도 같은 값이 나온다.
 *
 * ⚠️ 예전엔 서버가 **값마다 따로** 안개를 씌워 내려보냈다(`overall`에 한 번,
 * 자리별 전력에 또 한 번). 그러면 화면은 참값이 없어 같은 규칙을 재현할 수 없고,
 * 자리를 옮겨 보려면 "서버 값에 차이만 얹는" 보정을 해야 했다 — 그 보정이 명단과
 * 전술판에서 갈려 같은 선수의 OVR이 두 숫자로 보였다. 특히 예비 선수를 판에
 * 끌어 넣으면 기준점이 없어 명단은 종합값에 눌러앉았다.
 *
 * 지금은 안개가 **축에만** 있고(`AxisValues`가 이미 관측값이다) 합성값은 전부
 * 거기서 파생된다. 자리를 어떻게 옮겨도 서로 어긋날 수 없다.
 *
 * @param code 서 있는 자리 — 배치 밖이면 null
 * @param role 그 자리의 세부 역할 (아직 저장되지 않은 선택까지 포함한다)
 */
export function slotOverallOf(
  p: SquadRow,
  code: string | null,
  role: string | undefined,
): number | null {
  if (!code) return null;
  const axes = p as unknown as AxisValues;
  return clampRating(roleFit(axes, code, role) + p.observation.overallOffset);
}

const clampRating = (value: number) => Math.max(1, Math.min(99, Math.round(value)));
