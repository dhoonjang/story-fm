import { z } from "zod";
import { PlayerSchema } from "./player";

export const TeamSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    shortName: z.string().min(1),
    players: z.array(PlayerSchema).min(11),
    /** 선발 11 — players의 id를 참조 */
    startingXI: z.array(z.string()).length(11),
    bench: z.array(z.string()),
  })
  .superRefine((team, ctx) => {
    const ids = new Set(team.players.map((p) => p.id));
    for (const id of [...team.startingXI, ...team.bench]) {
      if (!ids.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `라인업의 "${id}"는 보유 선수가 아닙니다`,
        });
      }
    }
    const dup = new Set<string>();
    for (const id of [...team.startingXI, ...team.bench]) {
      if (dup.has(id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${id}"가 라인업에 중복 등재` });
      }
      dup.add(id);
    }
  });
export type Team = z.infer<typeof TeamSchema>;
