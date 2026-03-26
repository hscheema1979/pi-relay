module.exports = {
  apps: [{
    name: "pi-relay",
    script: "lib/daemon.js",
    cwd: "/home/ubuntu/pi-relay",
    env: {
      PI_RELAY_HOME: "/home/ubuntu/.pi-relay",
    },
    autorestart: true,
    max_restarts: 10,
    error_file: "/home/ubuntu/.pi-relay/logs/error.log",
    out_file: "/home/ubuntu/.pi-relay/logs/output.log",
    merge_logs: true,
  }],
};
