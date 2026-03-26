# Default Deployment Configuration

This repository comes pre-configured for **production deployment** with dangerously skip permissions enabled.

## Default Settings

| Configuration | Value | Location |
|---------------|-------|----------|
| **Port** | 3002 | `ecosystem.config.cjs`, `docker-compose.yml` |
| **PIN** | 000000 | `ecosystem.config.cjs`, `docker-compose.yml` |
| **Skip Permissions** | ✅ Enabled | `ecosystem.config.cjs`, `docker-compose.yml` |
| **Mode** | Headless | `ecosystem.config.cjs` |
| **Auto-restart** | ✅ Enabled | `ecosystem.config.cjs` |
| **Auto-start on boot** | ✅ Enabled | PM2 startup script |

## ⚠️ Security Notice

**Dangerously skip permissions is ENABLED by default.**

This means:
- ✅ Claude Code will execute commands WITHOUT approval
- ✅ Claude Code will edit files WITHOUT approval  
- ✅ Claude Code will use tools WITHOUT approval

**Only use this default configuration in:**
- Private networks (VPS, home network)
- Trusted environments
- Development/Testing scenarios
- Where you have full control over the workspace

## Quick Deploy

### Option 1: PM2 (Recommended for Production)

```bash
cd /home/ubuntu/hscheema1979/ultra-chat
./start-with-pm2.sh
```

**What it does:**
- Starts relay with dangerously skip permissions
- Configures auto-restart on failure
- Sets up auto-start on system boot
- Saves PM2 configuration

### Option 2: Docker

```bash
cd /home/ubuntu/hscheema1979/ultra-chat
docker-compose up -d
```

**What it does:**
- Starts relay in Docker container
- Mounts workspace directories
- Enables dangerously skip permissions via environment variables
- Auto-restarts on failure

## Customizing Permissions

### To Enable Permission Prompts (More Secure)

**For PM2:**
Edit `ecosystem.config.cjs`:
```javascript
args: '--port 3002 --headless --pin YOUR_SECURE_PIN'
// Remove: --dangerously-skip-permissions
```

Then restart:
```bash
pm2 restart ultra-chat-relay
pm2 save
```

**For Docker:**
Edit `docker-compose.yml`:
```yaml
environment:
  - RELAY_DANGEROUSLY_SKIP_PERMISSIONS=false  # Change to false
```

Then restart:
```bash
docker-compose restart
```

### To Change PIN

**For PM2:**
Edit `ecosystem.config.cjs`:
```javascript
args: '--port 3002 --headless --pin YOUR_NEW_PIN --dangerously-skip-permissions'
```

**For Docker:**
Edit `docker-compose.yml`:
```yaml
environment:
  - RELAY_PIN=YOUR_NEW_PIN
```

### To Change Port

**For PM2:**
Edit `ecosystem.config.cjs`:
```javascript
args: '--port YOUR_PORT --headless --pin 000000 --dangerously-skip-permissions'
```

**For Docker:**
Edit `docker-compose.yml`:
```yaml
ports:
  - "YOUR_PORT:3002"
environment:
  - RELAY_PORT=YOUR_PORT
```

## Verification

After deployment, verify the configuration:

```bash
# Check relay is running
curl http://localhost:3002/info

# Check PM2 status
pm2 status

# Check Docker status
docker-compose ps

# Check logs
pm2 logs ultra-chat-relay --lines 50
# or
docker-compose logs -f
```

## Accessing the WebUI

1. **URL**: http://localhost:3002 (or http://YOUR-SERVER-IP:3002)
2. **PIN**: 000000 (unless you changed it)
3. **Projects**: Select from ubuntu, projects, myhealthteam, hscheema1979

## Troubleshooting

### "Permission denied" errors

If you get permission errors even with skip permissions enabled:

1. Check workspace permissions:
   ```bash
   ls -la /home/ubuntu
   ```

2. Ensure relay can access workspaces:
   ```bash
   # For PM2
   pm2 logs ultra-chat-relay --lines 50
   
   # For Docker
   docker-compose exec ultra-chat-relay ls -la /workspace/
   ```

### Can't connect to relay

1. Check if relay is running:
   ```bash
   lsof -i :3002
   ```

2. Check firewall:
   ```bash
   sudo ufw status
   sudo ufw allow 3002
   ```

3. Check logs for errors:
   ```bash
   pm2 logs ultra-chat-relay
   ```

### "Connecting..." stays forever

This means the relay can't spawn Claude Code backends:

1. Make sure you're not in a nested Claude session
2. Check if Claude Agent SDK is installed:
   ```bash
   ls node_modules/@anthropic-ai/claude-agent-sdk/
   ```
3. Restart the relay:
   ```bash
   pm2 restart ultra-chat-relay
   ```

## Migration from Previous Setup

If you're upgrading from a version without dangerously skip permissions:

1. **Stop old relay:**
   ```bash
   pm2 stop ultra-chat-relay
   # or
   docker-compose down
   ```

2. **Backup config:**
   ```bash
   cp ecosystem.config.cjs ecosystem.config.cjs.backup
   cp docker-compose.yml docker-compose.yml.backup
   ```

3. **Update config** (files already updated in this version)

4. **Start new relay:**
   ```bash
   pm2 start ecosystem.config.cjs
   pm2 save
   # or
   docker-compose up -d
   ```

## Best Practices

1. **Always backup** before changing configuration
2. **Test in development** before production deployment
3. **Monitor logs** regularly for unusual activity
4. **Update regularly** to get latest features and security fixes
5. **Use strong PINs** if exposing to network (even with skip permissions)
6. **Network isolation** - Use VPN, firewall, or private network only

## Support

For issues or questions:
- Check logs: `pm2 logs ultra-chat-relay`
- Check status: `pm2 status`
- Review configuration: `ecosystem.config.cjs`
- See [README.md](README.md) for full documentation
