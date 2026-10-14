/**
 * Live metrics collector: scrapes vLLM's /metrics endpoint (Prometheus
 * exposition format) and maps the families we care about onto MetricsSnapshot.
 *
 * READ-ONLY by design: a GET against the serving process's metrics endpoint.
 * It does not touch the model, the scheduler, or any serving knob.
 *
 * vLLM metric names (as of 0.x, can vary by version — mapped defensively):
 *   vllm:time_to_first_token_seconds          (histogram)
 *   vllm:time_per_output_token_seconds        (histogram — ITL)
 *   vllm:prompt_tokens_total                  (counter)
 *   vllm:generation_tokens_total              (counter)
 *   vllm:request_success_total                (counter)
 *   vllm:request_total / num_requests_running (gauges/counters)
 *   vllm:gpu_cache_usage_perc                 (gauge, 0..1)
 *   vllm:num_requests_running                 (gauge)
 * GPU utilization comes from DCGM if present (DCGM_FI_DEV_GPU_UTIL), else
 * falls back to vllm:gpu_cache_usage_perc as a serving-pressure proxy.
 */
import type { MetricsSnapshot, HistogramData } from "../types";
import { parsePrometheus, findFamily, sumFamily } from "../prometheus/parse";
import { buildHistogram } from "../prometheus/histogram";

export interface LiveSourceConfig {
  /** Base URL of the vLLM server, e.g. http://<head-node>:8000 */
  baseUrl: string;
  /** Optional bearer token for /metrics if the deployment guards it. */
  apiKey?: string;
  /** Fetch timeout ms. */
  timeoutMs?: number;
}

function extractHistogramCounts(
  families: ReturnType<typeof parsePrometheus>,
  baseName: string
): { bounds: number[]; counts: number[] } | null {
  const fam = findFamily(families, baseName);
  if (!fam || fam.type !== "histogram") return null;

  const buckets = fam.samples
    .filter((s) => s.name.endsWith("_bucket"))
    .map((s) => ({ le: Number(s.labels.le), count: s.value }))
    .filter((b) => Number.isFinite(b.le))
    .sort((a, b) => a.le - b.le);

  if (buckets.length === 0) return null;
  return { bounds: buckets.map((b) => b.le), counts: buckets.map((b) => b.count) };
}

/**
 * Parse a comma-separated node list from env (POCKET_WATCH_NODES), e.g.
 *   POCKET_WATCH_NODES=http://192.168.0.182:8000,http://192.168.0.157:8421
 * Invalid/empty entries are dropped. Returns [] when unset.
 */
export function parseNodeUrls(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter((s) => s.length > 0);
}

export interface FleetFetchResult {
  /** Merged snapshot across every node that answered. */
  snapshot: MetricsSnapshot;
  /** Per-node outcome, for honest reporting (a down node ≠ page broken). */
  nodes: { url: string; ok: boolean; error?: string }[];
}

/**
 * Fleet fetch: scrape /metrics from MULTIPLE serving nodes in parallel and
 * merge into one snapshot. Per-node failure is tolerated — one node down
 * degrades the merged numbers, it never breaks the page. If EVERY node
 * fails, the last error is thrown so the route can fall back to the last
 * good snapshot.
 *
 * Merge semantics:
 *   - counters (prompt/generation tokens, requests) → summed
 *   - gauges (gpu util, kv cache, running/waiting)   → null-aware mean
 *   - histograms → bucket-wise sum; requires identical bucket bounds across
 *     nodes (same vLLM version), otherwise the first node's histogram wins
 *     (documented approximation, never a crash).
 */
