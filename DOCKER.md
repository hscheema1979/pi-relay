# Ultra-Chat Relay - Docker Setup

**⚠️ IMPORTANT**: This deployment comes with `--dangerously-skip-permissions` enabled by default. See [README.md](README.md) for security details.

## Quick Start

```bash
# Build and start the container
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the container
docker-compose down
```

## Access

- **Direct**: http://localhost:3002
- **PIN**: 000000
- **Projects**: http://localhost:3002/p/ubuntu/, /p/projects/, /p/hscheema1979/, /p/myhealthteam/

## Configuration

### Default Settings

The Docker deployment comes pre-configured with:

| Setting | Value | How It's Set |
|---------|-------|-------------|
| **Port** | 3002 | Command argument `--port 3002` |
| **PIN** | 000000 | Command argument `--pin 000000` |
| **Skip Permissions** | ✅ Enabled | Command argument `--dangerously-skip-permissions` |
| **Mode** | Headless | Command argument `--headless` |

### Customizing Settings

Edit `docker-compose.yml` command line:

```yaml
command: ["node", "bin/cli.js", "--port", "YOUR_PORT", "--headless", "--pin", "YOUR_PIN", "--dangerously-skip-permissions"]
```

Or to enable permission prompts:

```yaml
command: ["node", "bin/cli.js", "--port", "3002", "--headless", "--pin", "YOUR_PIN"]
# Remove: --dangerously-skip-permissions
```

Then restart:
```bash
docker-compose down
docker-compose up -d
```

## Workspaces

The following workspaces are mounted inside the container:
- `/workspace/ubuntu` → `/home/ubuntu`
- `/workspace/projects` → `/home/ubuntu/projects`
- `/workspace/hscheema1979` → `/home/ubuntu/hscheema1979`
- `/workspace/myhealthteam` → `/home/ubuntu/hscheema1979/myhealthteam`

## Adding New Workspaces

1. Add the volume mount to `docker-compose.yml`:
   ```yaml
   volumes:
     - /path/to/project:/workspace/new-project:rw
   ```

2. Restart: `docker-compose restart`

3. Access via webUI: The relay will scan `/workspace/` for available projects

## Docker Management

```bash
# Start
docker-compose up -d

# Stop
docker-compose down

# Restart
docker-compose restart

# View logs
docker-compose logs -f

# Check status
docker-compose ps

# Rebuild after code changes
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

## Troubleshooting

### Relay shows "Connecting..."

This means the relay can't spawn Claude Code backends.

**Check 1: Verify the relay is properly configured**
```bash
# Check the running command
docker-compose exec ultra-chat-relay ps aux

# Should show something like:
# node ... bin/cli.js --port 3002 --headless --pin 000000 --dangerously-skip-permissions
```

**Check 2: Verify workspace permissions**
```bash
docker-compose exec ultra-chat-relay ls -la /workspace/
```

**Check 3: Check logs**
```bash
docker-compose logs
```

### Can't access workspace files

```bash
# Check mounts
docker inspect ultra-chat-relay | grep -A 20 Mounts

# Check permissions
docker-compose exec ultra-chat-relay ls -la /workspace/ubuntu
```

### Port conflict

Edit `docker-compose.yml`:
```yaml
ports:
  - "3003:3002"  # Use port 3003 instead
```

Then restart:
```bash
docker-compose down
docker-compose up -d
```

## Architecture

```
Docker Container (port 3002)
├── /relay (relay code)
├── /data/.claude-relay (config)
└── /workspace/ (mounted workspaces)
    ├── ubuntu
    ├── projects
    ├── hscheema1979
    └── myhealthteam
```

## Why Docker vs Native?

### Docker Pros:
- ✅ Isolated environment
- ✅ Easy deployment
- ✅ Version control
- ✅ Resource limits
- ✅ Easy to move/restore

### Native (PM2) Pros:
- ✅ Direct file system access
- ✅ No Docker overhead
- ✅ Easier debugging
- ✅ Native performance
- ✅ PM2 process management

**Recommendation**: Use PM2 for production (native), Docker for testing/isolation.

## Security Notes

⚠️ **Critical Security Warnings**:

1. **Skip Permissions Enabled**: The relay auto-approves all tool executions
   - Only run on private networks
   - Only expose through authenticated reverse proxy
   - Keep Docker/PM2 updated

2. **Workspace Access**: Container has full access to mounted workspaces
   - Only mount trusted directories
   - Use read-only mounts where possible
   - Monitor relay activity

3. **Network Exposure**: Port 3002 is exposed
   - Use firewall rules to restrict access
   - Consider nginx/traefik reverse proxy with auth
   - Use VPN or SSH tunnel for remote access

### Securing the Deployment

**Option 1: Reverse Proxy with Auth**
```bash
# Example nginx configuration
location / {
    auth_basic "Restricted";
    auth_basic_user_file /etc/nginx/.htpasswd;
    proxy_pass http://localhost:3002;
}
```

**Option 2: SSH Tunnel**
```bash
ssh -L 3002:localhost:3002 user@server
# Access at http://localhost:3002
```

**Option 3: VPN Only**
```bash
# Only allow VPN IP ranges
sudo ufw allow from 10.0.0.0/8 to any port 3002
```

## Previous Issues Fixed

### Issue: Docker container showed "Connecting..." forever

**Root Cause**: Dockerfile was running `lib/daemon.js` directly without CLI arguments.

**Fix**: Updated Dockerfile and docker-compose.yml to pass proper command arguments:
- `--port 3002`
- `--headless`
- `--pin 000000`
- `--dangerously-skip-permissions`

**Result**: Docker container now spawns Claude Code backends correctly.

## Updating the Deployment

After pulling latest changes:

```bash
git pull
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```
