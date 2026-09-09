"use client"

/** Owns text selection detection, highlight overlays, and anchored floating chips on model replies. */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { QuoteUpIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  FloatingAnnotationChip,
  type FloatingAnnotation,
} from "@/components/chat/floating-annotation-chip"
import { Markdown, type ChatAnnotation } from "@/components/ui/markdown"
import type { ChatCitation } from "@/lib/citations"

/** Bounding rectangle relative to the parent message container. */
type RelativeRect = {
  left: number
  top: number
  width: number
  height: number
}

/** Positioned highlight and anchored chip for one annotation. */
type PositionedAnnotation = {
  annotation: FloatingAnnotation
  rects: RelativeRect[]
  chipPosition: { left: number; top: number }
}

/** Properties for displaying an assistant message with interactive annotation overlays. */
interface AnnotatedAssistantMessageProps {
  messageId: string
  content: string
  citations?: readonly ChatCitation[]
  annotations?: readonly FloatingAnnotation[]
  allChatAnnotations?: readonly ChatAnnotation[]
  isReadOnly?: boolean
  expandedAnnotationId?: string
  onToggleExpand?: (id: string) => void
  onCitation?: (citation: ChatCitation) => void
  onAddAnnotation?: (selectedText: string) => void
  onSaveAnnotation?: (id: string, note: string) => void
  onDeleteAnnotation?: (id: string) => void
}

/**
 * Finds the DOM Range in text nodes matching the target quoted text.
 *
 * Traverses text nodes in document order and strips whitespace differences (including line
 * breaks, paragraph boundaries, and multiple spaces) so that multi-line selections map
 * reliably to DOM text nodes.
 *
 * @param contentElement - Root DOM element containing rendered Markdown content.
 * @param searchText - Quoted text string to locate within contentElement.
 * @returns Matching DOM Range, or null if no match could be found.
 */
function findTextRangeInContainer(
  contentElement: HTMLElement,
  searchText: string
): Range | null {
  const trimmed = searchText.trim()
  if (!trimmed) return null

  // Extract non-whitespace characters and their corresponding text node positions
  const walker = document.createTreeWalker(contentElement, NodeFilter.SHOW_TEXT)
  const charPositions: { node: Text; offset: number }[] = []
  let fullNonWs = ""

  let currentNode = walker.nextNode()
  while (currentNode) {
    const textNode = currentNode as Text
    const val = textNode.nodeValue ?? ""
    for (let i = 0; i < val.length; i++) {
      const char = val[i]
      if (!/\s/.test(char)) {
        fullNonWs += char
        charPositions.push({ node: textNode, offset: i })
      }
    }
    currentNode = walker.nextNode()
  }

  if (!charPositions.length) return null

  // Extract non-whitespace characters from search target
  const targetNonWs = trimmed.replace(/\s+/g, "")
  if (!targetNonWs) return null

  // 1. Exact match in non-whitespace stream
  let matchIndex = fullNonWs.indexOf(targetNonWs)

  // 2. Case-insensitive fallback
  if (matchIndex === -1) {
    matchIndex = fullNonWs.toLowerCase().indexOf(targetNonWs.toLowerCase())
  }

  // 3. Prefix fallback for long passages that may have minor formatting differences
  if (matchIndex === -1 && targetNonWs.length > 20) {
    const prefix = targetNonWs.slice(0, Math.min(30, targetNonWs.length))
    matchIndex = fullNonWs.toLowerCase().indexOf(prefix.toLowerCase())
  }

  if (matchIndex === -1) return null

  const startIndex = matchIndex
  const matchedLength = Math.min(
    targetNonWs.length,
    fullNonWs.length - startIndex
  )
  const endIndex = startIndex + matchedLength - 1

  const startPos = charPositions[startIndex]
  const endPos = charPositions[endIndex]
  if (!startPos || !endPos) return null

  try {
    const range = document.createRange()
    range.setStart(startPos.node, startPos.offset)
    range.setEnd(
      endPos.node,
      Math.min(endPos.offset + 1, endPos.node.nodeValue?.length ?? 0)
    )
    return range
  } catch {
    return null
  }
}

