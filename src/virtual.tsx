import { type ReactNode, useState } from "react";
import { Box } from "@mui/material";

/** Rows to render for a scroll position: first index and one past the last. */
export function visibleRange(
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  count: number,
  overscan = 8,
): [number, number] {
  const first = Math.min(count, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const last = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return [first, Math.max(first, last)];
}

export type Column<T> = {
  header: string;
  /** A CSS grid track, e.g. "minmax(200px, 3fr)" or "120px". */
  width: string;
  align?: "right";
  cell: (row: T, index: number) => ReactNode;
};

type Props<T> = {
  columns: Column<T>[];
  rows: T[];
  /** Height of the scrolling body in px. */
  height: number;
  rowHeight?: number;
  /** Lets wide tables scroll sideways instead of squeezing their columns. */
  minWidth?: number;
  label: string;
  empty?: ReactNode;
};

/** A table that only mounts the rows in view, so 100 000 rows cost the same as 30. */
export function VirtualTable<T>({ columns, rows, height, rowHeight = 36, minWidth, label, empty }: Props<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  const [first, last] = visibleRange(scrollTop, height, rowHeight, rows.length);
  const grid = {
    display: "grid",
    gridTemplateColumns: columns.map((c) => c.width).join(" "),
    alignItems: "center",
    columnGap: 2,
    px: 2,
    height: rowHeight,
    fontSize: 14,
    borderBottom: 1,
    borderColor: "divider",
  };
  const cell = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
  return (
    <Box
      role="table"
      aria-label={label}
      aria-rowcount={rows.length + 1}
      tabIndex={0}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      sx={{ height: height + rowHeight, overflow: "auto", border: 1, borderColor: "divider", borderRadius: 1 }}
    >
      <Box sx={{ minWidth }}>
        <Box role="row" sx={{ ...grid, position: "sticky", top: 0, zIndex: 1, bgcolor: "background.paper", fontWeight: 600 }}>
          {columns.map((c) => (
            <Box key={c.header} role="columnheader" sx={{ ...cell, textAlign: c.align }}>
              {c.header}
            </Box>
          ))}
        </Box>
        <Box sx={{ height: rows.length * rowHeight, position: "relative" }}>
          {rows.slice(first, last).map((row, i) => (
            <Box
              key={first + i}
              role="row"
              aria-rowindex={first + i + 2}
              sx={{ ...grid, position: "absolute", top: (first + i) * rowHeight, left: 0, right: 0, "&:hover": { bgcolor: "action.hover" } }}
            >
              {columns.map((c) => (
                <Box key={c.header} role="cell" sx={{ ...cell, textAlign: c.align }}>
                  {c.cell(row, first + i)}
                </Box>
              ))}
            </Box>
          ))}
        </Box>
        {rows.length === 0 && <Box sx={{ p: 2 }}>{empty}</Box>}
      </Box>
    </Box>
  );
}
