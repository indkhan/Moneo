import { createFromTemplate } from "./actions";
import { outputLabel, outputValue } from "./calculator-rows";

type TemplateCard = { id: string; name: string; description: string; kind: string; preview: unknown; sample: boolean };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function TemplateGallery({ templates, currency, locale }: { templates: TemplateCard[]; currency: string; locale?: string }) {
  return <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
    {templates.map(template => {
      const preview = asRecord(template.preview);
      const numbers = Object.entries(asRecord(preview.numbers)).filter(([, value]) => typeof value === "string" || typeof value === "number").slice(0, 3) as [string, string | number][];
      return <li key={template.id} className="flex flex-col rounded-xl border border-border bg-card shadow-sm">
        <div aria-label={`${template.name} preview`} role="img" className="m-3 mb-0 rounded-lg border border-border bg-background p-3">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{template.sample ? "Sample output" : "Preview · synthetic data"}</p>
          {typeof preview.summary === "string" && <p className="mt-1 line-clamp-2 text-xs font-medium text-foreground">{preview.summary}</p>}
          <dl className="mt-2 grid grid-cols-3 gap-1.5">{numbers.map(([key, value]) => <div key={key} className="min-w-0 rounded bg-muted px-1.5 py-1">
            <dt className="truncate text-[10px] text-muted-foreground">{outputLabel(key)}</dt>
            <dd className="truncate text-xs font-semibold tabular-nums">{outputValue(key, value, currency, locale)}</dd>
          </div>)}</dl>
        </div>
        <form action={createFromTemplate} className="flex flex-1 flex-col p-4">
          <input type="hidden" name="template" value={template.id} />
          <h3 className="font-medium">{template.name}</h3>
          <p className="mt-1 flex-1 text-sm text-muted-foreground">{template.description}</p>
          <button className="mt-3 self-start rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">Use template</button>
        </form>
      </li>;
    })}
  </ul>;
}
