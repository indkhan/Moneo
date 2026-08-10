export const isDesktopLayout = (width) => width >= 1024;
export const isCompactAccountsLayout = (width) => width >= 1024 && width < 1400;
export const hydrationSafeWebWidth = (measuredWidth) =>
  measuredWidth ? (isDesktopLayout(measuredWidth) ? 1024 : measuredWidth) : 0;
