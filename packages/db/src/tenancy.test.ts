import { describe, expect, it, vi } from "vitest";
import { TENANT_SETTING, withWorkspaceTransaction, type TenantConnection } from "./tenancy.js";
import { uuidv7 } from "./uuid.js";

interface ScriptedConn extends TenantConnection {
  statements: string[];
  released: boolean;
  failOn: Set<string>;
}

/** In-memory stand-in for a pg connection: records statements, can fail on cue. */
function scriptedConn(failOn: string[] = []): ScriptedConn {
  const conn: ScriptedConn = {
    statements: [],
    released: false,
    failOn: new Set(failOn),
    query: (text: string) => {
      conn.statements.push(text);
      if (conn.failOn.has(text.split(" ")[0]!)) {
        return Promise.reject(new Error(`${text.split(" ")[0]} exploded`));
      }
      return Promise.resolve({ rows: [] });
    },
    release: () => {
      conn.released = true;
    },
  };
  return conn;
}

describe("withWorkspaceTransaction", () => {
  it("exposes the documented tenant setting name", () => {
    expect(TENANT_SETTING).toBe("app.current_workspace");
  });

  it("opens a transaction, pins the workspace, commits and releases — in order", async () => {
    const id = uuidv7();
    const conn = scriptedConn();
    const checkout = vi.fn(() => Promise.resolve(conn));
    const wrap = vi.fn((c: TenantConnection) => ({ via: c }));

    const result = await withWorkspaceTransaction(id, (tx) => Promise.resolve(tx), {
      checkout,
      wrap,
    });

    expect(result).toEqual({ via: conn });
    expect(checkout).toHaveBeenCalledOnce();
    expect(wrap).toHaveBeenCalledWith(conn);
    expect(conn.statements).toEqual([
      "BEGIN",
      `SET LOCAL app.current_workspace = '${id}'`,
      "COMMIT",
    ]);
    expect(conn.released).toBe(true);
  });

  it("returns the callback value untouched", async () => {
    const conn = scriptedConn();
    const out = await withWorkspaceTransaction(uuidv7(), () => Promise.resolve(42), {
      checkout: () => Promise.resolve(conn),
      wrap: (c) => c,
    });
    expect(out).toBe(42);
    expect(conn.released).toBe(true);
  });

  it("rolls back, rethrows the original error and still releases on callback failure", async () => {
    const conn = scriptedConn();
    const boom = new Error("domain invariant violated");
    await expect(
      withWorkspaceTransaction(uuidv7(), () => Promise.reject(boom), {
        checkout: () => Promise.resolve(conn),
        wrap: (c) => c,
      }),
    ).rejects.toBe(boom);
    expect(conn.statements).toEqual([
      expect.stringMatching(/^BEGIN$/),
      expect.stringMatching(/^SET LOCAL /),
      "ROLLBACK",
    ]);
    expect(conn.released).toBe(true);
  });

  it("rolls back and surfaces commit failures instead of reporting success", async () => {
    const conn = scriptedConn(["COMMIT"]);
    await expect(
      withWorkspaceTransaction(uuidv7(), () => Promise.resolve("ok"), {
        checkout: () => Promise.resolve(conn),
        wrap: (c) => c,
      }),
    ).rejects.toThrow("COMMIT exploded");
    expect(conn.statements).toContain("ROLLBACK");
    expect(conn.released).toBe(true);
  });

  it("still releases when rollback itself fails, keeping the original error", async () => {
    const conn = scriptedConn(["ROLLBACK"]);
    const boom = new Error("callback failed");
    await expect(
      withWorkspaceTransaction(uuidv7(), () => Promise.reject(boom), {
        checkout: () => Promise.resolve(conn),
        wrap: (c) => c,
      }),
    ).rejects.toBe(boom);
    expect(conn.released).toBe(true);
  });

  it("validates the workspace id before checking out a connection", async () => {
    const checkout = vi.fn(() => Promise.resolve(scriptedConn()));
    const wrap = vi.fn((c: TenantConnection) => c);
    await expect(
      withWorkspaceTransaction("not-a-uuid", () => Promise.resolve(1), { checkout, wrap }),
    ).rejects.toThrow("Invalid workspaceId: not a UUID");
    expect(checkout).not.toHaveBeenCalled();
    expect(wrap).not.toHaveBeenCalled();
  });

  it("rejects statement-smuggling ids without touching the database", async () => {
    const id = `${uuidv7()}'; DROP TABLE users; --`;
    const checkout = vi.fn(() => Promise.resolve(scriptedConn()));
    await expect(
      withWorkspaceTransaction(id, () => Promise.resolve(1), {
        checkout,
        wrap: (c) => c,
      }),
    ).rejects.toThrow("Invalid workspaceId");
    expect(checkout).not.toHaveBeenCalled();
  });

  it("uses SET LOCAL (transaction-scoped), never session-level SET", async () => {
    const conn = scriptedConn();
    await withWorkspaceTransaction(uuidv7(), () => Promise.resolve(null), {
      checkout: () => Promise.resolve(conn),
      wrap: (c) => c,
    });
    const setStmt = conn.statements.find((s) => s.startsWith("SET"))!;
    expect(setStmt.startsWith("SET LOCAL ")).toBe(true);
  });
});
