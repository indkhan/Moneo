const labels = ['Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'];

export function chartPoints(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return values.map((value, index) => ({
    label: labels[index],
    x: (index / (values.length - 1)) * 100,
    y: 74 - ((value - min) / range) * 56,
  }));
}

export function pointAtIndex(points, index) {
  return points[Math.max(0, Math.min(index, points.length - 1))];
}

export function tooltipLeft(anchorX, chartWidth, tooltipWidth = 168, gutter = 8) {
  return Math.max(gutter, Math.min(anchorX, chartWidth - tooltipWidth - gutter));
}
