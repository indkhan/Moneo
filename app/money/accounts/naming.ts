export const accountTypes = ["checking", "savings", "cash", "credit", "investment", "wallet", "other"] as const;

// Imports name accounts "<file stem> · <account value> · <product>" (lib/import/csv.ts proposeAccountRoutes).
// This only proposes a friendlier name; the user still confirms the rename.
const knownExports: [RegExp, string][] = [[/^account-statement_/i, "Revolut"]];
const fileLike = /[_]|\d{4}-\d{2}-\d{2}|\.(csv|xlsx)$/i;
const iban = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;

function humanize(stem: string) {
  const words = stem.replace(/\.(csv|xlsx)$/i, "").split(/[_\-\s]+/)
    .filter(word => word && !/\d/.test(word) && !/^(en|de|fr|es|it|nl)$/i.test(word));
  const text = words.join(" ");
  return text ? text[0].toUpperCase() + text.slice(1).toLowerCase() : "Imported account";
}

export function suggestAccountName(name: string): string | null {
  const [stem, ...rest] = name.split(" · ").map(part => part.trim());
  if (!stem || !fileLike.test(stem)) return null;
  const bank = knownExports.find(([pattern]) => pattern.test(stem))?.[1];
  const tail: string[] = [];
  let product: string | undefined;
  for (const part of rest) {
    const compact = part.replace(/\s+/g, "").toUpperCase();
    if (iban.test(compact)) tail.push(`••${compact.slice(-4)}`);
    else if (part) product ??= part;
  }
  const suggestion = [bank ?? (product ? undefined : humanize(stem)), product, ...tail].filter(Boolean).join(" ").slice(0, 120);
  return suggestion && suggestion !== name ? suggestion : null;
}
