export const navigationItems = [
  { route: 'index', label: 'Dashboard', icon: '▦' },
  { route: 'transactions', label: 'Transactions', icon: '▤' },
  { route: 'budgets', label: 'Budgets', icon: '◒' },
  { route: 'investments', label: 'Investments', icon: '⌁' },
  { route: 'recurring', label: 'Recurring', icon: '↻' },
];

export const isWorkspaceRoute = (route) => route === 'ai';
