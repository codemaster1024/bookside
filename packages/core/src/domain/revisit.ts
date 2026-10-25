import type { QuestionStatus } from "../db/schema.ts";

/** 回访间隔（天）：第 n 次回访用第 n 个，超出后一直用最后一个。 */
export const REVISIT_INTERVAL_DAYS = [3, 7, 21, 60] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 参与回访的问题状态。 */
export function isRevisited(status: QuestionStatus): boolean {
  return status === "unexplored" || status === "exploring" || status === "tentative";
}

export function nextRevisitAt(step: number, now: Date): Date {
  const days = REVISIT_INTERVAL_DAYS[Math.min(step, REVISIT_INTERVAL_DAYS.length - 1)]!;
  return new Date(now.getTime() + days * DAY_MS);
}
