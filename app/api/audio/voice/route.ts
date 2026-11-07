/** Returns the public microphone socket URL without exposing private service addresses. */

/** Uses the request origin for HTTPS proxies; loopback development talks directly to the voice port. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const publicHost = request.headers.get("host") || url.host
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(publicHost)
  return Response.json({
    url: local
      ? `ws://${publicHost.split(":")[0]}:${process.env.BLITZ_VOICE_PORT || Number(process.env.BLITZ_PORT || url.port || 3007) + 100}/voice`
      : `wss://${publicHost}/voice`,
  }, { headers: { "Cache-Control": "no-store" } })
}
