import { useEffect, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions as useNativeWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import Svg, { Circle, Defs, Line, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import { CsvImporter } from "@/components/csv-importer";
import { useFinanceData } from "@/components/finance-data-provider";
import { navigationItems } from "@/lib/navigation.mjs";
import { dashboardHeader } from "@/lib/dashboard-header";
import { dashboardPresentation } from "@/lib/dashboard-layout";
import { summarizeMonthlySpending } from "@/lib/dashboard-spending";
import { unavailableDashboardCapabilities as capabilityCopy } from "@/lib/dashboard-capabilities";
import { chartPoints, monthOverMonthTenths } from "@/lib/net-worth-chart";
import {
  hydrationSafeWebWidth,
  isCompactAccountsLayout,
  isDesktopLayout,
} from "@/lib/responsive-layout";
import {
  formatMinorMoney,
  recentTransactions,
} from "@/lib/finance-transactions.mjs";
import {
  balanceSeriesByCurrency,
  latestBalanceByAccount,
} from "@/lib/finance-summary.mjs";
import {
  categoryCatalog,
  categorizeTransaction,
  counterpartyKeyFor,
  normalizeEvidenceText,
  searchCategories,
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
    viewportWidth: Platform.OS === "web" ? webWidth : dimensions.width,
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

function Title({ title, hint, action, onAction }: { title: string; hint?: string; action?: string; onAction?: () => void }) {
  return (
    <View style={styles.panelTitle}>
      <View style={styles.grow}>
        <Text style={styles.panelHeading}>{title}</Text>
        {hint && <Text style={styles.hint}>{hint}</Text>}
      </View>
      {action && onAction && (
        <Pressable onPress={onAction}><Text style={styles.panelAction}>{action}</Text></Pressable>
      )}
    </View>
  );
}

function maskIdentifier(identifier?: string) {
  if (!identifier) return undefined;
  return identifier.length > 8
    ? `${identifier.slice(0, 4)}••••${identifier.slice(-4)}`
    : identifier;
}

type CategoryOption = { id: string; label: string; custom: boolean };

const builtInCategoryOptions = categoryCatalog() as CategoryOption[];
const newCategoryId = "__new_category__";

function categoryLabel(categoryId?: string, options = builtInCategoryOptions) {
  return options.find((category) => category.id === categoryId)?.label ?? "Needs category";
}

function Transactions({ limit, onSeeAll }: { limit?: number; onSeeAll?: () => void }) {
  const { data, database, refresh } = useFinanceData();
  const [selectedId, setSelectedId] = useState<string>();
  const [needsOnly, setNeedsOnly] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [chosenCategoryId, setChosenCategoryId] = useState<string>();
  const [categoryQuery, setCategoryQuery] = useState("");
  const [ruleRequired, setRuleRequired] = useState(false);
  const [savingCategory, setSavingCategory] = useState(false);
  const [categoryError, setCategoryError] = useState<string>();
  const [scope, setScope] = useState<"one" | "all">("one");
  const availableCategories = categoryCatalog(data.categoryRules) as CategoryOption[];
  const matchingCategories = searchCategories(availableCategories, categoryQuery) as CategoryOption[];
  const cleanCategoryName = categoryQuery.trim().replace(/\s+/g, " ");
  const exactCategory = availableCategories.find(
    (category) => normalizeEvidenceText(category.label) === normalizeEvidenceText(cleanCategoryName),
  );
  const unmatchedCount = data.transactions.filter((transaction) => !transaction.category).length;
  const ordered = recentTransactions(
    data.transactions,
  ) as MoneoTransaction[];
  const transactions = (needsOnly ? ordered.filter((transaction) => !transaction.category) : ordered)
    .slice(0, limit ?? ordered.length);

  const beginCategoryChange = (transaction: MoneoTransaction, requireRule = false) => {
    const decision = categorizeTransaction(transaction, data.categoryRules);
    const initialCategoryId = transaction.category?.categoryId ?? (decision.status === "suggested" ? decision.categoryId : undefined);
    setEditingId(transaction.id);
    setChosenCategoryId(initialCategoryId);
    setCategoryQuery(categoryLabel(initialCategoryId, availableCategories) === "Needs category" ? "" : categoryLabel(initialCategoryId, availableCategories));
    setRuleRequired(requireRule);
    setScope(requireRule ? "all" : "one");
    setCategoryError(undefined);
  };

  const saveCategory = async (transaction: MoneoTransaction) => {
    if (!database || !chosenCategoryId || savingCategory) return;
    const selectedCategory = chosenCategoryId === newCategoryId
      ? { id: `custom:${crypto.randomUUID()}`, label: cleanCategoryName, custom: true }
      : availableCategories.find(({ id }) => id === chosenCategoryId);
    if (!selectedCategory?.label) return;
    setSavingCategory(true);
    setCategoryError(undefined);
    try {
      if (scope === "all") {
        const counterpartyKey = counterpartyKeyFor(transaction);
        const existing = data.categoryRules.find((rule) => rule.counterpartyKey === counterpartyKey);
        const rule = {
          id: existing?.id ?? crypto.randomUUID(),
          counterpartyKey,
          categoryId: selectedCategory.id,
          ...(selectedCategory.custom ? { categoryLabel: selectedCategory.label } : {}),
          createdAt: existing?.createdAt ?? new Date().toISOString(),
        };
        await applyCategoryRule(
          database,
          rule,
          data.transactions.filter((item) => counterpartyKeyFor(item) === counterpartyKey).map((item) => item.id),
        );
      } else {
        await setTransactionCategory(database, transaction.id, {
          categoryId: selectedCategory.id,
          method: "manual",
          classifierVersion: "moneo-category-v1",
          evidence: ["Chosen by you"],
        });
      }
      await refresh();
      setEditingId(undefined);
      setCategoryQuery("");
    } catch (error) {
      setCategoryError(error instanceof Error ? error.message : "Category could not be saved");
    } finally {
      setSavingCategory(false);
    }
  };

  return (
    <Panel style={styles.flexPanel}>
      <Title
        title="Transactions"
        action={onSeeAll ? "See all" : undefined}
        onAction={onSeeAll}
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
        const matchingTransactionCount = data.transactions.filter(
          (item) => counterpartyKeyFor(item) === counterpartyKeyFor(transaction),
        ).length;
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
                  {transaction.category ? (
                    <Text style={styles.categoryBadge}>
                      {categoryLabel(transaction.category.categoryId, availableCategories)}
                    </Text>
                  ) : (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Categorize ${transaction.title}`}
                      onPress={(event) => {
                        event.stopPropagation();
                        setSelectedId(transaction.id);
                        beginCategoryChange(transaction, true);
                      }}
                    >
                      <Text style={[styles.categoryBadge, styles.needsBadge]}>Needs category</Text>
                    </Pressable>
                  )}
                  {!transaction.category && (() => {
                    const decision = categorizeTransaction(transaction, data.categoryRules);
                    return decision.status === "suggested" ? (
                      <Text style={styles.suggestion}>Suggested: {categoryLabel(decision.categoryId, availableCategories)}</Text>
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
                    <Text style={styles.detailValue}>{categoryLabel(transaction.category?.categoryId, availableCategories)}</Text>
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
                    <TextInput
                      accessibilityLabel="Search or create a category"
                      autoCapitalize="words"
                      autoCorrect={false}
                      autoFocus
                      maxLength={40}
                      onChangeText={(value) => {
                        setCategoryQuery(value);
                        const exact = availableCategories.find(
                          (category) => normalizeEvidenceText(category.label) === normalizeEvidenceText(value),
                        );
                        setChosenCategoryId(exact?.id);
                      }}
                      placeholder="Search or create a category"
                      placeholderTextColor={C.muted}
                      style={styles.categoryInput}
                      value={categoryQuery}
                    />
                    <View style={styles.categoryChoices}>
                      {matchingCategories.map((category) => (
                        <Pressable
                          key={category.id}
                          style={[styles.categoryChoice, chosenCategoryId === category.id && styles.categoryChoiceActive]}
                          onPress={() => {
                            setChosenCategoryId(category.id);
                            setCategoryQuery(category.label);
                          }}
                        >
                          <Text style={styles.categoryChoiceText}>{category.label}</Text>
                        </Pressable>
                      ))}
                      {Boolean(cleanCategoryName) && !exactCategory && (
                        <Pressable
                          style={[styles.categoryChoice, chosenCategoryId === newCategoryId && styles.categoryChoiceActive]}
                          onPress={() => {
                            setChosenCategoryId(newCategoryId);
                            setRuleRequired(true);
                            setScope("all");
                          }}
                        >
                          <Text style={styles.categoryChoiceText}>Create “{cleanCategoryName}”</Text>
                        </Pressable>
                      )}
                    </View>
                    {ruleRequired ? (
                      <Text style={styles.categoryScopeNote}>
                        Applies to {matchingTransactionCount} existing transaction{matchingTransactionCount === 1 ? "" : "s"} from {transaction.recipient || transaction.sender || transaction.title}, and future matches.
                      </Text>
                    ) : (
                      <View style={styles.scopeRow}>
                        <Pressable style={[styles.scopeChoice, scope === "one" && styles.scopeChoiceActive]} onPress={() => setScope("one")}>
                          <Text style={styles.categoryChoiceText}>This transaction only</Text>
                        </Pressable>
                        <Pressable style={[styles.scopeChoice, scope === "all" && styles.scopeChoiceActive]} onPress={() => setScope("all")}>
                          <Text style={styles.categoryChoiceText}>All from {transaction.recipient || transaction.sender || transaction.title}</Text>
                        </Pressable>
                      </View>
                    )}
                    {categoryError && <Text style={styles.categoryError}>{categoryError}</Text>}
                    <View style={styles.pickerActions}>
                      <Pressable style={styles.smallButton} onPress={() => setEditingId(undefined)} disabled={savingCategory}>
                        <Text style={styles.smallButtonText}>Cancel</Text>
                      </Pressable>
                      <Pressable
                        disabled={!chosenCategoryId || savingCategory}
                        style={[styles.smallButton, styles.saveButton, (!chosenCategoryId || savingCategory) && styles.disabledButton]}
                        onPress={() => saveCategory(transaction)}
                      >
                        <Text style={[styles.smallButtonText, styles.saveButtonText]}>{savingCategory ? "Saving…" : "Save"}</Text>
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

function NetWorth() {
  const { data } = useFinanceData();
  const { width } = useWindowDimensions();
  const [activeIndex, setActiveIndex] = useState(1);
  const series = balanceSeriesByCurrency(data.transactions) as {
    currency: string;
    currencyMinorUnit: number;
    basis: "source-backed" | "calculated-from-zero";
    points: { month: string; amountMinor: string }[];
  }[];
  const primary = series[0];
  const monthly = primary?.points ?? [];
  const visibleMonthly = monthly.slice(-6);
  const points = chartPoints(visibleMonthly.map((point) => ({
    label: new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" })
      .format(new Date(`${point.month}-01T00:00:00Z`)),
    value: Number(BigInt(point.amountMinor)),
  })));
  const selectedIndex = Math.min(activeIndex, Math.max(points.length - 1, 0));
  const selected = visibleMonthly[selectedIndex];
  const selectedPoint = points[selectedIndex];
  const latest = primary?.points.at(-1);
  const changeTenths = monthOverMonthTenths(monthly);
  const path = points.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" ");
  const compact = width < 480;
  const formatNetWorth = (amountMinor: string, currency: string, currencyMinorUnit: number) => {
    const formatted = formatMinorMoney(amountMinor, currency, currencyMinorUnit).replace(/^\+/, "");
    return currency === "EUR" ? `€${formatted.replace(/\s*EUR$/, "")}` : formatted;
  };

  useEffect(() => {
    if (points.length) setActiveIndex((index) => Math.min(index, points.length - 1));
  }, [points.length]);

  return (
    <Panel style={styles.netWorth}>
      <View style={styles.netWorthHero}>
        <Svg style={[StyleSheet.absoluteFill, styles.pointerEventsNone]} width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
          <Defs>
            <LinearGradient id="netWorthHeroWash" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor="#e7f7ef" />
              <Stop offset=".55" stopColor="#f3f7e9" />
              <Stop offset="1" stopColor="#edf6fd" />
            </LinearGradient>
          </Defs>
          <Rect width="100" height="100" fill="url(#netWorthHeroWash)" />
        </Svg>
        <View style={styles.netWorthHeroContent}>
          <Text style={styles.kicker}>NET WORTH</Text>
          {series.length ? (
            <>
              <View style={styles.netWorthValueRow}>
                {latest && (
                  <Text style={[styles.netWorthValue, compact && styles.netWorthValueCompact]}>
                    {formatNetWorth(latest.amountMinor, primary.currency, primary.currencyMinorUnit)}
                  </Text>
                )}
                {changeTenths !== undefined && (
                  <Text style={[styles.netWorthDelta, changeTenths < 0 && styles.netWorthDeltaNegative]}>
                    {changeTenths > 0 ? "+" : ""}{(changeTenths / 10).toFixed(1)}%
                  </Text>
                )}
                {changeTenths !== undefined && <Text style={styles.netWorthComparison}>vs. last month</Text>}
              </View>
              {series.length > 1 && (
                <View style={styles.secondaryNetWorthValues}>
                  {series.slice(1).map((currencySeries) => {
                    const secondaryLatest = currencySeries.points.at(-1);
                    return secondaryLatest ? (
                      <Text key={currencySeries.currency} style={styles.secondaryNetWorthValue}>
                        {formatNetWorth(secondaryLatest.amountMinor, currencySeries.currency, currencySeries.currencyMinorUnit)}
                      </Text>
                    ) : null;
                  })}
                </View>
              )}
              <Text style={styles.heroHint}>
                {primary?.basis === "calculated-from-zero"
                  ? "Calculated from imported history"
                  : "Source-backed monthly balances"}
                {series.length > 1 ? " · currencies shown separately" : " · no currency conversion"}
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.unavailableValue}>No balance history</Text>
              <Text style={styles.heroHint}>Import complete account history to calculate balances from €0.</Text>
            </>
          )}
        </View>
      </View>
      {primary && points.length ? (
        <View style={styles.chartWrap}>
          <View style={styles.lineChart}>
            <Svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
              <Defs>
                <LinearGradient id="netWorthFill" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={C.teal} stopOpacity=".14" />
                  <Stop offset="1" stopColor={C.teal} stopOpacity="0" />
                </LinearGradient>
              </Defs>
              {points.length > 1 && <Path d={`${path} L${points.at(-1)!.x} 100 L${points[0].x} 100 Z`} fill="url(#netWorthFill)" />}
              {points.length > 1 && (
                <Path
                  d={path}
                  fill="none"
                  stroke={C.teal}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {selectedPoint && (
                <Line
                  x1={selectedPoint.x}
                  x2={selectedPoint.x}
                  y1="6"
                  y2="100"
                  stroke="#dbe2dd"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </Svg>
            {selectedPoint && (
              <View
                style={[
                  styles.chartPoint,
                  styles.pointerEventsNone,
                  { left: `${selectedPoint.x}%`, top: `${selectedPoint.y}%` },
                ]}
              />
            )}
            <View style={styles.chartHitTargets}>
              {points.map((point, index) => (
                <Pressable
                  key={`${point.label}-${index}`}
                  accessibilityLabel={`Show ${new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${visibleMonthly[index].month}-01T00:00:00Z`))} balance, ${formatNetWorth(visibleMonthly[index].amountMinor, primary.currency, primary.currencyMinorUnit)}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: index === selectedIndex }}
                  onHoverIn={() => setActiveIndex(index)}
                  onFocus={() => setActiveIndex(index)}
                  onPress={() => setActiveIndex(index)}
                  style={styles.chartHitTarget}
                />
              ))}
            </View>
            {selected && selectedPoint && (
              <View
                style={[
                  styles.chartTooltip,
                  styles.pointerEventsNone,
                  compact && styles.chartTooltipCompact,
                  { top: `${Math.max(4, selectedPoint.y - 42)}%` },
                  selectedPoint.x > 64
                    ? { right: `${100 - selectedPoint.x}%`, marginRight: 12 }
                    : { left: `${selectedPoint.x}%`, marginLeft: 12 },
                ]}
              >
                <Text style={styles.tooltipMonth}>{points[selectedIndex].label}</Text>
                <Text style={[styles.tooltipValue, compact && styles.tooltipValueCompact]}>
                  Net worth: {formatNetWorth(selected.amountMinor, primary.currency, primary.currencyMinorUnit)}
                </Text>
              </View>
            )}
          </View>
          <View style={styles.chartMonths}>
            {points.map((point) => (
              <Text key={point.label} style={styles.chartMonth}>{point.label}</Text>
            ))}
          </View>
        </View>
      ) : (
        <View style={styles.chartEmpty}>
          <View style={styles.chartGuide} />
          <Text style={styles.emptyText}>A traceable balance trend will appear here.</Text>
        </View>
      )}
    </Panel>
  );
}

const spendingColors = [C.teal, "#58b4c3", "#ddb96e", "#d88776", "#9a86bc", "#809389"];

function Spending() {
  const { data } = useFinanceData();
  const availableCategories = categoryCatalog(data.categoryRules) as CategoryOption[];
  const latestMonth = recentTransactions(data.transactions)[0]?.bookingDate.slice(0, 7);
  const summaries = latestMonth ? summarizeMonthlySpending(data.transactions, latestMonth) as {
    currency: string;
    currencyMinorUnit: number;
    totalMinor: string;
    categories: { categoryId: string; amountMinor: string }[];
  }[] : [];
  const summary = summaries[0];
  const circumference = 2 * Math.PI * 44;
  let consumed = 0;
  const monthLabel = latestMonth
    ? new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
        .format(new Date(`${latestMonth}-01T00:00:00Z`))
    : "By Moneo category";

  return (
    <Panel style={styles.dashboardHalfCard}>
      <Title title="Spending" hint={summary ? `${monthLabel} · ${summary.currency}` : monthLabel} />
      {summary ? (
        <View style={styles.previewBody}>
          <View style={styles.donutChart}>
            <Svg width="126" height="126" viewBox="0 0 100 100">
              <Circle cx="50" cy="50" r="44" fill="none" stroke="#edf0ec" strokeWidth="12" />
              {summary.categories.map((category, index) => {
                const length = Number(BigInt(category.amountMinor)) / Number(BigInt(summary.totalMinor)) * circumference;
                const offset = -consumed;
                consumed += length;
                return (
                  <Circle
                    key={category.categoryId}
                    cx="50"
                    cy="50"
                    r="44"
                    fill="none"
                    stroke={spendingColors[index % spendingColors.length]}
                    strokeWidth="12"
                    strokeDasharray={`${Math.max(length - 2, 0)} ${circumference}`}
                    strokeDashoffset={offset}
                    transform="rotate(-90 50 50)"
                  />
                );
              })}
            </Svg>
            <View style={styles.donutCenter}>
              <Text style={styles.donutMoney}>
                {formatMinorMoney(summary.totalMinor, summary.currency, summary.currencyMinorUnit).replace(/^\+/, "")}
              </Text>
              <Text style={styles.donutCaption}>outflow</Text>
            </View>
          </View>
          <View style={styles.spendingLegend}>
            {summary.categories.slice(0, 5).map((category, index) => (
              <View key={category.categoryId} style={styles.legendRow}>
                <View style={[styles.legendDot, { backgroundColor: spendingColors[index % spendingColors.length] }]} />
                <Text style={styles.legendLabel} numberOfLines={1}>{categoryLabel(category.categoryId, availableCategories)}</Text>
                <Text style={styles.legendAmount}>
                  {formatMinorMoney(category.amountMinor, summary.currency, summary.currencyMinorUnit).replace(/^\+/, "")}
                </Text>
              </View>
            ))}
            {summaries.length > 1 && <Text style={styles.currencyNote}>Other currencies kept separate</Text>}
          </View>
        </View>
      ) : (
        <View style={styles.previewBody}>
          <View style={styles.donutEmpty}><View style={styles.donutEmptyHole} /></View>
          <Text style={[styles.emptyText, styles.previewCopy]}>
            Categorised outflow will appear after transactions are imported.
          </Text>
        </View>
      )}
    </Panel>
  );
}

function BudgetsPreview({ onOpen }: { onOpen: () => void }) {
  return (
    <Panel style={styles.dashboardHalfCard}>
      <Title title="Budgets" hint="Monthly progress" />
      <View style={styles.placeholderBars}>
        {[72, 92, 58, 44].map((width, index) => (
          <View key={width} style={styles.placeholderBudget}>
            <View style={[styles.placeholderLine, { width: `${index % 2 ? 55 : 38}%` }]} />
            <View style={styles.barTrack}><View style={[styles.barGhost, { width: `${width}%` }]} /></View>
          </View>
        ))}
      </View>
      <View style={styles.previewFooter}>
        <Text style={styles.emptyText}>{capabilityCopy.budgets}.</Text>
        <Pressable onPress={onOpen}><Text style={styles.secondaryLink}>Open budgets</Text></Pressable>
      </View>
    </Panel>
  );
}

function InsightPreview({ onOpen }: { onOpen: () => void }) {
  return (
    <View style={styles.insight}>
      <Text style={styles.insightKicker}>✦  AI INSIGHT</Text>
      <Text style={styles.insightText}>
        {capabilityCopy.ai}. Your financial data remains in this browser.
      </Text>
      <Pressable style={styles.insightButton} onPress={onOpen}>
        <Text style={styles.insightButtonText}>View AI workspace  ↗</Text>
      </Pressable>
    </View>
  );
}

function RecurringPreview({ onOpen }: { onOpen: () => void }) {
  return (
    <Panel style={styles.recurringCard}>
      <Title title="Recurring" hint={capabilityCopy.recurring} action="Learn more" onAction={onOpen} />
      <View style={styles.recurringEmptyRow}>
        <View style={styles.recurringMark} />
        <Text style={[styles.emptyText, styles.grow]}>
          Moneo does not infer subscriptions from limited history.
        </Text>
      </View>
    </Panel>
  );
}

function Accounts({ compact }: { compact: boolean }) {
  const { data } = useFinanceData();
  const balances = latestBalanceByAccount(data.transactions) as Record<
    string,
    {
      amountMinor: string;
      currency: string;
      currencyMinorUnit: number;
      bookingDate: string;
      basis: "source-backed" | "calculated-from-zero";
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
          <View key={account.id} style={[styles.accountRow, compact && styles.compactAccountRow]}>
            <View style={styles.accountIdentity}>
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
            </View>
            <View style={compact && styles.compactAccountBalance}>
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
                    {balance.basis === "source-backed" ? "Source-backed" : "Calculated from €0"} · {balance.bookingDate}
                  </Text>
                </>
              ) : (
                <Text style={[styles.hint, styles.right]}>
                  No booked transactions
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
  const { width, viewportWidth } = useWindowDimensions();
  const desktop = isDesktopLayout(width);
  const compactAccounts = isCompactAccountsLayout(viewportWidth);
  const nav = (route: string) =>
    router.push(`/${route === "index" ? "" : route}` as never);
  const dashboardHeading = dashboardHeader(new Date(), "en-GB");
  const dashboard = dashboardPresentation(data.transactions.length);

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
          <NetWorth />
          <View style={[styles.dashboardSplit, !desktop && styles.mobileStack]}>
            <Spending />
            <BudgetsPreview onOpen={() => nav("budgets")} />
          </View>
          <Transactions limit={6} onSeeAll={() => nav("transactions")} />
        </View>
        <View style={styles.sideColumn}>
          <InsightPreview onOpen={() => nav("ai")} />
          <Accounts compact={compactAccounts} />
          <RecurringPreview onOpen={() => nav("recurring")} />
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
              <Text style={styles.safeUnavailable}>{capabilityCopy.safeToSpend}</Text>
              <Text style={styles.hint}>Needs budgets and recurring payments</Text>
            </View>
            <Pressable
              disabled
              accessibilityLabel="Settings are not available"
              accessibilityState={{ disabled: true }}
              style={[styles.navItem, styles.disabledControl]}
            >
              <Text style={styles.navIcon}>⚙</Text>
              <Text style={styles.navText}>Settings</Text>
            </Pressable>
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
                <Pressable
                  disabled
                  accessibilityLabel="AI search is not connected"
                  accessibilityState={{ disabled: true }}
                  style={[styles.search, styles.disabledControl]}
                >
                  <Text style={styles.searchText}>⌕  AI not connected</Text>
                  <Text style={styles.shortcut}>⌘K</Text>
                </Pressable>
              )}
              <Pressable
                disabled
                accessibilityLabel="Notifications are not available"
                accessibilityState={{ disabled: true }}
                style={[styles.bell, styles.disabledControl]}
              >
                <Text style={styles.bellText}>♧</Text>
              </Pressable>
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
            {((page === "index" && dashboard.showImporter) || page === "transactions") && <CsvImporter />}
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
  panelTitle: { marginBottom: 18, flexDirection: "row", justifyContent: "space-between", gap: 10 },
  panelHeading: { fontSize: 15, fontWeight: "800", color: C.ink },
  panelAction: { color: C.teal, fontSize: 11, fontWeight: "800" },
  hint: { fontSize: 11, color: C.muted, marginTop: 3 },
  filterToggle: { alignSelf: "flex-start", marginBottom: 8, paddingVertical: 6 },
  filterToggleText: { color: C.teal, fontSize: 11, fontWeight: "700" },
  dashboardGrid: { flexDirection: "row", gap: 20 },
  mobileStack: { flexDirection: "column" },
  mainColumn: { flex: 2, gap: 20, minWidth: 0 },
  sideColumn: { flex: 1, gap: 20, minWidth: 0 },
  dashboardSplit: { flexDirection: "row", gap: 20 },
  dashboardHalfCard: { flex: 1, minHeight: 294 },
  netWorth: { padding: 0, overflow: "hidden", minHeight: 360 },
  netWorthHero: { minHeight: 136, position: "relative", overflow: "hidden" },
  netWorthHeroContent: { paddingHorizontal: 28, paddingVertical: 23 },
  kicker: { color: C.muted, fontSize: 11, fontWeight: "800", letterSpacing: 1.4 },
  unavailableValue: { color: C.ink, fontSize: 25, fontWeight: "800", marginTop: 10 },
  netWorthValueRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 12, rowGap: 4, marginTop: 7 },
  netWorthValue: { color: C.ink, fontSize: 40, lineHeight: 45, fontWeight: "800", letterSpacing: -1.1 },
  netWorthValueCompact: { fontSize: 34, lineHeight: 39, letterSpacing: -0.8 },
  netWorthDelta: { color: "#356f5b", backgroundColor: "#d9eee2", borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3, fontSize: 12, fontWeight: "800" },
  netWorthDeltaNegative: { color: C.red, backgroundColor: "#fae6e1" },
  netWorthComparison: { color: C.muted, fontSize: 12 },
  secondaryNetWorthValues: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 4 },
  secondaryNetWorthValue: { color: C.ink, fontSize: 13, fontWeight: "700" },
  heroHint: { color: C.muted, fontSize: 11, marginTop: 4 },
  chartEmpty: { minHeight: 168, padding: 24, justifyContent: "center" },
  chartGuide: { height: 2, borderRadius: 2, backgroundColor: C.tealSoft, transform: [{ rotate: "-5deg" }], marginBottom: 20 },
  chartWrap: { paddingTop: 15 },
  lineChart: { height: 180, marginHorizontal: 20, position: "relative", overflow: "hidden" },
  chartHitTargets: { ...StyleSheet.absoluteFill, flexDirection: "row", zIndex: 2 },
  chartHitTarget: { flex: 1 },
  chartPoint: { position: "absolute", zIndex: 1, width: 8, height: 8, borderRadius: 4, backgroundColor: C.teal, borderWidth: 2, borderColor: C.card, transform: [{ translateX: -4 }, { translateY: -4 }] },
  chartTooltip: { position: "absolute", zIndex: 3, width: 168, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 16, padding: 14, boxShadow: "0 8px 20px rgba(36, 60, 52, 0.10)", elevation: 3 },
  pointerEventsNone: { pointerEvents: "none" },
  chartTooltipCompact: { width: 144, padding: 12 },
  tooltipMonth: { fontSize: 13, color: C.ink, fontWeight: "600" },
  tooltipValue: { fontSize: 13, color: C.teal, marginTop: 7 },
  tooltipValueCompact: { fontSize: 11 },
  chartMonths: { flexDirection: "row", paddingHorizontal: 20, paddingTop: 5, paddingBottom: 17 },
  chartMonth: { flex: 1, color: C.muted, fontSize: 11, textAlign: "center" },
  previewBody: { flexDirection: "row", alignItems: "center", gap: 18, flex: 1 },
  previewCopy: { flex: 1 },
  donutEmpty: { width: 126, height: 126, borderRadius: 63, borderWidth: 18, borderColor: C.tealSoft, alignItems: "center", justifyContent: "center" },
  donutEmptyHole: { width: 56, height: 56, borderRadius: 28, backgroundColor: C.card },
  donutChart: { width: 126, height: 126, alignItems: "center", justifyContent: "center" },
  donutCenter: { position: "absolute", alignItems: "center", maxWidth: 82 },
  donutMoney: { color: C.ink, fontSize: 13, fontWeight: "800", textAlign: "center" },
  donutCaption: { color: C.muted, fontSize: 9, marginTop: 2 },
  spendingLegend: { flex: 1, gap: 7 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  legendDot: { width: 7, height: 7, borderRadius: 4 },
  legendLabel: { flex: 1, color: C.muted, fontSize: 11 },
  legendAmount: { color: C.ink, fontSize: 10, fontWeight: "700" },
  currencyNote: { color: C.muted, fontSize: 9, marginTop: 2 },
  placeholderBars: { gap: 18 },
  placeholderBudget: { gap: 8 },
  placeholderLine: { height: 8, borderRadius: 4, backgroundColor: "#e9eeea" },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: "#edf0ec", overflow: "hidden" },
  barGhost: { height: "100%", borderRadius: 4, backgroundColor: C.tealSoft },
  previewFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  secondaryLink: { color: C.teal, fontSize: 10, fontWeight: "800" },
  insight: { borderRadius: 22, padding: 24, backgroundColor: "#24705f", boxShadow: "0 12px 28px rgba(36, 60, 52, 0.13)", elevation: 2 },
  insightKicker: { color: "#d9eee2", fontSize: 11, fontWeight: "800", letterSpacing: 1.4 },
  insightText: { color: C.card, fontSize: 15, lineHeight: 22, fontWeight: "700", marginTop: 12 },
  insightButton: { alignSelf: "flex-start", marginTop: 18, borderRadius: 18, backgroundColor: "#ffffff22", paddingHorizontal: 14, paddingVertical: 10 },
  insightButtonText: { color: C.card, fontSize: 11, fontWeight: "700" },
  recurringCard: { minHeight: 164 },
  recurringEmptyRow: { flexDirection: "row", gap: 12, alignItems: "center" },
  recurringMark: { width: 4, height: 42, borderRadius: 2, backgroundColor: C.tealSoft },
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
  categoryInput: { borderWidth: 1, borderColor: C.line, borderRadius: 10, backgroundColor: C.card, color: C.ink, fontSize: 12, paddingHorizontal: 11, paddingVertical: 9 },
  categoryChoices: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  categoryChoice: { borderWidth: 1, borderColor: C.line, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 6, backgroundColor: C.card },
  categoryChoiceActive: { borderColor: C.teal, backgroundColor: C.tealSoft },
  categoryChoiceText: { color: C.ink, fontSize: 10, fontWeight: "600" },
  scopeRow: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  scopeChoice: { flexGrow: 1, borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 9, backgroundColor: C.card },
  scopeChoiceActive: { borderColor: C.teal, backgroundColor: C.tealSoft },
  categoryScopeNote: { color: C.muted, fontSize: 10, lineHeight: 15 },
  categoryError: { color: C.red, fontSize: 10 },
  pickerActions: { flexDirection: "row", justifyContent: "flex-end", gap: 7 },
  saveButton: { backgroundColor: C.teal, borderColor: C.teal },
  saveButtonText: { color: C.card },
  disabledButton: { opacity: 0.45 },
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
  accountRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderColor: C.line,
  },
  compactAccountRow: { flexDirection: "column", alignItems: "stretch" },
  accountIdentity: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10 },
  compactAccountBalance: { marginLeft: 44 },
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
