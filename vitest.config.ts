import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"
import path from "node:path"

const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    // M0 characterization tests are pure Node logic (lib/*). UI/component tests
    // (jsdom + Testing Library) arrive with the Settings UI milestone (M10).
    environment: "node",
    globals: true,
    // Some store/eval characterization tests do real file I/O; give them ample
    // headroom.
    testTimeout: 30000,
    include: ["**/*.{test,spec}.{ts,tsx}"],
    // Exclude nested node_modules (the demo micro-services vendor their own test
    // files, e.g. pg-protocol) and the relocated demo assets under examples/.
    exclude: [
      "**/node_modules/**",
      "**/.next/**",
      "examples/**",
    ],
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["lib/**"],
    },
  },
  resolve: {
    alias: {
      // Mirror the Next.js "@/*" path alias.
      "@": rootDir,
      // `server-only` throws when imported outside a server bundle; in the Vitest
      // Node runner it is a harmless no-op. Alias it to an empty stub so modules
      // that guard themselves with `import "server-only"` load in tests.
      "server-only": path.resolve(rootDir, "test/stubs/server-only.ts"),
    },
  },
})
