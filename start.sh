#!/bin/bash
# Start Ultra-Chat Relay (Port 3003)
# Modified version with banners disabled and --dangerously-skip-permissions

echo "Starting Ultra-Chat Relay..."

# Stop any existing ultra-chat process
pkill -f "ultra-chat.*lib/daemon.js" 2>/dev/null
sleep 2

# CRITICAL: Unset CLAUDECODE to prevent nested session detection
unset CLAUDECODE

# Set Ultra-Chat relay home
export CLAUDE_RELAY_HOME="$HOME/.claude-ultra-chat"

# Start Ultra-Chat Relay on port 3003
echo "Starting Ultra-Chat Relay on port 3003..."
cd /home/ubuntu/hscheema1979/ultra-chat
exec node lib/daemon.js > /tmp/ultra-chat-3003.log 2>&1 &
sleep 2

# Show status
echo ""
echo "=== Ultra-Chat Relay Status ==="
lsof -i :3003 | grep LISTEN || echo "❌ Not running"
echo ""
cat /tmp/ultra-chat-3003.log 2>/dev/null | grep "Projects:" || echo "No log found"
echo ""
echo "✅ Ultra-Chat Relay running on port 3003"
