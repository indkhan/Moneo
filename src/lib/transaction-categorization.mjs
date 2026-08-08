export const CLASSIFIER_VERSION = 'moneo-category-v1';

export const MONEO_CATEGORIES = [
  ['income', 'Income', [['income.salary', 'Salary'], ['income.interest', 'Interest']]],
  ['housing', 'Housing', [['housing.rent', 'Rent']]],
  ['utilities', 'Utilities', [['utilities.energy', 'Energy'], ['utilities.internet_phone', 'Internet & phone']]],
  ['food', 'Food', [['food.groceries', 'Groceries'], ['food.restaurants', 'Restaurants']]],
  ['transport', 'Transport', [['transport.public_transit', 'Public transit'], ['transport.fuel', 'Fuel']]],
  ['shopping', 'Shopping', [['shopping.general', 'General shopping']]],
  ['health', 'Health', [['health.pharmacy', 'Pharmacy']]],
  ['leisure', 'Leisure', [['leisure.streaming', 'Streaming']]],
  ['travel', 'Travel', []],
  ['education', 'Education', []],
  ['financial', 'Financial', [['financial.bank_fee', 'Bank fee']]],
  ['gifts', 'Gifts', [['gifts.donation', 'Donation']]],
  ['other', 'Other', [['other.uncategorized', 'Needs category']]],
].map(([id, label, categories]) => ({
  id,
  label,
  categories: categories.map(([categoryId, categoryLabel]) => ({ id: categoryId, label: categoryLabel })),
}));

const exactCounterparties = [
  { aliases: ['rewe', 'rewe markt'], categoryId: 'food.groceries' },
  { aliases: ['edeka'], categoryId: 'food.groceries' },
  { aliases: ['aldi', 'aldi nord', 'aldi sued', 'aldi süd'], categoryId: 'food.groceries' },
  { aliases: ['lidl', 'netto', 'kaufland'], categoryId: 'food.groceries' },
  { aliases: ['deutsche bahn', 'db vertrieb'], categoryId: 'transport.public_transit' },
  { aliases: ['netflix', 'spotify'], categoryId: 'leisure.streaming' },
];

const ambiguousCounterparties = [
  { aliases: ['amazon', 'paypal', 'apple', 'google'], categoryId: 'shopping.general' },
];

const bankCategories = [
  { phrases: ['groceries', 'grocery', 'lebensmittel'], categoryId: 'food.groceries' },
  { phrases: ['salary', 'earnings', 'gehalt'], categoryId: 'income.salary' },
  { phrases: ['rent', 'miete'], categoryId: 'housing.rent' },
  { phrases: ['bank fee', 'fees', 'gebuehren', 'gebühren'], categoryId: 'financial.bank_fee' },
];

const rawAliases = new Set([
  'purpose', 'transfer purpose', 'remittance', 'verwendungszweck',
  'category', 'kategorie', 'merchant', 'payee', 'recipient', 'empfanger', 'empfänger',
  'sender', 'payer', 'auftraggeber', 'booking text', 'description', 'buchungstext',
]);

export function normalizeEvidenceText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function displayText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

export function counterpartyKeyFor(transaction) {
  const outgoing = String(transaction.amountMinor).startsWith('-');
  const value = outgoing
    ? transaction.recipient || transaction.sender || transaction.title
    : transaction.sender || transaction.recipient || transaction.title;
  return normalizeEvidenceText(value)
    .replace(/^(?:card payment|kartenzahlung)\s+/, '')
    .replace(/\s+(?:gmbh|ag|ug|ltd|limited)$/, '');
}

export function extractCategoryEvidence(transaction) {
  const normalized = [
    ['title', transaction.title],
    ['description', transaction.description],
    ['sender', transaction.sender],
    ['recipient', transaction.recipient],
    ['purpose', transaction.transferPurpose],
    ['bankCategory', transaction.bankCategory],
    ['transactionType', transaction.transactionType],
    ...transaction.references.map((reference) => ['reference', reference.value]),
  ];
  for (const [header, value] of Object.entries(transaction.source?.rawRecord ?? {})) {
    if (rawAliases.has(normalizeEvidenceText(header))) normalized.push([`raw:${header}`, value]);
  }
  return normalized
    .map(([source, value]) => ({ source, value: displayText(value), normalized: normalizeEvidenceText(value) }))
    .filter((item) => item.normalized);
}

