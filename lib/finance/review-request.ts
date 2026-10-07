import {z} from "zod";
import {investigationSchema} from "./investigation-schema";

const budgetSchema=z.object({
  maxQueries:z.number().int().min(1).max(12).default(6),
  maxSupportRecords:z.number().int().min(1).max(200).default(60),
  maxOutputTokens:z.number().int().min(256).max(8000).default(4000),
  maxDurationMs:z.number().int().min(5000).max(180000).default(90000),
}).strict();
export const reviewRequestSchema=z.object({
  version:z.literal(1),question:z.string().trim().min(1).max(2000),
  focus:z.string().trim().max(500).optional(),
  query:investigationSchema.refine(query=>!query.page.cursor,"A new review needs a query scope, not a live pagination cursor").optional(),
  includePlanning:z.boolean().default(false),
  output:z.enum(["answer","report"]).default("answer"),
  budget:budgetSchema.default({maxQueries:6,maxSupportRecords:60,maxOutputTokens:4000,maxDurationMs:90000}),
}).strict();
export type ReviewRequest=ReturnType<typeof resolveReviewRequest>;

const date=(day:Date)=>day.toISOString().slice(0,10);
const shifted=(value:string,days:number)=>date(new Date(Date.parse(`${value}T00:00:00Z`)+days*86400000));
function previousMonth(first:string){
  const to=shifted(first,-1);return {from:`${to.slice(0,7)}-01`,to};
}

/** Resolve dates once at creation; dispatch and retry replay this exact specification. */
export function resolveReviewRequest(input:unknown,today:string){
  const request=reviewRequestSchema.parse(input);z.iso.date().parse(today);
  const from=`${today.slice(0,7)}-01`,prior=previousMonth(from);
  const comparisonTo=`${prior.from.slice(0,7)}-${String(Math.min(Number(today.slice(8)),Number(prior.to.slice(8)))).padStart(2,"0")}`;
  return {...request,query:request.query??investigationSchema.parse({version:1,period:{from,to:today},comparison:{from:prior.from,to:comparisonTo},groupBy:["category","merchant"]})};
}

/** A cadence receipt names the next period; investigate the preceding completed period. */
export function scheduledReviewRequest(cadence:"weekly"|"monthly",periodStart:string):ReviewRequest{
  z.iso.date().parse(periodStart);
  if(cadence==="weekly"&&new Date(`${periodStart}T00:00:00Z`).getUTCDay()!==1)throw new Error("Weekly review anchor must be Monday");
  if(cadence==="monthly"&&!periodStart.endsWith("-01"))throw new Error("Monthly review anchor must be the first day");
  const period=cadence==="weekly"?{from:shifted(periodStart,-7),to:shifted(periodStart,-1)}:previousMonth(periodStart);
  const comparison=cadence==="weekly"?{from:shifted(period.from,-7),to:shifted(period.from,-1)}:previousMonth(period.from);
  return resolveReviewRequest({version:1,question:`Review the completed ${cadence} period ${period.from} through ${period.to}, compared with ${comparison.from} through ${comparison.to}.`,output:"report",query:{version:1,period,comparison,groupBy:["category","merchant"]}},periodStart);
}
