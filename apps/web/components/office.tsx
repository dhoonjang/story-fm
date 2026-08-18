/**
 * 장부 다섯 뷰의 배럴 — 뷰마다 파일 하나다.
 *
 * 한 경로는 한 사람이 갖는다. 다섯 뷰가 한 파일에 있으면 서로 다른 뷰를 손보는
 * 작업끼리도 순서를 기다려야 하므로, 파일 안의 구분선을 그대로 파일 경계로 옮겼다.
 * 부르는 쪽(`game-screen.tsx`)은 여기만 보면 된다.
 */
export { SquadView } from "./office/squad/squad-view";
export { CalendarView } from "./office/calendar";
export { FinanceView } from "./office/finance";
export { CompetitionsView } from "./office/competitions";
export { CareerView } from "./office/career";
