import {describe,expect,it} from "vitest";
import {resolveReviewRequest,scheduledReviewRequest,reviewRequestSchema} from "./review-request";

describe("question-driven review requests",()=>{
  it("retains explicit planning decisions with strict read-only bounded inputs", () => {
    const input = {version: 1, question: "Compare this goal and scenario", planningViews: [{view: "goals", goalIds: ["11111111-1111-4111-8111-111111111111"]}, {view: "forecast", input: {horizonDays: 7, scenarioId: "22222222-2222-4222-8222-222222222222"}}]};
    const request = resolveReviewRequest(input, "2026-10-07");
    expect(request.includePlanning).toBe(true);
    expect(request.planningViews).toEqual(input.planningViews);
    expect(resolveReviewRequest(request, "2026-11-01")).toEqual(request);
    expect(reviewRequestSchema.safeParse({...input, planningViews: [{view: "forecast", input: {horizonDays: 366}}]}).success).toBe(false);
    expect(reviewRequestSchema.safeParse({...input, planningViews: [{view: "forecast", input: {mutate: true}}]}).success).toBe(false);
    expect(reviewRequestSchema.safeParse({...input, planningViews: Array(4).fill(input.planningViews[0])}).success).toBe(false);
  });
  it("retains bounded visible context across dispatch without treating it as financial evidence",()=>{
    const input = {version: 1, question: "Explain the selected spending change", context: {page: "/money/investigations", selection: {accountId: "11111111-1111-4111-8111-111111111111", period: "September"}}};
    const frozen = resolveReviewRequest(input, "2026-10-07");
    expect(frozen.context).toEqual(input.context);
    expect(resolveReviewRequest(frozen, "2026-11-01")).toEqual(frozen);
    expect(reviewRequestSchema.safeParse({...input, context: {page: "x".repeat(2001)}}).success).toBe(false);
  });
  it("freezes a chosen question, exact periods, focus and owned query context",()=>{
    const input={version:1,question:"Compare grocery spending in September excluding the trip",focus:"Groceries",query:{version:1,period:{from:"2026-09-01",to:"2026-09-30"},comparison:{from:"2026-08-01",to:"2026-08-31"},accounts:{include:[{id:"11111111-1111-4111-8111-111111111111"}]},events:{exclude:["Trip"]},groupBy:["merchant"]}};
    const request=resolveReviewRequest(input,"2026-10-07");
    expect(request.question).toBe(input.question);expect(request.focus).toBe("Groceries");expect(request.query).toMatchObject(input.query);
    expect(resolveReviewRequest(request,"2026-11-07")).toEqual(request);
    expect(request.budget).toEqual({maxQueries:6,maxSupportRecords:60,maxOutputTokens:4000,maxDurationMs:90000});
    expect(request.output).toBe("answer");
  });
  it("uses the selected calendar month with an equal immediately preceding comparison by default",()=>{
    const request=resolveReviewRequest({version:1,question:"Review my finances and focus on subscriptions",focus:"Subscriptions"},"2026-10-07");
    expect(request.query.period).toEqual({from:"2026-10-01",to:"2026-10-07"});
    expect(request.query.comparison).toEqual({from:"2026-09-01",to:"2026-09-07"});
  });
  it("rejects invalid queries, excessive budgets and unknown mutation/output options",()=>{
    for(const input of [
      {version:1,question:""},
      {version:1,question:"Review",budget:{maxQueries:1000}},
      {version:1,question:"Review",query:{version:1,period:{from:"2026-02-30",to:"2026-03-01"}}},
      {version:1,question:"Review",output:"artifact"},
      {version:1,question:"Review",mutate:true},
    ])expect(reviewRequestSchema.safeParse(input).success).toBe(false);
  });
  it("weekly and monthly schedules review their previous complete periods rather than a rolling90day window",()=>{
    const weekly=scheduledReviewRequest("weekly","2026-10-05");
    expect(weekly.query.period).toEqual({from:"2026-09-28",to:"2026-10-04"});
    expect(weekly.query.comparison).toEqual({from:"2026-09-21",to:"2026-09-27"});
    const monthly=scheduledReviewRequest("monthly","2026-10-01");
    expect(monthly.query.period).toEqual({from:"2026-09-01",to:"2026-09-30"});
    expect(monthly.query.comparison).toEqual({from:"2026-08-01",to:"2026-08-31"});
    expect(monthly.output).toBe("report");
  });
  it("rejects malformed cadence anchors instead of labelling partial periods complete",()=>{
    expect(()=>scheduledReviewRequest("weekly","2026-10-07")).toThrow(/Monday/);
    expect(()=>scheduledReviewRequest("monthly","2026-10-15")).toThrow(/first day/);
  });
});
