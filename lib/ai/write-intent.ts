const categoryChange = /^(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:change|set|correct|categorize|reclassify)\b.+\b(?:to|as)\b/i;

export function isExplicitCategoryChange(message: string): boolean {
  return categoryChange.test(message.trim());
}
