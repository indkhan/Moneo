export const recurringCadences = ["weekly", "biweekly", "monthly", "quarterly", "yearly"] as const;
export const cadenceWords: Record<string, string> = { weekly: "Every week", biweekly: "Every two weeks", monthly: "Every month", quarterly: "Every quarter", yearly: "Every year" };
export const scheduleCadences = ["once", "daily", ...recurringCadences] as const;
