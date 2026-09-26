"use client";

import {
  useTable,
  flexRender,
  tableFeatures,
  coreFeatures,
  createCoreRowModel,
  type ColumnDef,
  type CoreFeatures,
} from "@tanstack/react-table";

export function DataTable<T extends object>({
  data,
  columns,
}: {
  data: T[];
  columns: ColumnDef<CoreFeatures, T>[];
}) {
  const table = useTable({
    features: tableFeatures({ ...coreFeatures, coreRowModel: createCoreRowModel() }),
    data,
    columns,
  });
  return (
    <table className="w-full text-sm">
      <thead>
        {table.getHeaderGroups().map((hg) => (
          <tr key={hg.id} className="border-b border-border text-left">
            {hg.headers.map((h) => (
              <th key={h.id} className="py-2 pr-4 font-medium text-muted-foreground">
                {flexRender(h.column.columnDef.header, h.getContext())}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id} className="border-b border-border">
            {row.getAllCells().map((cell) => (
              <td key={cell.id} className="py-2 pr-4">
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
