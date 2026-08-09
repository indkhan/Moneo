export function chartPoints(values) {
  if (!values.length) return [];
  if (values.length === 1) return [{ label: values[0].label, x: 50, y: 46 }];
  const min = Math.min(...values.map((point) => point.value));
  const max = Math.max(...values.map((point) => point.value));
  const range = max - min || 1;
  return values.map((point, index) => ({
    label: point.label,
    x: (index / (values.length - 1)) * 100,
    y: 74 - ((point.value - min) / range) * 56,
  }));
}
