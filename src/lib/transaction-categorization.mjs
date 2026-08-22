export const CLASSIFIER_VERSION = 'moneo-category-v2';

export const MONEO_CATEGORIES = [
  ['income', 'Income', [['income.salary', 'Salary'], ['income.interest', 'Interest']]],
  ['housing', 'Housing', [['housing.rent', 'Rent']]],
  ['utilities', 'Utilities', [['utilities.energy', 'Energy'], ['utilities.internet_phone', 'Internet & phone']]],
  ['food', 'Food', [['food.groceries', 'Groceries'], ['food.restaurants', 'Restaurants']]],
  ['transport', 'Transport', [['transport.public_transit', 'Public transit'], ['transport.fuel', 'Fuel']]],
  ['shopping', 'Shopping', [['shopping.general', 'General shopping'], ['shopping.subscriptions', 'Subscriptions & software']]],
  ['health', 'Health', [['health.pharmacy', 'Pharmacy'], ['health.insurance', 'Insurance']]],
  ['leisure', 'Leisure', [['leisure.streaming', 'Streaming'], ['leisure.tickets', 'Tickets']]],
  ['travel', 'Travel', []],
  ['education', 'Education', []],
  ['financial', 'Financial', [['financial.bank_fee', 'Bank fee'], ['financial.investments', 'Investments']]],
  ['gifts', 'Gifts', [['gifts.donation', 'Donation']]],
  ['transfer', 'Transfers', [['transfer.internal', 'Internal transfer']]],
  ['other', 'Other', [['other.uncategorized', 'Needs category']]],
].map(([id, label, categories]) => ({
  id,
  label,
  categories: categories.map(([categoryId, categoryLabel]) => ({ id: categoryId, label: categoryLabel })),
}));

export function categoryCatalog(rules = []) {
  const options = MONEO_CATEGORIES.flatMap((group) =>
    group.categories.map((category) => ({ ...category, custom: false })),
  );
  const ids = new Set(options.map(({ id }) => id));
  for (const rule of rules) {
    if (!rule.categoryLabel || ids.has(rule.categoryId)) continue;
    options.push({ id: rule.categoryId, label: rule.categoryLabel.trim(), custom: true });
    ids.add(rule.categoryId);
  }
  return options;
}

export function searchCategories(catalog, query) {
  const normalizedQuery = normalizeEvidenceText(query);
  if (!normalizedQuery) return catalog;
  return catalog
    .map((category, index) => {
      const label = normalizeEvidenceText(category.label);
      const rank = label === normalizedQuery ? 0 : label.startsWith(normalizedQuery) ? 1 : label.includes(normalizedQuery) || normalizedQuery.includes(label) ? 2 : 3;
      return { category, index, rank };
    })
    .filter(({ rank }) => rank < 3)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ category }) => category);
}

