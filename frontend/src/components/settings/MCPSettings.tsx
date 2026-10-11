import { useState, useEffect, useCallback, useRef } from 'react'
import { Plus, RefreshCw, Server, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import { getMCPStatus, getMCPServers, getToolList, updateMCPServers } from '@/api/mcp'
import { getCapabilityModes, updateCapabilityModes } from '@/api/capabilities'
import { subscribe } from '@/api/runtime'
import { logger } from '@/lib/logger'
import { MCPServerCard } from './MCPServerCard'
import { MCPServerForm } from './MCPServerForm'
import type { CapabilityModes, MCPServerConfig, MCPServerMode, MCPServerStatus, ToolInfo } from '@/types/models'

export function MCPSettings() {
  const [servers, setServers] = useState<MCPServerStatus[]>([])
  const [configs, setConfigs] = useState<Record<string, MCPServerConfig>>({})
  const [tools, setTools] = useState<ToolInfo[]>([])
  // The MCP slice of the capabilities section. Null until the first load
  // resolves: mode selectors stay disabled without it, because
  // updateCapabilityModes REPLACES the whole section — writing from a
  // half-known map would silently reset every other server's modes.
  const [caps, setCaps] = useState<Record<string, CapabilityModes> | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  // Guard full-map writes synchronously, including callbacks from already-open menus.
  const savingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Form state
  const [formOpen, setFormOpen] = useState(false)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [editServer, setEditServer] = useState<{ name: string; transport: string } | undefined>()
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    // The gateway view (status/tools/configs) and the capabilities section
    // load independently: a capabilities failure must NOT blank the server
    // list — it only leaves the mode selectors disabled (caps stays null),
    // because writing modes from a half-known map would reset the others.
    let loadError: string | null = null
    try {
      const [st, tl, cf] = await Promise.all([getMCPStatus(), getToolList(), getMCPServers()])
      setServers(st || [])
      setTools(tl || [])
      setConfigs(cf || {})
    } catch (err) {
      logger.error('Failed to load MCP status:', err)
      loadError = err instanceof Error ? err.message : String(err)
    }
    try {
      setCaps((await getCapabilityModes()).mcp ?? {})
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

  // Refresh when the MCP gateway finishes its (async) startup so the transient
  // "Starting…" placeholder resolves into the real per-server status without
  // manual polling. mcp:ready is emitted once by the desktop layer.
  useEffect(() => subscribe('mcp:ready', () => { loadData() }), [loadData])

  const handleSave = async (newServers: Record<string, MCPServerConfig>): Promise<string | null> => {
    if (savingRef.current) return 'An MCP configuration save is already in progress.'
    savingRef.current = true
    setIsSaving(true)
    setError(null)
    try { await updateMCPServers(newServers); setConfigs(newServers); await loadData(); return null }
    catch (err) { return err instanceof Error ? err.message : String(err) }
    finally { savingRef.current = false; setIsSaving(false) }
  }

  // Persist one context's mode for one server through the capabilities RPC.
  // The payload must carry the FULL mcp section (the backend replaces it
  // wholesale), so every rendered card contributes its current entry — a
  // server never shown here cannot exist (the card list mirrors the
  // configured set) and stale names are trimmed server-side anyway.
  const handleModeChange = async (name: string, context: 'chat' | 'code', mode: MCPServerMode) => {
    if (!caps || savingRef.current) return
    const current = caps[name] ?? { chat_mode: 'auto', code_mode: 'auto' }
    const field: keyof CapabilityModes = context === 'chat' ? 'chat_mode' : 'code_mode'
    if (current[field] === mode) return
    const next: Record<string, CapabilityModes> = {
      ...caps,
      [name]: { ...current, [field]: mode },
    }
    savingRef.current = true
    setIsSaving(true)
    setError(null)
    try {
      await updateCapabilityModes('mcp', next)
      setCaps(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      savingRef.current = false
      setIsSaving(false)
    }
  }

  const handleDelete = async (name: string) => {
    if (savingRef.current) return
    const next = { ...configs }; delete next[name]
    const err = await handleSave(next)
    if (err) setError(err)
    setDeleteConfirm(null)
  }

  const openAdd = () => { setEditingName(null); setEditServer(undefined); setFormOpen(true) }
  const openEdit = (s: MCPServerStatus) => { setEditingName(s.name); setEditServer({ name: s.name, transport: s.transport }); setFormOpen(true) }

  const handleToggleExpand = useCallback((name: string) => {
    setExpanded((prev) => {
      const n = new Set(prev)
      if (n.has(name)) n.delete(name)
      else n.add(name)
      return n
    })
  }, [])

  if (isLoading) return <div className="flex items-center justify-center py-8"><span className="text-sm text-muted-foreground">Loading MCP settings...</span></div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><Server className="h-4 w-4 text-muted-foreground" /><span className="text-sm font-medium">MCP Servers</span></div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" title="Reload servers" onClick={loadData} disabled={isLoading || isSaving}><RefreshCw className="h-3 w-3" /></Button>
          <Button variant="default" size="sm" onClick={openAdd} disabled={isSaving}><Plus className="h-3 w-3 mr-1" />Add Server</Button>
        </div>
      </div>

      {error && <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20 text-sm"><AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" /><p>{error}</p></div>}

      {servers.length === 0
        ? <div className="text-sm text-muted-foreground py-4 text-center">No MCP servers configured.</div>
        : <div className="space-y-2">{servers.map((s) => (
            <MCPServerCard
              key={s.name}
              server={s}
              tools={tools.filter((t) => t.source === s.name)}
              expanded={expanded.has(s.name)}
              onToggleExpand={() => handleToggleExpand(s.name)}
              onEdit={() => openEdit(s)}
              onDelete={() => setDeleteConfirm(s.name)}
              chatMode={caps?.[s.name]?.chat_mode ?? 'auto'}
              codeMode={caps?.[s.name]?.code_mode ?? 'auto'}
              isSaving={isSaving || !caps}
              onChatModeChange={(mode) => { void handleModeChange(s.name, 'chat', mode) }}
              onCodeModeChange={(mode) => { void handleModeChange(s.name, 'code', mode) }}
            />
          ))}</div>
      }

      {formOpen && <MCPServerForm open={formOpen} onOpenChange={setFormOpen} editingName={editingName} serverConfigs={configs} editServer={editServer} isSaving={isSaving} onSave={handleSave} />}

      <Dialog open={!!deleteConfirm} onOpenChange={(o) => { if (!o) setDeleteConfirm(null) }}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader><DialogTitle>Delete Server</DialogTitle><DialogDescription>Are you sure you want to delete &quot;{deleteConfirm}&quot;?</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleteConfirm && handleDelete(deleteConfirm)} disabled={isSaving}>{isSaving ? 'Deleting...' : 'Delete'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
