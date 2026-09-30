/** Prepares installed local speech assets when the Node server starts, without blocking requests. */

/** Starts background speech warmup only on the supported host runtime. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { warmKokoro } = await import("./lib/server/kokoro")
    void warmKokoro().catch((error: unknown) => {
      // A failed optional warmup leaves the speech route responsible for useful recovery errors.
      console.warn(
        "Local speech warmup failed:",
        error instanceof Error ? error.message : error
      )
    })
  }
}