const counterpartyRules = [
  { aliases: ['rewe', 'rewe markt'], categoryId: 'food.groceries' },
  { aliases: ['edeka'], categoryId: 'food.groceries' },
  { aliases: ['aldi', 'aldi nord', 'aldi sued', 'aldi süd'], categoryId: 'food.groceries' },
  { aliases: ['lidl', 'netto', 'kaufland', 'globus', 'dz markt', 'campusmarkt', 'euroshop', 'woolworth', 'tedi', 'asia market', 'asia markt', 'dallmayr', 'coop', 'bereket', 'frischmarkt'], categoryId: 'food.groceries' },
  { aliases: ['burger king', 'mcdonalds', 'mcdonald s', 'kfc', 'subway', 'domino', 'dominos', 'wolt', 'five guys', 'mr phung', 'asiahung', 'trento eiscafe', 'trento eiscafé', 'icoffee', 'barbarossa', 'postillion', 'da ma bistro', 'au sirop derable', 'maison behr', 'restaurant gaststaetten', 'lamm heidelberg', 'cafe unique', 'mensa uni saar', 'pommes freunde'], categoryId: 'food.restaurants' },
  { aliases: ['deutsche bahn', 'db vertrieb', 'flixbus', 'cfl mobilites', 'dott scooter', 'ridedott'], categoryId: 'transport.public_transit' },
  { aliases: ['aral', 'totalenergies'], categoryId: 'transport.fuel' },
  { aliases: ['vattenfall'], categoryId: 'utilities.energy' },
  { aliases: ['lebara'], categoryId: 'utilities.internet_phone' },
  { aliases: ['netflix', 'spotify'], categoryId: 'leisure.streaming' },
  { aliases: ['rossmann', 'dm drogerie', 'temu', 'back market', 'primark', 'blumen becht', 'blumenladen ingrid', 'deutsche post'], categoryId: 'shopping.general' },
  { aliases: ['anthropic', 'windsurf'], categoryId: 'shopping.subscriptions' },
  { aliases: ['apotheke', 'zava'], categoryId: 'health.pharmacy' },
  { aliases: ['techniker krankenkasse', 'getsafe'], categoryId: 'health.insurance' },
  { aliases: ['universität des saarlandes', 'studierendenwerk'], categoryId: 'education' },
  { aliases: ['scalable capital'], categoryId: 'financial.investments' },
  { aliases: ['eventix'], categoryId: 'leisure.tickets' },
  { aliases: ['personalclientcare', '3kb'], direction: 'incoming', categoryId: 'income.salary' },
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

const internalTransferMarkers = [
  { phrase: 'to pocket', transactionType: 'transfer' },
  { phrase: 'pocket withdrawal', transactionType: 'transfer' },
  { phrase: 'open banking top up', transactionType: 'topup' },
];

function internalTransferEvidence(transaction) {
  const transactionType = normalizeEvidenceText(transaction.transactionType);
  const text = [transaction.title, transaction.description, transaction.transferPurpose]
    .map((value) => normalizeEvidenceText(value))
    .filter(Boolean)
    .join(' ');
  const marker = internalTransferMarkers.find(({ phrase, transactionType: expectedType }) =>
    transactionType === expectedType && hasPhrase(text, phrase));
  return marker ? `Internal transfer: ${marker.phrase}` : undefined;
}

function matchingRule(rules, key) {
  return rules.find((rule) => rule.counterpartyKey === key);
}

const MIN_PARTIAL_ALIAS_LENGTH = 4;

function aliasMatch(pack, key, outgoing) {
  let phraseHit;
  for (const rule of pack) {
    if ((rule.direction === 'incoming' && outgoing) || (rule.direction === 'outgoing' && !outgoing)) continue;
    for (const alias of rule.aliases) {
      const normalizedAlias = normalizeEvidenceText(alias);
      if (key === normalizedAlias) return { rule, exact: true };
      if (!phraseHit && normalizedAlias.length >= MIN_PARTIAL_ALIAS_LENGTH && hasPhrase(key, normalizedAlias)) {
        phraseHit = { rule, exact: false };
      }
    }
  }
  return phraseHit;
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

  const internalTransfer = internalTransferEvidence(transaction);
  if (internalTransfer) {
    return {
      status: 'assigned', categoryId: 'transfer.internal', confidence: 'high', method: 'built-in',
      evidence: [internalTransfer],
    };
  }

  const evidence = extractCategoryEvidence(transaction);
  const allText = evidence.map((item) => item.normalized).join(' ');
  const outgoing = String(transaction.amountMinor).startsWith('-');
  const strong = [];
  const merchant = aliasMatch(counterpartyRules, key, outgoing);
  if (merchant) {
    strong.push({
      categoryId: merchant.rule.categoryId,
      evidence: `${merchant.exact ? 'Exact counterparty' : 'Counterparty match'}: ${counterpartyDisplay}`,
    });
  }

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

  const ambiguous = aliasMatch(ambiguousCounterparties, key, outgoing);
  if (ambiguous) {
    return {
      status: 'suggested', categoryId: ambiguous.rule.categoryId, confidence: 'medium',
      evidence: [`${ambiguous.exact ? 'Ambiguous counterparty' : 'Ambiguous counterparty match'}: ${counterpartyDisplay}`],
    };
  }
  if (bank) {
    return { status: 'suggested', categoryId: bank.categoryId, confidence: 'medium', evidence: [bankEvidence] };
  }
  return { status: 'unmatched', confidence: 'low', evidence: [] };
}
