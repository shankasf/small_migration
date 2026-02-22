#!/bin/bash
# Start all services for local development

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Starting Migration Agent Development Environment..."

# Function to cleanup on exit
cleanup() {
    echo "Stopping services..."
    pkill -f "uvicorn main:app" 2>/dev/null || true
    pkill -f "tsx watch" 2>/dev/null || true
    pkill -f "vite" 2>/dev/null || true
    exit 0
}

trap cleanup SIGINT SIGTERM

# Start AI Service
echo "Starting AI Service (port 8084)..."
cd "$PROJECT_DIR/ai-service"
source venv/bin/activate
uvicorn main:app --port 8084 --reload &
AI_PID=$!

# Start Backend
echo "Starting Backend (port 3001)..."
cd "$PROJECT_DIR/backend"
npm run dev &
BACKEND_PID=$!

# Start Frontend
echo "Starting Frontend (port 5173)..."
cd "$PROJECT_DIR/frontend"
npm run dev &
FRONTEND_PID=$!

echo ""
echo "========================================="
echo "Migration Agent is starting..."
echo "========================================="
echo "Frontend:   http://localhost:5173"
echo "Backend:    http://localhost:3001"
echo "AI Service: http://localhost:8084"
echo "========================================="
echo "Press Ctrl+C to stop all services"
echo ""

# Wait for all background processes
wait
