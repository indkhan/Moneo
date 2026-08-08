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
import Svg, {
  Circle,
  Defs,
  Line,
  LinearGradient,
  Path,
  Stop,
} from "react-native-svg";
import { navigationItems } from "@/lib/navigation.mjs";
import { chartPoints, pointAtIndex, tooltipLeft } from "@/lib/net-worth-chart";
import {
  hydrationSafeWebWidth,
  isDesktopLayout,
} from "@/lib/responsive-layout";
import { CsvImporter } from "@/components/csv-importer";
import { useFinanceData } from "@/components/finance-data-provider";
import {
  formatMinorMoney,
  recentTransactions,
} from "@/lib/finance-transactions.mjs";
import type { MoneoTransaction } from "@/lib/transaction-types";

type Page =
  | "index"
  | "transactions"
  | "budgets"
  | "investments"
  | "recurring"
  | "ai";
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
  const width =
    Platform.OS === "web"
      ? hydrationSafeWebWidth(webWidth)
      : dimensions.width;
  return {
    ...dimensions,
    width: isDesktopLayout(width) ? 1024 : width,
  };
}
const C = {
  bg: "#fafbf8",
  card: "#ffffff",
  ink: "#243c34",
  muted: "#79877f",
  line: "#e5e9e4",
  teal: "#438f7a",
  tealSoft: "#e7f4ed",
  blue: "#94b7c9",
  yellow: "#e5c67c",
  orange: "#d59176",
  purple: "#a58cb7",
  red: "#bd5b4d",
};
const data = {
  accounts: [
    ["Everyday", "N26 · Checking", "€4,820.44", "+2.4%", C.teal],
    ["Safety net", "Trade Republic · Savings", "€18,240.00", "+1.1%", C.blue],
    ["Amex Gold", "Amex · Credit", "-€1,284.17", "-8.6%", C.orange],
    ["Portfolio", "Scalable · Investment", "€62,190.83", "+4.7%", C.purple],
  ],
  budgets: [
    ["Groceries", 81, "€486 / €600"],
    ["Dining out", 100, "€312 / €300"],
    ["Transport", 66, "€164 / €250"],
    ["Shopping", 53, "€210 / €400"],
  ],
  transactions: [
    ["Whole Foods", "Groceries · Everyday", "-€64.20", "Today"],
    ["Spotify", "Subscriptions · Amex Gold", "-€10.99", "Today"],
    ["Salary — Northwind", "Income · Everyday", "+€4,200.00", "Yesterday"],
    ["Uber", "Transport · Amex Gold", "-€18.40", "Yesterday"],
    ["Blue Bottle", "Dining · Everyday", "-€6.50", "Mon"],
    ["Vattenfall", "Utilities · Everyday", "-€78.00", "Mon"],
    ["Apple", "Shopping · Amex Gold", "-€249.00", "Sun"],
    ["Rent — Kastanienallee", "Housing · Everyday", "-€1,180.00", "Sat"],
  ],
  recurring: [
    ["Rent", "Monthly · 1st", "€1,180.00", "in 12 days"],
    ["Spotify Family", "Monthly · 4th", "€10.99", "in 15 days"],
    ["Gym", "Monthly · 7th", "€39.00", "in 18 days"],
    ["iCloud 2TB", "Monthly · 12th", "€9.99", "in 23 days"],
    ["Insurance", "Quarterly", "€148.50", "in 31 days"],
  ],
  spending: [
    ["Housing", "€1,180", C.teal],
    ["Groceries", "€486", C.blue],
    ["Dining", "€312", C.yellow],
    ["Transport", "€164", C.orange],
    ["Fun", "€270", C.purple],
  ],
};

function Panel({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: object;
}) {
  return <View style={[styles.panel, style]}>{children}</View>;
}
function Title({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: string;
}) {
  return (
    <View style={styles.panelTitle}>
      <View>
        <Text style={styles.panelHeading}>{title}</Text>
        {hint && <Text style={styles.hint}>{hint}</Text>}
      </View>
      {action && <Text style={styles.action}>{action}</Text>}
    </View>
  );
}
function Delta({ value = "+5.7%" }: { value?: string }) {
  return (
    <Text style={[styles.delta, value.startsWith("-") && styles.negative]}>
      {value}
    </Text>
  );
}
function Bar({ value, color = C.teal }: { value: number; color?: string }) {
  return (
    <View style={styles.barTrack}>
      <View
        style={[styles.barFill, { width: `${value}%`, backgroundColor: color }]}
      />
    </View>
  );
}

