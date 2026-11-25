@echo off
rem MyMadison backend for local testing: AI_ENGINE=sdk, demo user u1, and the local PostgreSQL 17 (no Docker), database madison_eleave_sdk.
rem These values override backend/.env (Nest config never overwrites a variable already set), so the DB in .env is not touched.
set "NODE_ENV=development"
set "AUTH_DEV_USER=true"
set "AI_ENGINE=sdk"
rem Keep the every-minute Teams tag sync away from the real Microsoft Teams while testing against the local DB.
set "TEAMS_GRAPH_ENABLED=false"
set "PORT=4000"
set "DATABASE_URL=postgresql://madison:madison_local_only@127.0.0.1:5432/madison_eleave_sdk?sslmode=disable"
set "DB_HOST=127.0.0.1"
set "DB_PORT=5432"
set "DB_USER=madison"
set "DB_PASSWORD=madison_local_only"
set "DB_NAME=madison_eleave_sdk"
cd /d D:\MADISON\MyMadison\backend
npm run start:dev
