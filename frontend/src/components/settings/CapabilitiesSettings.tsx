import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Bot, Sparkles } from 'lucide-react'
import { listAgents } from '@/api/agents'
import { listSkills } from '@/api/skills'
import { getCapabilityModes, updateCapabilityModes } from '@/api/capabilities'
import { logger } from '@/lib/logger'
import { CapabilityCard } from './CapabilityCard'
import { MCPSettings } from './MCPSettings'
import type { AgentDescriptor, CapabilitiesInfo, CapabilityModes, CapabilitySection, MCPServerMode, SkillDescriptor } from '@/types/models'

/**
 * Settings → Capabilities: the per-context activation modes of everything
 * the agent can reach, in three subsections — Subagents, MCP Servers,
 * Skills. MCP Servers keeps its full management surface (add/edit/delete +
 * live status); profiles and skills are view-only catalogs whose mode
 * selectors persist through the capabilities RPC. Hidden agent profiles
 * never appear here because ListAgents already excludes them.
 */
export function CapabilitiesSettings() {
  const [agents, setAgents] = useState<AgentDescriptor[]>([])
  const [skills, setSkills] = useState<SkillDescriptor[]>([])
  // Null until the first load resolves: selectors stay disabled without it,
  // because updateCapabilityModes REPLACES a whole section — writing from a
  // half-known map would silently reset every other entry's modes.
  const [caps, setCaps] = useState<CapabilitiesInfo | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const savingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    // The catalogs and the capabilities section load independently: a
    // capabilities failure must NOT blank the lists — it only leaves the
    // mode selectors disabled (caps stays null), because writing modes from
    // a half-known map would reset every other entry's modes.
    let loadError: string | null = null
    try {
      const [ag, sk] = await Promise.all([listAgents(), listSkills()])
      setAgents(ag)
      setSkills(sk)
    } catch (err) {
      logger.error('Failed to load capability catalogs:', err)
      loadError = err instanceof Error ? err.message : String(err)
    }
    try {
      setCaps(await getCapabilityModes())
    } catch (err) {
      logger.error('Failed to load capability modes:', err)
      // Drop any previously loaded map: a failed load must never leave a
      // stale section behind for the selectors to write back.
      setCaps(null)
      loadError = loadError ?? (err instanceof Error ? err.message : String(err))
    }
    if (loadError) setError(loadError)
    setIsLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // Persist one context's mode for one catalog entry. The payload must carry
  // the FULL section (the backend replaces it wholesale), so every rendered
  // card contributes its current entry; names the backend no longer knows
  // (a deleted profile/skill/server) are trimmed server-side.
  const handleModeChange = async (section: Exclude<CapabilitySection, 'mcp'>, name: string, context: 'chat' | 'code', mode: MCPServerMode) => {
    if (!caps || savingRef.current) return
    const sectionCaps = caps[section]
    const current = sectionCaps[name] ?? { chat_mode: 'auto', code_mode: 'auto' }
    const field: keyof CapabilityModes = context === 'chat' ? 'chat_mode' : 'code_mode'
    if (current[field] === mode) return
    const next: Record<string, CapabilityModes> = {
      ...sectionCaps,
      [name]: { ...current, [field]: mode },
    }
    savingRef.current = true
    setIsSaving(true)
    setError(null)
    try {
      await updateCapabilityModes(section, next)
      setCaps({ ...caps, [section]: next })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      savingRef.current = false
      setIsSaving(false)
    }
  }

  if (isLoading) return <div className="flex items-center justify-center py-8"><span className="text-sm text-muted-foreground">Loading capabilities...</span></div>

  const sectionDisabled = isSaving || !caps

  return (
    <div className="flex flex-col gap-6">
      {error && <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20 text-sm"><AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" /><p>{error}</p></div>}

      <CapabilitySection
        icon={<Bot className="h-4 w-4 text-muted-foreground" />}
        title="Subagents"
        emptyText="No subagent profiles found."
        entries={agents.map((a) => ({ name: a.name, description: a.description }))}
        section="agents"
        modes={caps?.agents ?? {}}
        disabled={sectionDisabled}
        onModeChange={(name, context, mode) => { void handleModeChange('agents', name, context, mode) }}
      />

      <MCPSettings />

      <CapabilitySection
        icon={<Sparkles className="h-4 w-4 text-muted-foreground" />}
        title="Skills"
        emptyText="No skills found."
        entries={skills.map((s) => ({ name: s.name, description: s.description }))}
        section="skills"
        modes={caps?.skills ?? {}}
        disabled={sectionDisabled}
        onModeChange={(name, context, mode) => { void handleModeChange('skills', name, context, mode) }}
      />
    </div>
  )
}

function CapabilitySection({ icon, title, emptyText, entries, section, modes, disabled, onModeChange }: {
  icon: React.ReactNode
  title: string
  emptyText: string
  entries: Array<{ name: string; description: string }>
  section: Exclude<CapabilitySection, 'mcp'>
  modes: Record<string, CapabilityModes>
  disabled: boolean
  onModeChange: (name: string, context: 'chat' | 'code', mode: MCPServerMode) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">{icon}<span className="text-sm font-medium">{title}</span></div>
      {entries.length === 0
        ? <div className="text-sm text-muted-foreground py-4 text-center">{emptyText}</div>
        : <div className="space-y-2">{entries.map((e) => (
            <CapabilityCard
              key={`${section}:${e.name}`}
              icon={section === 'agents' ? 'agent' : 'skill'}
              name={e.name}
              description={e.description}
              modes={modes[e.name] ?? { chat_mode: 'auto', code_mode: 'auto' }}
              disabled={disabled}
              onChange={(context, mode) => onModeChange(e.name, context, mode)}
            />
          ))}</div>}
    </div>
  )
}
