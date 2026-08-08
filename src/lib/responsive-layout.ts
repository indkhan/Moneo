export const isDesktopLayout = (width: number) => width >= 1024;
export const hydrationSafeWebWidth = (measuredWidth: number) =>
  measuredWidth ? (isDesktopLayout(measuredWidth) ? 1024 : measuredWidth) : 0;
