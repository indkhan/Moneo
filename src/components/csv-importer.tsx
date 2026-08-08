import { createElement, useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFinanceData } from "@/components/finance-data-provider";
import type {
  ColumnMapping,
  ImportRowError,
  SavedColumnMapping,
  TransactionDraft,
} from "@/lib/transaction-types";
import { normalizeCommerzbankCsv } from "@/lib/csv-import.mjs";
import { mappingSignature, normalizeMappedCsv } from "@/lib/csv-mapping.mjs";
import {
  decodeCsvBytes,
  detectCsvFormat,
  localAccountId,
  suggestColumnMapping,
} from "@/lib/csv-workflow.mjs";
import {
  deduplicateTransactions,
  sha256Hex,
} from "@/lib/transaction-dedup.mjs";
import {
  deleteImport,
  findImportByFileHash,
  saveImport,
} from "@/lib/transaction-store.mjs";

const colors = {
  ink: "#243c34",
  muted: "#79877f",
  line: "#e5e9e4",
  teal: "#438f7a",
  tealSoft: "#e7f4ed",
  red: "#bd5b4d",
  redSoft: "#fae6e1",
  white: "#ffffff",
};

type NormalizationResult = {
  adapterId: string;
  mappingSignature?: string;
  account: { institution: string; displayName: string; identifier?: string };
  transactions: TransactionDraft[];
  errors: ImportRowError[];
};

type Candidate = {
  file: File;
  hash: string;
  text: string;
  result: NormalizationResult;
  mapping?: SavedColumnMapping;
};

type MappingRequest = {
  file: File;
  hash: string;
  text: string;
  headers: string[];
  sampleRows: Record<string, string>[];
  autoMapping?: Pick<ColumnMapping, "dateFormat" | "numberFormat" | "columns">;
};

type MappingColumnsDraft = Partial<ColumnMapping["columns"]>;

function maskIdentifier(identifier?: string) {
  if (!identifier) return undefined;
  return identifier.length > 8
    ? `${identifier.slice(0, 4)}••••${identifier.slice(-4)}`
    : identifier;
}

