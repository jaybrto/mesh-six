const statusStyles: Record<string, string> = {
  online: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  degraded: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  offline: "bg-red-500/20 text-red-400 border-red-500/30",
  pending: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  dispatched: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  completed: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  failed: "bg-red-500/20 text-red-400 border-red-500/30",
  timeout: "bg-orange-500/20 text-orange-400 border-orange-500/30",
};

const defaultStyle = "bg-zinc-500/20 text-zinc-400 border-zinc-500/30";

export function StatusBadge({ status }: { status: string }) {
  const style = statusStyles[status] ?? defaultStyle;
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${style}`}>
      {status}
    </span>
  );
}
