import { useEffect, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions as useNativeWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { CsvImporter } from "@/components/csv-importer";
import { useFinanceData } from "@/components/finance-data-provider";
import { navigationItems } from "@/lib/navigation.mjs";
import { dashboardHeader } from "@/lib/dashboard-header";
import {
  hydrationSafeWebWidth,
  isDesktopLayout,
} from "@/lib/responsive-layout";
import {
  formatMinorMoney,
  recentTransactions,
} from "@/lib/finance-transactions.mjs";
import {
  latestBalanceByAccount,
  summarizeByCurrency,
} from "@/lib/finance-summary.mjs";
import {
  categorizeTransaction,
  counterpartyKeyFor,
  MONEO_CATEGORIES,
} from "@/lib/transaction-categorization.mjs";
import {
  applyCategoryRule,
  setTransactionCategory,
} from "@/lib/transaction-store.mjs";
import type { MoneoTransaction } from "@/lib/transaction-types";

type Page =
  | "index"
  | "transactions"
  | "budgets"
  | "investments"
  | "recurring"
  | "ai";

const C = {
  bg: "#fafbf8",
  card: "#ffffff",
  ink: "#243c34",
  muted: "#79877f",
  line: "#e5e9e4",
  teal: "#438f7a",
  tealSoft: "#e7f4ed",
  red: "#bd5b4d",
};

function useWindowDimensions() {
  const dimensions = useNativeWindowDimensions();
  const [webWidth, setWebWidth] = useState(0);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const syncWidth = () =>
      setWebWidth(document.documentElement.clientWidth || window.innerWidth);
    syncWidth();
    window.addEventListener("resize", syncWidth);
    return () => window.removeEventListener("resize", syncWidth);
  }, []);
  return {
    ...dimensions,
    width:
      Platform.OS === "web"
        ? hydrationSafeWebWidth(webWidth)
        : dimensions.width,
  };
}

function Panel({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: object;
}) {
  return <View style={[styles.panel, style]}>{children}</View>;
}