function ColumnChoice({
  label,
  value,
  headers,
  onChange,
  optional = false,
}: {
  label: string;
  value?: string;
  headers: string[];
  onChange: (value: string | undefined) => void;
  optional?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.choiceWrap}>
      <Text style={styles.label}>{label}</Text>
      <Pressable style={styles.choice} onPress={() => setOpen(!open)}>
        <Text style={value ? styles.choiceText : styles.placeholder}>
          {value || (optional ? "Not mapped" : "Choose column")}
        </Text>
        <Text style={styles.choiceArrow}>⌄</Text>
      </Pressable>
      {open && (
        <View style={styles.choiceMenu}>
          {optional && (
            <Pressable
              style={styles.choiceOption}
              onPress={() => {
                onChange(undefined);
                setOpen(false);
              }}
            >
              <Text style={styles.placeholder}>Not mapped</Text>
            </Pressable>
          )}
          {headers.map((header) => (
            <Pressable
              key={header}
              style={styles.choiceOption}
              onPress={() => {
                onChange(header);
                setOpen(false);
              }}
            >
              <Text style={styles.choiceText}>{header}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function MappingForm({
  request,
  onMapped,
  onCancel,
}: {
  request: MappingRequest;
  onMapped: (candidate: Candidate) => void;
  onCancel: () => void;
}) {
  const suggested = useMemo(
    () => suggestColumnMapping(request.headers),
    [request.headers],
  );
  const [bankName, setBankName] = useState("");
  const [accountName, setAccountName] = useState("");
  const [constantCurrency, setConstantCurrency] = useState("");
  const [dateFormat, setDateFormat] = useState<ColumnMapping["dateFormat"]>(request.autoMapping?.dateFormat ?? "DD.MM.YYYY");
  const [numberFormat, setNumberFormat] =
    useState<ColumnMapping["numberFormat"]>(request.autoMapping?.numberFormat ?? "de-DE");
  const [columns, setColumns] = useState<MappingColumnsDraft>(request.autoMapping?.columns ?? suggested);
  const [error, setError] = useState<string>();

  const setColumn = (
    field: keyof ColumnMapping["columns"],
    value: string | undefined,
  ) => setColumns((current) => ({ ...current, [field]: value }));

  const submit = () => {
    try {
      const mapping: ColumnMapping = {
        bankName,
        accountName,
        dateFormat,
        numberFormat,
        ...(constantCurrency.trim()
          ? { constantCurrency: constantCurrency.trim().toUpperCase() }
          : {}),
        columns: columns as ColumnMapping["columns"],
      };
      const signature = mappingSignature(request.text, mapping);
      const savedMapping = { ...mapping, signature };
      const result = normalizeMappedCsv(
        request.text,
        request.file.name,
        savedMapping,
      ) as NormalizationResult;
      onMapped({
        file: request.file,
        hash: request.hash,
        text: request.text,
        result,
        mapping: savedMapping,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Mapping failed");
    }
  };

  const optionalFields: [keyof ColumnMapping["columns"], string][] = [
    ["valueDate", "Value date"],
    ["description", "Full description"],
    ["sender", "Sender"],
    ["recipient", "Recipient"],
    ["reference", "Reference"],
    ["transactionId", "Transaction ID"],
    ["transactionType", "Transaction type"],
    ["status", "Status"],
    ["balance", "Balance after"],
    ["bankCategory", "Bank category"],
  ];

  return (
    <View style={styles.panel}>
      <Text style={styles.heading}>Map this bank once</Text>
      <Text style={styles.help}>
        {request.autoMapping
          ? "Moneo recognised these columns. Add an account label to import and save this mapping."
          : "Moneo will reuse this mapping only when the CSV headers match exactly."}
      </Text>
      <View style={styles.formGrid}>
        <View style={styles.field}>
          <Text style={styles.label}>Bank name</Text>
          <TextInput
            value={bankName}
            onChangeText={setBankName}
            placeholder="e.g. Sparkasse"
            style={styles.input}
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Local account name</Text>
          <TextInput
            value={accountName}
            onChangeText={setAccountName}
            placeholder="e.g. Main account"
            style={styles.input}
          />
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Date format</Text>
          <View style={styles.optionRow}>
            {(["DD.MM.YYYY", "YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"] as const).map(
              (format) => (
                <Pressable
                  key={format}
                  onPress={() => setDateFormat(format)}
                  style={[styles.option, dateFormat === format && styles.optionActive]}
                >
                  <Text style={styles.optionText}>{format}</Text>
                </Pressable>
              ),
            )}
          </View>
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>Number format</Text>
          <View style={styles.optionRow}>
            {(["de-DE", "en-US"] as const).map((format) => (
              <Pressable
                key={format}
                onPress={() => setNumberFormat(format)}
                style={[styles.option, numberFormat === format && styles.optionActive]}
              >
                <Text style={styles.optionText}>
                  {format === "de-DE" ? "1.234,56" : "1,234.56"}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
        <ColumnChoice
          label="Booking date"
          value={columns.bookingDate}
          headers={request.headers}
          onChange={(value) => setColumn("bookingDate", value)}
        />
        <ColumnChoice
          label="Title / description"
          value={columns.title}
          headers={request.headers}
          onChange={(value) => setColumn("title", value)}
        />
        <ColumnChoice
          label="Signed amount"
          value={columns.amount}
          headers={request.headers}
          optional
          onChange={(value) => setColumn("amount", value)}
        />
        <ColumnChoice
          label="Debit"
          value={columns.debit}
          headers={request.headers}
          optional
          onChange={(value) => setColumn("debit", value)}
        />
        <ColumnChoice
          label="Credit"
          value={columns.credit}
          headers={request.headers}
          optional
          onChange={(value) => setColumn("credit", value)}
        />
        <ColumnChoice
          label="Currency column"
          value={columns.currency}
          headers={request.headers}
          optional
          onChange={(value) => setColumn("currency", value)}
        />
        <View style={styles.field}>
          <Text style={styles.label}>Or one currency for the file</Text>
          <TextInput
            value={constantCurrency}
            onChangeText={setConstantCurrency}
            autoCapitalize="characters"
            placeholder="EUR"
            maxLength={3}
            style={styles.input}
          />
        </View>
        {optionalFields.map(([field, label]) => (
          <ColumnChoice
            key={field}
            label={label}
            value={columns[field]}
            headers={request.headers}
            optional
            onChange={(value) => setColumn(field, value)}
          />
        ))}
      </View>
      <Text style={styles.sampleLabel}>Sample values</Text>
      {request.headers.slice(0, 8).map((header) => (
        <Text key={header} style={styles.sample} numberOfLines={1}>
          <Text style={styles.sampleStrong}>{header}: </Text>
          {request.sampleRows.map((row) => row[header]).filter(Boolean).slice(0, 2).join(" · ") || "empty"}
        </Text>
      ))}
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.actions}>
        <Pressable style={styles.secondaryButton} onPress={onCancel}>
          <Text style={styles.secondaryButtonText}>Cancel</Text>
        </Pressable>
        <Pressable style={styles.primaryButton} onPress={submit}>
          <Text style={styles.primaryButtonText}>Save mapping & import</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function CsvImporter() {
  const {
    data,
    database,
    loading,
    error: storageError,
    refresh,
    requestPersistentStorage,
  } = useFinanceData();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [mappingRequest, setMappingRequest] = useState<MappingRequest>();
  const [candidate, setCandidate] = useState<Candidate>();
  const [corrections, setCorrections] = useState<
    Record<number, Record<string, string>>
  >({});
  const [confirmDelete, setConfirmDelete] = useState<string>();

  const commitCandidate = async (
    current: Candidate,
    skippedRowNumbers: number[] = [],
  ) => {
    if (!database) return;
    setBusy(true);
    setError(undefined);
    try {
      const accountId = await localAccountId(current.result.account);
      const duplicateResult = deduplicateTransactions(
        data.transactions,
        current.result.transactions,
        accountId,
      );
      const importId = crypto.randomUUID();
      const sourceFileId = crypto.randomUUID();
      const transactions = duplicateResult.accepted.map(
        (transaction: TransactionDraft) => ({
          ...transaction,
          id: crypto.randomUUID(),
          accountId,
          importId,
        }),
      );
      await saveImport(database, {
        account: { ...current.result.account, id: accountId },
        sourceFile: {
          id: sourceFileId,
          name: current.file.name,
          type: current.file.type || "text/csv",
          blob: current.file,
        },
        importRecord: {
          id: importId,
          accountId,
          sourceFileId,
          fileName: current.file.name,
          fileHash: current.hash,
          adapterId: current.result.adapterId,
          importedAt: new Date().toISOString(),
          importedCount: transactions.length,
          duplicateCount: duplicateResult.skipped.length,
          skippedRowNumbers,
        },
        transactions,
        mapping: current.mapping,
      });
      const persistent = await requestPersistentStorage();
      await refresh();
      setNotice(
        `Imported ${transactions.length}. Skipped ${duplicateResult.skipped.length} duplicate${duplicateResult.skipped.length === 1 ? "" : "s"}${skippedRowNumbers.length ? ` and ${skippedRowNumbers.length} invalid row${skippedRowNumbers.length === 1 ? "" : "s"}` : ""}. ${persistent ? "Persistent browser storage is enabled." : "Keep a backup: the browser did not grant persistent storage."}`,
      );
      setCandidate(undefined);
      setMappingRequest(undefined);
      setCorrections({});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const acceptCandidate = async (next: Candidate) => {
    setMappingRequest(undefined);
    setCandidate(next);
    setCorrections({});
    if (!next.result.errors.length) await commitCandidate(next);
  };

  const processFile = async (file: File) => {
    if (!database) return;
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    setCandidate(undefined);
    setMappingRequest(undefined);
    try {
      if (!file.name.toLowerCase().endsWith(".csv"))
        throw new Error("Choose a .csv file");
      if (file.size > 25 * 1024 * 1024)
        throw new Error("CSV files must be 25 MB or smaller");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = await sha256Hex(bytes);
      if (await findImportByFileHash(database, hash)) {
        setNotice("This exact CSV file was already imported. Nothing changed.");
        return;
      }
      const text = decodeCsvBytes(bytes);
      const detected = detectCsvFormat(text, file.name, data.mappings);
      if (detected.kind === "mapping-required" || detected.kind === "auto-mapping") {
        setMappingRequest({
          file,
          hash,
          text,
          headers: detected.headers as string[],
          sampleRows: detected.sampleRows as Record<string, string>[],
          ...(detected.kind === "auto-mapping"
            ? { autoMapping: detected.mapping as MappingRequest["autoMapping"] }
            : {}),
        });
        return;
      }
      await acceptCandidate({
        file,
        hash,
        text,
        result: detected.result as NormalizationResult,
        mapping: detected.mapping,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "CSV import failed");
    } finally {
      setBusy(false);
    }
  };

  const retryCorrections = async () => {
    if (!candidate) return;
    try {
      const result = candidate.mapping
        ? normalizeMappedCsv(
            candidate.text,
            candidate.file.name,
            candidate.mapping,
            corrections,
          )
        : normalizeCommerzbankCsv(
            candidate.text,
            candidate.file.name,
            corrections,
          );
      await acceptCandidate({ ...candidate, result: result as NormalizationResult });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Correction failed");
    }
  };

  const removeImport = async (importId: string) => {
    if (!database) return;
    if (confirmDelete !== importId) {
      setConfirmDelete(importId);
      return;
    }
    setBusy(true);
    try {
      await deleteImport(database, importId);
      await refresh();
      setNotice("Import, source CSV, and its transactions were deleted.");
      setConfirmDelete(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  if (Platform.OS !== "web") return null;

  return (
    <View style={styles.wrap}>
      <View style={styles.importBar}>
        <View style={styles.importCopy}>
          <Text style={styles.heading}>
            {data.transactions.length
              ? `${data.transactions.length} local transactions`
              : "Import your bank transactions"}
          </Text>
          <Text style={styles.help}>
            CSV files and transactions stay in this browser on this device.
          </Text>
        </View>
        <View
          style={[
            styles.primaryButton,
            styles.fileButton,
            (busy || loading || !database) && styles.disabled,
          ]}
        >
          <Text style={styles.primaryButtonText}>
            {busy ? "Working…" : "Import bank CSV"}
          </Text>
          {createElement("input", {
            type: "file",
            accept: ".csv,text/csv",
            disabled: busy || loading || !database,
            "aria-label": "Import bank CSV",
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void processFile(file);
            },
            style: {
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              opacity: 0,
              cursor: "pointer",
            },
          })}
        </View>
      </View>
      {(notice || error || storageError) && (
        <View style={[styles.notice, (error || storageError) && styles.noticeError]}>
          <Text style={(error || storageError) ? styles.error : styles.noticeText}>
            {error || storageError || notice}
          </Text>
        </View>
      )}
      {mappingRequest && (
        <MappingForm
          request={mappingRequest}
          onMapped={(next) => void acceptCandidate(next)}
          onCancel={() => setMappingRequest(undefined)}
        />
      )}
      {candidate?.result.errors.length ? (
        <View style={styles.panel}>
          <Text style={styles.heading}>
            {candidate.result.errors.length} row
            {candidate.result.errors.length === 1 ? " needs" : "s need"} attention
          </Text>
          <Text style={styles.help}>
            Correct the values, import only valid rows, or cancel. Nothing is stored yet.
          </Text>
          {candidate.result.errors.map((rowError) => (
            <View key={`${rowError.rowNumber}-${rowError.field}`} style={styles.badRow}>
              <View style={styles.badRowCopy}>
                <Text style={styles.badRowTitle}>
                  Row {rowError.rowNumber} · {rowError.field}
                </Text>
                <Text style={styles.error}>{rowError.message}</Text>
              </View>
              <TextInput
                value={corrections[rowError.rowNumber]?.[rowError.field] || ""}
                onChangeText={(value) =>
                  setCorrections((current) => ({
                    ...current,
                    [rowError.rowNumber]: {
                      ...current[rowError.rowNumber],
                      [rowError.field]: value,
                    },
                  }))
                }
                placeholder={
                  rowError.field.includes("Date") || rowError.field === "bookingDate"
                    ? "YYYY-MM-DD"
                    : `Correct ${rowError.field}`
                }
                style={[styles.input, styles.correctionInput]}
              />
            </View>
          ))}
          <View style={styles.actions}>
            <Pressable
              style={styles.secondaryButton}
              onPress={() => {
                setCandidate(undefined);
                setCorrections({});
              }}
            >
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={styles.secondaryButton}
              onPress={() =>
                void commitCandidate(
                  candidate,
                  candidate.result.errors.map((item) => item.rowNumber),
                )
              }
            >
              <Text style={styles.secondaryButtonText}>Import valid rows</Text>
            </Pressable>
            <Pressable style={styles.primaryButton} onPress={() => void retryCorrections()}>
              <Text style={styles.primaryButtonText}>Retry corrections</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {data.imports.length > 0 && (
        <View style={styles.history}>
          <Text style={styles.historyTitle}>Local import history</Text>
          {data.imports
            .slice()
            .sort((left, right) => right.importedAt.localeCompare(left.importedAt))
            .slice(0, 4)
            .map((item) => {
              const account = data.accounts.find(
                (candidateAccount) => candidateAccount.id === item.accountId,
              );
              return (
                <View key={item.id} style={styles.historyRow}>
                  <View style={styles.importCopy}>
                    <Text style={styles.historyName}>{item.fileName}</Text>
                    <Text style={styles.help}>
                      {account?.institution || "Bank"}
                      {maskIdentifier(account?.identifier)
                        ? ` · ${maskIdentifier(account?.identifier)}`
                        : ""}
                      {` · ${item.importedCount} imported · ${item.duplicateCount} duplicates`}
                    </Text>
                  </View>
                  <Pressable onPress={() => void removeImport(item.id)}>
                    <Text style={styles.deleteText}>
                      {confirmDelete === item.id ? "Confirm delete" : "Delete"}
                    </Text>
                  </Pressable>
                </View>
              );
            })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12, marginBottom: 20 },
  importBar: {
    backgroundColor: colors.white,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 20,
    padding: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  importCopy: { flex: 1, minWidth: 0 },
  heading: { color: colors.ink, fontSize: 16, fontWeight: "800" },
  help: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 3 },
  primaryButton: {
    borderRadius: 16,
    backgroundColor: colors.teal,
    paddingHorizontal: 16,
    paddingVertical: 11,
    alignSelf: "flex-start",
  },
  fileButton: { position: "relative", overflow: "hidden" },
  primaryButtonText: { color: colors.white, fontSize: 12, fontWeight: "800" },
  secondaryButton: {
    borderRadius: 16,
    borderColor: colors.line,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  secondaryButtonText: { color: colors.ink, fontSize: 12, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  notice: { borderRadius: 14, backgroundColor: colors.tealSoft, padding: 12 },
  noticeError: { backgroundColor: colors.redSoft },
  noticeText: { color: colors.ink, fontSize: 12, lineHeight: 18 },
  error: { color: colors.red, fontSize: 12, lineHeight: 18 },
  panel: {
    backgroundColor: colors.white,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 20,
    padding: 20,
  },
  formGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 18,
  },
  field: { minWidth: 220, flex: 1 },
  label: { color: colors.ink, fontSize: 11, fontWeight: "700", marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.ink,
    backgroundColor: colors.white,
    fontSize: 13,
  },
  optionRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  option: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 9,
    paddingVertical: 8,
  },
  optionActive: { backgroundColor: colors.tealSoft, borderColor: colors.teal },
  optionText: { color: colors.ink, fontSize: 11, fontWeight: "600" },
  choiceWrap: { minWidth: 220, flex: 1, position: "relative", zIndex: 1 },
  choice: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: colors.white,
  },
  choiceText: { color: colors.ink, fontSize: 13 },
  placeholder: { color: colors.muted, fontSize: 13 },
  choiceArrow: { color: colors.muted },
  choiceMenu: {
    marginTop: 4,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    backgroundColor: colors.white,
    overflow: "hidden",
  },
  choiceOption: { paddingHorizontal: 12, paddingVertical: 9 },
  sampleLabel: { color: colors.ink, fontSize: 12, fontWeight: "800", marginTop: 18 },
  sample: { color: colors.muted, fontSize: 11, marginTop: 5 },
  sampleStrong: { color: colors.ink, fontWeight: "700" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end", marginTop: 18 },
  badRow: {
    borderBottomWidth: 1,
    borderColor: colors.line,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  badRowCopy: { flex: 1 },
  badRowTitle: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  correctionInput: { minWidth: 200 },
  history: { paddingHorizontal: 4 },
  historyTitle: { color: colors.muted, fontSize: 11, fontWeight: "800", marginBottom: 4 },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderColor: colors.line,
  },
  historyName: { color: colors.ink, fontSize: 12, fontWeight: "700" },
  deleteText: { color: colors.red, fontSize: 11, fontWeight: "700" },
});
