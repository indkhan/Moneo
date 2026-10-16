import { z } from "zod";

export type FollowUp = { label: string; prompt?: string; href?: string };
export const planInput = z.object({
  steps: z.array(z.string().trim().min(3).max(120)).min(1).max(6),
  followUps: z.array(z.string().trim().min(3).max(120)).max(3).optional(),
}).strict();

const ANALYSIS = ["finance_investigate", "analytics_cashflow", "reviews_investigate", "finance_scenario"];
/**
 * Up to four next steps after an answer: the model's own follow-up questions
 * (text only, never actions) first, then deterministic app actions.
 */
export function chatFollowUps(message: string, toolsUsed: string[], modelPrompts: string[] = []): FollowUp[] {
  const items: FollowUp[] = modelPrompts.map(prompt => ({ label: prompt, prompt }));
  const analysed = toolsUsed.some(name => ANALYSIS.includes(name));
  if (analysed && !/merchant/i.test(message)) items.push({ label: "Break this down by merchant", prompt: `${message.slice(0, 200)} Break it down by merchant.` });
  if (analysed && !/last year|previous year/i.test(message)) items.push({ label: "Compare with the same period last year", prompt: `${message.slice(0, 200)} Compare with the same period last year.` });
  if (/\b(subscriptions?|recurring|bills?)\b/i.test(message)) items.push({ label: "Review recurring payments", href: "/money/recurring" });
  if (/\b(why|explain|what changed|unusual|anomal)/i.test(message) && !toolsUsed.includes("reviews_start")) items.push({ label: "Start a deep review", prompt: `Start a deep review: ${message.slice(0, 200)}` });
  items.push({ label: "Let the agent team dig deeper", href: "/ai/agents" });
  return [...new Map(items.map(item => [item.label.toLowerCase(), item])).values()].slice(0, 4);
}
