import { liveSnapshot, subscribe } from "../../../server/live.ts";
import { accessState } from "../../../server/session.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The live-update stream (Server-Sent Events).
 *
 * One long-lived GET per open screen. It carries `{boot, version}` and nothing else — never an
 * amount, a name or a message — so even a captured stream says only "something changed at 21:04".
 * The browser reacts by re-requesting its current page, which goes through the normal session
 * check. The stream itself needs the session cookie to open, and every stream is closed the moment
 * the ledger locks, so a browser whose session has ended cannot keep listening.
 *
 * SSE rather than WebSockets: it is plain HTTP, it needs no upgrade handling in the standalone
 * server, the traffic is one-way anyway, and `EventSource` reconnects by itself.
 */
export async function GET(request: Request): Promise<Response> {
  const access = await accessState();
  if (access.kind !== "ready") {
    // Not 200, so `EventSource` stops retrying and the client falls back to a normal page load.
    return new Response(null, { status: 401, headers: { "cache-control": "no-store" } });
  }

  const encoder = new TextEncoder();
  let close = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };

      // Subscribe first: the hub's opening tick may notice writes made while nobody was listening,
      // and the `hello` below must report the version *after* that.
      const unsubscribe = subscribe((event) => {
        send(`event: ${event.type}\ndata: ${JSON.stringify({ boot: event.boot, version: event.version })}\n\n`);
        if (event.type === "locked") close();
      });
      // Proxies and phones drop connections that stay silent; a comment line is ignored by clients.
      const heartbeat = setInterval(() => send(": keep-alive\n\n"), 25_000);

      close = () => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      };

      request.signal.addEventListener("abort", close, { once: true });

      const { boot, version } = liveSnapshot();
      send(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ boot, version })}\n\n`);
    },
    cancel() {
      close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // `no-transform` is what stops the server's gzip layer from buffering events until it has
      // "enough" to compress, which would turn live updates into updates every few minutes.
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
