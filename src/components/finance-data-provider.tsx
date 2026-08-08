import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Platform } from "react-native";
import type { FinanceData } from "@/lib/transaction-types";
import {
  loadFinanceData,
  openMoneoDatabase,
} from "@/lib/transaction-store.mjs";

const emptyData: FinanceData = {
  accounts: [],
  imports: [],
  transactions: [],
  mappings: [],
};

type FinanceDataContextValue = {
  data: FinanceData;
  database: IDBDatabase | null;
  loading: boolean;
  error?: string;
  refresh: () => Promise<void>;
  requestPersistentStorage: () => Promise<boolean>;
};

const FinanceDataContext = createContext<FinanceDataContextValue | undefined>(
  undefined,
);

export function FinanceDataProvider({ children }: { children: React.ReactNode }) {
  const [database, setDatabase] = useState<IDBDatabase | null>(null);
  const [data, setData] = useState<FinanceData>(emptyData);
  const [loading, setLoading] = useState(Platform.OS === "web");
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    if (!database) return;
    setData((await loadFinanceData(database)) as FinanceData);
  }, [database]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    let active = true;
    openMoneoDatabase()
      .then(async (opened: IDBDatabase) => {
        if (!active) {
          opened.close();
          return;
        }
        setDatabase(opened);
        setData((await loadFinanceData(opened)) as FinanceData);
      })
      .catch((caught: unknown) => {
        if (active)
          setError(
            caught instanceof Error ? caught.message : "Local storage failed",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const requestPersistentStorage = useCallback(async () => {
    if (Platform.OS !== "web" || !navigator.storage?.persist) return false;
    return navigator.storage.persist();
  }, []);

  const value = useMemo(
    () => ({
      data,
      database,
      loading,
      error,
      refresh,
      requestPersistentStorage,
    }),
    [data, database, loading, error, refresh, requestPersistentStorage],
  );

  return (
    <FinanceDataContext.Provider value={value}>
      {children}
    </FinanceDataContext.Provider>
  );
}

export function useFinanceData() {
  const context = useContext(FinanceDataContext);
  if (!context)
    throw new Error("useFinanceData must be used inside FinanceDataProvider");
  return context;
}

