import "server-only"
import { promises as fs } from "fs"
import path from "path"
import type { CaseResult } from "./judge"

// Persistent history of eval runs. Written to data/eval-runs.json (same DATA_DIR
// convention as the incident store). This is Nova's own product data (eval
// results) — not observability data — so persisting it is intentional.

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data")
const STORE_PATH = path.join(DATA_DIR, "eval-runs.json")
const MAX_RUNS = 50

export interface EvalRun {
  id: string
  startedAt: string
  finishedAt: string
  generatorModel: string
  judgeModel: string | null
  /** Mean overall score across the cases in this run (0–1). */
  aggregate: number
  caseCount: number
  results: CaseResult[]
  /** "golden" = curated regression suite (default). "incident" = graded a real
   *  resolved incident's approved RCA. Optional for backward compatibility. */
  kind?: "golden" | "incident"
  /** Set when kind === "incident": the incident whose RCA was evaluated. */
  incidentId?: string
  /** Whether the run's aggregate met the configured pass threshold. Optional for
   *  backward compatibility with runs recorded before this field existed. */
  pass?: boolean
}

interface StoreFile {
  version: number
  runs: EvalRun[]
}

let writeChain: Promise<unknown> = Promise.resolve()
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn)
  writeChain = run.catch(() => {})
  return run
}

async function readStore(): Promise<StoreFile> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8")
    const parsed = JSON.parse(raw) as StoreFile
    if (!parsed || !Array.isArray(parsed.runs)) return { version: 1, runs: [] }
    return parsed
  } catch {
    return { version: 1, runs: [] }
  }
}

export async function saveRun(run: EvalRun): Promise<void> {
  await withWriteLock(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true })
    const store = await readStore()
    store.runs.unshift(run)
    store.runs = store.runs.slice(0, MAX_RUNS)
    await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8")
  })
}

export async function listRuns(): Promise<EvalRun[]> {
  const store = await readStore()
  return store.runs
}
