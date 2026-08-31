"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { BookOpen, FolderOpen, Plus, Zap } from "lucide-react"
import type { ReactNode } from "react"

import { ThemeToggle } from "@/components/theme-toggle"
import { cn } from "@/lib/utils"

type AppShellProps = { children: ReactNode; projectId?: string }
type NavLink = {
  href: string
  label: string
  icon: typeof FolderOpen
  active: boolean
}

export function AppShell({ children, projectId }: AppShellProps) {
  const pathname = usePathname()
  const isStudyRoute = pathname.endsWith("/study")
  const routeProjectId =
    projectId ?? pathname.match(/^\/projects\/([^/]+)/)?.[1]
  const projectHref = routeProjectId ? `/projects/${routeProjectId}` : "/"
  const links: NavLink[] = [
    {
      href: "/",
      label: "Projects",
      icon: FolderOpen,
      active:
        pathname === "/" ||
        (pathname.startsWith("/projects/") && !pathname.endsWith("/study")),
    },
    {
      href: routeProjectId ? `${projectHref}#add-source` : "/#new-project",
      label: "Add source",
      icon: Plus,
      active: false,
    },
    {
      href: routeProjectId ? `${projectHref}/study` : "/",
      label: "Study",
      icon: BookOpen,
      active: isStudyRoute,
    },
  ]

  return (
    <div className="min-h-svh bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[84px] flex-col items-center border-r border-border/70 bg-background/90 py-6 backdrop-blur-xl md:flex">
        <Link
          href="/"
          aria-label="Blitz home"
          className="group mb-auto flex flex-col items-center gap-1"
        >
          <span className="grid size-11 place-items-center rounded-2xl bg-[#FFD60A] text-black shadow-[0_8px_24px_-12px_#FFD60A] transition-transform group-hover:-rotate-6">
            <Zap
              aria-hidden="true"
              size={27}
              fill="currentColor"
              strokeWidth={2.5}
            />
          </span>
          <span className="font-display text-[11px] tracking-[0.18em]">
            BLITZ
          </span>
        </Link>
        <nav
          aria-label="Primary navigation"
          className="flex flex-col items-center gap-3"
        >
          {links.map((link) => (
            <NavItem key={link.label} {...link} compact />
          ))}
        </nav>
        <div className="mt-auto">
          <ThemeToggle />
        </div>
      </aside>

      {!isStudyRoute ? (
        <header className="flex items-center justify-between border-b border-border/70 px-5 py-4 md:hidden">
          <Link
            href="/"
            aria-label="Blitz home"
            className="flex items-center gap-2"
          >
            <Zap
              aria-hidden="true"
              className="text-[#FFD60A]"
              fill="currentColor"
              size={25}
            />
            <span className="font-display text-lg tracking-[0.16em]">
              BLITZ
            </span>
          </Link>
          <ThemeToggle />
        </header>
      ) : null}
      <main
        className={cn(isStudyRoute ? "pb-0" : "pb-24", "md:ml-[84px] md:pb-0")}
      >
        {children}
      </main>
      <nav
        aria-label="Primary navigation"
        className="fixed inset-x-0 bottom-0 z-40 grid h-[76px] grid-cols-3 border-t border-border/70 bg-background/90 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
      >
        {links.map((link) => (
          <NavItem key={link.label} {...link} />
        ))}
      </nav>
    </div>
  )
}

function NavItem({
  href,
  label,
  icon: Icon,
  active,
  compact,
}: NavLink & { compact?: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex items-center justify-center gap-2 rounded-2xl text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        compact
          ? "size-14 flex-col gap-1 text-[10px]"
          : "my-2 flex-col text-[11px]",
        active && "bg-[#FFD60A] font-semibold text-black hover:text-black"
      )}
    >
      <Icon
        aria-hidden="true"
        size={compact ? 25 : 28}
        strokeWidth={active ? 2.6 : 2.1}
      />
      <span>{label}</span>
    </Link>
  )
}
