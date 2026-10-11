#!/usr/bin/env python3
"""Cost Peep live load driver — generates REAL inference traffic against the
cluster so the dashboard shows real $/1M tokens.

READ-ONLY w.r.t. infrastructure: sends chat completions to the existing,
already-running vLLM endpoint. Does not touch serving config, systemd units,
the rail, or anything else. Same class of traffic as a developer using VS Code
against the cluster.

Usage:
    python scripts/generate_load.py [--requests 60] [--concurrency 3] [--max-tokens 120]

Env:
    VLLM_BASE_URL  default http://localhost:8000
    VLLM_API_KEY   required (bearer token) — set in your shell, never committed
"""
import argparse
import concurrent.futures
import json
import os
import sys
import time
import urllib.request
import urllib.error

PROMPTS = [
    "Summarize the trade-offs between GPU time-slicing and MIG partitioning in two sentences.",
    "Write a one-paragraph explanation of continuous batching for a financial auditor.",
    "In one sentence: why does KV cache size scale with context length?",
    "List three reasons a self-hosted LLM can cost less per token than an API.",
    "Explain prefix caching to a developer who has never run an inference server.",
    "Write a JSON object with keys model, tokens, cost describing an inference bill.",
    "What does p95 latency mean and why do SREs care about it more than the mean?",
    "Two sentences on why speculative decoding improves latency but not throughput.",
]


def post_chat(base, key, prompt, max_tokens, timeout=120):
    payload = {
        "model": os.environ.get("VLLM_MODEL", "glm-5.3-flash"),
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0.3,
    }
    req = urllib.request.Request(
        base.rstrip("/") + "/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.load(r)
        wall = time.perf_counter() - t0
        usage = body.get("usage", {})
        return {
            "ok": True,
            "wall_s": wall,
            "prompt_tokens": usage.get("prompt_tokens", 0),
            "completion_tokens": usage.get("completion_tokens", 0),
        }
    except Exception as e:  # noqa: BLE001 - we want the error name + message
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "wall_s": time.perf_counter() - t0}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--requests", type=int, default=60)
    ap.add_argument("--concurrency", type=int, default=3)
    ap.add_argument("--max-tokens", type=int, default=120)
    ap.add_argument("--gap", type=float, default=0.2, help="seconds between request submissions")
    args = ap.parse_args()

    base = os.environ.get("VLLM_BASE_URL", "http://localhost:8000")
    key = os.environ.get("VLLM_API_KEY")
    if not key:
        sys.exit("set VLLM_API_KEY (bearer token) — it is never committed to the repo")

    print(f"Generating {args.requests} real requests, concurrency {args.concurrency}, "
          f"max_tokens {args.max_tokens} against {base}")
    print("This is plain chat traffic — the serving stack is untouched.\n")

    t0 = time.perf_counter()
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        pending = []
        for i in range(args.requests):
            prompt = PROMPTS[i % len(PROMPTS)]
            pending.append(ex.submit(post_chat, base, key, prompt, args.max_tokens))
            time.sleep(args.gap)
        for fut in concurrent.futures.as_completed(pending):
            results.append(fut.result())

    wall = time.perf_counter() - t0
    ok = [r for r in results if r["ok"]]
    failed = [r for r in results if not r["ok"]]
    ptok = sum(r["prompt_tokens"] for r in ok)
    ctok = sum(r["completion_tokens"] for r in ok)

    print(f"\n=== done in {wall:.1f}s ===")
    print(f"ok: {len(ok)}  failed: {len(failed)}")
    if failed[:3]:
        for f in failed[:3]:
            print("  fail sample:", f.get("error"))
    print(f"prompt tokens: {ptok:,}  completion tokens: {ctok:,}  total: {ptok + ctok:,}")
    if ok:
        walls = sorted(r["wall_s"] for r in ok)
        print(f"wall per request: median {walls[len(walls)//2]:.2f}s  max {walls[-1]:.2f}s")
        print(f"aggregate throughput: {(ptok + ctok) / wall:.1f} tok/s")


if __name__ == "__main__":
    main()
