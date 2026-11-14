import Link from "next/link";
import { SafeForm } from "@/components/safe-form";
import { displayFormat } from "@/lib/display-format";
import type { Answered, Question } from "@/lib/organize/surfaces";
import { answerSafely, dismissSafely, undoAnswerSafely } from "./actions";
import { Action, Empty, Pick, card, primary } from "./parts";

type Options = { id: string; name: string }[];
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function NeedsYou({ questions, answered, categories, merchants, locale, timezone }: { questions: Question[]; answered: Answered[]; categories: Options; merchants: Options; locale: string; timezone: string }) {
  const { date, money } = displayFormat(locale, timezone);
  const name = (id: string | null, list: Options) => (id && list.find(item => item.id === id)?.name) || null;
  return <div className="space-y-4">
    {questions.length === 0 ? <Empty>Nothing needs you. The organizer asks here when it can&apos;t tell what a payment is.</Empty>
      : <ul aria-label="Questions" className="space-y-3">{questions.map(question => {
        const total = question.transactionIds.length, who = question.identityName ?? "Unknown payee";
        return <li key={question.id}><section aria-label={`Question about ${who}`} className={card}>
          <h2 className="font-medium">{who}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{question.question}</p>
          <p className="mt-3 text-xs text-muted-foreground">{plural(total, "row", "rows")}{question.blank < total && `, ${question.blank} still blank`}</p>
          <ul className="mt-1 divide-y divide-border text-sm">{question.rows.map(row => <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{date(row.posted_on)}</span>
            <Link href={`/money/transactions?transaction=${row.id}`} className="min-w-0 flex-1 truncate hover:underline">{row.description}</Link>
            <span className="shrink-0 font-mono">{money(row.amount_minor, row.currency_code)}</span>
            <span className="basis-full text-xs text-muted-foreground sm:basis-auto">{name(row.category_id, categories) ?? "No category"}</span>
          </li>)}</ul>
          {total > question.rows.length && <p className="mt-1 text-xs text-muted-foreground">and {total - question.rows.length} more</p>}
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            {question.identityId ? <SafeForm action={answerSafely} className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <input type="hidden" name="question" value={question.id} /><input type="hidden" name="identity" value={question.identityId} />
              <Pick name="category" label={`Category for ${who}`} options={categories} empty="Choose a category" />
              <Pick name="merchant" label={`Merchant for ${who}`} options={merchants} empty="No merchant" />
              <button aria-label={`Label the rows of ${who}`} className={primary}>Label {plural(total, "row", "rows")}</button>
            </SafeForm> : <p className="text-sm text-muted-foreground">These rows have no payee yet. Set their category in <Link href="/money/transactions?category=none" className="underline">Transactions</Link>.</p>}
            <Action action={dismissSafely} fields={[["question", question.id]]} label="Dismiss" name={`Dismiss the question about ${who}`} />
          </div>
        </section></li>;
      })}</ul>}
    {answered.length > 0 && <section aria-label="Recently answered" className="space-y-2">
      <h2 className="text-sm font-medium">Recently answered</h2>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card text-sm">{answered.map(item => <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
        <span className="min-w-0 flex-1">{item.identityName ?? item.question}<span className="text-muted-foreground"> · {plural(item.applied, "row", "rows")} labelled</span></span>
        <Action action={undoAnswerSafely} fields={[["batch", item.batchId]]} label="Undo" name={`Undo the answer for ${item.identityName ?? item.question}`} />
      </li>)}</ul>
      <p className="text-xs text-muted-foreground">Undo takes back the labels. What you said the payee is stays in Memory until you remove it.</p>
    </section>}
  </div>;
}

