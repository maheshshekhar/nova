import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join } from "node:path"

// Architecture boundary: the Nova server (app/lib/components/hooks) is one entity
// and must never import demo assets. The demo micro-services live under
// examples/kind-demo and are wired only through HTTP/k8s, never a code import.
// This test fails if any core file imports from examples/ or a demo service.

const CORE_DIRS = ["app", "lib", "components", "hooks"]

const FORBIDDEN_IMPORT =
  /\bfrom\s+["'](?:@\/)?(?:\.\.\/)*(?:examples\/|(?:payment|transaction|config)-service\/|metrics-collector\/|load-generator\/)/

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if ([".ts", ".tsx"].includes(extname(full))) out.push(full)
  }
  return out
}

describe("architecture boundary — core is one entity with zero demo deps", () => {
  it("no core file imports from examples/ or a demo micro-service", () => {
    const offenders: string[] = []
    for (const dir of CORE_DIRS) {
      for (const file of walk(dir)) {
        if (FORBIDDEN_IMPORT.test(readFileSync(file, "utf8"))) offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})
