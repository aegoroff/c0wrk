import { useCallback, useState } from 'react'
import { useFileViewerStore } from '@/stores/fileViewerStore'

interface FileLinkProps {
  path: string
  line?: number
  label?: string
  className?: string
  /**
   * Render the native `title` (full path) hint. Defaults to `true`. Set to
   * `false` when the link sits inside a tooltip-providing parent (e.g. the tool
   * card title) to avoid a duplicate hint.
   */
  nativeTitle?: boolean
  /**
   * Optional async resolver invoked at click time BEFORE the viewer opens.
   * When provided, the click awaits it and opens the RESOLVED path; a null
   * result marks the path unresolvable and the link re-renders as plain text
   * (further clicks are no-ops). When omitted the raw path opens directly
   * (the historical behavior). Tool cards use this to resolve a tool call's
   * path argument against its true base — the skill catalog directory for
   * read_skill_resource (backend RPC), the workspace root for the workspace
   * file tools (normalizePath).
   */
  resolve?: (path: string) => Promise<string | null>
}

function open(store: ReturnType<typeof useFileViewerStore.getState>, path: string, line?: number) {
  if (line !== undefined) {
    store.openFileAtLine(path, line)
  } else {
    store.openFile(path)
  }
}

export function FileLink({ path, line, label, className, nativeTitle = true, resolve }: FileLinkProps) {
  const displayName = label ?? path.split('/').pop() ?? path
  // `failed` freezes the link into plain text: the resolver reported that the
  // path has no base to resolve against (unknown skill, traversal refusal, or
  // a backend error), so retrying on every click would just repeat a failing
  // RPC — the downgrade is sticky for the lifetime of the card.
  const [failed, setFailed] = useState(false)

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!resolve) {
      open(useFileViewerStore.getState(), path, line)
      return
    }
    // A rejecting resolver is exactly as unresolvable as a null answer —
    // sticky downgrade, and the void'd click never turns into an unhandled
    // rejection.
    const resolved = await resolve(path).catch(() => null)
    if (resolved === null) {
      setFailed(true)
      return
    }
    open(useFileViewerStore.getState(), resolved, line)
  }, [path, line, resolve])

  if (failed) {
    return (
      <span className={`font-mono text-xs ${className ?? ''}`}>
        {displayName}
      </span>
    )
  }

  return (
    <span
      role="button"
      tabIndex={0}
      title={nativeTitle ? path : undefined}
      className={`text-info hover:underline cursor-pointer font-mono text-xs ${className ?? ''}`}
      onClick={(e) => { void handleClick(e) }}
      onKeyDown={(e) => { if (e.key === 'Enter') void handleClick(e as unknown as React.MouseEvent) }}
    >
      {displayName}
    </span>
  )
}
