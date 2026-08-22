import test from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryCatalog,
  categorizeTransaction,
  counterpartyKeyFor,
  normalizeEvidenceText,
  searchCategories,
} from './transaction-categorization.mjs';

const base = {
  bookingDate: '2026-08-08', amountMinor: '-1234', currency: 'EUR', currencyMinorUnit: 2,
  title: 'Unknown', description: '', references: [],
  source: { fileName: 'statement.csv', rowNumber: 2, rawRecord: {} },
};

test('REWE plus matching bank category assigns groceries', () => {
  const result = categorizeTransaction({ ...base, title: 'REWE', recipient: 'REWE', bankCategory: 'Groceries' }, []);
  assert.deepEqual(result, {
    status: 'assigned', categoryId: 'food.groceries', confidence: 'high', method: 'built-in',
    evidence: ['Exact counterparty: REWE', 'Bank category: Groceries'],
  });
});

test('approved exact REWE alias assigns groceries without a bank category', () => {
  assert.equal(categorizeTransaction({ ...base, title: 'REWE', recipient: 'REWE' }, []).status, 'assigned');
});

test('Amazon merchant alone is only a medium suggestion', () => {
  assert.deepEqual(categorizeTransaction({ ...base, title: 'Amazon', recipient: 'Amazon' }, []), {
    status: 'suggested', categoryId: 'shopping.general', confidence: 'medium', evidence: ['Ambiguous counterparty: Amazon'],
  });
});

test('Commerzbank card payment counterparty matches by contained merchant phrase', () => {
  assert.deepEqual(
    categorizeTransaction({ ...base, title: 'NETTO MARKEN-DISCOU/AM MARKT 1/SAAR Kartenzahlung', recipient: 'NETTO MARKEN-DISCOU AM MARKT 1 SAAR' }, []),
    {
      status: 'assigned', categoryId: 'food.groceries', confidence: 'high', method: 'built-in',
      evidence: ['Counterparty match: NETTO MARKEN-DISCOU AM MARKT 1 SAAR'],
    },
  );
});

test('phrase matching respects word boundaries inside the counterparty key', () => {
  assert.equal(categorizeTransaction({ ...base, title: 'Garnetto market' }, []).status, 'unmatched');
});

test('real Commerzbank and Revolut merchants map to their categories', () => {
  const cases = [
    [{ title: 'VATTENFALL EUROPE SALES Strom Abschlag', recipient: 'VATTENFALL EUROPE SALES' }, 'utilities.energy'],
    [{ title: 'Lebara Germany Limited', recipient: 'Lebara Germany Limited' }, 'utilities.internet_phone'],
    [{ title: 'Techniker Krankenkasse Beitraege', recipient: 'Techniker Krankenkasse' }, 'health.insurance'],
    [{ title: 'Getsafe', recipient: 'Getsafe' }, 'health.insurance'],
    [{ title: 'Universität des Saarlandes Sport', recipient: 'Universität des Saarlandes Finanz- und Anlagebuchhaltung' }, 'education'],
    [{ title: 'Studierendenwerk Saarland', recipient: 'Studierendenwerk Saarland' }, 'education'],
    [{ title: 'Scalable Capital Broker withdrawal', sender: 'Scalable Capital GmbH' }, 'financial.investments'],
    [{ title: 'Anthropic', recipient: 'Anthropic' }, 'shopping.subscriptions'],
    [{ title: 'Windsurf', recipient: 'Windsurf' }, 'shopping.subscriptions'],
    [{ title: 'AUFLADUNG MENSA UNI SAAR-DE', recipient: 'AUFLADUNG MENSA UNI SAAR-DE Saarbr' }, 'food.restaurants'],
    [{ title: 'www.ridedott.com*Dott scooter ride*AMSTERDAM', recipient: '' }, 'transport.public_transit'],
    [{ title: 'Flixbus*Munchen', recipient: '' }, 'transport.public_transit'],
    [{ title: 'Aral', recipient: 'Aral' }, 'transport.fuel'],
    [{ title: 'Rothenbuehl Apotheke', recipient: 'Rothenbuehl Apotheke' }, 'health.pharmacy'],
    [{ title: 'Eventix', recipient: 'Eventix' }, 'leisure.tickets'],
    [{ title: 'dm drogerie', recipient: 'dm drogerie' }, 'shopping.general'],
  ];
  for (const [fields, categoryId] of cases) {
    const result = categorizeTransaction({ ...base, ...fields }, []);
    assert.equal(result.status, 'assigned', JSON.stringify(fields));
    assert.equal(result.categoryId, categoryId, JSON.stringify(fields));
    assert.equal(result.confidence, 'high', JSON.stringify(fields));
  }
});

test('salary employer rules only apply to incoming payments', () => {
  const incoming = categorizeTransaction({ ...base, amountMinor: '1051170', title: 'Lohn + Gehalt Juni 2026', sender: 'PersonalClientCare (PCC) GmbH' }, []);
  assert.equal(incoming.categoryId, 'income.salary');
  assert.equal(incoming.evidence.includes('Counterparty match: PersonalClientCare (PCC) GmbH'), true);
  assert.notEqual(
    categorizeTransaction({ ...base, amountMinor: '-100', title: 'Transfer to PersonalClientCare', recipient: 'PersonalClientCare (PCC) GmbH' }, []).categoryId,
    'income.salary',
  );
});

