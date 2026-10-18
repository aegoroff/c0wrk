import { ProviderAccordion } from './ProviderAccordion'
import type { ProviderConfig } from './ProviderAccordion'

/**
 * One compatible-provider GROUP: the section heading (which transport the
 * providers speak) plus the accordions of every provider of that transport.
 * The heading replaces the old per-accordion "OpenAI Compatible: name" label
 * prefix — an accordion's label is now just the provider name, the transport
 * lives once on the group. An empty set renders nothing: a heading with no
 * providers under it is noise (a fresh machine shows only the
 * "+ Add compatible provider" button above).
 */
interface CompatibleProviderGroupProps {
  /** The group heading, e.g. "OpenAI-compatible providers". */
  heading: string
  providerNames: Set<string>
  providerConfigs: Record<string, ProviderConfig>
  expandedProviders: Set<string>
  onToggle: (provider: string) => void
  onConfigChange: (provider: string, updates: Partial<{ api_key: string; base_url: string; tls_fingerprint: string; auto_retry_seconds?: number }>) => void
  onToggleModel: (provider: string, model: string) => void
  onDelete: (provider: string) => void
  defaultModel: string
  /** Server-published auto_retry_seconds upper bound (ADR-065). REQUIRED —
   *  LLMSettings gates the forms until the bound has loaded. */
  autoRetryMaxSeconds: number
}

export function CompatibleProviderGroup({
  heading,
  providerNames,
  providerConfigs,
  expandedProviders,
  onToggle,
  onConfigChange,
  onToggleModel,
  onDelete,
  defaultModel,
  autoRetryMaxSeconds,
}: CompatibleProviderGroupProps) {
  if (providerNames.size === 0) return null

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{heading}</h3>
      {[...providerNames].sort().map((name) => {
        const config = providerConfigs[name]
        if (!config) return null
        const isExpanded = expandedProviders.has(name)

        return (
          <ProviderAccordion
            key={name}
            provider={name}
            label={name}
            config={config}
            isExpanded={isExpanded}
            onToggle={() => onToggle(name)}
            onConfigChange={(updates) => onConfigChange(name, updates)}
            onToggleModel={(model) => onToggleModel(name, model)}
            onDelete={() => onDelete(name)}
            defaultModel={defaultModel}
            providerConfigs={providerConfigs}
            autoRetryMaxSeconds={autoRetryMaxSeconds}
          />
        )
      })}
    </section>
  )
}
