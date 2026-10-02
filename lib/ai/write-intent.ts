const categoryChange = /^(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:change|set|correct|categorize|reclassify)\b.+\b(?:to|as)\b/i;

export function isExplicitCategoryChange(message: string): boolean {
  return categoryChange.test(message.trim());
}

// The model cannot select a different record/category from an unambiguous user command.
export function parseCategoryCommand(message: string): { transactionId: string; category: string } | null {
  const match = /^set category of transaction ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) to "([^"\n]{1,100})"\.?$/i.exec(message.trim());
  if (!match || !match[2].trim()) return null;
  return { transactionId: match[1].toLowerCase(), category: match[2].trim() };
}

export function isExplicitReviewRequest(message: string) {
  return /^(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:(?:start|run|create)\s+(?:a\s+)?(?:deep\s+)?financial\s+review|review\s+my\s+finances)[.!?]?$/i.test(message.trim());
}
