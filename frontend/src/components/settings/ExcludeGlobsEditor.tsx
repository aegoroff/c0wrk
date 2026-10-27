import { useState, type KeyboardEvent } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { validateExcludeGlob, validateExcludeGlobList } from '@/lib/indexingGlobs'

interface ExcludeGlobsEditorProps {
  patterns: string[]
  onChange: (patterns: string[]) => void
}

/**
 * Gitignore-style exclude-glob editor for the vector-index policy, modeled
 * on the security blocklist editor (chips + free-text input + per-chip
 * removal). Every accepted edit is a discrete commit handed to the parent
 * for an immediate full-policy save; a rejected candidate stays in the
 * input with the reason rendered beneath it.
 */
export function ExcludeGlobsEditor({ patterns, onChange }: ExcludeGlobsEditorProps) {
  const [newPattern, setNewPattern] = useState('')
  const [patternError, setPatternError] = useState<string | null>(null)

  // A hand-edited config may carry duplicate patterns (the backend stores
  // the list verbatim); dedupe for display so the chips keep unique React
  // keys and the add-path duplicate check sees the same set the user does.
  // Adding appends to the deduped list, and removing filters every instance
  // of a pattern, so the next save persists a self-healed list.
  const unique = Array.from(new Set(patterns))

  const addPattern = () => {
    const pattern = newPattern.trim()
    if (!pattern) return
    if (unique.includes(pattern)) {
      setNewPattern('')
      setPatternError(null)
      return
    }
    // Pre-flight the candidate against the same rules the backend enforces
    // on UpdateIndexingSettings (non-empty, no '!', caps, glob syntax) so a
    // typo surfaces here at the input instead of after the save round trip.
    // Best-effort UX only — the backend remains authoritative.
    const listError = validateExcludeGlobList([...unique, pattern])
    const error = listError ?? validateExcludeGlob(pattern)
    if (error) {
      setPatternError(error)
      return
    }
    setPatternError(null)
    onChange([...unique, pattern])
    setNewPattern('')
  }

  const removePattern = (pattern: string) => onChange(patterns.filter((p) => p !== pattern))

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      addPattern()
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="exclude-globs-editor">
      <p className="text-xs text-muted-foreground">
        Excluded paths (gitignore-style globs: <code className="font-mono">*</code>,{' '}
        <code className="font-mono">**</code>, <code className="font-mono">?</code>,{' '}
        <code className="font-mono">[...]</code>, <code className="font-mono">{'{a,b}'}</code>) —
        matching files never enter the index:
      </p>
      {unique.length > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="exclude-globs-chips">
          {unique.map((p) => (
            <div key={p} className="flex items-center gap-1 px-2 py-1 bg-muted rounded text-xs">
              <code className="font-mono">{p}</code>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove pattern ${p}`}
                title={`Remove pattern ${p}`}
                className="h-4 w-4 p-0 hover:bg-destructive/20"
                onClick={() => removePattern(p)}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input
          placeholder="e.g., node_modules/ or *.min.js"
          aria-label="New exclude pattern"
          value={newPattern}
          onChange={(e) => {
            setNewPattern(e.target.value)
            setPatternError(null)
          }}
          onKeyDown={handleKey}
          aria-invalid={patternError !== null}
          className="h-8 text-xs font-mono"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={addPattern}
          disabled={!newPattern.trim()}
          aria-label="Add exclude pattern"
          title="Add exclude pattern"
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>
      {patternError && (
        <p role="alert" className="text-xs text-destructive">
          {patternError}
        </p>
      )}
    </div>
  )
}
