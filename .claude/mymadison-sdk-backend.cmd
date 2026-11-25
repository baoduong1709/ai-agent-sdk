@echo off
rem Backend of the SDK worktree (D:\MADISON\MyMadison-sdk: develop + the agent-studio-sdk engine) with AI_ENGINE=sdk,
rem demo user u1 and the local PostgreSQL 17 database madison_eleave_sdk.
rem These values override backend/.env (Nest config never overwrites a variable already set), so the remote DB in .env is never used.
set "NODE_ENV=development"
set "AUTH_DEV_USER=true"
set "AI_ENGINE=sdk"
set "AI_UI_LAYOUT=true"
rem The model comes from backend/.env (local Ollama qwen2.5:14b). At Ollama's 4096 context the ~10k-token prompt
rem (system prompt + 43 tool schemas) is cut to ~2k tokens, so answers can be off topic; a 16k context does not fit
rem the 12 GB GPU (the CPU offload fails with a CUDA PTX error).
rem Keep the every-minute Teams tag sync away from the real Microsoft Teams while testing against the local DB.
set "TEAMS_GRAPH_ENABLED=false"
rem Dev-only tool gateway (/api/v1/ai/tools) for testing the chat's tools from agent Studio (http://127.0.0.1:4173).
set "AI_TOOL_GATEWAY=true"
set "PORT=4000"
set "DATABASE_URL=postgresql://madison:madison_local_only@127.0.0.1:5432/madison_eleave_sdk?sslmode=disable"
set "DB_HOST=127.0.0.1"
set "DB_PORT=5432"
set "DB_USER=madison"
set "DB_PASSWORD=madison_local_only"
set "DB_NAME=madison_eleave_sdk"
cd /d D:\MADISON\MyMadison-sdk\backend
npm run start:dev
