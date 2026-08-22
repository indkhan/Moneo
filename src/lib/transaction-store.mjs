const databaseVersion = 2;

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
  request.onupgradeneeded = (event) => {
    const database = request.result;
    if (event.oldVersion < 1) {
      database.createObjectStore('accounts', { keyPath: 'id' });
      database.createObjectStore('sourceFiles', { keyPath: 'id' });
      const imports = database.createObjectStore('imports', { keyPath: 'id' });
      imports.createIndex('fileHash', 'fileHash', { unique: true });
      imports.createIndex('accountId', 'accountId');
      const transactions = database.createObjectStore('transactions', { keyPath: 'id' });
      transactions.createIndex('accountId', 'accountId');
      transactions.createIndex('importId', 'importId');
      database.createObjectStore('mappings', { keyPath: 'signature' });
    }
    if (event.oldVersion < 2) {
      const rules = database.createObjectStore('categoryRules', { keyPath: 'id' });
      rules.createIndex('counterpartyKey', 'counterpartyKey', { unique: true });
    }
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
  const transaction = database.transaction(['accounts', 'imports', 'transactions', 'mappings', 'categoryRules'], 'readonly');
  const done = transactionDone(transaction);
  const requests = {
    accounts: requestResult(transaction.objectStore('accounts').getAll()),
    imports: requestResult(transaction.objectStore('imports').getAll()),
    transactions: requestResult(transaction.objectStore('transactions').getAll()),
    mappings: requestResult(transaction.objectStore('mappings').getAll()),
    categoryRules: requestResult(transaction.objectStore('categoryRules').getAll()),
  };
  const [accounts, imports, transactions, mappings, categoryRules] = await Promise.all(Object.values(requests));
  await done;
  return { accounts, imports, transactions, mappings, categoryRules };
}

export async function saveCategoryRule(database, rule) {
  const transaction = database.transaction('categoryRules', 'readwrite');
  transaction.objectStore('categoryRules').put(rule);
  await transactionDone(transaction);
}

export async function setTransactionCategory(database, transactionId, assignment) {
  const transaction = database.transaction('transactions', 'readwrite');
  const store = transaction.objectStore('transactions');
  const item = await requestResult(store.get(transactionId));
  if (!item) throw new Error('Transaction was not found');
  store.put({ ...item, category: assignment });
  await transactionDone(transaction);
}

export async function applyCategoryRule(database, rule, matchingTransactionIds) {
  const transaction = database.transaction(['categoryRules', 'transactions'], 'readwrite');
  const done = transactionDone(transaction);
  const store = transaction.objectStore('transactions');
  const items = await Promise.all(matchingTransactionIds.map((id) => requestResult(store.get(id))));
  transaction.objectStore('categoryRules').put(rule);
  const category = {
    categoryId: rule.categoryId,
    method: 'user-rule',
    classifierVersion: 'moneo-category-v2',
    evidence: [`Personal rule for ${rule.counterpartyKey}`],
  };
  items.filter(Boolean).forEach((item) => store.put({ ...item, category }));
  await done;
}

export async function saveMissingAutomaticCategories(database, updates) {
  if (!updates.length) return;
  const transaction = database.transaction('transactions', 'readwrite');
  const done = transactionDone(transaction);
  const store = transaction.objectStore('transactions');
  const items = await Promise.all(updates.map((update) => requestResult(store.get(update.id))));
  items.forEach((item, index) => {
    if (item && !item.category) store.put({ ...item, category: updates[index].category });
  });
  await done;
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
  const transaction = database.transaction(['accounts', 'imports', 'transactions', 'sourceFiles'], 'readwrite');
  const done = transactionDone(transaction);
  const importStore = transaction.objectStore('imports');
  const transactionStore = transaction.objectStore('transactions');
  const [importRecord, ownedTransactions, imports] = await Promise.all([
    requestResult(importStore.get(importId)),
    requestResult(transactionStore.index('importId').getAll(importId)),
    requestResult(importStore.getAll()),
  ]);
  if (!importRecord) {
    await done;
    return;
  }
  ownedTransactions.forEach((item) => {
    const successor = imports.find((candidate) => (
      candidate.id !== importId && candidate.duplicateTransactionIds?.includes(item.id)
    ));
    if (!successor) {
      transactionStore.delete(item.id);
      return;
    }
    transactionStore.put({ ...item, importId: successor.id });
    importStore.put({
      ...successor,
      duplicateTransactionIds: successor.duplicateTransactionIds.filter((id) => id !== item.id),
    });
  });
  importStore.delete(importId);
  if (importRecord.sourceFileId) transaction.objectStore('sourceFiles').delete(importRecord.sourceFileId);
  if (!imports.some((item) => item.id !== importId && item.accountId === importRecord.accountId)) {
    transaction.objectStore('accounts').delete(importRecord.accountId);
  }
  await done;
}
