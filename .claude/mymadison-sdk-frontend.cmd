@echo off
rem Frontend of the SDK worktree (D:\MADISON\MyMadison-sdk) on port 5180, calling the local backend through the Vite /api proxy.
rem VITE_* set here win over frontend/.env.local.
set "VITE_API_URL=/api"
set "VITE_API_PROXY=http://localhost:4000"
cd /d D:\MADISON\MyMadison-sdk\frontend
npm run dev -- --port 5180 --strictPort