function NetWorth() {
  const [activeIndex, setActiveIndex] = useState(2);
  const points = chartPoints([
    68_200, 70_140, 71_980, 74_510, 76_920, 79_430, 83_967,
  ]);
  const values = [68_200, 70_140, 71_980, 74_510, 76_920, 79_430, 83_967];
  const activePoint = pointAtIndex(points, activeIndex) ?? points[2];
  const activeValue = values[activeIndex] ?? values[2];
  const [chartWidth, setChartWidth] = useState(0);
  const chartTooltipLeft = tooltipLeft(
    (activePoint.x / 100) * chartWidth,
    chartWidth,
  );
  const path = points
    .map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`)
    .join(" ");
  return (
    <Panel style={styles.netWorth}>
      <View style={styles.hero}>
        <Text style={styles.kicker}>NET WORTH</Text>
        <View style={styles.heroRow}>
          <Text style={styles.money}>€83,967.10</Text>
          <Delta />
          <Text style={styles.heroHint}>vs. last month</Text>
        </View>
      </View>
      <View
        style={styles.lineChart}
        onLayout={({ nativeEvent }) => setChartWidth(nativeEvent.layout.width)}
      >
        <Svg
          width="100%"
          height="100%"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <Defs>
            <LinearGradient id="netWorthFill" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={C.teal} stopOpacity=".22" />
              <Stop offset="1" stopColor={C.teal} stopOpacity="0" />
            </LinearGradient>
          </Defs>
          <Path d={`${path} L100 100 L0 100 Z`} fill="url(#netWorthFill)" />
          <Path d={path} fill="none" stroke={C.teal} strokeWidth="1.15" />
          <Line
            x1={activePoint.x}
            x2={activePoint.x}
            y1="17"
            y2="100"
            stroke="#dbe2dd"
            strokeWidth=".35"
          />
          <Circle
            cx={activePoint.x}
            cy={activePoint.y}
            r="1.6"
            fill={C.teal}
            stroke="#fff"
            strokeWidth=".7"
          />
        </Svg>
        <View style={styles.chartHitTargets}>
          {points.map((point, index) => (
            <Pressable
              key={point.label}
              accessibilityLabel={`Show ${point.label} net worth`}
              focusable={false}
              onHoverIn={() => setActiveIndex(index)}
              onPointerMove={() => setActiveIndex(index)}
              onPress={() => setActiveIndex(index)}
              style={styles.chartHitTarget}
            />
          ))}
        </View>
        <View
          pointerEvents="none"
          style={[
            styles.chartTooltip,
            { left: chartTooltipLeft, top: `${activePoint.y}%` },
          ]}
        >
          <Text style={styles.tooltipMonth}>{activePoint.label}</Text>
          <Text style={styles.tooltipValue}>
            Net worth: €{activeValue.toLocaleString("en-US")}
          </Text>
        </View>
      </View>
      <View style={styles.chartMonths}>
        {points.map((x) => (
          <Text key={x.label} style={styles.chartMonth}>
            {x.label}
          </Text>
        ))}
      </View>
    </Panel>
  );
}
function Accounts() {
  return (
    <Panel>
      <Title title="Accounts" hint="4 connected" action="Manage" />
      {data.accounts.map((a) => (
        <View key={a[0]} style={styles.row}>
          <View style={[styles.logo, { backgroundColor: a[4] as string }]}>
            <Text style={styles.logoText}>{(a[1] as string).slice(0, 2)}</Text>
          </View>
          <View style={styles.grow}>
            <Text style={styles.rowTitle}>{a[0]}</Text>
            <Text style={styles.hint}>{a[1]}</Text>
          </View>
          <View>
            <Text style={styles.amount}>{a[2]}</Text>
            <Text
              style={[
                styles.deltaText,
                (a[3] as string).startsWith("-") && styles.redText,
              ]}
            >
              {a[3]}
            </Text>
          </View>
        </View>
      ))}
    </Panel>
  );
}
function Spending() {
  return (
    <Panel>
      <Title title="Spending" hint="August, by category" />
      <View style={styles.spending}>
        <View style={styles.donut}>
          <View style={styles.donutHole}>
            <Text style={styles.donutMoney}>€2,412</Text>
            <Text style={styles.tiny}>this month</Text>
          </View>
        </View>
        <View style={styles.grow}>
          {data.spending.map((s) => (
            <View key={s[0]} style={styles.legend}>
              <View style={[styles.dot, { backgroundColor: s[2] as string }]} />
              <Text style={styles.legendLabel}>{s[0]}</Text>
              <Text style={styles.amount}>{s[1]}</Text>
            </View>
          ))}
        </View>
      </View>
    </Panel>
  );
}
function Budgets() {
  return (
    <Panel>
      <Title title="Budgets" hint="August progress" />
      {data.budgets.map((b) => (
        <View key={b[0]} style={styles.budget}>
          <View style={styles.budgetTop}>
            <Text style={styles.rowTitle}>{b[0]}</Text>
            <Text style={styles.hint}>
              <Text
                style={(b[1] as number) >= 100 ? styles.redText : styles.amount}
              >
                {b[2]}
              </Text>
            </Text>
          </View>
          <Bar
            value={b[1] as number}
            color={(b[1] as number) >= 100 ? C.red : C.teal}
          />
        </View>
      ))}
    </Panel>
  );
}
function Transactions({ limit }: { limit?: number }) {
  const { data: financeData } = useFinanceData();
  const [selectedId, setSelectedId] = useState<string>();
  const transactions = recentTransactions(
    financeData.transactions,
    limit ?? financeData.transactions.length,
  ) as MoneoTransaction[];
  return (
    <Panel>
      <Title
        title="Transactions"
        hint={transactions.length ? `${financeData.transactions.length} stored locally` : "No bank data imported"}
      />
      {!transactions.length && (
        <Text style={styles.emptyText}>Import a bank CSV to see exact transactions here.</Text>
      )}
      {transactions.map((transaction) => {
        const account = financeData.accounts.find(
          (item) => item.id === transaction.accountId,
        );
        const selected = selectedId === transaction.id;
        return (
          <View key={transaction.id}>
            <Pressable
              onPress={() => setSelectedId(selected ? undefined : transaction.id)}
              style={styles.transaction}
            >
              <View style={styles.merchant}>
                <Text style={styles.merchantText}>
                  {transaction.title.slice(0, 2).toUpperCase()}
                </Text>
              </View>
              <View style={styles.grow}>
                <Text style={styles.rowTitle}>{transaction.title}</Text>
                <Text style={styles.hint} numberOfLines={1}>
                  {transaction.transactionType || "Bank transaction"}
                  {account ? ` · ${account.displayName}` : ""}
                </Text>
              </View>
              <View>
                <Text
                  style={[
                    transaction.amountMinor.startsWith("-")
                      ? styles.amount
                      : styles.greenText,
                    styles.amount,
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
                <Text style={styles.detailLabel}>Original bank description</Text>
                <Text style={styles.detailValue}>{transaction.description}</Text>
                <View style={styles.detailGrid}>
                  {transaction.valueDate && (
                    <View style={styles.detailItem}>
                      <Text style={styles.detailLabel}>Value date</Text>
                      <Text style={styles.detailValue}>{transaction.valueDate}</Text>
                    </View>
                  )}
                  {transaction.sender && (
                    <View style={styles.detailItem}>
                      <Text style={styles.detailLabel}>Sender</Text>
                      <Text style={styles.detailValue}>{transaction.sender}</Text>
                    </View>
                  )}
                  {transaction.recipient && (
                    <View style={styles.detailItem}>
                      <Text style={styles.detailLabel}>Recipient</Text>
                      <Text style={styles.detailValue}>{transaction.recipient}</Text>
                    </View>
                  )}
                  {transaction.bankCategory && (
                    <View style={styles.detailItem}>
                      <Text style={styles.detailLabel}>Bank category</Text>
                      <Text style={styles.detailValue}>{transaction.bankCategory}</Text>
                    </View>
                  )}
                </View>
                {transaction.references.map((reference) => (
                  <View key={`${reference.type}-${reference.value}`} style={styles.referenceRow}>
                    <Text style={styles.detailLabel}>{reference.type}</Text>
                    <Text selectable style={[styles.detailValue, styles.grow]}>{reference.value}</Text>
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
function Recurring() {
  return (
    <Panel>
      <Title title="Recurring" hint="€1,388 committed each month" />
      {data.recurring.map((r) => (
        <View key={r[0]} style={styles.row}>
          <View style={styles.recurringMark} />
          <View style={styles.grow}>
            <Text style={styles.rowTitle}>{r[0]}</Text>
            <Text style={styles.hint}>{r[1]}</Text>
          </View>
          <View>
            <Text style={styles.amount}>{r[2]}</Text>
            <Text style={[styles.hint, styles.right]}>{r[3]}</Text>
          </View>
        </View>
      ))}
    </Panel>
  );
}
function Investments() {
  return (
    <Panel>
      <Title title="Investments" hint="Portfolio €62,190.83" action="+4.7%" />
      <View style={styles.investmentBars}>
        {[75, 55, 37, 21].map((h, i) => (
          <View key={i} style={styles.investmentColumn}>
            <View style={[styles.investmentBar, { height: `${h}%` }]} />
            <Text style={styles.tiny}>
              {["VWCE", "AAPL", "BTC", "Cash"][i]}
            </Text>
          </View>
        ))}
      </View>
      {[
        ["VWCE", "FTSE All-World", "€34,820", "+5.2%"],
        ["AAPL", "Apple Inc.", "€12,240", "+2.8%"],
        ["BTC", "Bitcoin", "€9,840", "-3.4%"],
        ["Cash", "Money market", "€5,290", "+0.4%"],
      ].map((h) => (
        <View key={h[0]} style={styles.holding}>
          <Text style={styles.holdingName}>{h[0]}</Text>
          <Text style={[styles.hint, styles.grow]}>{h[1]}</Text>
          <Text style={styles.amount}>{h[2]}</Text>
          <Text
            style={h[3].startsWith("-") ? styles.redText : styles.greenText}
          >
            {h[3]}
          </Text>
        </View>
      ))}
    </Panel>
  );
}
function Insight() {
  return (
    <View style={styles.insight}>
      <Text style={styles.insightKicker}>✦ AI INSIGHT</Text>
      <Text style={styles.insightText}>
        Dining is trending 18% above your usual pace, but two subscriptions went
        unused in July. Cancelling them covers the gap.
      </Text>
      <Pressable style={styles.insightButton}>
        <Text style={styles.insightButtonText}>Open in AI workspace ↗</Text>
      </Pressable>
    </View>
  );
}
function Pinned() {
  return (
    <View style={styles.pinned}>
      <View style={styles.pinnedTitle}>
        <Text style={styles.pin}>⚑</Text>
        <Text style={styles.panelHeading}>Pinned from AI</Text>
        <Text style={styles.badge}>2 views</Text>
      </View>
      <View style={styles.twoCol}>
        <Panel style={styles.flex}>
          <Title
            title="Coffee habit tracker"
            hint="✦ “how much do I spend on coffee?”"
          />
          <View style={styles.coffee}>
            {[62, 78, 94, 41].map((x, i) => (
              <View key={i} style={styles.coffeeCol}>
                <Text style={styles.tiny}>€{x}</Text>
                <View style={[styles.coffeeBar, { height: x }]} />
                <Text style={styles.tiny}>
                  {["May", "Jun", "Jul", "Aug"][i]}
                </Text>
              </View>
            ))}
          </View>
        </Panel>
        <Panel style={styles.flex}>
          <Title
            title="Subscription audit"
            hint="✦ “find subscriptions I don’t use”"
          />
          <View style={styles.audit}>
            <Text style={styles.rowTitle}>
              Unused since May <Text style={styles.greenText}>€35/mo</Text>
            </Text>
            <Text style={styles.hint}>Adobe CC · Audible</Text>
          </View>
          <View style={styles.audit}>
            <Text style={styles.rowTitle}>
              Price increased <Text style={styles.greenText}>€6/mo</Text>
            </Text>
            <Text style={styles.hint}>Netflix · iCloud</Text>
          </View>
        </Panel>
      </View>
    </View>
  );
}

function AIWorkspace({ compact = false }: { compact?: boolean }) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([
    { user: true, text: "Where did my money actually go last month?" },
    {
      user: false,
      text: "Housing took 49% of your outflow, but the real change is Dining — €312 across 21 visits, up 18% on your six-month average. I built an interactive breakdown on the right.",
    },
  ]);
  const [table, setTable] = useState(false);
  const send = () => {
    if (!input.trim()) return;
    setMessages([
      ...messages,
      { user: true, text: input },
      {
        user: false,
        text: "Rebuilt the view using 412 transactions across 4 accounts. Pin it if you’d like it on your dashboard.",
      },
    ]);
    setInput("");
  };
  return (
    <View style={[styles.aiLayout, compact && styles.mobileStack]}>
      <Panel style={[styles.aiPanel, compact && styles.aiPanelMobile]}>
        <ScrollView contentContainerStyle={styles.messages}>
          {messages.map((m, i) => (
            <View
              key={i}
              style={m.user ? styles.userBubbleWrap : styles.aiBubbleWrap}
            >
              <Text style={m.user ? styles.userBubble : styles.aiBubble}>
                {m.text}
              </Text>
            </View>
          ))}
        </ScrollView>
        <View style={styles.promptRow}>
          {[
            "Can I afford a €2,400 trip in October?",
            "Show my dining spend by weekday",
            "Forecast my savings to December",
          ].map((p) => (
            <Pressable
              key={p}
              onPress={() => setInput(p)}
              style={styles.prompt}
            >
              <Text style={styles.promptText}>{p}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.inputRow}>
          <TextInput
            value={input}
            onChangeText={setInput}
            onSubmitEditing={send}
            placeholder="Ask about your money…"
            placeholderTextColor={C.muted}
            style={styles.input}
          />
          <Pressable onPress={send} style={styles.send}>
            <Text style={styles.sendText}>↑</Text>
          </Pressable>
        </View>
      </Panel>
      <Panel style={[styles.aiPanel, compact && styles.aiPanelMobile]}>
        <View style={styles.generatedHead}>
          <View>
            <Text style={styles.kicker}>✦ GENERATED VIEW</Text>
            <Text style={styles.generatedTitle}>
              Outflow breakdown · August
            </Text>
          </View>
          <Pressable style={styles.pinButton}>
            <Text style={styles.pinButtonText}>⚑ Pin to dashboard</Text>
          </Pressable>
        </View>
        <View style={styles.tabs}>
          <Pressable
            onPress={() => setTable(false)}
            style={[styles.tab, !table && styles.tabActive]}
          >
            <Text style={styles.tabText}>◒ Chart</Text>
          </Pressable>
          <Pressable
            onPress={() => setTable(true)}
            style={[styles.tab, table && styles.tabActive]}
          >
            <Text style={styles.tabText}>▤ Transactions</Text>
          </Pressable>
        </View>
        {table ? (
          <Transactions limit={8} />
        ) : (
          <View style={styles.outflow}>
            {data.spending.map((s, i) => (
              <View key={s[0]} style={styles.outflowRow}>
                <Text style={styles.rowTitle}>{s[0]}</Text>
                <Text style={styles.amount}>{s[1]}</Text>
                <Bar value={[100, 42, 27, 14, 23][i]} color={s[2] as string} />
              </View>
            ))}
            <View style={styles.aiNote}>
              <Text style={styles.noteText}>
                ⌁ Dining is your fastest growing category. Capping it at{" "}
                <Text style={styles.amount}>€260</Text> keeps your savings rate
                at 24%.
              </Text>
            </View>
          </View>
        )}
      </Panel>
    </View>
  );
}

export function FinanceWorkspace({ page }: { page: Page }) {
  const router = useRouter();
  const { data: financeData } = useFinanceData();
  const { width } = useWindowDimensions();
  const desktop = width >= 1024;
  const title: Record<Page, [string, string]> = {
    index: [
      "Good morning, Mara",
      "Saturday, 8 August · everything is up to date",
    ],
    transactions: [
      "Transactions",
      financeData.transactions.length
        ? `${financeData.transactions.length} stored locally across ${financeData.accounts.length} account${financeData.accounts.length === 1 ? "" : "s"}`
        : "Import a bank CSV to begin",
    ],
    budgets: ["Budgets", "August · €1,172 of €1,550 used"],
    investments: ["Investments", "Portfolio €62,190.83 · +4.7% this month"],
    recurring: [
      "Recurring payments",
      "5 detected · €1,388 committed each month",
    ],
    ai: ["AI Workspace", "Ask anything. Get a view. Pin what matters."],
  };
  const nav = (route: string) =>
    router.push(`/${route === "index" ? "" : route}` as never);
  const pageContent =
    page === "ai" ? (
      <AIWorkspace compact={!desktop} />
    ) : page === "transactions" ? (
      <View style={[styles.contentGrid, !desktop && styles.mobileStack]}>
        <Transactions />
      </View>
    ) : page === "budgets" ? (
      <View style={[styles.contentGrid, !desktop && styles.mobileStack]}>
        <Budgets />
        <View style={styles.stack}>
          <Insight />
          <Spending />
        </View>
      </View>
    ) : page === "investments" ? (
      <View style={[styles.contentGrid, !desktop && styles.mobileStack]}>
        <View style={styles.stack}>
          <NetWorth />
          <Investments />
        </View>
        <Accounts />
      </View>
    ) : page === "recurring" ? (
      <View style={[styles.contentGrid, !desktop && styles.mobileStack]}>
        <Recurring />
        <Insight />
      </View>
    ) : (
      <>
        <View style={[styles.dashboardGrid, !desktop && styles.mobileStack]}>
          <View style={[styles.mainColumn, !desktop && styles.fullWidth]}>
            <NetWorth />
            <View style={[styles.twoCol, !desktop && styles.mobileStack]}>
              <Spending />
              <Budgets />
            </View>
            <Transactions />
          </View>
          <View style={[styles.sideColumn, !desktop && styles.fullWidth]}>
            <Insight />
            <Accounts />
            <Recurring />
            <Investments />
          </View>
        </View>
        <Pinned />
      </>
    );
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.app}>
        {desktop && (
          <View style={styles.sidebar}>
            <Pressable onPress={() => nav("index")} style={styles.brand}>
              <View style={styles.brandMark}>
                <Text style={styles.brandLetter}>L</Text>
              </View>
              <View>
                <Text style={styles.brandName}>Lumen</Text>
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
              style={[styles.navItem, page === "ai" && styles.navAI]}
            >
              <Text style={styles.navIcon}>✦</Text>
              <Text style={[styles.navText, page === "ai" && styles.navTextAI]}>
                AI Workspace
              </Text>
            </Pressable>
            <View style={styles.safeSpend}>
              <Text style={styles.safeLabel}>Safe to spend</Text>
              <Text style={styles.safeMoney}>€1,284</Text>
              <Text style={styles.hint}>until 31 August</Text>
            </View>
            <Pressable style={styles.navItem}>
              <Text style={styles.navIcon}>⚙</Text>
              <Text style={styles.navText}>Settings</Text>
            </Pressable>
          </View>
        )}
        <View style={styles.body}>
          <View style={styles.header}>
            <View style={styles.grow}>
              <Text style={styles.screenTitle}>{title[page][0]}</Text>
              <Text style={styles.screenSubtitle}>{title[page][1]}</Text>
            </View>
            {desktop && (
              <View style={styles.search}>
                <Text style={styles.hint}>⌕ Ask anything… ⌘K</Text>
              </View>
            )}
            <View style={styles.bell}>
              <Text>♧</Text>
            </View>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>MK</Text>
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
    width: 248,
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
    shadowColor: C.ink,
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 2,
  },
  navAI: { backgroundColor: C.teal },
  navIcon: { fontSize: 18, color: C.muted, width: 18, textAlign: "center" },
  navText: { fontSize: 14, fontWeight: "600", color: C.muted },
  navTextActive: { color: C.ink },
  navTextAI: { color: "#fff" },
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
    backgroundColor: C.card,
    borderRadius: 16,
    padding: 16,
    marginHorizontal: 1,
    marginBottom: 4,
    shadowColor: C.ink,
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 1,
  },
  safeLabel: { fontSize: 12, fontWeight: "700", color: C.ink },
  safeMoney: { fontSize: 24, fontWeight: "800", color: C.ink, marginTop: 4 },
  body: { flex: 1, minWidth: 0 },
  header: {
    height: 91,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 24,
    borderBottomWidth: 1,
    borderColor: C.line,
    backgroundColor: C.bg,
  },
  screenTitle: {
    fontSize: 22,
    fontWeight: "800",
    color: C.ink,
    letterSpacing: -0.5,
  },
  screenSubtitle: { fontSize: 14, color: C.muted, marginTop: 2 },
  grow: { flex: 1, minWidth: 0 },
  search: {
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: C.card,
    width: 260,
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
  avatar: {
    height: 40,
    width: 40,
    borderRadius: 20,
    backgroundColor: C.tealSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontWeight: "800", fontSize: 13, color: C.ink },
  content: {
    padding: 32,
    alignSelf: "center",
    width: "100%",
    maxWidth: 1180,
    paddingBottom: 72,
  },
  panel: {
    backgroundColor: C.card,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: C.line,
    padding: 24,
    shadowColor: C.ink,
    shadowOpacity: 0.07,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 7 },
    elevation: 2,
  },
  panelTitle: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 20,
  },
  panelHeading: { fontSize: 15, fontWeight: "800", color: C.ink },
  hint: { fontSize: 12, color: C.muted, marginTop: 2 },
  action: { fontSize: 12, fontWeight: "800", color: C.teal },
  dashboardGrid: { gap: 20, flexDirection: "row" },
  mainColumn: { flex: 2, gap: 20 },
  sideColumn: { flex: 1, gap: 20 },
  contentGrid: { gap: 20, flexDirection: "row" },
  mobileStack: { flexDirection: "column" },
  fullWidth: {
    width: "100%",
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: "auto",
  },
  stack: { flex: 1, gap: 20 },
  netWorth: { padding: 0, overflow: "hidden" },
  hero: { padding: 24, backgroundColor: "#eaf5ef" },
  kicker: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.5,
    color: C.muted,
  },
  heroRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    marginTop: 9,
    flexWrap: "wrap",
  },
  money: { fontSize: 38, fontWeight: "800", color: C.ink, letterSpacing: -1 },
  delta: {
    fontSize: 12,
    fontWeight: "800",
    color: "#356f5b",
    backgroundColor: "#d9eee2",
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 3,
  },
  negative: { color: C.red, backgroundColor: "#fae6e1" },
  heroHint: { fontSize: 12, color: C.muted, marginBottom: 5 },
  chart: {
    height: 164,
    paddingHorizontal: 32,
    paddingTop: 30,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 12,
  },
  chartBar: {
    flex: 1,
    backgroundColor: C.teal,
    borderRadius: 8,
    opacity: 0.85,
  },
  chartMonths: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    paddingBottom: 15,
  },
  chartMonth: { fontSize: 11, color: C.muted },
  row: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    paddingVertical: 9,
  },
  logo: {
    height: 36,
    width: 36,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: { fontSize: 10, fontWeight: "800", color: "#fff" },
  rowTitle: { fontSize: 14, fontWeight: "700", color: C.ink },
  amount: { fontSize: 13, fontWeight: "700", color: C.ink },
  deltaText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#3f8a70",
    textAlign: "right",
    marginTop: 2,
  },
  redText: { color: C.red },
  greenText: { color: "#3f8a70" },
  right: { textAlign: "right" },
  spending: { flexDirection: "row", gap: 18, alignItems: "center" },
  donut: {
    height: 126,
    width: 126,
    borderRadius: 63,
    borderWidth: 18,
    borderColor: C.teal,
    alignItems: "center",
    justifyContent: "center",
    borderTopColor: C.yellow,
    borderRightColor: C.blue,
    borderBottomColor: C.orange,
  },
  donutHole: { alignItems: "center" },
  donutMoney: { fontSize: 17, fontWeight: "800", color: C.ink },
  tiny: { fontSize: 10, color: C.muted },
  legend: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingVertical: 3,
  },
  dot: { height: 8, width: 8, borderRadius: 4 },
  legendLabel: { flex: 1, fontSize: 13, color: C.muted },
  budget: { marginBottom: 16 },
  budgetTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 7,
  },
  barTrack: {
    height: 8,
    borderRadius: 4,
    overflow: "hidden",
    backgroundColor: "#edf0ec",
  },
  barFill: { height: "100%", borderRadius: 4 },
  transaction: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderColor: "#edf0ec",
  },
  emptyText: { color: C.muted, fontSize: 13, paddingVertical: 12 },
  transactionDetail: {
    backgroundColor: "#f7f9f6",
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
    gap: 7,
  },
  detailGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  detailItem: { minWidth: 150, flex: 1 },
  detailLabel: { color: C.muted, fontSize: 10, fontWeight: "700", textTransform: "uppercase" },
  detailValue: { color: C.ink, fontSize: 12, lineHeight: 17 },
  referenceRow: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  sourceText: { color: C.muted, fontSize: 10, marginTop: 3 },
  merchant: {
    height: 36,
    width: 36,
    borderRadius: 11,
    backgroundColor: "#edf0ec",
    alignItems: "center",
    justifyContent: "center",
  },
  merchantText: { fontSize: 10, fontWeight: "800", color: C.muted },
  recurringMark: {
    height: 32,
    width: 4,
    borderRadius: 3,
    backgroundColor: C.tealSoft,
  },
  investmentBars: {
    height: 120,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 18,
    marginBottom: 15,
  },
  investmentColumn: {
    flex: 1,
    height: "100%",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 4,
  },
  investmentBar: { width: "70%", backgroundColor: C.teal, borderRadius: 8 },
  holding: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    paddingVertical: 4,
  },
  holdingName: { width: 44, fontSize: 13, fontWeight: "800", color: C.ink },
  insight: {
    borderRadius: 22,
    padding: 24,
    backgroundColor: C.teal,
    shadowColor: C.ink,
    shadowOpacity: 0.12,
    shadowRadius: 18,
    elevation: 2,
  },
  insightKicker: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.4,
    color: "#d9eee2",
  },
  insightText: {
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 22,
    color: "#fff",
    marginTop: 12,
  },
  insightButton: {
    alignSelf: "flex-start",
    borderRadius: 18,
    backgroundColor: "#ffffff22",
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: 18,
  },
  insightButtonText: { fontSize: 12, fontWeight: "700", color: "#fff" },
  pinned: { marginTop: 34 },
  pinnedTitle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
  },
  pin: { color: C.teal },
  badge: {
    fontSize: 11,
    fontWeight: "700",
    color: C.muted,
    backgroundColor: "#edf0ec",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  twoCol: { flexDirection: "row", gap: 20 },
  flex: { flex: 1 },
  coffee: {
    height: 120,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 12,
  },
  coffeeCol: { flex: 1, alignItems: "center", gap: 5 },
  coffeeBar: {
    width: "75%",
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    backgroundColor: C.teal,
  },
  audit: {
    backgroundColor: "#f1f4f0",
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
  },
  aiLayout: { flexDirection: "row", gap: 20 },
  aiPanel: { flex: 1, height: 640, padding: 0, overflow: "hidden" },
  aiPanelMobile: {
    width: "100%",
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: "auto",
    height: 560,
  },
  messages: { padding: 24, gap: 20 },
  userBubbleWrap: { alignItems: "flex-end" },
  aiBubbleWrap: { alignItems: "flex-start" },
  userBubble: {
    maxWidth: "82%",
    fontSize: 14,
    lineHeight: 20,
    color: "#fff",
    backgroundColor: C.teal,
    padding: 14,
    borderRadius: 18,
  },
  aiBubble: { maxWidth: "86%", fontSize: 14, lineHeight: 21, color: C.ink },
  promptRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingHorizontal: 15,
    paddingBottom: 10,
  },
  prompt: {
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 14,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  promptText: { fontSize: 10, color: C.muted, fontWeight: "600" },
  inputRow: {
    margin: 14,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 18,
    backgroundColor: "#f5f7f4",
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 14,
  },
  input: { flex: 1, fontSize: 14, color: C.ink, paddingVertical: 12 },
  send: {
    height: 36,
    width: 36,
    borderRadius: 18,
    backgroundColor: C.teal,
    alignItems: "center",
    justifyContent: "center",
    margin: 4,
  },
  sendText: { fontSize: 18, color: "#fff", fontWeight: "800" },
  generatedHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
    padding: 20,
    borderBottomWidth: 1,
    borderColor: C.line,
  },
  generatedTitle: {
    fontSize: 17,
    fontWeight: "800",
    color: C.ink,
    marginTop: 5,
  },
  pinButton: {
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 18,
    paddingHorizontal: 11,
    paddingVertical: 8,
    alignSelf: "center",
  },
  pinButtonText: { fontSize: 11, fontWeight: "700", color: C.ink },
  tabs: {
    flexDirection: "row",
    gap: 5,
    padding: 12,
    borderBottomWidth: 1,
    borderColor: C.line,
  },
  tab: { borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  tabActive: { backgroundColor: C.tealSoft },
  tabText: { fontSize: 12, fontWeight: "700", color: C.ink },
  outflow: { padding: 24, gap: 15 },
  outflowRow: { gap: 6 },
  aiNote: {
    borderRadius: 14,
    backgroundColor: "#f1f4f0",
    padding: 14,
    marginTop: 7,
  },
  noteText: { fontSize: 13, lineHeight: 19, color: C.muted },
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
  mobileContent: { padding: 16, paddingBottom: 94 },
  lineChart: {
    height: 180,
    marginHorizontal: 20,
    position: "relative",
    overflow: "hidden",
  },
  chartHitTargets: {
    ...StyleSheet.absoluteFill,
    flexDirection: "row",
    zIndex: 2,
  },
  chartHitTarget: { flex: 1 },
  chartWash: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "74%",
    backgroundColor: "#f3faf6",
    opacity: 0.72,
  },
  lineSegment: {
    position: "absolute",
    height: 3,
    backgroundColor: C.teal,
    borderRadius: 2,
    transformOrigin: "left center",
  },
  crosshair: {
    position: "absolute",
    top: 30,
    bottom: 0,
    width: 1,
    backgroundColor: "#dbe2dd",
  },
  focusPoint: {
    position: "absolute",
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: C.teal,
    borderWidth: 2,
    borderColor: "#fff",
    marginLeft: -5,
    marginTop: -5,
  },
  chartTooltip: {
    position: "absolute",
    width: 168,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 16,
    padding: 14,
    marginTop: -24,
    shadowColor: C.ink,
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 3,
    zIndex: 3,
  },
  tooltipMonth: { fontSize: 13, color: C.ink, fontWeight: "600" },
  tooltipValue: { fontSize: 13, color: C.teal, marginTop: 7 },
});
