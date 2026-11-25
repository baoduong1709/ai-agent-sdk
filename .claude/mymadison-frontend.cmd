@echo off
rem MyMadison frontend for local testing on port 5180 (5173 and 5174 are used by other projects), calling the local backend
rem through the Vite /api proxy. VITE_* set here win over frontend/.env.local.
set "VITE_API_URL=/api"
set "VITE_API_PROXY=http://localhost:4000"
cd /d D:\MADISON\MyMadison\frontend
npm run dev -- --port 5180 --strictPort
