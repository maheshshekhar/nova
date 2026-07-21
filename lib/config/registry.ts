// Adapter registry — the runtime mechanism that turns a `provider` string in the
// config into a concrete adapter instance. Each plug point (persistence, logs,
// ai, metrics) owns one registry; adapters register a factory keyed by their
// provider name, and the app resolves `config.<kind>.provider` through it.
//
// Generic + dependency-free so it can be unit-tested in isolation and reused by
// every interface without circular imports on the adapters themselves.

export type AdapterFactory<TConfig, TAdapter> = (config: TConfig) => TAdapter

export class AdapterRegistry<TConfig, TAdapter> {
  private readonly factories = new Map<string, AdapterFactory<TConfig, TAdapter>>()

  constructor(private readonly kind: string) {}

  /** Register a provider's factory. Throws on a duplicate provider key so two
   * adapters can never silently claim the same name. */
  register(provider: string, factory: AdapterFactory<TConfig, TAdapter>): this {
    if (this.factories.has(provider)) {
      throw new Error(`Adapter already registered for ${this.kind} provider "${provider}"`)
    }
    this.factories.set(provider, factory)
    return this
  }

  has(provider: string): boolean {
    return this.factories.has(provider)
  }

  /** List registered provider keys (for diagnostics / error messages). */
  providers(): string[] {
    return [...this.factories.keys()]
  }

  /** Resolve + construct the adapter for a provider. Throws a helpful error
   * (listing known providers) when the provider is unknown. */
  create(provider: string, config: TConfig): TAdapter {
    const factory = this.factories.get(provider)
    if (!factory) {
      const known = this.providers().join(", ") || "none registered"
      throw new Error(
        `Unknown ${this.kind} provider "${provider}". Registered providers: ${known}.`
      )
    }
    return factory(config)
  }
}
