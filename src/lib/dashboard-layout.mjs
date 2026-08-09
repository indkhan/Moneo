const main = ['net-worth', 'spending', 'budgets', 'transactions'];
const rail = ['ai-insight', 'accounts', 'recurring'];

export function dashboardPresentation(transactionCount) {
  return { showImporter: transactionCount === 0, main, rail };
}
