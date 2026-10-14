import { NextResponse } from "next/server";
import path from "node:path";
import { buildPayload, pushSnapshot, ensureData } from "@/lib/store";
import { nextMockSnapshot } from "@/lib/metrics/mock";
import { fetchLiveSnapshot, fetchFleetSnapshot, parseNodeUrls, LiveSourceConfig } from "@/lib/metrics/live";
import { tenantFeed, specFeed, sliceFeed, reliabilityFeed } from "@/lib/feeds";

export const dynamic = "force-dynamic";

/**
 * GET /api/metrics — current dashboard payload.
 *
 * Mode selection:
 *   POCKET_WATCH_MODE=live  → scrape vLLM /metrics each poll (read-only GET)
 *   POCKET_WATCH_MODE=mock  → simulated telemetry (default; CI/demo safe)
 *
 * Live failures fall back to the last good snapshot; the payload reports its
 * source so the UI can show a stale/live badge honestly.
 *
 * Integration feeds (portfolio stack): tenant attribution from the Ball
 * Knowledge gateway, spec-decode acceptance (Green-Zone), slice shares
 * (Circuiter), reliability (Flunk). Each is best-effort: a down feed
 * shows "no data", never breaks the dashboard.
 */
export async function GET() {
  ensureData();
  const mode = process.env.POCKET_WATCH_MODE ?? "mock";
  const base = process.env.VLLM_BASE_URL;
  const apiKey = process.env.VLLM_API_KEY;

  let fleetNodes: { url: string; ok: boolean; error?: string }[] | null = null;

  if (mode === "live") {
    // Fleet config: POCKET_WATCH_NODES (comma-separated list) wins; the
    // single-node VLLM_BASE_URL remains the default when the list is unset.
    const nodeUrls = parseNodeUrls(process.env.POCKET_WATCH_NODES);
    const cfgs: LiveSourceConfig[] =
      nodeUrls.length > 0
        ? nodeUrls.map((baseUrl) => ({ baseUrl, apiKey }))
        : base
          ? [{ baseUrl: base, apiKey }]
          : [];

    if (cfgs.length === 1) {
      try {
        const snap = await fetchLiveSnapshot(cfgs[0]!);
        pushSnapshot(snap);
      } catch (err) {
        // Keep serving the last good snapshot; surface the error honestly.
        const payload = buildPayload();
        return NextResponse.json({
          ...payload,
          liveError: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (cfgs.length > 1) {
      try {
        // Fleet mode: per-node failure tolerated; only a total outage throws.
        const { snapshot, nodes } = await fetchFleetSnapshot(cfgs);
        pushSnapshot(snapshot);
        fleetNodes = nodes;
      } catch (err) {
        const payload = buildPayload();
        return NextResponse.json({
          ...payload,
          liveError: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else if (mode === "mock") {
    pushSnapshot(nextMockSnapshot(null));
  }

  // Integration feeds (best-effort, non-blocking)
  const benchDir = path.resolve(process.cwd(), "benchmarks");
  const bkUrl = process.env.BK_BASE_URL ?? "http://127.0.0.1:3100";
  const [tenants] = await Promise.all([tenantFeed(bkUrl)]);

  return NextResponse.json({
    ...buildPayload(),
    ...(fleetNodes ? { fleetNodes } : {}),
    feeds: {
      gatewayTenants: tenants,
      spec: specFeed(benchDir),
      slices: sliceFeed(benchDir),
      reliability: reliabilityFeed(),
    },
  });
}
