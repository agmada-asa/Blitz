/**
 * @file ocean-app/src/main.tsx
 * @description The Blitz mini app inside Ocean: the user's phone and desktop view of Blitz (Today,
 * the Library, a module's units and Review) without opening the web app. It starts by asking
 * Ocean for its host context, then shows the route Ocean opened it on, with tabs along the bottom
 * and Ask Ocean in the header. Review takes the whole screen, like /review on the Mac.
 */

import "@fontsource-variable/instrument-sans"
import "katex/dist/katex.min.css"
import * as React from "react"
import { createRoot } from "react-dom/client"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { askOcean, initialize, onNotification } from "./bridge"
import { ChangesProvider, go, useRoute } from "./data"
import { Library, ModuleScreen } from "./screens/library"
import { Review } from "./screens/review"
import { Today } from "./screens/today"
import { Sheet } from "./ui"

/** Tabs along the bottom, by the route each opens. */
const TABS = [
  { route: "today", label: "Today" },
  { route: "library", label: "Library" },
  { route: "review", label: "Review" },
]

/**
 * Applies Ocean's colour mode.
 *
 * @param theme "light" or "dark".
 */
function applyTheme(theme: string): void {
  document.documentElement.classList.toggle("dark", theme === "dark")
}

/** Picks the screen for the current route. */
function Screen() {
  const [screen, ...rest] = useRoute()
  switch (screen) {
    case "library":
      return <Library />
    case "module":
      return <ModuleScreen id={rest[0] ?? ""} />
    default:
      return <Today />
  }
}

/**
 * Ask Ocean: a request sent as a new Ocean chat, starting with what's on screen.
 *
 * @param props.onClose Closes the sheet.
 */
function AskSheet({ onClose }: { onClose: () => void }) {
  const [text, setText] = React.useState("")
  const [state, setState] = React.useState<
    "idle" | "sending" | "sent" | string
  >("idle")

  /** Sends the request and confirms it. */
  const send = async () => {
    setState("sending")
    try {
      await askOcean(text.trim())
      setState("sent")
      setText("")
    } catch (error) {
      setState(
        error instanceof Error ? error.message : "Ocean couldn't be asked."
      )
    }
  }

  return (
    <Sheet
      title="Ask Ocean"
      detail="It starts a chat about what's on this screen. Material an agent adds shows up here."
      onClose={onClose}
    >
      {state === "sent" ? (
        <p className="mt-4 text-[14px]">
          Ocean&apos;s on it. The answer comes back as a chat.
        </p>
      ) : (
        <Textarea
          autoFocus
          className="mt-4 min-h-24"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="E.g. add this week's COMP24011 slides from Canvas to a new unit"
          aria-label="Request"
        />
      )}
      {state !== "idle" && state !== "sending" && state !== "sent" ? (
        <p className="mt-2 text-[13px] text-destructive">{state}</p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="lg" onClick={onClose}>
          {state === "sent" ? "Done" : "Cancel"}
        </Button>
        {state === "sent" ? null : (
          <Button
            size="lg"
            disabled={!text.trim() || state === "sending"}
            onClick={send}
          >
            {state === "sending" ? "Sending…" : "Send"}
          </Button>
        )}
      </div>
    </Sheet>
  )
}

/** The app's frame: header, the current screen, and the tabs; or Review on its own. */
function App() {
  const [screen, ...rest] = useRoute()
  const [asking, setAsking] = React.useState(false)
  const tab = screen === "module" ? "library" : screen

  if (screen === "review")
    return <Review key={rest[0] ?? "all"} module={rest[0]} />

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-5 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <span className="flex-1 text-[15px] font-semibold tracking-[-0.02em]">
          Blitz
        </span>
        <Button size="sm" variant="outline" onClick={() => setAsking(true)}>
          Ask Ocean
        </Button>
      </div>
      <main className="min-h-0 flex-1 overflow-y-auto pb-4">
        <Screen />
      </main>
      <nav className="flex border-t border-border pb-[env(safe-area-inset-bottom)]">
        {TABS.map((item) => (
          <button
            key={item.route}
            type="button"
            onClick={() => go(item.route)}
            className={cn(
              "flex-1 py-3 text-[13px] font-medium",
              tab === item.route ? "text-foreground" : "text-muted-foreground"
            )}
            aria-current={tab === item.route ? "page" : undefined}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {asking ? <AskSheet onClose={() => setAsking(false)} /> : null}
    </div>
  )
}

/** Shown when the page is opened outside Ocean, where nothing answers the bridge. */
function OutsideOcean() {
  return (
    <div className="p-8 text-[15px]">
      <p className="font-semibold">Blitz</p>
      <p className="mt-2 text-muted-foreground">
        This is Blitz&apos;s mini app for Ocean. Open it from Ocean on your
        phone or Mac.
      </p>
    </div>
  )
}

/** Starts the app once Ocean has answered, on the route it asked for. */
async function boot(): Promise<void> {
  const root = createRoot(document.getElementById("root")!)
  try {
    const context = await initialize()
    applyTheme(context.theme)
    if (context.route && !window.location.hash)
      window.location.hash = `/${context.route}`
    onNotification((method, params) => {
      if (method === "ui/notifications/host-context-changed" && params?.theme)
        applyTheme(params.theme)
      if (method === "ocean/navigate" && typeof params?.route === "string")
        window.location.hash = `/${params.route}`
    })
    root.render(
      <ChangesProvider>
        <App />
      </ChangesProvider>
    )
  } catch {
    root.render(<OutsideOcean />)
  }
}

void boot()
