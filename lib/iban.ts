const IBAN = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{8,30}$/;

export const compactIban = (value: string) => value.replace(/\s/g, "").toUpperCase();

export function normalizeIban(value: string) {
  const iban = compactIban(value);
  return IBAN.test(iban) ? iban : null;
}
