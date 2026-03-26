# Ultra-Chat Relay - PM2 Setup

## Quick Start (After exiting Claude Code session)

```bash
/home/ubuntu/hscheema1979/ultra-chat/start-with-pm2.sh
```

## Manual PM2 Commands

### Start the relay
```bash
cd /home/ubuntu/hscheema1979/ultra-chat
pm2 start ecosystem.config.cjs
pm2 save
```

### Check status
```bash
pm2 status
pm2 logs ultra-chat-relay
```

### Stop/Restart
```bash
pm2 stop ultra-chat-relay
pm2 restart ultra-chat-relay
```

## Access the WebUI

- **URL**: http://localhost:3002 (or your server IP)
- **PIN**: 000000
- **Projects**: ubuntu, projects, myhealthteam, hscheema1979

## How It Works

- PM2 manages the relay process
- Auto-restarts on failure
- Auto-starts on system reboot
- Logs saved to: `logs/pm2-*.log`

## Important Notes

⚠️ **Cannot run from within Claude Code session**
- The relay spawns Claude Code backends via the SDK
- Nested Claude sessions aren't allowed
- Start this AFTER you exit this Claude session

✅ **Once started:**
1. Access http://localhost:3002
2. Enter PIN: 000000
3. Click on a project
4. Send messages - they'll work!

## Troubleshooting

If messages show "Connecting...":
- Check if a Claude Code backend is running: `ps aux | grep claude`
- The relay should auto-spawn backends when you send a message
- If issues persist: `pm2 logs ultra-chat-relay --lines 50`
