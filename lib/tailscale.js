/**
 * tailscale.js — Tailscale network discovery for pi-relay.
 *
 * Uses `tailscale status --json` to discover machines on the tailnet,
 * then probes each online peer for a running pi-relay instance.
 */

var { execFile } = require("child_process");

/**
 * Get full tailscale status including self and peers.
 * Returns null if tailscale is not available.
 */
function getTailscaleStatus() {
  return new Promise(function (resolve) {
    execFile("tailscale", ["status", "--json"], { timeout: 5000, encoding: "utf8" }, function (err, stdout) {
      if (err) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        resolve(null);
      }
    });
  });
}

/**
 * Probe a single host for a running pi-relay.
 * Tries the /info endpoint (unauthenticated, returns project list + version).
 * Returns machine info or null if not reachable / not a relay.
 */
function probeRelay(host, port, timeoutMs) {
  port = port || 3002;
  timeoutMs = timeoutMs || 3000;
  var url = "http://" + host + ":" + port + "/info";

  return new Promise(function (resolve) {
    // Use Node's http module since fetch may not be available in Node 18
    var http = require("http");
    var req = http.get(url, { timeout: timeoutMs }, function (res) {
      var body = "";
      res.on("data", function (chunk) { body += chunk; });
      res.on("end", function () {
        try {
          var data = JSON.parse(body);
          resolve(data);
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on("error", function () { resolve(null); });
    req.on("timeout", function () { req.destroy(); resolve(null); });
  });
}

/**
 * Discover all pi-relay instances on the tailnet.
 *
 * Returns: {
 *   tailnet: { name, magicDNSSuffix },
 *   self: { hostname, fqdn, ip, os },
 *   machines: [
 *     {
 *       hostname, fqdn, ip, os, online,
 *       hasRelay: true/false,
 *       relay: { projects: [...], version } | null,
 *       lastSeen
 *     }
 *   ]
 * }
 */
async function discover(opts) {
  opts = opts || {};
  var callerPort = opts.port || 3002;
  var probeTimeout = opts.probeTimeout || 3000;

  // Build list of ports to probe: always try 3002 (default), plus caller's
  // own port if different, to handle mixed-port deployments
  var probePorts = [3002];
  if (callerPort !== 3002) probePorts.push(callerPort);

  var status = await getTailscaleStatus();
  if (!status) {
    return { tailnet: null, self: null, machines: [], error: "Tailscale not available" };
  }

  var self = status.Self;
  var magicDNSSuffix = status.MagicDNSSuffix || "";
  var tailnetName = status.CurrentTailnet ? status.CurrentTailnet.Name : "";

  var selfInfo = {
    hostname: self.HostName,
    fqdn: self.DNSName ? self.DNSName.replace(/\.$/, "") : self.HostName,
    ip: self.TailscaleIPs ? self.TailscaleIPs[0] : null,
    os: self.OS,
  };

  // Collect online Linux/Windows peers (skip phones)
  var peers = [];
  var peerMap = status.Peer || {};
  var keys = Object.keys(peerMap);
  for (var i = 0; i < keys.length; i++) {
    var peer = peerMap[keys[i]];
    peers.push({
      hostname: peer.HostName,
      fqdn: peer.DNSName ? peer.DNSName.replace(/\.$/, "") : peer.HostName,
      ip: peer.TailscaleIPs ? peer.TailscaleIPs[0] : null,
      os: peer.OS,
      online: !!peer.Online,
      lastSeen: peer.LastSeen || null,
    });
  }

  // Probe online peers for pi-relay in parallel, trying multiple ports
  var probePromises = [];
  for (var j = 0; j < peers.length; j++) {
    if (!peers[j].online) {
      peers[j].hasRelay = false;
      peers[j].relay = null;
      peers[j].relayPort = null;
      continue;
    }
    // Use IP for probing (more reliable than DNS in some setups)
    probePromises.push((function (peer) {
      var probeHost = peer.ip || peer.fqdn;
      // Try each port in order, stop at first success
      var tryPort = function (idx) {
        if (idx >= probePorts.length) {
          peer.hasRelay = false;
          peer.relay = null;
          peer.relayPort = null;
          return Promise.resolve();
        }
        return probeRelay(probeHost, probePorts[idx], probeTimeout).then(function (info) {
          if (info && (info.projects || info.version || info.authRequired)) {
            peer.hasRelay = true;
            peer.relay = info;
            peer.relayPort = probePorts[idx];
          } else {
            return tryPort(idx + 1);
          }
        });
      };
      return tryPort(0);
    })(peers[j]));
  }

  await Promise.all(probePromises);

  // Sort: relay machines first, then online, then offline
  peers.sort(function (a, b) {
    if (a.hasRelay && !b.hasRelay) return -1;
    if (!a.hasRelay && b.hasRelay) return 1;
    if (a.online && !b.online) return -1;
    if (!a.online && b.online) return 1;
    return a.hostname.localeCompare(b.hostname);
  });

  return {
    tailnet: { name: tailnetName, magicDNSSuffix: magicDNSSuffix },
    self: selfInfo,
    machines: peers,
  };
}

module.exports = {
  getTailscaleStatus: getTailscaleStatus,
  probeRelay: probeRelay,
  discover: discover,
};
