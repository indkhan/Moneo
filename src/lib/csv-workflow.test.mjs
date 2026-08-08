import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeCsvBytes,
  detectCsvFormat,
  localAccountId,
  suggestColumnMapping,
} from './csv-workflow.mjs';
import { mappingSignature } from './csv-mapping.mjs';

const commerzbankCsv = `Booking date;Value date;Transaction type;Booking text;Amount;Currency;Account IBAN;Category;Sender;Recipient;Transfer purpose
08.08.2026;08.08.2026;Debit;Example;-5,00;EUR;DE00000000000000000000;Other;;Example;Coffee`;

const unknownCsv = `Date,Details,Amount,Currency\n2026-08-08,Coffee,-5.00,EUR`;
const mapping = {
  bankName: 'Example Bank',
  accountName: 'Main',
  accountIdentifier: 'example-main',
  dateFormat: 'YYYY-MM-DD',
  numberFormat: 'en-US',
  columns: {
    bookingDate: 'Date',
    title: 'Details',
    amount: 'Amount',
    currency: 'Currency',
  },
};

test('decodes UTF-8 and falls back to Windows-1252 for German exports', () => {
  assert.equal(decodeCsvBytes(new TextEncoder().encode('Grüße')), 'Grüße');
  assert.equal(decodeCsvBytes(Uint8Array.from([0x47, 0x72, 0xfc, 0xdf, 0x65])), 'Grüße');
});

test('detects the verified Commerzbank structure automatically', () => {
  const detected = detectCsvFormat(commerzbankCsv, 'statement.csv', []);

  assert.equal(detected.kind, 'normalized');
  assert.equal(detected.result.adapterId, 'commerzbank-v1');
});

test('asks for mapping when a partial Commerzbank shape is missing required columns', () => {
  const partial = `Booking date;Value date;Transaction type;Booking text;Amount;Currency;Account IBAN
08.08.2026;;Debit;Coffee;-5,00;EUR;DE00000000000000000000`;

  const detected = detectCsvFormat(partial, 'partial.csv', []);

  assert.equal(detected.kind, 'mapping-required');
});

test('asks for mapping when a bank shape is unknown', () => {
  const detected = detectCsvFormat('Date,Details,Amount\n2026-08-08,Coffee,-5.00', 'unknown.csv', []);

  assert.equal(detected.kind, 'mapping-required');
  assert.deepEqual(detected.headers, ['Date', 'Details', 'Amount']);
  assert.equal(detected.sampleRows[0].Details, 'Coffee');
});

test('automatically maps an unambiguous generic CSV shape', () => {
  const detected = detectCsvFormat(unknownCsv, 'unknown.csv', []);

  assert.equal(detected.kind, 'auto-mapping');
  assert.deepEqual(detected.mapping.columns, {
    bookingDate: 'Date',
    title: 'Details',
    amount: 'Amount',
    currency: 'Currency',
  });
  assert.equal(detected.mapping.dateFormat, 'YYYY-MM-DD');
  assert.equal(detected.mapping.numberFormat, 'en-US');
});

test('reuses a saved mapping only when its exact signature matches', () => {
  const identifiedCsv = `${unknownCsv.replace('\n', ',IBAN\n')},DE111`;
  const identifiedMapping = { ...mapping, columns: { ...mapping.columns, accountIdentifier: 'IBAN' } };
  const saved = { ...identifiedMapping, signature: mappingSignature(identifiedCsv, identifiedMapping) };
  const detected = detectCsvFormat(identifiedCsv, 'unknown.csv', [saved]);
  const changed = detectCsvFormat(identifiedCsv.replace('Details', 'Description'), 'unknown.csv', [saved]);

  assert.equal(detected.kind, 'normalized');
  assert.equal(detected.result.adapterId, 'mapped-v1');
  assert.equal(changed.kind, 'auto-mapping');
});

test('does not reuse a same-schema mapping without a CSV account identifier', () => {
  const saved = { ...mapping, signature: mappingSignature(unknownCsv, mapping) };

  const detected = detectCsvFormat(unknownCsv, 'other-account.csv', [saved]);

  assert.equal(detected.kind, 'auto-mapping');
});

test('separates same-schema mappings by the account identifier in each file', () => {
  const first = 'Date,Details,Amount,Currency,IBAN\n2026-08-08,Coffee,-5.00,EUR,DE111';
  const second = first.replace('DE111', 'DE222');
  const identifiedMapping = {
    ...mapping,
    columns: { ...mapping.columns, accountIdentifier: 'IBAN' },
  };
  const saved = { ...identifiedMapping, signature: mappingSignature(first, identifiedMapping) };

  assert.equal(detectCsvFormat(first, 'first.csv', [saved]).kind, 'normalized');
  assert.notEqual(mappingSignature(first, identifiedMapping), mappingSignature(second, identifiedMapping));
  assert.notEqual(detectCsvFormat(second, 'second.csv', [saved]).kind, 'normalized');
});

test('creates a stable opaque local account ID from bank identity', async () => {
  const account = { institution: 'Commerzbank', displayName: 'Commerzbank', identifier: 'DE00000000000000000000' };
  const first = await localAccountId(account);
  const second = await localAccountId(account);

  assert.equal(first, second);
  assert.match(first, /^account-[a-f0-9]{16}$/);
  assert.doesNotMatch(first, /DE000/);
});

test('suggests common English and German columns without inventing missing fields', () => {
  assert.deepEqual(
    suggestColumnMapping(['Buchungstag', 'Verwendungszweck', 'Betrag', 'Währung']),
    {
      bookingDate: 'Buchungstag',
      title: 'Verwendungszweck',
      amount: 'Betrag',
      currency: 'Währung',
    },
  );
  assert.deepEqual(
    suggestColumnMapping(['Date', 'Details', 'Debit', 'Credit']),
    {
      bookingDate: 'Date',
      title: 'Details',
      debit: 'Debit',
      credit: 'Credit',
    },
  );
});
