import { Badge } from '@/components/ui/badge'
import { CapabilityModeSelect } from './CapabilityModeSelect'
import { isDisabledInBothContexts, isManualAnywhere } from '@/lib/capabilityModes'
import type { CapabilityModes, MCPServerMode } from '@/types/models'

/**
 * Read-only capability card (Settings → Capabilities → Subagents / Skills).
 * Mirrors the MCP server card's information shape — name, description, one
 * activation selector per context — but carries NO mutation controls:
 * profiles and skills are files on disk, not rows to add/delete here. The
 * selectors themselves persist through the capabilities RPC. Unlike the MCP
 * cards there is no per-card icon (catalog icons live on the section headers
 * only) and no per-context explanation captions — the two selectors stack
 * vertically so the description keeps the card's full width.
 */
export function CapabilityCard({ name, description, modes, disabled, onChange }: {
  name: string
  description: string
  modes: CapabilityModes
  disabled: boolean
  onChange: (context: 'chat' | 'code', mode: MCPServerMode) => void
}) {
  const neutralDisabled = isDisabledInBothContexts(modes.chat_mode, modes.code_mode)
  return (
    <div className="border rounded-lg p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">{name}</span>
            {isManualAnywhere(modes.chat_mode, modes.code_mode) && (
              <Badge variant="outline" className="text-xs text-info border-info/50 gap-1">
                manual
              </Badge>
            )}
            {neutralDisabled && (
              <Badge variant="outline" className="text-xs text-muted-foreground gap-1">
                disabled
              </Badge>
            )}
          </div>
          {description && (
            <p className="text-xs text-muted-foreground break-words">{description}</p>
          )}
        </div>
        {/* One activation selector per context, stacked vertically. */}
        <div className="flex flex-col gap-2 flex-shrink-0">
          <CapabilityModeSelect
            name={name}
            context="chat"
            mode={modes.chat_mode}
            disabled={disabled}
            onChange={(mode) => onChange('chat', mode)}
          />
          <CapabilityModeSelect
            name={name}
            context="code"
            mode={modes.code_mode}
            disabled={disabled}
            onChange={(mode) => onChange('code', mode)}
          />
        </div>
      </div>
    </div>
  )
}
