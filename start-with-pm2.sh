#!/bin/bash
cd /home/ubuntu/hscheema1979/ultra-chat

# Start with PM2 using ecosystem config
pm2 start ecosystem.config.cjs

# Save PM2 configuration
pm2 save

# Check status
pm2 status

echo ""
echo "✅ Ultra-chat relay started with PM2!"
echo "Access it at: http://localhost:3002"
echo "PIN: 000000"
echo "Permissions: ⚠️ Dangerously skipped (auto-approve tools)"
echo ""
echo "View logs: pm2 logs ultra-chat-relay"
echo "Stop: pm2 stop ultra-chat-relay"
echo "Restart: pm2 restart ultra-chat-relay"
