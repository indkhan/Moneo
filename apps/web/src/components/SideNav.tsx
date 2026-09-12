"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/home", label: "Home" },
  { href: "/money", label: "Money" },
  { href: "/plan", label: "Plan" },
  { href: "/ai", label: "AI" },
  { href: "/settings", label: "Settings" },
] as const;

export function SideNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" style={{ display: "grid", gap: 4, padding: 12 }}>
      {NAV.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              textDecoration: "none",
              fontWeight: active ? 700 : 500,
              background: active ? "var(--moneo-surface, #171e28)" : "transparent",
              border: active ? "1px solid var(--moneo-border, #2a3442)" : "1px solid transparent",
            }}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
