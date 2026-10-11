import { Combobox } from '@/components/ui/combobox'
import { CAPABILITY_MODE_OPTIONS, capabilityModeExplanation, type CapabilityContext } from '@/lib/capabilityModes'
import type { MCPServerMode } from '@/types/models'

/**
 * One capability context's activation selector: a labeled combobox plus the
 * per-context explanation beside it. Shared by the MCP server cards and the
 * read-only Subagents/Skills cards — the only visual difference is the
 * accessible name, so every selector in the Capabilities tab reads and
 * behaves identically.
 */
export function CapabilityModeSelect({ name, context, mode, disabled, onChange }: {
  /** Capability name (server / profile / skill) — labeled into the aria name. */
  name: string
  context: CapabilityContext
  mode: MCPServerMode
  disabled: boolean
  onChange: (mode: MCPServerMode) => void
}) {
  const label = context === 'chat' ? 'Chat' : 'Code'
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground w-10 text-right">{label}</span>
      <Combobox
        ariaLabel={`${name} ${context} mode`}
        value={mode}
        options={CAPABILITY_MODE_OPTIONS}
        disabled={disabled}
        onChange={(value) => onChange(value as MCPServerMode)}
        fitToOptions
        contentClassName="min-w-36"
        className="h-8 px-2 text-xs"
      />
    </div>
  )
}

/** The per-context explanation pair rendered under a card's selector row. */
export function CapabilityModeExplanations({ chatMode, codeMode }: {
  chatMode: MCPServerMode
  codeMode: MCPServerMode
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{capabilityModeExplanation('chat', chatMode)}</span>
      <span className="text-xs text-muted-foreground">{capabilityModeExplanation('code', codeMode)}</span>
    </div>
  )
}
