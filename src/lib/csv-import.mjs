const currencyMinorUnits = new Map([
  ...['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'].map((code) => [code, 0]),
  ...['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'].map((code) => [code, 3]),
  ['CLF', 4],
  ['UYW', 4],
]);

const referenceLabels = [
  ['End-To-End Reference', 'endToEnd'],
  ['Customer Reference', 'customer'],
  ['Mandate Reference', 'mandate'],
  ['ID Of Ordering Party', 'orderingParty'],
];

function recordsForDelimiter(input, delimiter) {
  const text = input.replace(/^\uFEFF/, '');
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;

  const pushRecord = () => {
    record.push(field);
    if (record.some((value) => value.length > 0)) {
      records.push({ values: record, rowNumber: recordLine });
    }
    record = [];
    field = '';
    recordLine = line;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
        if (character === '\n') line += 1;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      record.push(field);
      field = '';
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      pushRecord();
      line += 1;
      recordLine = line;
    } else {
      field += character;
    }
  }
  if (field.length || record.length) pushRecord();
  return records;
}

export function parseCsv(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('CSV file is empty');

  const candidates = [';', ',', '\t'].map((delimiter) => {
    const records = recordsForDelimiter(text, delimiter);
    const width = records[0]?.values.length ?? 0;
    const matchingRows = records.slice(1).filter((record) => record.values.length === width).length;
    return { delimiter, records, width, score: width > 1 ? matchingRows * 100 + width : 0 };
  });
  const selected = candidates.sort((left, right) => right.score - left.score)[0];
  if (!selected || selected.width < 2) throw new Error('CSV delimiter could not be detected');

  const headers = selected.records[0].values.map((header) => header.trim());
  if (new Set(headers).size !== headers.length) throw new Error('CSV headers must be unique');
  const rows = selected.records.slice(1).map((record) => {
    if (record.values.length !== headers.length) {
      throw new Error(`CSV row ${record.rowNumber} has ${record.values.length} columns; expected ${headers.length}`);
    }
    return {
      rowNumber: record.rowNumber,
      rawRecord: Object.fromEntries(headers.map((header, index) => [header, record.values[index] ?? ''])),
    };
  });
  return { delimiter: selected.delimiter, headers, rows };
}

function minorUnitFor(currency) {
  return currencyMinorUnits.get(currency) ?? 2;
}

export function parseMoney(value, currency) {
  const normalizedCurrency = currency.trim().toUpperCase();
  const currencyMinorUnit = minorUnitFor(normalizedCurrency);
  let amount = value.trim().replace(/[\s\u00A0]/g, '');
  if (!amount) throw new Error('Amount is required');

  const sign = amount.startsWith('-') ? '-' : '';
  amount = amount.replace(/^[+-]/, '');
  const comma = amount.lastIndexOf(',');
  const dot = amount.lastIndexOf('.');
  let decimalSeparator = '';
  if (comma >= 0 && dot >= 0) decimalSeparator = comma > dot ? ',' : '.';
  else if (comma >= 0) decimalSeparator = ',';
  else if (dot >= 0) decimalSeparator = '.';

  let whole = amount;
  let fraction = '';
  if (decimalSeparator) {
    const splitAt = amount.lastIndexOf(decimalSeparator);
    whole = amount.slice(0, splitAt);
    fraction = amount.slice(splitAt + 1);
  }
  whole = whole.replace(/[.,]/g, '') || '0';
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) throw new Error('Amount is invalid');
  while (fraction.length > currencyMinorUnit && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  if (fraction.length > currencyMinorUnit) throw new Error(`Amount has more than ${currencyMinorUnit} decimal places`);
  fraction = fraction.padEnd(currencyMinorUnit, '0');
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '') || '0';
  return {
    amountMinor: sign && digits !== '0' ? `-${digits}` : digits,
    currencyMinorUnit,
  };
}

export function parseMoneyWithFormat(value, currency, numberFormat) {
  const text = value.trim();
  if (numberFormat === 'de-DE') {
    return parseMoney(text.replace(/\./g, '').replace(',', '.'), currency);
  }
  if (numberFormat === 'en-US') {
    return parseMoney(text.replace(/,/g, ''), currency);
  }
  throw new Error('Number format is not supported');
}

