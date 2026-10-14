/**
 * Fleet-compute tests: multi-node metrics sourcing.
 *
 * POCKET_WATCH_NODES env → multiple upstream nodes, scraped in parallel,
 * merged into one snapshot. One node down must degrade gracefully, never
 * break the page. No live network: fetch is stubbed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { parseNodeUrls, fetchFleetSnapshot, type LiveSourceConfig } from "@/lib/metrics/live";

const PROM = (promptTokens: number, gpuUtil: number) => `# TYPE vllm:prompt_tokens_total counter
vllm:prompt_tokens_total{model="m"} ${promptTokens}
# TYPE vllm:kv_cache_usage_perc gauge
vllm:kv_cache_usage_perc ${gpuUtil}
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_bucket{le="0.1"} 10
vllm:time_to_first_token_seconds_bucket{le="0.5"} 18
vllm:time_to_first_token_seconds_bucket{le="+Inf"} 20
vllm:time_to_first_token_seconds_count 20
vllm:time_to_first_token_seconds_sum 4.2
`;

const cfg = (url: string): LiveSourceConfig => ({ baseUrl: url, timeoutMs: 500 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseNodeUrls", () => {
  it("splits a comma-separated list and trims cruft", () => {
    expect(parseNodeUrls("http://a:8000, http://b:8421 ,http://c:9000/")).toEqual([
      "http://a:8000",
      "http://b:8421",
      "http://c:9000",
    ]);
  });

  it("returns [] for unset/empty/garbage input", () => {
    expect(parseNodeUrls(undefined)).toEqual([]);
    expect(parseNodeUrls("")).toEqual([]);
    expect(parseNodeUrls("  ,  ,")).toEqual([]);
  });
});

describe("fetchFleetSnapshot", () => {
  it("merges counters (sum) and gauges (mean) across healthy nodes", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url instanceof Request ? url.url : url);
      if (u.includes("n1")) return new Response(PROM(1000, 0.4), { status: 200 });
      return new Response(PROM(2500, 0.8), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { snapshot, nodes } = await fetchFleetSnapshot([cfg("http://n1:8000"), cfg("http://n2:8000")]);
    expect(nodes.every((n) => n.ok)).toBe(true);
    expect(snapshot.promptTokensTotal).toBe(3500);
    expect(snapshot.kvCacheUsage).toBeCloseTo(0.6);
    // histograms with identical bounds merge bucket-wise: 10+10=20 @ le=0.1
    // (+Inf bucket is dropped by the existing parser: Number("+Inf") → NaN)
    expect(snapshot.ttftHistogram.counts).toEqual([20, 36]);
  });

  it("tolerates one node down — the healthy node still answers", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url instanceof Request ? url.url : url);
      if (u.includes("dead")) throw new Error("connect ECONNREFUSED");
      return new Response(PROM(1000, 0.5), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { snapshot, nodes } = await fetchFleetSnapshot([cfg("http://dead:8000"), cfg("http://alive:8000")]);
    expect(nodes.find((n) => n.url.includes("dead"))?.ok).toBe(false);
    expect(nodes.find((n) => n.url.includes("alive"))?.ok).toBe(true);
    expect(snapshot.promptTokensTotal).toBe(1000);
    expect(snapshot.source).toBe("live");
  });

  it("throws only when EVERY node fails (route falls back to last good snapshot)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      })
    );
    await expect(fetchFleetSnapshot([cfg("http://dead:8000"), cfg("http://deader:8000")])).rejects.toThrow(
      /all fleet nodes failed/
    );
  });

  it("handles a 500 from one node without crashing the merge", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url instanceof Request ? url.url : url);
      if (u.includes("sick")) return new Response("boom", { status: 500 });
      return new Response(PROM(7, 0.1), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { snapshot, nodes } = await fetchFleetSnapshot([cfg("http://sick:8000"), cfg("http://ok:8000")]);
    expect(nodes.filter((n) => !n.ok)).toHaveLength(1);
    expect(snapshot.promptTokensTotal).toBe(7);
  });
});
