import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  deleteImport,
  findImportByFileHash,
  getSourceFile,
  loadFinanceData,
  openMoneoDatabase,
  saveImport,
} from './transaction-store.mjs';

function samplePayload(suffix = 'one') {
  return {
    account: {
      id: 'account-1',
      institution: 'Example Bank',
      displayName: 'Main account',
      identifier: 'masked-account',
    },
    sourceFile: {
      id: `file-${suffix}`,
      name: 'statement.csv',
      type: 'text/csv',
      blob: new Blob(['Date,Amount\n2026-08-08,-5.00'], { type: 'text/csv' }),
    },
    importRecord: {
      id: `import-${suffix}`,
      accountId: 'account-1',
      sourceFileId: `file-${suffix}`,
      fileName: 'statement.csv',
      fileHash: 'abc123',
      adapterId: 'mapped-v1',
      importedAt: '2026-08-08T12:00:00.000Z',
      importedCount: 1,
      duplicateCount: 0,
      skippedRowNumbers: [],
    },
    transactions: [{
      id: `transaction-${suffix}`,
      accountId: 'account-1',
      importId: `import-${suffix}`,
      bookingDate: '2026-08-08',
      amountMinor: '-500',
      currency: 'EUR',
      currencyMinorUnit: 2,
      title: 'Coffee',
      description: 'Coffee',
      references: [],
      source: { fileName: 'statement.csv', rowNumber: 2, rawRecord: { Date: '2026-08-08' } },
    }],
    mapping: {
      signature: 'mapped-v1|,|Date|Amount',
      bankName: 'Example Bank',
      accountName: 'Main account',
      dateFormat: 'YYYY-MM-DD',
      numberFormat: 'en-US',
      constantCurrency: 'EUR',
      columns: { bookingDate: 'Date', title: 'Date', amount: 'Amount' },
    },
  };
}

test('atomically stores finance records, the original CSV blob, and mapping', async () => {
  const database = await openMoneoDatabase('moneo-test-save', new IDBFactory());
  await saveImport(database, samplePayload());

  const data = await loadFinanceData(database);
  const source = await getSourceFile(database, 'file-one');

  assert.equal(data.accounts.length, 1);
  assert.equal(data.imports.length, 1);
  assert.equal(data.transactions.length, 1);
  assert.equal(data.mappings.length, 1);
  assert.equal(await source.blob.text(), 'Date,Amount\n2026-08-08,-5.00');
  assert.equal((await findImportByFileHash(database, 'abc123')).id, 'import-one');
  database.close();
});

test('rejects an exact file hash without leaving partial records', async () => {
  const database = await openMoneoDatabase('moneo-test-duplicate', new IDBFactory());
  await saveImport(database, samplePayload('one'));

  await assert.rejects(
    saveImport(database, samplePayload('two')),
    (error) => error?.name === 'ConstraintError',
  );

  const data = await loadFinanceData(database);
  assert.equal(data.imports.length, 1);
  assert.equal(data.transactions.length, 1);
  assert.equal(await getSourceFile(database, 'file-two'), undefined);
  database.close();
});

test('deletes one import, its transactions, and its retained source file', async () => {
  const database = await openMoneoDatabase('moneo-test-delete', new IDBFactory());
  await saveImport(database, samplePayload());

  await deleteImport(database, 'import-one');

  const data = await loadFinanceData(database);
  assert.equal(data.imports.length, 0);
  assert.equal(data.transactions.length, 0);
  assert.equal(await getSourceFile(database, 'file-one'), undefined);
  assert.equal(data.accounts.length, 1);
  assert.equal(data.mappings.length, 1);
  database.close();
});
