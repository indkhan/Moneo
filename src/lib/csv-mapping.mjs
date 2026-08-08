import {
  parseCsv,
  parseDateWithFormat,
  parseMoneyWithFormat,
  normalizeCurrency,
} from './csv-import.mjs';

const mappingVersion = 'mapped-v1';

function mappedColumnNames(mapping) {
  return Object.values(mapping.columns).filter(Boolean);
}

function validateMapping(parsed, mapping) {
  if (!mapping.bankName?.trim()) throw new Error('Bank name is required');
  if (!mapping.accountName?.trim()) throw new Error('Account name is required');
  if (!mapping.columns?.bookingDate) throw new Error('Booking date mapping is required');
  if (!mapping.columns?.title) throw new Error('Title mapping is required');
  if (!mapping.columns.amount && !(mapping.columns.debit && mapping.columns.credit)) {
    throw new Error('Amount or debit and credit mappings are required');
  }
  if (!mapping.constantCurrency && !mapping.columns.currency) throw new Error('Currency mapping is required');
  const missing = mappedColumnNames(mapping).find((column) => !parsed.headers.includes(column));
  if (missing) throw new Error(`Mapped column is missing: ${missing}`);
}

function valueAt(row, column) {
  return column ? row[column]?.trim() ?? '' : '';
}

function mappedAmount(row, mapping, currency) {
  if (mapping.columns.amount) {
    return parseMoneyWithFormat(valueAt(row, mapping.columns.amount), currency, mapping.numberFormat);
  }
  const debit = valueAt(row, mapping.columns.debit);
  const credit = valueAt(row, mapping.columns.credit);
  if (Boolean(debit) === Boolean(credit)) throw new Error('Exactly one debit or credit value is required');
  const value = debit ? `-${debit.replace(/^[+-]/, '')}` : credit.replace(/^[+-]/, '');
  return parseMoneyWithFormat(value, currency, mapping.numberFormat);
}

function optionalValue(row, column) {
  const value = valueAt(row, column);
  return value || undefined;
}

export function mappingSignature(text, mapping) {
  const parsed = parseCsv(text);
  return [mappingVersion, parsed.delimiter, ...parsed.headers, mapping.dateFormat, mapping.numberFormat].join('|');
}

export function normalizeMappedCsv(text, fileName, mapping, corrections = {}) {
  const parsed = parseCsv(text);
  validateMapping(parsed, mapping);
  const transactions = [];
  const errors = [];

  for (const source of parsed.rows) {
    const row = source.rawRecord;
    const correction = corrections[source.rowNumber] ?? {};
    try {
      let currency;
      try {
        currency = normalizeCurrency(correction.currency || mapping.constantCurrency || valueAt(row, mapping.columns.currency));
      } catch (error) {
        throw { field: 'currency', message: error.message };
      }

      let bookingDate;
      let valueDate;
      let money;
      try {
        bookingDate = correction.bookingDate
          ? parseDateWithFormat(correction.bookingDate, 'YYYY-MM-DD')
          : parseDateWithFormat(valueAt(row, mapping.columns.bookingDate), mapping.dateFormat);
      } catch (error) {
        throw { field: 'bookingDate', message: error.message };
      }
      try {
        const rawValueDate = valueAt(row, mapping.columns.valueDate);
        valueDate = correction.valueDate
          ? parseDateWithFormat(correction.valueDate, 'YYYY-MM-DD')
          : (rawValueDate ? parseDateWithFormat(rawValueDate, mapping.dateFormat) : undefined);
      } catch (error) {
        throw { field: 'valueDate', message: error.message };
      }
      try {
        money = correction.amount
          ? parseMoneyWithFormat(correction.amount, currency, mapping.numberFormat)
          : mappedAmount(row, mapping, currency);
      } catch (error) {
        throw { field: 'amount', message: error.message };
      }

      const title = (correction.title || valueAt(row, mapping.columns.title)).trim();
      if (!title) throw { field: 'title', message: 'Title is required' };
      const description = (correction.description || valueAt(row, mapping.columns.description) || title).trim();
      const reference = optionalValue(row, mapping.columns.reference);
      const sender = optionalValue(row, mapping.columns.sender);
      const recipient = optionalValue(row, mapping.columns.recipient);
      const bankTransactionId = optionalValue(row, mapping.columns.transactionId);
      const transactionType = optionalValue(row, mapping.columns.transactionType);
      const bankCategory = optionalValue(row, mapping.columns.bankCategory);
      const rawStatus = optionalValue(row, mapping.columns.status)?.toLowerCase();
      const status = rawStatus === 'booked' || rawStatus === 'completed' ? 'booked'
        : rawStatus === 'pending' ? 'pending'
          : rawStatus === 'reverted' || rawStatus === 'reversed' ? 'reverted'
            : undefined;
      let balanceAfterMinor;
      const rawBalance = correction.balance || valueAt(row, mapping.columns.balance);
      if (rawBalance) {
        try {
          balanceAfterMinor = parseMoneyWithFormat(rawBalance, currency, mapping.numberFormat).amountMinor;
        } catch (error) {
          throw { field: 'balance', message: error.message };
        }
      }

      transactions.push({
        bookingDate,
        ...(valueDate ? { valueDate } : {}),
        ...money,
        currency,
        title,
        description,
        ...(sender ? { sender } : {}),
        ...(recipient ? { recipient } : {}),
        references: reference ? [{ type: 'bank', value: reference }] : [],
        ...(bankTransactionId ? { bankTransactionId } : {}),
        ...(transactionType ? { transactionType } : {}),
        ...(bankCategory ? { bankCategory } : {}),
        ...(status ? { status } : {}),
        ...(balanceAfterMinor ? { balanceAfterMinor } : {}),
        source: { fileName, rowNumber: source.rowNumber, rawRecord: row },
      });
    } catch (error) {
      errors.push({
        rowNumber: source.rowNumber,
        field: error?.field ?? 'row',
        message: error?.message ?? 'Row could not be normalized',
        rawRecord: row,
      });
    }
  }

  return {
    adapterId: mappingVersion,
    mappingSignature: mappingSignature(text, mapping),
    account: {
      institution: mapping.bankName.trim(),
      displayName: mapping.accountName.trim(),
      ...(mapping.accountIdentifier?.trim() ? { identifier: mapping.accountIdentifier.trim() } : {}),
    },
    transactions,
    errors,
  };
}
