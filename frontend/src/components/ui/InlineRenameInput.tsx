import type { RefObject } from "react";
import { Input } from "@/components/ui/input";

interface InlineRenameInputProps {
  /** Focus target — the host hook focuses it right after `startRename`. */
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  /** Commit on Enter and on blur. */
  onCommit: () => void;
  /** Cancel on Escape. */
  onCancel: () => void;
  autoFocus?: boolean;
}

/**
 * Inline rename editor shared by the session selector and the branch combo:
 * an `h-7 text-sm` Input that commits on Enter/blur and cancels on Escape.
 * The host swaps the row being renamed for this editor.
 */
export function InlineRenameInput({
  inputRef,
  value,
  onChange,
  onCommit,
  onCancel,
  autoFocus,
}: InlineRenameInputProps) {
  return (
    <Input
      ref={inputRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit();
        if (e.key === "Escape") onCancel();
      }}
      onBlur={onCommit}
      className="h-7 text-sm"
      autoFocus={autoFocus}
    />
  );
}
