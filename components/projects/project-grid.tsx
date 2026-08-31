"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { ArrowUpRight, FolderOpen, Plus, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

type Project = {
  _id: string
  title: string
  createdAt?: number
  cardCount?: number
  sourceCount?: number
}

export function ProjectGrid({
  projects = [],
  onCreate,
}: {
  projects?: Project[]
  onCreate?: (title: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState("")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    const openFromHash = () => {
      if (window.location.hash === "#new-project") setOpen(true)
    }

    openFromHash()
    window.addEventListener("hashchange", openFromHash)
    return () => window.removeEventListener("hashchange", openFromHash)
  }, [])

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) setError("")
    if (!nextOpen && window.location.hash === "#new-project") {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search
      )
    }
  }

  const create = async () => {
    const value = title.trim()
    if (!value) return
    setCreating(true)
    setError("")
    try {
      if (onCreate) await onCreate(value)
      setTitle("")
      changeOpen(false)
    } catch {
      setError("Could not create that project. Please try again.")
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <div className="mb-10 flex items-end justify-between gap-4">
        <div>
          <p className="mb-3 text-xs font-semibold tracking-[0.2em] text-muted-foreground uppercase">
            Your library
          </p>
          <h1 className="font-heading text-4xl tracking-tight sm:text-6xl">
            Projects
            <span className="text-[#e6be00] dark:text-[#ffd60a]">.</span>
          </h1>
        </div>
        <Button
          size="lg"
          onClick={() => setOpen(true)}
          className="h-11 gap-2 rounded-full px-5"
        >
          <Plus size={18} /> New project
        </Button>
      </div>
      {projects.length === 0 ? (
        <Card className="border-dashed bg-transparent py-0 shadow-none">
          <CardContent className="flex min-h-72 flex-col items-center justify-center text-center">
            <div className="mb-5 flex size-16 items-center justify-center rounded-2xl bg-[#ffd60a] text-black">
              <Sparkles size={30} />
            </div>
            <h2 className="font-heading text-2xl">
              Make your first study space
            </h2>
            <p className="mt-2 max-w-sm text-muted-foreground">
              Turn a lecture, article, or book chapter into a focused set of
              learning cards.
            </p>
            <Button onClick={() => setOpen(true)} className="mt-6 rounded-full">
              Create a project <ArrowUpRight size={16} />
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((project, index) => (
            <Link key={project._id} href={`/projects/${project._id}`}>
              <Card className="group min-h-48 justify-between border-transparent bg-card transition-transform hover:-translate-y-1 hover:ring-primary/40">
                <CardContent className="flex h-full flex-col justify-between">
                  <div
                    className={`mb-8 flex size-12 items-center justify-center rounded-2xl ${index % 2 ? "bg-blue-500 text-white" : "bg-[#ffd60a] text-black"}`}
                  >
                    <FolderOpen size={26} />
                  </div>
                  <div>
                    <div className="flex items-start justify-between gap-3">
                      <h2 className="font-heading text-xl leading-tight">
                        {project.title}
                      </h2>
                      <ArrowUpRight
                        className="text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                        size={20}
                      />
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {project.sourceCount ?? 0} sources ·{" "}
                      {project.cardCount ?? 0} cards
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              Name a study space to keep your sources and cards together.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void create()
            }}
            placeholder="e.g. Cognitive science"
          />
          {error ? (
            <p aria-live="polite" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => changeOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!title.trim() || creating}
              onClick={() => void create()}
            >
              {creating ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
