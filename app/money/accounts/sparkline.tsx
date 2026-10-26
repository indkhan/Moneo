export type Point = { date: string; value: bigint };

// Server-rendered SVG: no chart library or client JS. Numbers are used only for pixel scale.
export function Sparkline({ points, label, width = 120, height = 32, className = "text-brand", area = false }: { points: Point[]; label: string; width?: number; height?: number; className?: string; area?: boolean }) {
  if (points.length < 2) return <span className="text-xs text-muted-foreground">No trend yet</span>;
  const values = points.map(point => Number(point.value));
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const step = width / (points.length - 1);
  const path = values.map((value, index) => `${(index * step).toFixed(1)},${(height - 2 - ((value - min) / span) * (height - 4)).toFixed(1)}`).join(" ");
  return <svg role="img" aria-label={label} viewBox={`0 0 ${width} ${height}`} width={width} height={height} preserveAspectRatio={area ? "none" : undefined} className={`overflow-visible ${className}`}>
    {area && <polygon points={`0,${height} ${path} ${width},${height}`} fill="currentColor" fillOpacity={0.08} />}
    <polyline points={path} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
  </svg>;
}
