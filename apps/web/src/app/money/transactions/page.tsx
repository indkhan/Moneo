import { TransactionsView } from "@/components/TransactionsView";

export default async function MoneyTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; transactionId?: string; dateFrom?: string; dateTo?: string }>;
}) {
  const params = await searchParams;
  const transactionId = params.transactionId;
  return (
    <TransactionsView
      initialQ={typeof params.q === "string" ? params.q.slice(0, 200) : ""}
      initialDateFrom={
        typeof params.dateFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.dateFrom)
          ? params.dateFrom
          : ""
      }
      initialDateTo={
        typeof params.dateTo === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params.dateTo)
          ? params.dateTo
          : ""
      }
      initialSelectedId={
        typeof transactionId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          transactionId,
        )
          ? transactionId
          : null
      }
    />
  );
}
