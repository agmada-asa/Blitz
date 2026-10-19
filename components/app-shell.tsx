"use client"

/** Provides responsive project navigation around every Blitz route. */

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Chat01Icon,
  Folder01Icon,
  Notification02Icon,
  Settings02Icon,
  SidebarLeftIcon,
  SidebarRightIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { useState, type ReactNode } from "react"

import { BlitzLogo } from "@/components/blitz-logo"
import { useNotifications } from "@/components/notifications/notification-provider"
import { cn } from "@/lib/utils"

/** Content rendered inside the shared shell. */
type AppShellProps = { children: ReactNode }
/** One route-aware navigation destination. */
type NavLink = {
  href?: string
  label: string
  icon: IconSvgElement
  active: boolean
  count?: number
}

/** Renders desktop and mobile navigation and tracks desktop collapse state. */
export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname()
  const { unreadCount } = useNotifications()
  const isPreviewRoute =
    pathname === "/preview" || pathname.startsWith("/preview/")
  const isReviewRoute = pathname === "/review"
  const isChatRoute = pathname === "/chat"
  // Teach is a focused screen with its own back link and dock.
  const isTeachRoute = /^\/projects\/[^/]+\/learn\/[^/]+$/.test(pathname)
  const isFullHeightMobileRoute = isReviewRoute || isChatRoute || isTeachRoute
  const [collapsed, setCollapsed] = useState(true)
  const links: NavLink[] = [
    {
      // The Library is the start page; Review is reached from its Today panel.
      href: "/",
      label: "Library",
      icon: Folder01Icon,
      active:
        pathname === "/" ||
        isReviewRoute ||
        pathname.startsWith("/projects/"),
    },
    {
      href: "/chat",
      label: "Chat",
      icon: Chat01Icon,
      active: pathname === "/chat",
    },
    {
      href: "/notifications",
      label: "Notifications",
      icon: Notification02Icon,
      active: pathname === "/notifications" || pathname === "/activity",
      count: unreadCount,
    },
    {
      href: "/settings",
      label: "Settings",
      icon: Settings02Icon,
      active: pathname === "/settings",
    },
  ]

  if (isPreviewRoute) {
    return <>{children}</>
  }

  return (
    <div className="min-h-svh bg-background text-foreground">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 hidden w-[76px] flex-col overflow-hidden border-r border-border/70 bg-background/95 px-3 py-5 shadow-sm backdrop-blur-xl transition-[width] duration-200 md:flex",
          collapsed ? "w-[76px]" : "w-[224px]"
        )}
      >
        <Link
          href="/"
          aria-label="Blitz home"
          title="Blitz home"
          className={cn(
            "mb-6 flex h-12 shrink-0 items-center rounded-xl text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            collapsed ? "justify-center" : "gap-3 px-3"
          )}
        >
          <BlitzLogo size={28} className="shrink-0" />
          {!collapsed ? (
            <span className="font-sans text-xl font-semibold tracking-tight">
              Blitz
            </span>
          ) : null}
        </Link>
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
          className={cn(
            "mb-6 flex h-11 w-full shrink-0 items-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            collapsed ? "justify-center" : "gap-3 px-3"
          )}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <HugeiconsIcon
            icon={collapsed ? SidebarRightIcon : SidebarLeftIcon}
            size={20}
            strokeWidth={1.8}
          />
          {!collapsed ? (
            <span className="text-sm font-medium">Collapse</span>
          ) : null}
        </button>
        <nav aria-label="Primary navigation" className="flex flex-col gap-1">
          {links.map((link) => (
            <NavItem key={link.label} {...link} collapsed={collapsed} />
          ))}
        </nav>
      </aside>

      <div
        className={cn(
          isFullHeightMobileRoute
            ? "pb-0"
            : "pb-[calc(84px+env(safe-area-inset-bottom))]",
          "min-w-0 transition-[margin] duration-200 md:pb-0",
          collapsed ? "md:ml-[76px]" : "md:ml-[224px]"
        )}
      >
        {children}
      </div>
      <nav
        aria-label="Primary navigation"
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 grid h-[calc(68px+env(safe-area-inset-bottom))] grid-cols-4 border-t border-border/70 bg-background/95 px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden",
          isTeachRoute && "hidden"
        )}
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
  count,
  collapsed,
  mobile,
}: NavLink & { collapsed?: boolean; mobile?: boolean }) {
  const classes = cn(
    "group relative flex min-h-12 items-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
    collapsed || mobile ? "justify-center" : "gap-3 px-3",
    mobile && "my-2 h-12 flex-col gap-0 text-[11px]",
    active && "bg-brand/10 text-brand"
  )
  const content = (
    <>
      <HugeiconsIcon
        icon={icon}
        size={mobile ? 24 : 20}
        strokeWidth={active ? 2 : 1.8}
      />
      <span
        className={cn(
          (collapsed || mobile) && "sr-only",
          !mobile && "text-sm font-medium"
        )}
      >
        {label}
      </span>
      {count ? (
        <span
          aria-label={`${count} unread`}
          className={cn(
            "flex min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] leading-4 font-semibold text-brand-foreground",
            collapsed || mobile
              ? "absolute translate-x-2.5 -translate-y-2.5"
              : "ml-auto"
          )}
        >
          {count > 9 ? "9+" : count}
        </span>
      ) : null}
    </>
  )

  return href ? (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      title={mobile ? label : undefined}
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
