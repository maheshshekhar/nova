import { Sparkles } from "lucide-react"

// Provenance badge shown on incidents that Nova Sentinel opened itself (from
// zero-instrumentation k8s + log detection), distinguishing them from incidents
// created by external Alertmanager/inject paths.
export function NovaBadge({ className = "" }: { className?: string }) {
  return (
    <span
      title="Detected by Nova Sentinel — before an external alert fired"
      className={`inline-flex items-center gap-1 text-[10px] font-mono font-bold border px-1.5 py-0.5 rounded bg-[var(--neon-blue)]/15 text-[var(--neon-blue)] border-[var(--neon-blue)]/30 ${className}`}
    >
      <Sparkles className="w-2.5 h-2.5" />
      NOVA
    </span>
  )
}
