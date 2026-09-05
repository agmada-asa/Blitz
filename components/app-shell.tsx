"use client"

/** Provides responsive project navigation around every Blitz route. */

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Folder01Icon,
  Home01Icon,
  Clock01Icon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { useState, type ReactNode } from "react"

import { ThemeToggle } from "@/components/theme-toggle"
import { ZapIcon } from "@/components/ui/icon"
import { cn } from "@/lib/utils"

/** Content rendered inside the shared shell. */
type AppShellProps = { children: ReactNode }
/** One route-aware navigation destination. */
type NavLink = {
  href?: string
  label: string
  icon: IconSvgElement
  active: boolean
}

/** Renders desktop and mobile navigation and tracks desktop collapse state. */
export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname()
  const isPreviewRoute =
    pathname === "/preview" || pathname.startsWith("/preview/")
  const isHomeRoute = pathname === "/"
  const [collapsed, setCollapsed] = useState(false)
  const isStudyRoute = /\/(study|practice|test|write)$/.test(pathname)
  const links: NavLink[] = [
    {
      href: "/",
      label: "Home",
      icon: Home01Icon,
      active: isHomeRoute,
    },
    {
      href: "/library",
      label: "Library",
      icon: Folder01Icon,
      active:
        pathname === "/library" ||
        (pathname.startsWith("/projects/") && !isStudyRoute),
    },
    {
      href: "/activity",
      label: "Activity",
      icon: Clock01Icon,
      active: pathname === "/activity",
    },
  ]

  if (isPreviewRoute || isHomeRoute || isStudyRoute) {
    return <>{children}</>
  }

  return (
    <div className="min-h-svh bg-background text-foreground">
      <aside
        className={cn(
          "fixed inset-y-6 left-6 z-40 hidden flex-col rounded-[36px] border border-border/80 bg-background/95 p-4 shadow-sm backdrop-blur-xl transition-[width] duration-200 md:flex",
          collapsed ? "w-[88px]" : "w-[288px]"
        )}
      >
        <Link
          href="/"
          aria-label="Blitz home"
          title="Blitz home"
          className={cn(
            "mb-5 flex h-12 items-center rounded-2xl text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            collapsed ? "justify-center" : "gap-3 px-3"
          )}
        >
          <span className="flex size-8 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <ZapIcon aria-hidden="true" size={18} strokeWidth={2.4} />
          </span>
          {!collapsed ? (
            <span className="font-sans text-xl font-semibold tracking-tight">
              Blitz
            </span>
          ) : null}
        </Link>
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className={cn(
            "mb-8 flex h-14 items-center rounded-2xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            collapsed ? "justify-center" : "gap-4 px-5"
          )}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <HugeiconsIcon icon={SidebarLeftIcon} size={20} strokeWidth={1.8} />
          {!collapsed ? (
            <span className="text-sm font-medium">Collapse</span>
          ) : null}
        </button>
        <nav aria-label="Primary navigation" className="flex flex-col gap-2">
          {links.map((link) => (
            <NavItem key={link.label} {...link} collapsed={collapsed} />
          ))}
        </nav>
        <div
          className={cn(
            "mt-auto flex items-center",
            collapsed ? "justify-center" : "px-2"
          )}
        >
          <ThemeToggle className="size-8" iconSize={14} />
          {!collapsed ? (
            <span className="ml-3 text-sm font-medium text-muted-foreground">
              Appearance
            </span>
          ) : null}
        </div>
      </aside>

      <div
        className={cn(
          isStudyRoute ? "pb-0" : "pb-24",
          "transition-[margin] duration-200 md:pb-0",
          collapsed ? "md:ml-[112px]" : "md:ml-[336px]"
        )}
      >
        {children}
      </div>
      <nav
        aria-label="Primary navigation"
        className="fixed inset-x-0 bottom-0 z-40 grid h-[76px] grid-cols-3 border-t border-border/70 bg-background/90 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
      >
        {links.map((link) => (
          <NavItem key={link.label} {...link} mobile />
        ))}
      </nav>
    </div>
  )
}

/** Renders one navigation link with compact desktop and mobile variants. */
function NavItem({
  href,
  label,
  icon,
  active,
  collapsed,
  mobile,
}: NavLink & { collapsed?: boolean; mobile?: boolean }) {
  const classes = cn(
    "group flex h-14 items-center rounded-[18px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
    collapsed || mobile ? "justify-center" : "gap-4 px-5",
    mobile && "my-2 flex-col gap-1 text-[11px]",
    active && "bg-muted text-foreground"
  )
  const content = (
    <>
      <HugeiconsIcon
        icon={icon}
        size={mobile ? 25 : 20}
        strokeWidth={active ? 2 : 1.8}
      />
      <span
        className={cn(collapsed && "sr-only", !mobile && "text-sm font-medium")}
      >
        {label}
      </span>
    </>
  )

  return href ? (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={classes}
    >
      {content}
    </Link>
  ) : (
    <button
      type="button"
      className={classes}
      title={`${label} is coming soon`}
      onClick={() => undefined}
    >
      {content}
    </button>
  )
}