function hasPhrase(text, phrase) {
  return new RegExp(`(?:^| )${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`, 'u').test(text);
}

function matchingRule(rules, key) {
  return rules.find((rule) => rule.counterpartyKey === key);
}

function aliasMatch(pack, key) {
  return pack.find((rule) => rule.aliases.includes(key));
}

export function categorizeTransaction(transaction, userRules = []) {
  const key = counterpartyKeyFor(transaction);
  const counterpartyDisplay = displayText(
    String(transaction.amountMinor).startsWith('-')
      ? transaction.recipient || transaction.sender || transaction.title
      : transaction.sender || transaction.recipient || transaction.title,
  );
  const userRule = matchingRule(userRules, key);
  if (userRule) {
    return {
      status: 'assigned', categoryId: userRule.categoryId, confidence: 'high', method: 'user-rule',
      evidence: [`Personal rule for ${counterpartyDisplay}`],
    };
  }

  const evidence = extractCategoryEvidence(transaction);
  const allText = evidence.map((item) => item.normalized).join(' ');
  const outgoing = String(transaction.amountMinor).startsWith('-');
  const strong = [];
  const exact = aliasMatch(exactCounterparties, key);
  if (exact) strong.push({ categoryId: exact.categoryId, evidence: `Exact counterparty: ${counterpartyDisplay}` });

  const purposeText = evidence.filter((item) => item.source === 'purpose' || item.source.startsWith('raw:')).map((item) => item.normalized).join(' ');
  if (!outgoing && ['gehalt', 'lohn', 'salary', 'payroll'].some((phrase) => hasPhrase(purposeText || allText, phrase))) {
    strong.push({ categoryId: 'income.salary', evidence: 'Incoming salary phrase' });
  }
  if (outgoing && ['miete', 'mietzahlung', 'rent'].some((phrase) => hasPhrase(purposeText, phrase))) {
    strong.push({ categoryId: 'housing.rent', evidence: 'Outgoing rent phrase' });
  }
  if (outgoing && ['bank fee', 'kontofuehrungsgebuehr', 'kontoführungsgebühr'].some((phrase) => hasPhrase(purposeText || allText, phrase))) {
    strong.push({ categoryId: 'financial.bank_fee', evidence: 'Bank fee phrase' });
  }

  const categories = new Set(strong.map((signal) => signal.categoryId));
  if (categories.size > 1) return { status: 'unmatched', confidence: 'low', evidence: ['Conflicting category evidence'] };

  const bankText = normalizeEvidenceText(transaction.bankCategory);
  const bank = bankCategories.find((rule) => rule.phrases.some((phrase) => hasPhrase(bankText, phrase)));
  const bankEvidence = bank ? `Bank category: ${displayText(transaction.bankCategory)}` : undefined;
  if (strong.length) {
    const signal = strong[0];
    return {
      status: 'assigned', categoryId: signal.categoryId, confidence: 'high', method: 'built-in',
      evidence: [signal.evidence, ...(bank?.categoryId === signal.categoryId ? [bankEvidence] : [])],
    };
  }

  const ambiguous = aliasMatch(ambiguousCounterparties, key);
  if (ambiguous) {
    return {
      status: 'suggested', categoryId: ambiguous.categoryId, confidence: 'medium',
      evidence: [`Ambiguous counterparty: ${counterpartyDisplay}`],
    };
  }
  if (bank) {
    return { status: 'suggested', categoryId: bank.categoryId, confidence: 'medium', evidence: [bankEvidence] };
  }
  return { status: 'unmatched', confidence: 'low', evidence: [] };
}
