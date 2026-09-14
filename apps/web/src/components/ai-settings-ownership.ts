export function canManageAiSettings<T extends { canManage?: boolean }>(
  settings: T | null | undefined,
): settings is T & { canManage: true } {
  return settings?.canManage === true;
}
