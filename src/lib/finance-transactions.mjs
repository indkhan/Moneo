export function formatMinorMoney(amountMinor, currency, minorUnit) {
  const negative = amountMinor.startsWith('-');
  const digits = amountMinor.replace(/^[+-]/, '').padStart(minorUnit + 1, '0');
  const whole = minorUnit ? digits.slice(0, -minorUnit) : digits;
  const fraction = minorUnit ? digits.slice(-minorUnit) : '';
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : '+'}${groupedWhole}${fraction ? `,${fraction}` : ''} ${currency}`;
}

export function recentTransactions(transactions, limit = transactions.length) {
  return [...transactions]
    .sort((left, right) => right.bookingDate.localeCompare(left.bookingDate)
      || left.source.rowNumber - right.source.rowNumber)
    .slice(0, limit);
}
