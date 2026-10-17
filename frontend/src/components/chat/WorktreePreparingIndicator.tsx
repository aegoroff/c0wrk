import { Loader2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** Outside the disabled workspace trigger so the hint remains reachable. */
export function WorktreePreparingIndicator() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          tabIndex={0}
          className="inline-flex shrink-0 items-center text-muted-foreground"
        >
          <Loader2 aria-hidden="true" className="size-3 animate-spin" />
          {/* A live region announces its own text content on insertion (an
              `aria-label` is not announced reliably), so the text lives here —
              visually hidden — and doubles as the accessible name. */}
          <span className="sr-only">Preparing worktree…</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>Preparing worktree…</TooltipContent>
    </Tooltip>
  )
}
