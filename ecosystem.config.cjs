module.exports = {
  apps: [
    {
      name: 'ultra-chat-relay',
      script: './lib/daemon.js',
      args: '--port 3002 --headless --pin 000000 --dangerously-skip-permissions',
      cwd: '/home/ubuntu/ultra-chat',
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: '3002'
      },
      error_file: '/home/ubuntu/ultra-chat/logs/pm2-error.log',
      out_file: '/home/ubuntu/ultra-chat/logs/pm2-out.log',
      log_file: '/home/ubuntu/ultra-chat/logs/pm2-combined.log',
      time: true
    }
  ]
};
