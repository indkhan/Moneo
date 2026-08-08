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

test('asks for mapping when a bank shape is unknown', () => {
  const detected = detectCsvFormat(unknownCsv, 'unknown.csv', []);

  assert.equal(detected.kind, 'mapping-required');
  assert.deepEqual(detected.headers, ['Date', 'Details', 'Amount', 'Currency']);
  assert.equal(detected.sampleRows[0].Details, 'Coffee');
});

test('reuses a saved mapping only when its exact signature matches', () => {
  const saved = { ...mapping, signature: mappingSignature(unknownCsv, mapping) };
  const detected = detectCsvFormat(unknownCsv, 'unknown.csv', [saved]);
  const changed = detectCsvFormat(unknownCsv.replace('Details', 'Description'), 'unknown.csv', [saved]);

  assert.equal(detected.kind, 'normalized');
  assert.equal(detected.result.adapterId, 'mapped-v1');
  assert.equal(changed.kind, 'mapping-required');
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
