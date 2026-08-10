export const isDesktopLayout = (width: number) => width >= 1024;
export const isCompactAccountsLayout = (width: number) => width >= 1024 && width < 1400;
export const hydrationSafeWebWidth = (measuredWidth: number) =>
  measuredWidth ? (isDesktopLayout(measuredWidth) ? 1024 : measuredWidth) : 0;
