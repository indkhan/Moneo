import test from 'node:test';
import assert from 'node:assert/strict';
import {
  categorizeTransaction,
  counterpartyKeyFor,
  normalizeEvidenceText,
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
