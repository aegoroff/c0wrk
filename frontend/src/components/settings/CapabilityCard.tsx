import { Bot, Sparkles, CircleOff } from 'lucide-react'
import { CapabilityModeExplanations, CapabilityModeSelect } from './CapabilityModeSelect'
import { isDisabledInBothContexts, isManualAnywhere } from '@/lib/capabilityModes'
import { Badge } from '@/components/ui/badge'
import type { CapabilityModes, MCPServerMode } from '@/types/models'

/**
 * Read-only capability card (Settings → Capabilities → Subagents / Skills).
 * Mirrors the MCP server card's information shape — name, description, one
 * activation selector per context with the per-context explanations — but
 * carries NO mutation controls: profiles and skills are files on disk, not
 * rows to add/delete here. The selectors themselves persist through the
 * capabilities RPC.
 */
export function CapabilityCard({ icon, name, description, modes, disabled, onChange }: {
  /** Which catalog the entry belongs to — picks the card icon. */
  icon: 'agent' | 'skill'
  name: string
  description: string
  modes: CapabilityModes
  disabled: boolean
  onChange: (context: 'chat' | 'code', mode: MCPServerMode) => void
}) {
  const Icon = icon === 'agent' ? Bot : Sparkles
  const neutralDisabled = isDisabledInBothContexts(modes.chat_mode, modes.code_mode)
  return (
    <div className="border rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-3">
        {neutralDisabled
          ? <CircleOff className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          : <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />}
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
        <div className="flex flex-wrap items-center gap-2">
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
      <CapabilityModeExplanations chatMode={modes.chat_mode} codeMode={modes.code_mode} />
    </div>
  )
}
