export type ChartPoint = {
  label: string;
  x: number;
  y: number;
};

const labels = ['Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'];

export function chartPoints(values: number[]): ChartPoint[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return values.map((value, index) => ({
    label: labels[index],
    x: (index / (values.length - 1)) * 100,
    y: 74 - ((value - min) / range) * 56,
  }));
}

export function pointAtIndex(
  points: ChartPoint[],
  index: number,
): ChartPoint | undefined {
  return points[Math.max(0, Math.min(index, points.length - 1))];
}
