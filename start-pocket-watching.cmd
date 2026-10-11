@echo off
REM Pocket Watching launcher - LAN-bound, live mode.
REM Serves the dashboard on http://<this-PC-LAN-IP>:3000 so anyone on the
REM network (e.g. another tenant) can open it in a browser. Read-only toward the
REM Spark cluster: only GETs /metrics.

cd /d "%~dp0"

REM Settings
set POCKET_WATCH_MODE=live
set VLLM_BASE_URL=http://localhost:8000
REM API key only needed for generating load, not for the dashboard itself.
REM Set it in your user environment variables if you want load tests.

echo ============================================
echo  Pocket Watching - live dashboard
echo  URL for both of you: http://localhost:3000
echo  (pin this URL to the taskbar in Edge/Chrome)
echo  Close this window to stop the dashboard.
echo ============================================

npm run dev -- -H 0.0.0.0 -p 3000
