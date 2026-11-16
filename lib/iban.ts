const IBAN = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{8,30}$/;

export function normalizeIban(value: string) {
  const iban = value.replace(/\s/g, "").toUpperCase();
  return IBAN.test(iban) ? iban : null;
}
