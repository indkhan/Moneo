const databaseVersion = 1;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = (event) => reject(event.target?.error ?? transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function openMoneoDatabase(name = 'moneo-finance', factory = globalThis.indexedDB) {
  if (!factory) return Promise.reject(new Error('IndexedDB is not available'));
  const request = factory.open(name, databaseVersion);
  request.onupgradeneeded = () => {
    const database = request.result;
    database.createObjectStore('accounts', { keyPath: 'id' });
    database.createObjectStore('sourceFiles', { keyPath: 'id' });
    const imports = database.createObjectStore('imports', { keyPath: 'id' });
    imports.createIndex('fileHash', 'fileHash', { unique: true });
    imports.createIndex('accountId', 'accountId');
    const transactions = database.createObjectStore('transactions', { keyPath: 'id' });
    transactions.createIndex('accountId', 'accountId');
    transactions.createIndex('importId', 'importId');
    database.createObjectStore('mappings', { keyPath: 'signature' });
  };
  return requestResult(request);
}

export async function saveImport(database, payload) {
  const storeNames = ['accounts', 'sourceFiles', 'imports', 'transactions', 'mappings'];
  const transaction = database.transaction(storeNames, 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore('accounts').put(payload.account);
  transaction.objectStore('sourceFiles').put(payload.sourceFile);
  transaction.objectStore('imports').add(payload.importRecord);
  const transactionStore = transaction.objectStore('transactions');
  payload.transactions.forEach((item) => transactionStore.add(item));
  if (payload.mapping) transaction.objectStore('mappings').put(payload.mapping);
  await done;
}

export async function loadFinanceData(database) {
  const transaction = database.transaction(['accounts', 'imports', 'transactions', 'mappings'], 'readonly');
  const done = transactionDone(transaction);
  const requests = {
    accounts: requestResult(transaction.objectStore('accounts').getAll()),
    imports: requestResult(transaction.objectStore('imports').getAll()),
    transactions: requestResult(transaction.objectStore('transactions').getAll()),
    mappings: requestResult(transaction.objectStore('mappings').getAll()),
  };
  const [accounts, imports, transactions, mappings] = await Promise.all(Object.values(requests));
  await done;
  return { accounts, imports, transactions, mappings };
}

export async function findImportByFileHash(database, fileHash) {
  const transaction = database.transaction('imports', 'readonly');
  const result = await requestResult(transaction.objectStore('imports').index('fileHash').get(fileHash));
  await transactionDone(transaction);
  return result;
}

export async function getSourceFile(database, id) {
  const transaction = database.transaction('sourceFiles', 'readonly');
  const result = await requestResult(transaction.objectStore('sourceFiles').get(id));
  await transactionDone(transaction);
  return result;
}

export async function deleteImport(database, importId) {
  const transaction = database.transaction(['imports', 'transactions', 'sourceFiles'], 'readwrite');
  const done = transactionDone(transaction);
  const importStore = transaction.objectStore('imports');
  const transactionStore = transaction.objectStore('transactions');
  const [importRecord, transactionIds] = await Promise.all([
    requestResult(importStore.get(importId)),
    requestResult(transactionStore.index('importId').getAllKeys(importId)),
  ]);
  transactionIds.forEach((id) => transactionStore.delete(id));
  importStore.delete(importId);
  if (importRecord?.sourceFileId) transaction.objectStore('sourceFiles').delete(importRecord.sourceFileId);
  await done;
}
