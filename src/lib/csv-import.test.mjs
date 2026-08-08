import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCommerzbankCsv,
  parseCsv,
  parseMoney,
} from './csv-import.mjs';

const commerzbankCsv = `\uFEFFBooking date;Value date;Transaction type;Booking text;Amount;Currency;Account IBAN;Category;Sender;Recipient;Transfer purpose
07.08.2026;07.08.2026;Transfer (realtime);Example Recipient TESTDEFF DE001234 End-To-End Reference: E2E-001 Customer Reference: CUST-001;-5,75;EUR;DE00000000000000000000;Other Expenses;;Example Recipient;Dinner
06.08.2026;06.08.2026;Transfer;Example Employer Salary End-To-End Reference: E2E-002;742,23;EUR;DE00000000000000000000;Earnings;Example Employer;;August salary
05.08.2026;05.08.2026;Debit;Example Energy Mandate Reference: MANDATE-9 ID Of Ordering Party: DE00ZZZ00000000000;-59;EUR;DE00000000000000000000;Home;;Example Energy;Electricity`;

test('parses BOM, semicolon records, quoted fields, and source row numbers', () => {
  const parsed = parseCsv('\uFEFFDate;Text;Amount\n08.08.2026;"Coffee; breakfast";-4,20');

  assert.equal(parsed.delimiter, ';');
  assert.deepEqual(parsed.headers, ['Date', 'Text', 'Amount']);
  assert.equal(parsed.rows[0].rowNumber, 2);
  assert.equal(parsed.rows[0].rawRecord.Text, 'Coffee; breakfast');
});

test('keeps valid CSV rows when another row has the wrong column count', () => {
  const parsed = parseCsv('Date,Text,Amount\n2026-08-08,Coffee,-4.20\nmalformed,row\n2026-08-09,Tea,-2.10');

  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.errors, [
    { rowNumber: 3, field: 'row', message: 'CSV row 3 has 2 columns; expected 3' },
  ]);
  assert.equal(parsed.rows[1].rawRecord.Text, 'Tea');
});

test('parses German money exactly for currencies with different minor units', () => {
  assert.deepEqual(parseMoney('-1.234,56', 'EUR'), {
    amountMinor: '-123456',
    currencyMinorUnit: 2,
  });
  assert.deepEqual(parseMoney('1250', 'JPY'), {
    amountMinor: '1250',
    currencyMinorUnit: 0,
  });
  assert.deepEqual(parseMoney('2,345', 'KWD'), {
    amountMinor: '2345',
    currencyMinorUnit: 3,
  });
});

test('normalizes the verified Commerzbank shape without losing source data', () => {
  const result = normalizeCommerzbankCsv(commerzbankCsv, 'statement.csv');

  assert.equal(result.adapterId, 'commerzbank-v1');
  assert.equal(result.account.institution, 'Commerzbank');
  assert.equal(result.account.identifier, 'DE00000000000000000000');
  assert.equal(result.transactions.length, 3);
  assert.deepEqual(result.errors, []);

  assert.deepEqual(
    {
      bookingDate: result.transactions[0].bookingDate,
      valueDate: result.transactions[0].valueDate,
      amountMinor: result.transactions[0].amountMinor,
      currency: result.transactions[0].currency,
      title: result.transactions[0].title,
      bankCategory: result.transactions[0].bankCategory,
      rowNumber: result.transactions[0].source.rowNumber,
    },
    {
      bookingDate: '2026-08-07',
      valueDate: '2026-08-07',
      amountMinor: '-575',
      currency: 'EUR',
      title: 'Example Recipient',
      bankCategory: 'Other Expenses',
      rowNumber: 2,
    },
  );
  assert.deepEqual(result.transactions[0].references, [
    { type: 'endToEnd', value: 'E2E-001' },
    { type: 'customer', value: 'CUST-001' },
  ]);
  assert.equal(result.transactions[1].title, 'Example Employer');
  assert.equal(result.transactions[2].references[0].type, 'mandate');
  assert.equal(result.transactions[0].source.rawRecord['Transfer purpose'], 'Dinner');
  assert.equal(result.transactions[0].transferPurpose, 'Dinner');
});

test('normalizes recognized Commerzbank status without changing raw source data', () => {
  const csv = commerzbankCsv.replace(
    'Transfer purpose\n',
    'Transfer purpose;Status\n',
  ).replace(/Dinner\n/, 'Dinner;Vorgemerkt\n')
    .replace(/August salary\n/, 'August salary;Gebucht\n')
    .replace(/Electricity$/, 'Electricity;Storniert');

  const result = normalizeCommerzbankCsv(csv, 'statement.csv');

  assert.deepEqual(result.transactions.map((transaction) => transaction.status), ['pending', 'booked', 'reverted']);
  assert.equal(result.transactions[0].source.rawRecord.Status, 'Vorgemerkt');
});

test('returns row errors instead of inventing required Commerzbank values', () => {
  const invalid = commerzbankCsv.replace(';EUR;DE00000000000000000000;', ';;DE00000000000000000000;');
  const result = normalizeCommerzbankCsv(invalid, 'statement.csv');

  assert.equal(result.transactions.length, 2);
  assert.deepEqual(result.errors, [
    { rowNumber: 2, field: 'currency', message: 'Currency is required' },
  ]);
});

test('accepts a user correction for a malformed Commerzbank row', () => {
  const invalid = commerzbankCsv.replace('-5,75;EUR', 'broken;EUR');
  const failed = normalizeCommerzbankCsv(invalid, 'statement.csv');
  assert.equal(failed.errors[0].field, 'amount');

  const corrected = normalizeCommerzbankCsv(invalid, 'statement.csv', {
    2: { amount: '-5,75' },
  });

  assert.equal(corrected.errors.length, 0);
  assert.equal(corrected.transactions[0].amountMinor, '-575');
  assert.equal(corrected.transactions[0].source.rawRecord.Amount, 'broken');
});

test('accepts a corrected Commerzbank transaction status', () => {
  const withStatusHeader = commerzbankCsv.replace(
    'Transfer purpose\n',
    'Transfer purpose;Status\n',
  ).replace(/Dinner\n/, 'Dinner;In progress\n')
    .replace(/August salary\n/, 'August salary;Booked\n')
    .replace(/Electricity$/, 'Electricity;Booked');
  const failed = normalizeCommerzbankCsv(withStatusHeader, 'statement.csv');
  assert.equal(failed.errors[0].field, 'status');

  const corrected = normalizeCommerzbankCsv(withStatusHeader, 'statement.csv', {
    2: { status: 'Booked' },
  });

  assert.equal(corrected.errors.length, 0);
  assert.equal(corrected.transactions[0].status, 'booked');
  assert.equal(corrected.transactions[0].source.rawRecord.Status, 'In progress');
});

test('rejects an invalid corrected Commerzbank date', () => {
  const invalid = commerzbankCsv.replace('07.08.2026', 'not-a-date');
  const corrected = normalizeCommerzbankCsv(invalid, 'statement.csv', {
    2: { bookingDate: 'not-a-date' },
  });

  assert.equal(corrected.transactions.length, 2);
  assert.equal(corrected.errors[0].field, 'bookingDate');
});

test('rejects an invalid corrected Commerzbank currency', () => {
  const corrected = normalizeCommerzbankCsv(commerzbankCsv, 'statement.csv', {
    2: { currency: 'EURO' },
  });

  assert.equal(corrected.transactions.length, 2);
  assert.equal(corrected.errors[0].field, 'currency');
});