test('incoming salary phrase assigns salary but outgoing salary does not', () => {
  assert.equal(categorizeTransaction({ ...base, amountMinor: '250000', title: 'Gehalt August', transferPurpose: 'Gehalt August' }, []).categoryId, 'income.salary');
  assert.notEqual(categorizeTransaction({ ...base, title: 'Gehalt August', transferPurpose: 'Gehalt August' }, []).status, 'assigned');
});

test('SEPA transfer with rent purpose assigns rent while SEPA alone abstains', () => {
  const rent = categorizeTransaction({ ...base, title: 'SEPA transfer', transactionType: 'SEPA', transferPurpose: 'Miete August' }, []);
  const plain = categorizeTransaction({ ...base, title: 'SEPA transfer', transactionType: 'SEPA' }, []);
  assert.equal(rent.categoryId, 'housing.rent');
  assert.deepEqual(plain, { status: 'unmatched', confidence: 'low', evidence: [] });
});

test('bank category alone produces at most a medium suggestion', () => {
  assert.deepEqual(categorizeTransaction({ ...base, bankCategory: 'Groceries' }, []), {
    status: 'suggested', categoryId: 'food.groceries', confidence: 'medium', evidence: ['Bank category: Groceries'],
  });
});

test('exact user counterparty rule wins over built-in evidence', () => {
  const transaction = { ...base, title: 'REWE', recipient: 'REWE' };
  const rules = [{ id: 'rule-1', counterpartyKey: counterpartyKeyFor(transaction), categoryId: 'gifts.donation', createdAt: '2026-08-08T00:00:00Z' }];
  assert.deepEqual(categorizeTransaction(transaction, rules), {
    status: 'assigned', categoryId: 'gifts.donation', confidence: 'high', method: 'user-rule', evidence: ['Personal rule for REWE'],
  });
});

test('conflicting strong evidence abstains', () => {
  const result = categorizeTransaction({ ...base, amountMinor: '1000', title: 'REWE', recipient: 'REWE', transferPurpose: 'Gehalt August' }, []);
  assert.deepEqual(result, { status: 'unmatched', confidence: 'low', evidence: ['Conflicting category evidence'] });
});

test('matching uses whole words and never single letters or substrings', () => {
  assert.equal(categorizeTransaction({ ...base, title: 'Rental equipment' }, []).status, 'unmatched');
  assert.equal(categorizeTransaction({ ...base, title: 'A' }, []).status, 'unmatched');
  assert.equal(normalizeEvidenceText('  LIDL\u2014Berlin  '), 'lidl berlin');
});

test('recognized raw semantic headers contribute evidence without mutation', () => {
  const transaction = { ...base, title: 'Transfer', source: { ...base.source, rawRecord: { Verwendungszweck: 'Miete August', IBAN: 'DE123' } } };
  const before = structuredClone(transaction.source.rawRecord);
  assert.equal(categorizeTransaction(transaction, []).categoryId, 'housing.rent');
  assert.deepEqual(transaction.source.rawRecord, before);
});

test('counterparty key stays stable across normalized statement variants', () => {
  const first = { ...base, title: 'REWE Markt', recipient: ' REWE\u00a0Markt GmbH ' };
  const second = { ...base, title: 'Card payment REWE', recipient: 'REWE Markt GmbH' };
  assert.equal(counterpartyKeyFor(first), counterpartyKeyFor(second));
});

test('category catalog adds each persisted custom category once', () => {
  const rules = [
    { id: 'rule-1', counterpartyKey: 'fitx', categoryId: 'custom-gym', categoryLabel: 'Gym', createdAt: '2026-08-10T00:00:00Z' },
    { id: 'rule-2', counterpartyKey: 'mcfit', categoryId: 'custom-gym', categoryLabel: 'Gym', createdAt: '2026-08-10T00:00:00Z' },
    { id: 'rule-3', counterpartyKey: 'rewe', categoryId: 'food.groceries', createdAt: '2026-08-10T00:00:00Z' },
  ];

  const catalog = categoryCatalog(rules);

  assert.deepEqual(catalog.filter(({ id }) => id === 'custom-gym'), [
    { id: 'custom-gym', label: 'Gym', custom: true },
  ]);
  assert.ok(catalog.some(({ id, label, custom }) => id === 'food.groceries' && label === 'Groceries' && !custom));
});

test('category search normalizes names and ranks exact then prefix matches', () => {
  const catalog = [
    { id: 'custom-home-gym', label: 'Home Gym', custom: true },
    { id: 'custom-gym-membership', label: 'Gym Membership', custom: true },
    { id: 'custom-gym', label: 'Gym', custom: true },
  ];

  assert.deepEqual(searchCategories(catalog, ' GYM! ').map(({ id }) => id), [
    'custom-gym',
    'custom-gym-membership',
    'custom-home-gym',
  ]);
});

test('category search keeps a shorter existing name visible in a longer draft', () => {
  const catalog = [{ id: 'custom-gym', label: 'Gym', custom: true }];

  assert.deepEqual(searchCategories(catalog, 'Gym membership'), catalog);
});
