import Link from "next/link";
import { Button } from "@/components/ui/button";

const STACK = [
  "Next.js + React + TypeScript (Vercel)",
  "Supabase PostgreSQL + Auth + Storage",
  "Vercel Workflows (background jobs)",
  "OpenRouter free models + Vercel AI SDK",
  "shadcn/ui + Tailwind CSS",
  "TanStack Query + Table + Apache ECharts",
  "Drizzle ORM + Zod",
  "Papa Parse + ExcelJS",
  "CodeMirror",
  "Vitest + Playwright",
];

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
        Moneo
      </p>
      <h1 className="mt-2 text-4xl font-bold tracking-tight">
        Personal Finance Workspace
      </h1>
      <p className="mt-4 text-muted-foreground">
        Stack is wired. Put your keys in{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 text-sm">.env</code>{" "}
        (see <code className="rounded bg-muted px-1.5 py-0.5 text-sm">.env.example</code>),
        then run <code className="rounded bg-muted px-1.5 py-0.5 text-sm">npm run dev</code>.
      </p>
      <div className="mt-6 flex gap-3">
        <Button asChild>
          <Link href="/ai">Open AI panel</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/api/health">API health</Link>
        </Button>
      </div>
      <h2 className="mt-12 text-lg font-semibold">Stack status</h2>
      <ul className="mt-3 space-y-2">
        {STACK.map((s) => (
          <li key={s} className="flex items-center gap-2 text-sm">
            <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
            {s}
          </li>
        ))}
      </ul>
    </main>
  );
}
