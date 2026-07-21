// Global test setup. Node-environment tests need nothing here; the jest-dom
// matchers (toBeInTheDocument, etc.) are registered for the component tests that
// opt into the jsdom environment via a `// @vitest-environment jsdom` docblock.
import "@testing-library/jest-dom/vitest"
