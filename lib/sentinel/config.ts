import { readFileSync, existsSync } from "node:fs"
import yaml from "js-yaml"
import { NovaConfigSchema, SentinelConfigSchema, type SentinelConfig } from "@/lib/config/schema"
import { Correlator } from "./correlate"
import { LogAnalyzer } from "./logs/analyzer"
import { LogTemplateMiner } from "./logs/template"
import { LogRateMonitor } from "./logs/rate"
import type { LogSignature, SignatureCategory } from "./logs/signatures"
import { ImpactMonitor } from "./business/impact"
import { AbsenceMonitor } from "./business/absence"

// Bridges the typed `sentinel:` config block (lib/config/schema.ts) to the
// engine's runtime objects. Pure `buildSentinel()` is unit-testable; the
// standalone loader reads nova.config.yaml WITHOUT the server-only config loader
// so the companion process can consume the same single source of truth.

// sensitivity → rate-shift spike factor (lower factor = more sensitive).
const SPIKE_FACTOR: Record<SentinelConfig["sensitivity"], number> = {
  low: 6,
  medium: 4,
  high: 3,
}

export interface SentinelBuild {
  correlator: Correlator
  analyzer: LogAnalyzer
  logsEnabled: boolean
}

/** Turn a validated SentinelConfig into the engine's collaborators. Pure. */
export function buildSentinel(cfg: SentinelConfig, now?: () => number): SentinelBuild {
  const correlator = new Correlator({
    windowMs: cfg.dedupeWindowSec * 1000,
    softConfirmKinds: cfg.softConfirmKinds,
    now,
  })

  const extraSignatures: LogSignature[] = cfg.logs.extraSignatures.map((s) => ({
    kind: s.kind,
    category: s.category as SignatureCategory,
    severity: s.severity,
    hard: s.hard,
    pattern: new RegExp(s.pattern, "i"),
  }))

  const impact =
    cfg.impact.enabled && (cfg.impact.pattern || cfg.impact.level)
      ? new ImpactMonitor({
          match: { pattern: cfg.impact.pattern, level: cfg.impact.level },
          minImpact: cfg.impact.minImpact,
          label: cfg.impact.label,
          now,
        })
      : undefined

  const absence =
    cfg.absence.enabled && (cfg.absence.successPattern || cfg.absence.level)
      ? new AbsenceMonitor({
          match: { pattern: cfg.absence.successPattern, level: cfg.absence.level },
          minBaseline: cfg.absence.minBaseline,
          dropFactor: cfg.absence.dropFactor,
          label: cfg.absence.label,
          now,
        })
      : undefined

  const analyzer = new LogAnalyzer({
    miner: new LogTemplateMiner({ warmupLines: cfg.logs.warmupLines, now }),
    rate: new LogRateMonitor({ spikeFactor: SPIKE_FACTOR[cfg.sensitivity], now }),
    extraSignatures,
    impact,
    absence,
    now,
  })

  return { correlator, analyzer, logsEnabled: cfg.logs.enabled }
}

/** Load just the `sentinel:` block from a nova.config.yaml. Returns schema
 * defaults (enabled: false) when the file is absent. No server-only import, so it
 * runs in the standalone companion. */
export function loadSentinelConfig(path?: string): SentinelConfig {
  const file = path || process.env.NOVA_CONFIG || "/app/nova.config.yaml"
  if (!existsSync(file)) return SentinelConfigSchema.parse({})
  const raw = yaml.load(readFileSync(file, "utf8")) ?? {}
  // Full-config parse fills defaults for every section; we only need `sentinel`.
  return NovaConfigSchema.parse(raw).sentinel
}
