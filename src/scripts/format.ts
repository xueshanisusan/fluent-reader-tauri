// Relative time like the original Fluent Reader card meta ("3h", "1d").
export function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60000) return "now";
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(mo / 12)}y`;
}
