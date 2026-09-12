import { AccountsView } from "@/components/AccountsView";

export default function MoneyAccountsPage() {
  return (
    <section aria-labelledby="accounts-heading" style={{ display: "grid", gap: 16 }}>
      <h1 id="accounts-heading" style={{ margin: 0, fontSize: 24 }}>
        Accounts
      </h1>
      <AccountsView />
    </section>
  );
}
