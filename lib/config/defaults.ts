// The default Nova configuration == today's behaviour.
//
// Derived from the schema so there is a single source of truth: every field's
// default lives on the zod schema, and `DEFAULT_CONFIG` is what you get with no
// user config at all. A test asserts the key values (file store / Loki /
// production scope / openrouter) so an accidental default change is caught.

import { NovaConfigSchema, type NovaConfig } from "./schema"

export const DEFAULT_CONFIG: NovaConfig = NovaConfigSchema.parse({})