function Title({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={styles.panelTitle}>
      <Text style={styles.panelHeading}>{title}</Text>
      {hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

function maskIdentifier(identifier?: string) {
  if (!identifier) return undefined;
  return identifier.length > 8
    ? `${identifier.slice(0, 4)}••••${identifier.slice(-4)}`
    : identifier;
}

const categoryGroups = MONEO_CATEGORIES as {
  id: string;
  label: string;
  categories: { id: string; label: string }[];
}[];
const categoryOptions = categoryGroups.flatMap((group) => group.categories);

function categoryLabel(categoryId?: string) {
  return categoryOptions.find((category) => category.id === categoryId)?.label ?? "Needs category";
}

function Transactions({ limit }: { limit?: number }) {
  const { data, database, refresh } = useFinanceData();
  const [selectedId, setSelectedId] = useState<string>();
  const [needsOnly, setNeedsOnly] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [chosenCategoryId, setChosenCategoryId] = useState<string>();
  const [scope, setScope] = useState<"one" | "all">("one");
  const unmatchedCount = data.transactions.filter((transaction) => !transaction.category).length;
  const ordered = recentTransactions(
    data.transactions,
  ) as MoneoTransaction[];
  const transactions = (needsOnly ? ordered.filter((transaction) => !transaction.category) : ordered)
    .slice(0, limit ?? ordered.length);

  const beginCategoryChange = (transaction: MoneoTransaction) => {
    const decision = categorizeTransaction(transaction, data.categoryRules);
    setEditingId(transaction.id);
    setChosenCategoryId(transaction.category?.categoryId ?? (decision.status === "suggested" ? decision.categoryId : undefined));
    setScope("one");
  };

  const saveCategory = async (transaction: MoneoTransaction) => {
    if (!database || !chosenCategoryId) return;
    if (scope === "all") {
      const counterpartyKey = counterpartyKeyFor(transaction);
      const existing = data.categoryRules.find((rule) => rule.counterpartyKey === counterpartyKey);
      const rule = {
        id: existing?.id ?? crypto.randomUUID(),
        counterpartyKey,
        categoryId: chosenCategoryId,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      };
      await applyCategoryRule(
        database,
        rule,
        data.transactions.filter((item) => counterpartyKeyFor(item) === counterpartyKey).map((item) => item.id),
      );
    } else {
      await setTransactionCategory(database, transaction.id, {
        categoryId: chosenCategoryId,
        method: "manual",
        classifierVersion: "moneo-category-v1",
        evidence: ["Chosen by you"],
      });
    }
    await refresh();
    setEditingId(undefined);
  };

  return (
    <Panel style={styles.flexPanel}>
      <Title
        title="Transactions"
        hint={
          transactions.length
            ? `${data.transactions.length} stored locally \u00b7 ${unmatchedCount} need${unmatchedCount === 1 ? "s" : ""} category`
            : "No bank data imported"
        }
      />
      {unmatchedCount > 0 && (
        <Pressable style={styles.filterToggle} onPress={() => setNeedsOnly(!needsOnly)}>
          <Text style={styles.filterToggleText}>{needsOnly ? "Show all" : "Show needs category"}</Text>
        </Pressable>
      )}
      {!transactions.length && (
        <Text style={styles.emptyText}>
          Import a bank CSV to see exact transactions here.
        </Text>
      )}
      {transactions.map((transaction) => {
        const account = data.accounts.find(
          (item) => item.id === transaction.accountId,
        );
        const selected = selectedId === transaction.id;
        return (
          <View key={transaction.id}>
            <Pressable
              onPress={() =>
                setSelectedId(selected ? undefined : transaction.id)
              }
              style={styles.transaction}
            >
              <View style={styles.merchant}>
                <Text style={styles.merchantText}>
                  {transaction.title.slice(0, 2).toUpperCase()}
                </Text>
              </View>
              <View style={styles.grow}>
                <Text style={styles.rowTitle}>{transaction.title}</Text>
                <View style={styles.categoryLine}>
                  <Text style={[styles.categoryBadge, !transaction.category && styles.needsBadge]}>
                    {categoryLabel(transaction.category?.categoryId)}
                  </Text>
                  {!transaction.category && (() => {
                    const decision = categorizeTransaction(transaction, data.categoryRules);
                    return decision.status === "suggested" ? (
                      <Text style={styles.suggestion}>Suggested: {categoryLabel(decision.categoryId)}</Text>
                    ) : null;
                  })()}
                </View>
                <Text style={styles.hint} numberOfLines={1}>
                  {transaction.transactionType || "Bank transaction"}
                  {account ? ` · ${account.displayName}` : ""}
                </Text>
              </View>
              <View>
                <Text
                  style={[
                    styles.amount,
                    !transaction.amountMinor.startsWith("-") &&
                      styles.positive,
                  ]}
                >
                  {formatMinorMoney(
                    transaction.amountMinor,
                    transaction.currency,
                    transaction.currencyMinorUnit,
                  )}
                </Text>
                <Text style={[styles.hint, styles.right]}>
                  {transaction.bookingDate.split("-").reverse().join(".")}
                </Text>
              </View>
            </Pressable>
            {selected && (
              <View style={styles.transactionDetail}>
                <View style={styles.categoryDetailHead}>
                  <View style={styles.grow}>
                    <Text style={styles.detailLabel}>Moneo category</Text>
                    <Text style={styles.detailValue}>{categoryLabel(transaction.category?.categoryId)}</Text>
                    {transaction.category && (
                      <Text style={styles.hint}>
                        {transaction.category.method === "built-in" ? "Automatic" : transaction.category.method === "user-rule" ? "Personal rule" : "Manual"}
                        {transaction.category.evidence.length ? ` \u00b7 ${transaction.category.evidence.join("; ")}` : ""}
                      </Text>
                    )}
                  </View>
                  <Pressable style={styles.smallButton} onPress={() => beginCategoryChange(transaction)}>
                    <Text style={styles.smallButtonText}>Change category</Text>
                  </Pressable>
                </View>
                {editingId === transaction.id && (
                  <View style={styles.categoryPicker}>
                    {categoryGroups.filter((group) => group.categories.length).map((group) => (
                      <View key={group.id} style={styles.categoryGroup}>
                        <Text style={styles.detailLabel}>{group.label}</Text>
                        <View style={styles.categoryChoices}>
                          {group.categories.map((category) => (
                            <Pressable
                              key={category.id}
                              style={[styles.categoryChoice, chosenCategoryId === category.id && styles.categoryChoiceActive]}
                              onPress={() => setChosenCategoryId(category.id)}
                            >
                              <Text style={styles.categoryChoiceText}>{category.label}</Text>
                            </Pressable>
                          ))}
                        </View>
                      </View>
                    ))}
                    <View style={styles.scopeRow}>
                      <Pressable style={[styles.scopeChoice, scope === "one" && styles.scopeChoiceActive]} onPress={() => setScope("one")}>
                        <Text style={styles.categoryChoiceText}>This transaction only</Text>
                      </Pressable>
                      <Pressable style={[styles.scopeChoice, scope === "all" && styles.scopeChoiceActive]} onPress={() => setScope("all")}>
                        <Text style={styles.categoryChoiceText}>All from {transaction.recipient || transaction.sender || transaction.title}</Text>
                      </Pressable>
                    </View>
                    <View style={styles.pickerActions}>
                      <Pressable style={styles.smallButton} onPress={() => setEditingId(undefined)}>
                        <Text style={styles.smallButtonText}>Cancel</Text>
                      </Pressable>
                      <Pressable style={[styles.smallButton, styles.saveButton]} onPress={() => saveCategory(transaction)}>
                        <Text style={[styles.smallButtonText, styles.saveButtonText]}>Save</Text>
                      </Pressable>
                    </View>
                  </View>
                )}
                <Text style={styles.detailLabel}>
                  Original bank description
                </Text>
                <Text style={styles.detailValue}>{transaction.description}</Text>
                <View style={styles.detailGrid}>
                  {transaction.valueDate && (
                    <View style={styles.detailItem}>
                      <Text style={styles.detailLabel}>Value date</Text>
                      <Text style={styles.detailValue}>
                        {transaction.valueDate}
                      </Text>
                    </View>
                  )}
                  {transaction.sender && (
                    <View style={styles.detailItem}>
                      <Text style={styles.detailLabel}>Sender</Text>
                      <Text style={styles.detailValue}>
                        {transaction.sender}
                      </Text>
                    </View>
                  )}
                  {transaction.recipient && (
                    <View style={styles.detailItem}>
                      <Text style={styles.detailLabel}>Recipient</Text>
                      <Text style={styles.detailValue}>
                        {transaction.recipient}
                      </Text>
                    </View>
                  )}
                  {transaction.bankCategory && (
                    <View style={styles.detailItem}>
                      <Text style={styles.detailLabel}>
                        Bank category (source)
                      </Text>
                      <Text style={styles.detailValue}>
                        {transaction.bankCategory}
                      </Text>
                    </View>
                  )}
                </View>
                {transaction.references.map((reference) => (
                  <View
                    key={`${reference.type}-${reference.value}`}
                    style={styles.referenceRow}
                  >
                    <Text style={styles.detailLabel}>{reference.type}</Text>
                    <Text selectable style={[styles.detailValue, styles.grow]}>
                      {reference.value}
                    </Text>
                  </View>
                ))}
                <Text style={styles.detailLabel}>Original CSV fields</Text>
                {Object.entries(transaction.source.rawRecord)
                  .filter(([, value]) => value)
                  .map(([field, value]) => (
                    <View key={field} style={styles.rawRow}>
                      <Text style={styles.rawField}>{field}</Text>
                      <Text selectable style={[styles.detailValue, styles.grow]}>
                        {value}
                      </Text>
                    </View>
                  ))}
                <Text style={styles.sourceText}>
                  Source: {transaction.source.fileName} · row {transaction.source.rowNumber}
                </Text>
              </View>
            )}
          </View>
        );
      })}
    </Panel>
  );
}

function CashFlow() {
  const { data } = useFinanceData();
  const summaries = summarizeByCurrency(data.transactions) as {
    currency: string;
    currencyMinorUnit: number;
    incomeMinor: string;
    outflowMinor: string;
    netMinor: string;
    count: number;
  }[];
  const ordered = recentTransactions(data.transactions) as MoneoTransaction[];
  const firstDate = ordered.at(-1)?.bookingDate;
  const lastDate = ordered[0]?.bookingDate;

  return (
    <Panel>
      <Title
        title="Cash flow"
        hint={
          firstDate && lastDate
            ? `${firstDate} to ${lastDate} · no currency conversion`
            : "Waiting for imported transactions"
        }
      />
      {!summaries.length && (
        <Text style={styles.emptyText}>
          Income and outflow will be calculated per currency.
        </Text>
      )}
      {summaries.map((summary) => (
        <View key={summary.currency} style={styles.cashFlowBlock}>
          <View style={styles.currencyHead}>
            <Text style={styles.currency}>{summary.currency}</Text>
            <Text style={styles.hint}>{summary.count} transactions</Text>
          </View>
          <View style={styles.metricGrid}>
            <View style={styles.metric}>
              <Text style={styles.metricLabel}>Income</Text>
              <Text style={[styles.metricValue, styles.positive]}>
                {formatMinorMoney(
                  summary.incomeMinor,
                  summary.currency,
                  summary.currencyMinorUnit,
                )}
              </Text>
            </View>
            <View style={styles.metric}>
              <Text style={styles.metricLabel}>Outflow</Text>
              <Text style={styles.metricValue}>
                {formatMinorMoney(
                  `-${summary.outflowMinor}`,
                  summary.currency,
                  summary.currencyMinorUnit,
                )}
              </Text>
            </View>
            <View style={styles.metric}>
              <Text style={styles.metricLabel}>Net flow</Text>
              <Text
                style={[
                  styles.metricValue,
                  !summary.netMinor.startsWith("-") && styles.positive,
                ]}
              >
                {formatMinorMoney(
                  summary.netMinor,
                  summary.currency,
                  summary.currencyMinorUnit,
                )}
              </Text>
            </View>
          </View>
        </View>
      ))}
    </Panel>
  );
}

function Accounts() {
  const { data } = useFinanceData();
  const balances = latestBalanceByAccount(data.transactions) as Record<
    string,
    {
      amountMinor: string;
      currency: string;
      currencyMinorUnit: number;
      bookingDate: string;
    }
  >;

  return (
    <Panel>
      <Title
        title="Accounts"
        hint={`${data.accounts.length} local account${data.accounts.length === 1 ? "" : "s"}`}
      />
      {!data.accounts.length && (
        <Text style={styles.emptyText}>
          Accounts are created from recognized CSV identifiers or your mapping.
        </Text>
      )}
      {data.accounts.map((account) => {
        const balance = balances[account.id];
        const count = data.transactions.filter(
          (transaction) => transaction.accountId === account.id,
        ).length;
        return (
          <View key={account.id} style={styles.accountRow}>
            <View style={styles.accountMark}>
              <Text style={styles.accountMarkText}>
                {account.institution.slice(0, 2).toUpperCase()}
              </Text>
            </View>
            <View style={styles.grow}>
              <Text style={styles.rowTitle}>{account.displayName}</Text>
              <Text style={styles.hint}>
                {account.institution}
                {maskIdentifier(account.identifier)
                  ? ` · ${maskIdentifier(account.identifier)}`
                  : ""}
                {` · ${count} transactions`}
              </Text>
            </View>
            <View>
              {balance ? (
                <>
                  <Text style={styles.amount}>
                    {formatMinorMoney(
                      balance.amountMinor,
                      balance.currency,
                      balance.currencyMinorUnit,
                    ).replace(/^\+/, "")}
                  </Text>
                  <Text style={[styles.hint, styles.right]}>
                    Source balance · {balance.bookingDate}
                  </Text>
                </>
              ) : (
                <Text style={[styles.hint, styles.right]}>
                  Balance not provided by CSV
                </Text>
              )}
            </View>
          </View>
        );
      })}
    </Panel>
  );
}

function Deferred({ title, text }: { title: string; text: string }) {
  return (
    <Panel>
      <Title title={title} hint="Not calculated from the current CSV model" />
      <Text style={styles.deferredText}>{text}</Text>
      <Text style={styles.deferredFoot}>
        No sample or inferred financial data is shown here.
      </Text>
    </Panel>
  );
}

export function FinanceWorkspace({ page }: { page: Page }) {
  const router = useRouter();
  const { data } = useFinanceData();
  const { width } = useWindowDimensions();
  const desktop = isDesktopLayout(width);
  const nav = (route: string) =>
    router.push(`/${route === "index" ? "" : route}` as never);
  const dashboardHeading = dashboardHeader(new Date(), "en-GB");

  const titles: Record<Page, [string, string]> = {
    index: [dashboardHeading.title, dashboardHeading.subtitle],
    transactions: [
      "Transactions",
      data.transactions.length
        ? `${data.transactions.length} stored locally across ${data.accounts.length} account${data.accounts.length === 1 ? "" : "s"}`
        : "Import a bank CSV to begin",
    ],
    budgets: ["Budgets", "Waiting for Moneo category assignment"],
    investments: ["Investments", "Not available from bank transaction CSVs"],
    recurring: ["Recurring payments", "Detection is not part of normalization"],
    ai: ["AI Workspace", "No AI integration is connected"],
  };

  const pageContent =
    page === "index" ? (
      <View style={[styles.dashboardGrid, !desktop && styles.mobileStack]}>
        <View style={styles.mainColumn}>
          <CashFlow />
          <Transactions limit={8} />
        </View>
        <View style={styles.sideColumn}>
          <Accounts />
        </View>
      </View>
    ) : page === "transactions" ? (
      <Transactions />
    ) : page === "budgets" ? (
      <Deferred
        title="Budgets"
        text="Budgets need Moneo transaction categories. Category assignment is deliberately deferred until raw and normalized imports are proven reliable."
      />
    ) : page === "recurring" ? (
      <Deferred
        title="Recurring payments"
        text="Recurring detection needs a separate, tested model over sufficient transaction history. Normalization does not guess subscriptions."
      />
    ) : page === "investments" ? (
      <Deferred
        title="Investments"
        text="A bank transaction CSV does not reliably provide holdings, prices, or portfolio valuation."
      />
    ) : (
      <Deferred
        title="AI Workspace"
        text="No financial data leaves this browser and no AI integration currently exists."
      />
    );

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.app}>
        {desktop && (
          <View style={styles.sidebar}>
            <Pressable onPress={() => nav("index")} style={styles.brand}>
              <View style={styles.brandMark}>
                <Text style={styles.brandLetter}>M</Text>
              </View>
              <View>
                <Text style={styles.brandName}>Moneo</Text>
                <Text style={styles.hint}>Money, understood</Text>
              </View>
            </Pressable>
            {navigationItems.map((item) => (
              <Pressable
                key={item.route}
                onPress={() => nav(item.route)}
                style={[
                  styles.navItem,
                  page === item.route && styles.navActive,
                ]}
              >
                <Text style={styles.navIcon}>{item.icon}</Text>
                <Text
                  style={[
                    styles.navText,
                    page === item.route && styles.navTextActive,
                  ]}
                >
                  {item.label}
                </Text>
              </Pressable>
            ))}
            <Text style={styles.navSection}>INTELLIGENCE</Text>
            <Pressable
              onPress={() => nav("ai")}
              style={[styles.navItem, page === "ai" && styles.navActive]}
            >
              <Text style={styles.navIcon}>✦</Text>
              <Text
                style={[
                  styles.navText,
                  page === "ai" && styles.navTextActive,
                ]}
              >
                AI Workspace
              </Text>
            </Pressable>
            <View style={styles.safeSpend}>
              <Text style={styles.safeLabel}>Safe to spend</Text>
              <Text style={styles.safeUnavailable}>Not calculated</Text>
              <Text style={styles.hint}>Needs budgets and recurring payments</Text>
            </View>
            <View style={[styles.navItem, styles.disabledControl]}>
              <Text style={styles.navIcon}>⚙</Text>
              <Text style={styles.navText}>Settings</Text>
            </View>
          </View>
        )}
        <View style={styles.body}>
          <View style={styles.header}>
            <View style={styles.headerInner}>
              <View style={styles.grow}>
                <Text style={styles.screenTitle}>{titles[page][0]}</Text>
                <Text style={styles.screenSubtitle}>{titles[page][1]}</Text>
              </View>
              {desktop && (
                <View style={[styles.search, styles.disabledControl]}>
                  <Text style={styles.searchText}>⌕  AI not connected</Text>
                  <Text style={styles.shortcut}>⌘K</Text>
                </View>
              )}
              <View style={[styles.bell, styles.disabledControl]}>
                <Text style={styles.bellText}>♧</Text>
              </View>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>ME</Text>
              </View>
            </View>
          </View>
          <ScrollView
            contentContainerStyle={[
              styles.content,
              !desktop && styles.mobileContent,
            ]}
          >
            {(page === "index" || page === "transactions") && <CsvImporter />}
            {pageContent}
          </ScrollView>
        </View>
        {!desktop && (
          <View style={styles.bottomNav}>
            {[
              ...navigationItems.slice(0, 3),
              { route: "ai", label: "AI", icon: "✦" },
            ].map((item) => (
              <Pressable
                key={item.route}
                onPress={() => nav(item.route)}
                style={styles.bottomItem}
              >
                <Text
                  style={[
                    styles.bottomIcon,
                    page === item.route && styles.bottomActive,
                  ]}
                >
                  {item.icon}
                </Text>
                <Text
                  style={[
                    styles.bottomLabel,
                    page === item.route && styles.bottomActive,
                  ]}
                >
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  app: { flex: 1, flexDirection: "row", backgroundColor: C.bg },
  sidebar: {
    width: 240,
    paddingHorizontal: 16,
    paddingVertical: 24,
    borderRightWidth: 1,
    borderColor: C.line,
    backgroundColor: "#f8faf7",
  },
  brand: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    marginBottom: 32,
    paddingHorizontal: 8,
  },
  brandMark: {
    height: 36,
    width: 36,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.teal,
  },
  brandLetter: { color: "#fff", fontSize: 15, fontWeight: "800" },
  brandName: { fontWeight: "800", fontSize: 15, color: C.ink },
  navItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
    marginBottom: 2,
  },
  navActive: {
    backgroundColor: C.card,
    boxShadow: "0 4px 12px rgba(36, 60, 52, 0.08)",
    elevation: 2,
  },
  navIcon: { fontSize: 18, color: C.muted, width: 18, textAlign: "center" },
  navText: { fontSize: 14, fontWeight: "600", color: C.muted },
  navTextActive: { color: C.ink },
  navSection: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.5,
    color: C.muted,
    marginTop: 22,
    marginLeft: 12,
    marginBottom: 8,
  },
  safeSpend: {
    marginTop: "auto",
    borderRadius: 16,
    padding: 16,
    marginBottom: 4,
    backgroundColor: C.card,
    boxShadow: "0 5px 10px rgba(36, 60, 52, 0.06)",
    elevation: 1,
  },
  safeLabel: { color: C.ink, fontSize: 12, fontWeight: "700" },
  safeUnavailable: { color: C.ink, fontSize: 18, fontWeight: "800", marginTop: 5 },
  disabledControl: { opacity: 0.68 },
  body: { flex: 1, minWidth: 0 },
  header: {
    height: 91,
    justifyContent: "center",
    borderBottomWidth: 1,
    borderColor: C.line,
    backgroundColor: C.bg,
  },
  headerInner: {
    width: "100%",
    maxWidth: 1180,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 24,
  },
  screenTitle: {
    fontSize: 22,
    fontWeight: "800",
    color: C.ink,
    letterSpacing: -0.5,
  },
  screenSubtitle: { fontSize: 13, color: C.muted, marginTop: 3 },
  search: {
    width: 208,
    minHeight: 40,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 22,
    paddingHorizontal: 14,
    backgroundColor: C.card,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  searchText: { color: C.muted, fontSize: 12 },
  shortcut: {
    color: C.muted,
    fontSize: 9,
    fontWeight: "700",
    backgroundColor: "#eef1ed",
    borderRadius: 7,
    paddingHorizontal: 5,
    paddingVertical: 3,
  },
  bell: {
    height: 40,
    width: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.line,
    backgroundColor: C.card,
    alignItems: "center",
    justifyContent: "center",
  },
  bellText: { color: C.muted, fontSize: 16 },
  avatar: {
    height: 40,
    width: 40,
    borderRadius: 20,
    backgroundColor: "#d8f4e7",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: C.ink, fontSize: 12, fontWeight: "800" },
  grow: { flex: 1, minWidth: 0 },
  content: {
    padding: 32,
    alignSelf: "center",
    width: "100%",
    maxWidth: 1180,
    paddingBottom: 72,
  },
  mobileContent: { padding: 16, paddingBottom: 94 },
  panel: {
    backgroundColor: C.card,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: C.line,
    padding: 24,
    boxShadow: "0 7px 18px rgba(36, 60, 52, 0.07)",
    elevation: 2,
  },
  flexPanel: { flex: 1 },
  panelTitle: { marginBottom: 18 },
  panelHeading: { fontSize: 15, fontWeight: "800", color: C.ink },
  hint: { fontSize: 11, color: C.muted, marginTop: 3 },
  filterToggle: { alignSelf: "flex-start", marginBottom: 8, paddingVertical: 6 },
  filterToggleText: { color: C.teal, fontSize: 11, fontWeight: "700" },
  dashboardGrid: { flexDirection: "row", gap: 20 },
  mobileStack: { flexDirection: "column" },
  mainColumn: { flex: 2, gap: 20, minWidth: 0 },
  sideColumn: { flex: 1, gap: 20, minWidth: 0 },
  emptyText: { color: C.muted, fontSize: 13, lineHeight: 20, paddingVertical: 8 },
  transaction: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderColor: "#edf0ec",
  },
  merchant: {
    height: 36,
    width: 36,
    borderRadius: 11,
    backgroundColor: "#edf0ec",
    alignItems: "center",
    justifyContent: "center",
  },
  merchantText: { fontSize: 10, fontWeight: "800", color: C.muted },
  rowTitle: { fontSize: 13, fontWeight: "700", color: C.ink },
  categoryLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 4 },
  categoryBadge: { color: C.teal, backgroundColor: C.tealSoft, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3, fontSize: 9, fontWeight: "700", overflow: "hidden" },
  needsBadge: { color: C.muted, backgroundColor: "#edf0ec" },
  suggestion: { color: C.muted, fontSize: 9 },
  amount: { fontSize: 12, fontWeight: "700", color: C.ink },
  positive: { color: C.teal },
  right: { textAlign: "right" },
  transactionDetail: {
    backgroundColor: "#f7f9f6",
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
    gap: 8,
  },
  categoryDetailHead: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  smallButton: { borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: C.card },
  smallButtonText: { color: C.ink, fontSize: 10, fontWeight: "700" },
  categoryPicker: { borderTopWidth: 1, borderColor: C.line, paddingTop: 10, gap: 10 },
  categoryGroup: { gap: 5 },
  categoryChoices: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  categoryChoice: { borderWidth: 1, borderColor: C.line, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 6, backgroundColor: C.card },
  categoryChoiceActive: { borderColor: C.teal, backgroundColor: C.tealSoft },
  categoryChoiceText: { color: C.ink, fontSize: 10, fontWeight: "600" },
  scopeRow: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  scopeChoice: { flexGrow: 1, borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 9, backgroundColor: C.card },
  scopeChoiceActive: { borderColor: C.teal, backgroundColor: C.tealSoft },
  pickerActions: { flexDirection: "row", justifyContent: "flex-end", gap: 7 },
  saveButton: { backgroundColor: C.teal, borderColor: C.teal },
  saveButtonText: { color: C.card },
  detailGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  detailItem: { minWidth: 150, flex: 1 },
  detailLabel: {
    color: C.muted,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  detailValue: { color: C.ink, fontSize: 12, lineHeight: 17 },
  referenceRow: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  rawRow: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  rawField: { color: C.muted, fontSize: 10, width: 110 },
  sourceText: { color: C.muted, fontSize: 10, marginTop: 3 },
  cashFlowBlock: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderColor: C.line,
  },
  currencyHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  currency: { color: C.ink, fontSize: 13, fontWeight: "800" },
  metricGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  metric: {
    minWidth: 130,
    flex: 1,
    backgroundColor: "#f7f9f6",
    borderRadius: 14,
    padding: 12,
  },
  metricLabel: { color: C.muted, fontSize: 10, fontWeight: "700" },
  metricValue: { color: C.ink, fontSize: 15, fontWeight: "800", marginTop: 5 },
  accountRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderColor: C.line,
  },
  accountMark: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: C.tealSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  accountMarkText: { color: C.teal, fontSize: 10, fontWeight: "800" },
  deferredText: { color: C.ink, fontSize: 15, lineHeight: 23, maxWidth: 680 },
  deferredFoot: { color: C.muted, fontSize: 12, marginTop: 14 },
  bottomNav: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 66,
    backgroundColor: "#fffffff2",
    borderTopWidth: 1,
    borderColor: C.line,
    flexDirection: "row",
    justifyContent: "space-around",
    paddingTop: 8,
  },
  bottomItem: { alignItems: "center", minWidth: 65, gap: 3 },
  bottomIcon: { fontSize: 18, color: C.muted },
  bottomLabel: { fontSize: 10, fontWeight: "600", color: C.muted },
  bottomActive: { color: C.teal },
});
