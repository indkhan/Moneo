import { useSyncExternalStore } from "react";

const neverChanges = () => () => {};

export function useHydrated() {
  return useSyncExternalStore(neverChanges, () => true, () => false);
}
