export const recurringCadences = ["weekly", "biweekly", "monthly", "quarterly", "yearly"] as const;
export const scheduleCadences = ["once", "daily", ...recurringCadences] as const;
