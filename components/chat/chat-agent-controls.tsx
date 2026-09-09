"use client"

/**
 * Provides compact, accessible working project selection for chat submissions.
 *
 * This component manages project workspace targeting in the chat composer bar,
 * while access levels and approval policies are governed directly by the model picker.
 */

import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { CheckIcon, FolderIcon } from "@/components/ui/icon"
import { cn } from "@/lib/utils"
import type { Id } from "@/convex/_generated/dataModel"

import type { ChatAgentAutonomy } from "@/lib/agent-autonomy"

export {
  AGENT_AUTONOMY_STORAGE_KEY,
  DEFAULT_AGENT_AUTONOMY,
  LEGACY_AGENT_AUTONOMY_STORAGE_KEY,
  isChatAgentAutonomy,
  readCachedAgentAutonomy,
  writeCachedAgentAutonomy,
  subscribeToCachedAgentAutonomy,
  getClientCachedAgentAutonomy,
  getServerCachedAgentAutonomy,
  useCachedAgentAutonomy,
  type ChatAgentAutonomy,
  type AgentAutonomyStorage,
} from "@/lib/agent-autonomy"

/** Minimal project option used to select the one writable workspace. */
export type ChatAgentProject = { _id: Id<"projects">; title: string }

/** Controlled state and callbacks for the chat agent controls. */
export type ChatAgentControlsProps = {
  /** Maintained for backwards compatibility; access policies are now selected in the model picker bar. */
  autonomy?: ChatAgentAutonomy
  /** Prevents changing working project during an active turn. */
  disabled?: boolean
  /** Optional callback for autonomy changes. */
  onAutonomyChange?: (value: ChatAgentAutonomy) => void
  /** User-provided additional instructions. */
  additionalInstructions?: string
  /** Currently selected working project ID. */
  workingProjectId?: Id<"projects">
  /** Available projects for workspace targeting. */
  projects?: ChatAgentProject[]
  /** Receives changes to additional instructions. */
  onInstructionsChange?: (value: string) => void
  /** Receives changes to the working project workspace. */
  onWorkingProjectChange?: (value?: Id<"projects">) => void
}

/**
 * Renders the working project selector with responsive mobile popover and desktop inline layouts.
 *
 * @param props - Working project state and change callbacks.
 * @returns Project selection controls for the chat composer.
 */
export function ChatAgentControls({
  disabled = false,
  workingProjectId,
  projects = [],
  onWorkingProjectChange,
}: ChatAgentControlsProps) {
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const currentProject = projects.find(
    (project) => project._id === workingProjectId
  )

  return (
    <>
      {/* Mobile button opening project selection in a popover */}
      <Popover open={mobileOpen} onOpenChange={setMobileOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            className={cn(
              "relative size-8 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground sm:hidden",
              workingProjectId && "font-medium text-foreground"
            )}
            aria-label={`Working project: ${currentProject ? currentProject.title : "None"}`}
            title={`Working project: ${currentProject ? currentProject.title : "None"}`}
          >
            <FolderIcon
              size={16}
              className={cn("shrink-0", workingProjectId && "text-brand")}
              aria-hidden="true"
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-72 max-w-[calc(100vw-2rem)] space-y-3 rounded-2xl p-4 shadow-xl sm:hidden"
        >
          <div className="flex items-center justify-between border-b border-border/60 pb-2">
            <div>
              <h3 className="text-sm font-semibold tracking-tight text-foreground">
                Working project
              </h3>
              <p className="text-[11px] text-muted-foreground">
                Choose where Blitz reads and edits files
              </p>
            </div>
            {currentProject && onWorkingProjectChange ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  onWorkingProjectChange(undefined)
                  setMobileOpen(false)
                }}
                className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
              >
                Clear
              </button>
            ) : null}
          </div>

          {onWorkingProjectChange ? (
            <div className="space-y-1">
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  onWorkingProjectChange(undefined)
                  setMobileOpen(false)
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-xl p-2 text-left text-xs transition-colors hover:bg-muted/70",
                  !workingProjectId && "bg-muted/80 font-medium"
                )}
              >
                <span className="text-muted-foreground">No project</span>
                {!workingProjectId ? (
                  <CheckIcon size={14} className="text-brand shrink-0" />
                ) : null}
              </button>
              {projects.map((project) => {
                const isSelected = project._id === workingProjectId
                return (
                  <button
                    key={project._id}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      onWorkingProjectChange(project._id)
                      setMobileOpen(false)
                    }}
                    className={cn(
                      "flex w-full items-center justify-between rounded-xl p-2 text-left text-xs transition-colors hover:bg-muted/70",
                      isSelected && "bg-muted/80 font-medium"
                    )}
                  >
                    <span className="truncate">{project.title}</span>
                    {isSelected ? (
                      <CheckIcon size={14} className="text-brand shrink-0" />
                    ) : null}
                  </button>
                )
              })}
            </div>
          ) : null}
        </PopoverContent>
      </Popover>

      {/* Desktop inline working project selector */}
      {onWorkingProjectChange ? (
        <div className="hidden items-center sm:flex">
          <Select
            value={workingProjectId ?? ""}
            onValueChange={(value) =>
              onWorkingProjectChange(
                value === "__none__" || !value
                  ? undefined
                  : (value as Id<"projects">)
              )
            }
            disabled={disabled || projects.length === 0}
          >
            <SelectTrigger
              variant="ghost"
              showArrow={false}
              className="h-8 w-auto max-w-48 gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground"
              aria-label={
                currentProject
                  ? `Working project: ${currentProject.title}`
                  : "Select working project"
              }
            >
              <FolderIcon
                size={14}
                className="shrink-0 text-brand"
                aria-hidden="true"
              />
              <SelectValue placeholder="Select project" />
            </SelectTrigger>
            <SelectContent align="start" className="min-w-52">
              <SelectItem
                value="__none__"
                className="text-xs text-muted-foreground"
              >
                No project
              </SelectItem>
              {projects.map((project) => (
                <SelectItem
                  key={project._id}
                  value={project._id}
                  className="text-xs"
                >
                  {project.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </>
  )
}
