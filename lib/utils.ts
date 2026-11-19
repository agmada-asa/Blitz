/** Holds small presentation helpers shared by components. */

import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/** Combines conditional class values and resolves conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Returns a caught error's message for display, or `fallback` when it has
 * none, without exposing an arbitrary thrown value.
 */
export function messageForError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}