/** Renders an assistant message with text-selection triggers, highlights, and floating numbered chips. */
export function AnnotatedAssistantMessage({
  messageId,
  content,
  citations,
  annotations = [],
  allChatAnnotations = [],
  isReadOnly = false,
  expandedAnnotationId,
  onToggleExpand,
  onCitation,
  onAddAnnotation,
  onSaveAnnotation,
  onDeleteAnnotation,
}: AnnotatedAssistantMessageProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [positionedAnnotations, setPositionedAnnotations] = useState<
    PositionedAnnotation[]
  >([])
  const [pendingSelection, setPendingSelection] = useState<{
    text: string
    position: { left: number; top: number }
  } | null>(null)

  /** Measures the bounding boxes of all annotations on this message. */
  const measureAnnotations = useCallback(() => {
    const container = containerRef.current
    const contentEl = contentRef.current
    if (!container || !contentEl || !annotations.length) {
      setPositionedAnnotations([])
      return
    }

    const containerRect = container.getBoundingClientRect()
    const positioned: PositionedAnnotation[] = []

    for (const annotation of annotations) {
      const range = findTextRangeInContainer(contentEl, annotation.selectedText)
      if (range) {
        const clientRects = Array.from(range.getClientRects()).filter(
          (r) => r.width > 0 && r.height > 0
        )
        if (clientRects.length > 0) {
          const rects: RelativeRect[] = clientRects.map((rect) => ({
            left: rect.left - containerRect.left,
            top: rect.top - containerRect.top,
            width: rect.width,
            height: rect.height,
          }))
          const lastRect = rects[rects.length - 1]
          positioned.push({
            annotation,
            rects,
            chipPosition: {
              left: Math.min(
                containerRect.width - 24,
                Math.max(0, lastRect.left + lastRect.width)
              ),
              top: lastRect.top,
            },
          })
          continue
        }
      }

      // Fallback position if text was not found
      positioned.push({
        annotation,
        rects: [],
        chipPosition: {
          left: containerRect.width - 24,
          top: 8 + positioned.length * 24,
        },
      })
    }

    setPositionedAnnotations(positioned)
  }, [annotations])

  /** Re-measures on mount, resize, or content/annotation updates. */
  useEffect(() => {
    measureAnnotations()
    const container = containerRef.current
    if (!container || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => measureAnnotations())
    observer.observe(container)
    return () => observer.disconnect()
  }, [measureAnnotations, content])

  /** Evaluates current window selection and positions the Annotate button if valid. */
  const evaluateSelection = useCallback(() => {
    if (isReadOnly) return

    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setPendingSelection(null)
      return
    }

    const container = containerRef.current
    const contentEl = contentRef.current
    if (!container || !contentEl) return

    const range = selection.getRangeAt(0)
    // Ensure the selection starts inside this message's content
    if (!contentEl.contains(range.startContainer)) {
      setPendingSelection(null)
      return
    }

    const selectedText = selection.toString().trim()
    if (selectedText.length < 2) {
      setPendingSelection(null)
      return
    }

    const validRects = Array.from(range.getClientRects()).filter(
      (r) => r.width > 0 && r.height > 0
    )
    if (!validRects.length) {
      setPendingSelection(null)
      return
    }

    const lastRect = validRects[validRects.length - 1]
    const containerRect = container.getBoundingClientRect()
    const buttonWidth = 84
    const rawLeft = lastRect.right - containerRect.left
    const rawTop = lastRect.bottom - containerRect.top + 6

    setPendingSelection({
      text: selectedText,
      position: {
        left: Math.max(
          8,
          Math.min(
            containerRect.width - buttonWidth - 8,
            rawLeft - buttonWidth / 2
          )
        ),
        top: Math.max(0, rawTop),
      },
    })
  }, [isReadOnly])

  /** Clears selection trigger on click outside or document selection clear. */
  useEffect(() => {
    const handleDocumentSelectionChange = (): void => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) {
        setPendingSelection(null)
      }
    }
    document.addEventListener("selectionchange", handleDocumentSelectionChange)
    document.addEventListener("mouseup", evaluateSelection)
    document.addEventListener("keyup", evaluateSelection)
    return () => {
      document.removeEventListener(
        "selectionchange",
        handleDocumentSelectionChange
      )
      document.removeEventListener("mouseup", evaluateSelection)
      document.removeEventListener("keyup", evaluateSelection)
    }
  }, [evaluateSelection])

  return (
    <div
      ref={containerRef}
      data-message-id={messageId}
      className="relative min-w-0"
    >
      {/* Background highlight rects for existing annotations */}
      {positionedAnnotations.flatMap(({ annotation, rects }) =>
        rects.map((rect, index) => (
          <div
            key={`hl-${annotation.id}-${index}`}
            aria-hidden="true"
            className="pointer-events-none absolute rounded-xs bg-brand/18 border-b-2 border-brand/60"
            style={{
              left: `${rect.left}px`,
              top: `${rect.top}px`,
              width: `${rect.width}px`,
              height: `${rect.height}px`,
            }}
          />
        ))
      )}

      {/* Floating numbered chips */}
      {positionedAnnotations.map(({ annotation, chipPosition }) => (
        <FloatingAnnotationChip
          key={annotation.id}
          annotation={annotation}
          position={chipPosition}
          isExpanded={expandedAnnotationId === annotation.id}
          isReadOnly={isReadOnly || annotation.isDraft === false}
          onToggleExpand={(id) => onToggleExpand?.(id)}
          onSave={(id, note) => onSaveAnnotation?.(id, note)}
          onDelete={(id) => onDeleteAnnotation?.(id)}
        />
      ))}

      {/* Floating Annotate trigger on active text selection */}
      {pendingSelection ? (
        <div
          className="absolute z-30 pointer-events-auto animate-in fade-in-0 duration-100"
          style={{
            left: `${pendingSelection.position.left}px`,
            top: `${pendingSelection.position.top}px`,
          }}
        >
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-full bg-brand px-2.5 py-1 text-xs font-semibold text-brand-foreground shadow-md transition-all hover:scale-105 hover:brightness-110 cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onAddAnnotation?.(pendingSelection.text)
              window.getSelection()?.removeAllRanges()
              setPendingSelection(null)
            }}
          >
            <HugeiconsIcon icon={QuoteUpIcon} size={13} strokeWidth={2.2} />
            Annotate
          </button>
        </div>
      ) : null}

      {/* Rendered Markdown with citation & annotation hyperlink support */}
      <div ref={contentRef}>
        <Markdown
          text={content}
          citations={citations}
          annotations={allChatAnnotations}
          onCitation={onCitation}
        />
      </div>
    </div>
  )
}