export async function fetchFleetSnapshot(cfgs: LiveSourceConfig[]): Promise<FleetFetchResult> {
  const results = await Promise.all(
    cfgs.map(async (cfg) => {
      try {
        return { url: cfg.baseUrl, ok: true as const, snap: await fetchLiveSnapshot(cfg) };
      } catch (err) {
        return { url: cfg.baseUrl, ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    })
  );

  const nodes = results.map(({ url, ok, error }) => ({ url, ok, error }));
  const good = results.filter((r) => r.ok).map((r) => (r as { snap: MetricsSnapshot }).snap);
  if (good.length === 0) {
    const lastErr = results.find((r) => !r.ok)?.error ?? "no nodes configured";
    throw new Error(`all fleet nodes failed; last error: ${lastErr}`);
  }

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const mean = (xs: (number | null)[]): number | null => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? sum(v) / v.length : null;
  };

  const mergeHist = (key: "ttftHistogram" | "itlHistogram"): HistogramData => {
    const hists = good.map((s) => s[key]).filter((h) => h.bounds.length > 0);
    if (hists.length === 0) return { bounds: [], counts: [], p50: null, p95: null, p99: null };
    const first = hists[0]!;
    const sameBounds = hists.every(
      (h) => h.bounds.length === first.bounds.length && h.bounds.every((b, i) => b === first.bounds[i]!)
    );
    if (!sameBounds) return first; // mismatched bucket layouts: first node wins, documented
    const counts = first.bounds.map((_, i) => sum(hists.map((h) => h.counts[i] ?? 0)));
    return buildHistogram([...first.bounds], counts);
  };

  const merged: MetricsSnapshot = {
    ts: Math.max(...good.map((s) => s.ts)),
    source: "live",
    ttftHistogram: mergeHist("ttftHistogram"),
    itlHistogram: mergeHist("itlHistogram"),
    gpuUtil: mean(good.map((s) => s.gpuUtil)),
    kvCacheUsage: mean(good.map((s) => s.kvCacheUsage)),
    promptTokensTotal: sum(good.map((s) => s.promptTokensTotal)),
    generationTokensTotal: sum(good.map((s) => s.generationTokensTotal)),
    requestsTotal: sum(good.map((s) => s.requestsTotal)),
    requestsFailedTotal: sum(good.map((s) => s.requestsFailedTotal)),
    numRequestsRunning: mean(good.map((s) => s.numRequestsRunning)),
    numRequestsWaiting: mean(good.map((s) => s.numRequestsWaiting)),
    families: good.flatMap((s) => s.families),
  };
  return { snapshot: merged, nodes };
}

export async function fetchLiveSnapshot(cfg: LiveSourceConfig): Promise<MetricsSnapshot> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 8000);
  try {
    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/metrics`, {
      headers,
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`metrics endpoint returned ${res.status}`);
    }
    const text = await res.text();
    const families = parsePrometheus(text);

    const ttft = extractHistogramCounts(families, "vllm:time_to_first_token_seconds");
    // vLLM ≤0.9 named it time_per_output_token_seconds; newer builds expose
    // inter_token_latency_seconds. Accept both — same histogram shape.
    const itl =
      extractHistogramCounts(families, "vllm:inter_token_latency_seconds") ??
      extractHistogramCounts(families, "vllm:time_per_output_token_seconds");

    // DCGM GPU util if scraped; else null (cost engine flags the assumption).
    const dcgm = findFamily(families, "DCGM_FI_DEV_GPU_UTIL");
    let gpuUtil: number | null = null;
    if (dcgm && dcgm.samples.length > 0) {
      const v = dcgm.samples[0]?.value ?? 0;
      gpuUtil = v > 1 ? v / 100 : v;
    }

    const kv = findFamily(families, "vllm:kv_cache_usage_perc");
    const kvCacheUsage = kv && kv.samples[0] ? kv.samples[0].value : null;

    // Concurrency gauges: running + waiting. Averaged across engines if
    // multiple (single-engine deployments have exactly one sample).
    const runningFam = findFamily(families, "vllm:num_requests_running");
    const waitingFam = findFamily(families, "vllm:num_requests_waiting");
    const avgOf = (fam: ReturnType<typeof findFamily>): number | null => {
      if (!fam || fam.samples.length === 0) return null;
      return fam.samples.reduce((a, s) => a + s.value, 0) / fam.samples.length;
    };
    const numRequestsRunning = avgOf(runningFam);
    const numRequestsWaiting = avgOf(waitingFam);

    const promptTokens = sumFamily(findFamily(families, "vllm:prompt_tokens_total"));
    const generationTokens = sumFamily(findFamily(families, "vllm:generation_tokens_total"));
    const requests = sumFamily(
      findFamily(families, "vllm:request_success_total") ??
        findFamily(families, "vllm:request_total")
    );
    const failed = sumFamily(findFamily(families, "vllm:request_failure_total"));

    return {
      ts: Date.now(),
      source: "live",
      ttftHistogram: ttft
        ? buildHistogram(ttft.bounds, ttft.counts)
        : { bounds: [], counts: [], p50: null, p95: null, p99: null },
      itlHistogram: itl
        ? buildHistogram(itl.bounds, itl.counts)
        : { bounds: [], counts: [], p50: null, p95: null, p99: null },
      gpuUtil,
      kvCacheUsage,
      promptTokensTotal: promptTokens,
      generationTokensTotal: generationTokens,
      requestsTotal: requests,
      requestsFailedTotal: failed,
      numRequestsRunning,
      numRequestsWaiting,
      families,
    };
  } finally {
    clearTimeout(timer);
  }
}
