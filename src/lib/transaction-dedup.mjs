export async function sha256Hex(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function transactionFingerprint(accountId, transaction) {
  if (transaction.bankTransactionId) {
    return `${accountId}|bank-id|${transaction.bankTransactionId}`;
  }
  return JSON.stringify([
    accountId,
    transaction.bookingDate,
    transaction.valueDate ?? '',
    transaction.amountMinor,
    transaction.currency,
    transaction.description,
    transaction.transactionType ?? '',
    transaction.references.map((reference) => [reference.type, reference.value]),
  ]);
}

export function deduplicateTransactions(existing, incoming, accountId) {
  const remainingExisting = new Map();
  for (const transaction of existing) {
    const key = transactionFingerprint(transaction.accountId, transaction);
    remainingExisting.set(key, [...(remainingExisting.get(key) ?? []), transaction.id]);
  }

  const accepted = [];
  const skipped = [];
  const duplicateTransactionIds = [];
  const acceptedFingerprints = new Set();
  for (const transaction of incoming) {
    const key = transactionFingerprint(accountId, transaction);
    const remaining = remainingExisting.get(key) ?? [];
    if (remaining.length > 0) {
      skipped.push(transaction);
      duplicateTransactionIds.push(remaining[0]);
      remainingExisting.set(key, remaining.slice(1));
    } else if (acceptedFingerprints.has(key)) {
      skipped.push(transaction);
    } else {
      accepted.push(transaction);
      acceptedFingerprints.add(key);
    }
  }
  return { accepted, skipped, duplicateTransactionIds };
}