export function parseDateWithFormat(value, format) {
  const text = value.trim();
  const patterns = {
    'DD.MM.YYYY': /^(\d{2})\.(\d{2})\.(\d{4})$/,
    'YYYY-MM-DD': /^(\d{4})-(\d{2})-(\d{2})$/,
    'DD/MM/YYYY': /^(\d{2})\/(\d{2})\/(\d{4})$/,
    'MM/DD/YYYY': /^(\d{2})\/(\d{2})\/(\d{4})$/,
  };
  const match = patterns[format]?.exec(text);
  const parts = !match ? undefined
    : format === 'YYYY-MM-DD' ? [match[1], match[2], match[3]]
      : format === 'MM/DD/YYYY' ? [match[3], match[1], match[2]]
        : [match[3], match[2], match[1]];
  if (!parts) throw new Error('Date format is not supported');
  const [year, month, day] = parts.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('Date is invalid');
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDate(value) {
  const format = value.trim().includes('.') ? 'DD.MM.YYYY' : 'YYYY-MM-DD';
  return parseDateWithFormat(value, format);
}

function extractReferences(text) {
  const labels = referenceLabels.map(([label]) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(`(${labels}):\\s*(.*?)(?=\\s+(?:${labels}):|$)`, 'gi');
  return [...text.matchAll(pattern)].map((match) => ({
    type: referenceLabels.find(([label]) => label.toLowerCase() === match[1].toLowerCase())?.[1] ?? 'other',
    value: match[2].trim(),
  })).filter((reference) => reference.value);
}

const requiredCommerzbankHeaders = [
  'Booking date',
  'Value date',
  'Transaction type',
  'Booking text',
  'Amount',
  'Currency',
  'Account IBAN',
  'Category',
  'Sender',
  'Recipient',
  'Transfer purpose',
];

export function normalizeCommerzbankCsv(text, fileName, corrections = {}) {
  const parsed = parseCsv(text);
  const missingHeader = requiredCommerzbankHeaders.find((header) => !parsed.headers.includes(header));
  if (missingHeader) throw new Error(`Commerzbank column is missing: ${missingHeader}`);

  const transactions = [];
  const errors = [];
  for (const source of parsed.rows) {
    const row = source.rawRecord;
    const correction = corrections[source.rowNumber] ?? {};
    try {
      const currency = (correction.currency || row.Currency).trim().toUpperCase();
      if (!currency) throw { field: 'currency', message: 'Currency is required' };
      let bookingDate;
      let valueDate;
      let money;
      try { bookingDate = correction.bookingDate || parseDate(row['Booking date']); } catch (error) { throw { field: 'bookingDate', message: error.message }; }
      try { valueDate = correction.valueDate || (row['Value date'].trim() ? parseDate(row['Value date']) : undefined); } catch (error) { throw { field: 'valueDate', message: error.message }; }
      try { money = parseMoney(correction.amount || row.Amount, currency); } catch (error) { throw { field: 'amount', message: error.message }; }

      const outgoing = money.amountMinor.startsWith('-');
      const sender = row.Sender.trim() || undefined;
      const recipient = row.Recipient.trim() || undefined;
      const transferPurpose = row['Transfer purpose'].trim();
      const description = (correction.description || row['Booking text']).trim();
      const title = (correction.title || (outgoing ? recipient || sender : sender || recipient) || transferPurpose || description).trim();
      if (!title) throw { field: 'title', message: 'Title or description is required' };

      transactions.push({
        bookingDate,
        ...(valueDate ? { valueDate } : {}),
        ...money,
        currency,
        title,
        description,
        ...(sender ? { sender } : {}),
        ...(recipient ? { recipient } : {}),
        references: extractReferences(description),
        ...(row.Category.trim() ? { bankCategory: row.Category.trim() } : {}),
        ...(row['Transaction type'].trim() ? { transactionType: row['Transaction type'].trim() } : {}),
        source: { fileName, rowNumber: source.rowNumber, rawRecord: row },
      });
    } catch (error) {
      errors.push({
        rowNumber: source.rowNumber,
        field: error?.field ?? 'row',
        message: error?.message ?? 'Row could not be normalized',
      });
    }
  }

  const identifier = parsed.rows.map((row) => row.rawRecord['Account IBAN'].trim()).find(Boolean);
  return {
    adapterId: 'commerzbank-v1',
    account: { institution: 'Commerzbank', displayName: 'Commerzbank', ...(identifier ? { identifier } : {}) },
    transactions,
    errors,
  };
}
