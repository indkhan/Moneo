import { formatMoney } from "@/lib/finance/format";

function readableEvidence(value: unknown, currency?: string, path = "Evidence", locale?: string): string[] {
  if (Array.isArray(value)) return value.flatMap((row, index) => readableEvidence(row, currency, `${path} ${index + 1}`, locale));
  if (!value || typeof value !== "object") return [`${path}: ${value === null ? "Unknown" : String(value)}`];
  const fields = value as Record<string, unknown>;
  const code = [fields.currency, fields.currency_code, fields.currencyCode, currency].find(item => typeof item === "string" && /^[A-Z]{3}$/.test(item)) as string | undefined;
  return Object.entries(fields).flatMap(([key, item]) => {
    const label = `${path} / ${key}`;
    if (item !== null && typeof item === "object") return readableEvidence(item, code, label, locale);
    if (/(?:Minor|_minor)$/.test(key)) {
      if (item === null) return [`${label}: Unknown`];
      if (code && typeof item === "string" && /^-?\d+$/.test(item)) {
        try { return [`${label}: ${formatMoney(item, code, locale)}`]; } catch { /* Retain invalid or unsupported evidence literally. */ }
      }
    }
    return [`${label}: ${item === null ? "Unknown" : String(item)}`];
  });
}

export function calculatorExportText(title: string, version: string, output: unknown, params: Record<string, string | number>, snapshot: unknown, locale?: string): string {
  const partial = snapshot !== null && typeof snapshot === "object" && "partial" in snapshot && snapshot.partial === true;
  return [title, version, `Exported ${new Date().toISOString()}`, "Calculator results are illustrative; dated evidence and its limitations are included below.",
    ...(partial ? ["Partial data: unreviewed classifications are excluded."] : []), "", "Result", JSON.stringify(output, null, 2), "", "Inputs", JSON.stringify(params, null, 2),
    "", "Dated financial evidence", ...readableEvidence(snapshot, undefined, "Evidence", locale), "", "Exact evidence appendix", JSON.stringify(snapshot, null, 2)].join("\n");
}

export function printCalculator(text: string) {
  const frame = document.createElement("iframe");
  frame.setAttribute("title", "Printable calculator report"); frame.style.position = "fixed"; frame.style.width = "0"; frame.style.height = "0"; frame.style.border = "0";
  document.body.append(frame);
  const target = frame.contentDocument, host = frame.contentWindow;
  if (!target || !host) { frame.remove(); throw new Error("Print preview unavailable"); }
  target.title = "Moneo calculator report";
  const content = target.createElement("pre"); content.textContent = text;
  content.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace;color:#17212b;";
  target.body.append(content); host.onafterprint = () => frame.remove(); host.focus(); host.print();
}

export function calculatorPngLines(text: string) {
  if (text.length > 33000) throw new Error("Report is too large for a PNG. Use Print / PDF to export the complete report.");
  const lines = text.split("\n").flatMap(line => line.match(/.{1,100}/gu) ?? [""]);
  if (80 + lines.length * 24 > 8192) throw new Error("Report is too large for a PNG. Use Print / PDF to export the complete report.");
  return lines;
}

export function downloadCalculatorPng(text: string) {
  const lines = calculatorPngLines(text);
  const canvas = document.createElement("canvas"); canvas.width = 1200; canvas.height = Math.max(200, 80 + lines.length * 24);
  const context = canvas.getContext("2d"); if (!context) throw new Error("Image export unavailable");
  context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#17212b"; context.font = "18px monospace";
  lines.forEach((line, index) => context.fillText(line, 32, 44 + index * 24));
  const data = canvas.toDataURL("image/png");
  if (!data.startsWith("data:image/png;base64,")) throw new Error("Image export unavailable. Use Print / PDF.");
  const link = document.createElement("a"); link.download = "moneo-calculator.png"; link.href = data; link.click();
}
