"use client"

/** Provides compact, accessible agent access controls and local storage caching for chat submissions. */

import * as React from "react"
import { FilterHorizontalIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

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
import { CheckIcon, FolderIcon, ShieldCheckIcon, ZapIcon } from "@/components/ui/icon"
import { cn } from "@/lib/utils"
import type { Id } from "@/convex/_generated/dataModel"

import {
  type ChatAgentAutonomy,
  writeCachedAgentAutonomy,
} from "@/lib/agent-autonomy"

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

/** Visual and descriptive configuration for each safety level. */
type AutonomyLevelConfig = {
  label: string
  description: string
  color: string
  icon: (props: {
    size?: number
    className?: string
    "aria-hidden"?: boolean | "true" | "false"
  }) => React.JSX.Element
}

/** Mapping of runtime autonomy authority levels to their indicators and descriptions. */
const AUTONOMY_CONFIG: Record<ChatAgentAutonomy, AutonomyLevelConfig> = {
  approval: {
    label: "Require approval",
    description:
      "The runtime asks before edits and untrusted commands; safe reads may run.",
    color: "text-emerald-600 dark:text-emerald-400",
    icon: ShieldCheckIcon,
  },
  project: {
    label: "Project access",
    description:
      "The agent can edit the selected project workspace without prompts.",
    color: "text-amber-600 dark:text-amber-400",
    icon: FolderIcon,
  },
  full: {
    label: "Full access",
    description:
      "The agent has unrestricted file and network access without approval prompts.",
    color: "text-orange-600 dark:text-orange-400",
    icon: ZapIcon,
  },
}

/** Controlled state and callbacks for the chat agent controls. */
export type ChatAgentControlsProps = {
  autonomy: ChatAgentAutonomy
  disabled?: boolean
  onAutonomyChange: (value: ChatAgentAutonomy) => void
  additionalInstructions?: string
  workingProjectId?: Id<"projects">
  projects?: ChatAgentProject[]
  onInstructionsChange?: (value: string) => void
  onWorkingProjectChange?: (value?: Id<"projects">) => void
}

/** Renders the agent access and project selector with responsive mobile popover and desktop inline layouts. */
export function ChatAgentControls({
  autonomy,
  disabled = false,
  onAutonomyChange,
  workingProjectId,
  projects = [],
  onWorkingProjectChange,
}: ChatAgentControlsProps) {
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const current = AUTONOMY_CONFIG[autonomy] ?? AUTONOMY_CONFIG.approval
  const CurrentIcon = current.icon
  const currentProject = projects.find(
    (project) => project._id === workingProjectId
  )
  const hasActiveOverride = autonomy !== "approval" || Boolean(workingProjectId)

  return (
    <>
      {/* Mobile filter button opening access level and project options in a popover */}
      <Popover open={mobileOpen} onOpenChange={setMobileOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            className={cn(
              "relative size-8 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground sm:hidden",
              hasActiveOverride && "text-foreground font-medium"
            )}
            aria-label={`Agent settings: ${current.label}${currentProject ? `, ${currentProject.title}` : ""}`}
            title={`Agent settings: ${current.label}${currentProject ? `, ${currentProject.title}` : ""}`}
          >
            <HugeiconsIcon
              icon={FilterHorizontalIcon}
              size={17}
              strokeWidth={1.8}
              className={cn(hasActiveOverride && current.color)}
            />
            {hasActiveOverride ? (
              <span
                className="absolute top-1 right-1 size-1.5 rounded-full bg-brand ring-2 ring-card"
                aria-hidden="true"
              />
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-80 max-w-[calc(100vw-2rem)] space-y-3.5 rounded-2xl p-4 shadow-xl sm:hidden"
        >
          <div className="border-b border-border/60 pb-2">
            <h3 className="text-sm font-semibold tracking-tight text-foreground">
              Agent controls
            </h3>
            <p className="text-[11px] text-muted-foreground">
              Choose what Blitz can do and where it works
            </p>
          </div>

          <div className="space-y-1.5">
            <span className="text-xs font-medium text-foreground">
              Access level
            </span>
            <div className="space-y-1">
              {(
                Object.entries(AUTONOMY_CONFIG) as [
                  ChatAgentAutonomy,
                  AutonomyLevelConfig,
                ][]
              ).map(([key, item]) => {
                const ItemIcon = item.icon
                const isSelected = key === autonomy
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      writeCachedAgentAutonomy(key)
                      onAutonomyChange(key)
                    }}
                    className={cn(
                      "flex w-full flex-col gap-1 rounded-xl p-2.5 text-left transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isSelected && "bg-muted/80"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <ItemIcon
                          size={15}
                          className={cn("shrink-0", item.color)}
                          aria-hidden="true"
                        />
                        <span className="text-xs font-medium text-foreground">
                          {item.label}
                        </span>
                      </div>
                      {isSelected ? (
                        <CheckIcon
                          size={14}
                          className="shrink-0 text-brand"
                          aria-hidden="true"
                        />
                      ) : null}
                    </div>
                    <p className="pl-6 text-[11px] leading-snug text-muted-foreground">
                      {item.description}
                    </p>
                  </button>
                )
              })}
            </div>
          </div>

          {onWorkingProjectChange ? (
            <div className="space-y-2 border-t border-border/60 pt-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground">
                  Working project
                </span>
                {currentProject ? (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onWorkingProjectChange(undefined)}
                    className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                  >
                    Clear
                  </button>
                ) : null}
              </div>
              <select
                value={workingProjectId ?? ""}
                onChange={(event) =>
                  onWorkingProjectChange(
                    event.target.value
                      ? (event.target.value as Id<"projects">)
                      : undefined
                  )
                }
                disabled={disabled || projects.length === 0}
                className="h-10 w-full rounded-xl border border-input bg-background px-3 text-xs text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
              >
                <option value="" className="bg-popover text-popover-foreground">
                  {projects.length === 0
                    ? "No projects available"
                    : "Select a project (optional)"}
                </option>
                {projects.map((project) => (
                  <option
                    key={project._id}
                    value={project._id}
                    className="bg-popover text-popover-foreground"
                  >
                    {project.title}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>

      {/* Desktop inline controls */}
      <div className="hidden items-center gap-1.5 sm:flex">
        <Select
          value={autonomy}
          onValueChange={(value) => {
            const next = value as ChatAgentAutonomy
            writeCachedAgentAutonomy(next)
            onAutonomyChange(next)
          }}
          disabled={disabled}
        >
          <SelectTrigger
            variant="ghost"
            showArrow={false}
            className="h-8 w-auto gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground"
            aria-label={`Agent access: ${current.label}`}
          >
            <CurrentIcon
              size={14}
              className={cn("shrink-0", current.color)}
              aria-hidden="true"
            />
            <SelectValue>{current.label}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start" className="min-w-44">
            {(
              Object.entries(AUTONOMY_CONFIG) as [
                ChatAgentAutonomy,
                AutonomyLevelConfig,
              ][]
            ).map(([key, item]) => {
              const ItemIcon = item.icon
              return (
                <SelectItem key={key} value={key} className="text-xs">
                  <span className="flex items-center gap-2">
                    <ItemIcon
                      size={14}
                      className={cn("shrink-0", item.color)}
                      aria-hidden="true"
                    />
                    <span>{item.label}</span>
                  </span>
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
        <span className="sr-only">{current.description}</span>
        {onWorkingProjectChange ? (
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
        ) : null}
      </div>
    </>
  )
}
