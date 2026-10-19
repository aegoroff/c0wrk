import { useState } from 'react'
import { createProject, pickDirectory } from '@/api/projects'
import { isWebTransport } from '@/api/runtime'
import { useProjectSwitchState } from '@/hooks/useProjectSwitchState'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FolderOpen } from 'lucide-react'

/**
 * Final path segment of an OS-native path. The Wails directory picker returns
 * native separators, so a Windows path arrives as `C:\Users\me\proj` — splitting
 * on '/' alone would leave the whole path as a single segment.
 */
function pathBasename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
}

interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateProjectDialog({ open, onOpenChange }: CreateProjectDialogProps) {
  const [name, setName] = useState('')
  const [externalPath, setExternalPath] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const switchProjectWithState = useProjectSwitchState()

  const reset = () => {
    setName('')
    setExternalPath('')
  }

  const handlePickDir = async () => {
    try {
      const path = await pickDirectory()
      if (path) {
        setExternalPath(path)
        if (!name) setName(pathBasename(path))
      }
    } catch {
      // user cancelled
    }
  }

  const handleSubmit = async () => {
    if (!name.trim() || !externalPath) return
    setSubmitting(true)
    try {
      const project = await createProject(name.trim(), externalPath)
      try {
        await switchProjectWithState(project.id)
      } catch {
        // best effort; errors handled by API layer/logging
      }
      onOpenChange(false)
      reset()
    } catch {
      // error handled by API layer
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Project</DialogTitle>
          <DialogDescription>
            Choose a workspace directory and give your project a name.
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Directory</label>
            {!isWebTransport() && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 w-full justify-start"
                onClick={handlePickDir}
              >
                <FolderOpen className="size-4" />
                {externalPath ? 'Change directory' : 'Choose directory'}
              </Button>
            )}
            {externalPath && (
              <p className="truncate font-mono text-xs text-muted-foreground" title={externalPath}>
                {externalPath}
              </p>
            )}
            {isWebTransport() && (
              <p className="text-xs text-muted-foreground">
                Type the workspace directory path — the native folder browser
                is only available in the desktop app.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Project name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My project"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!name.trim() || !externalPath || submitting}
          >
            {submitting ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
