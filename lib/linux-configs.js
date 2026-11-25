'use strict';

const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Generates real self-hosted Linux configs for:
 * - Asterisk PJSIP (1,000 extensions 2000..2999)
 * - Asterisk Dialplan + USB GSM/LTE SIM dongle routing (chan_dongle)
 * - Linux ModemManager (mmcli) SMS bridge script
 * - Postfix local virtual mailbox transport -> Node SMTP :2525
 */
function generateLinuxConfigs({ domain, agents, smtpPort = 2525, apiPort = 3000 }) {
  const pjsipLines = [
    '; Auto-generated self-hosted Asterisk PJSIP config for 1,000 extensions (2000-2999)',
    '; Zero 3rd-party APIs or cloud trunks required.',
    '; Place in /etc/asterisk/pjsip_agents.conf and add: #include pjsip_agents.conf',
    '',
    '[transport-udp]',
    'type=transport',
    'protocol=udp',
    'bind=0.0.0.0:5060',
    '',
  ];

  for (const agent of agents) {
    const ext = agent.extension;
    const pass = agent.sipPassword;
    pjsipLines.push(
      `[${ext}]`,
      'type=endpoint',
      'context=agents-internal',
      'disallow=all',
      'allow=ulaw,alaw,opus',
      `auth=auth-${ext}`,
      `aors=aor-${ext}`,
      'direct_media=no',
      'force_rport=yes',
      'rewrite_contact=yes',
      'rtp_symmetric=yes',
      '',
      `[auth-${ext}]`,
      'type=auth',
      'auth_type=userpass',
      `username=${ext}`,
      `password=${pass}`,
      '',
      `[aor-${ext}]`,
      'type=aor',
      'max_contacts=4',
      'remove_existing=yes',
      ''
    );
  }

  const dialplan = `; Auto-generated Asterisk dialplan for self-hosted Linux calling
; Supports internal extension-to-extension calls (2000-2999)
; AND optional real PSTN cellular calls via USB SIM modem (chan_dongle).

[agents-internal]
; Call any internal extension 2000-2999
exten => _2XXX,1,NoOp(Internal call \${CALLERID(num)} -> \${EXTEN})
 same => n,Dial(PJSIP/\${EXTEN},30)
 same => n,Hangup()

; Dial real public phone number via Linux USB SIM dongle (prefix 9 + number, or +E164)
exten => _9X.,1,NoOp(Outbound cellular call via USB SIM -> \${EXTEN:1})
 same => n,Dial(Dongle/dongle0/\${EXTEN:1},60)
 same => n,Hangup()

exten => _+X.,1,NoOp(Outbound E.164 cellular call via USB SIM -> \${EXTEN})
 same => n,Dial(Dongle/dongle0/\${EXTEN},60)
 same => n,Hangup()

[from-pstn-sim]
; Route incoming real SIM-card calls to operator extension 2000
exten => s,1,NoOp(Incoming cellular call from \${CALLERID(num)})
 same => n,Dial(PJSIP/2000,45)
 same => n,Hangup()
`;

  const dongleConf = `; Asterisk chan_dongle config for a Linux USB GSM/3G/4G voice+SMS SIM modem
; Plug in a voice-capable USB modem with an active SIM card (zero 3rd-party APIs).
[general]
interval=15

[defaults]
context=from-pstn-sim
group=0
rxgain=0
txgain=0
autodeletesms=yes
resetdongle=yes
u2diag=-1
usecallingpres=yes
callingpres=allowed_passed_screen
disablesms=no

[dongle0]
audio=/dev/ttyUSB1
data=/dev/ttyUSB2
`;

  const simBridgeScript = `#!/usr/bin/env bash
# Self-hosted Linux ModemManager (mmcli) SIM-to-Agent SMS bridge (zero 3rd-party APIs)
# Polls a local USB 4G/LTE SIM modem and forwards incoming real SMS to extension 2000.
set -euo pipefail

API_URL="\${API_URL:-http://127.0.0.1:${apiPort}}"
TARGET_EXT="\${TARGET_EXT:-2000}"

if ! command -v mmcli >/dev/null 2>&1; then
  echo "ModemManager (mmcli) is not installed. Run: sudo apt-get install -y modemmanager" >&2
  exit 1
fi

echo "Watching local Linux USB SIM modem for incoming SMS -> ext \$TARGET_EXT (\$API_URL)..."
while true; do
  MODEM=\$(mmcli -L 2>/dev/null | sed -n 's|.*/Modem/\\([0-9]*\\).*|\\1|p' | head -n1 || true)
  if [ -n "\$MODEM" ]; then
    for SMS_ID in \$(mmcli -m "\$MODEM" --messaging-list-sms 2>/dev/null | sed -n 's|.*/SMS/\\([0-9]*\\).*|\\1|p'); do
      INFO=\$(mmcli -s "\$SMS_ID" -J 2>/dev/null || true)
      if [ -n "\$INFO" ]; then
        curl -s -X POST "\$API_URL/api/phone/inbound-sim" \\
          -H "Content-Type: application/json" \\
          -d "{\"to\":\"\$TARGET_EXT\",\"raw\":\$INFO}" >/dev/null || true
        mmcli -m "\$MODEM" --messaging-delete-sms="\$SMS_ID" >/dev/null 2>&1 || true
      fi
    done
  fi
  sleep 3
done
`;

  const postfixMain = `# Self-hosted Postfix config for ${domain} (zero 3rd-party mail SaaS)
# Routes mail for @${domain} into the built-in Node SMTP listener on 127.0.0.1:${smtpPort}
myhostname = mail.${domain}
mydomain = ${domain}
myorigin = \$mydomain
mydestination = localhost
inet_interfaces = all
inet_protocols = all
virtual_mailbox_domains = ${domain}
virtual_transport = smtp:[127.0.0.1]:${smtpPort}
smtpd_recipient_restrictions = permit_mynetworks, reject_unauth_destination
`;

  const setupScript = `#!/usr/bin/env bash
# Plug-and-play Linux host setup (zero 3rd-party API keys, 100% free/local)
set -euo pipefail
SCRIPT_DIR="\$(cd "\$(dirname "\$0")" && pwd)"

echo "[1/3] Local 1,000-agent Node server runs on port ${apiPort} and SMTP on port ${smtpPort}."
if [ -d /etc/asterisk ] && [ "\$(id -u)" -eq 0 ]; then
  cp "\$SCRIPT_DIR/pjsip_agents.conf" /etc/asterisk/pjsip_agents.conf
  cp "\$SCRIPT_DIR/extensions_agents.conf" /etc/asterisk/extensions_agents.conf
  cp "\$SCRIPT_DIR/dongle.conf" /etc/asterisk/dongle.conf
  grep -q 'pjsip_agents.conf' /etc/asterisk/pjsip.conf 2>/dev/null || echo '#include pjsip_agents.conf' >> /etc/asterisk/pjsip.conf
  grep -q 'extensions_agents.conf' /etc/asterisk/extensions.conf 2>/dev/null || echo '#include extensions_agents.conf' >> /etc/asterisk/extensions.conf
  systemctl restart asterisk 2>/dev/null || asterisk -rx "core reload" 2>/dev/null || true
  echo "[2/3] Asterisk 1,000 SIP extensions (2000-2999) + USB SIM dongle dialplan installed."
else
  echo "[2/3] Asterisk not active or not root; configs staged in \$SCRIPT_DIR"
fi

if [ -d /etc/postfix ] && [ "\$(id -u)" -eq 0 ]; then
  echo "[3/3] Postfix staged config available at \$SCRIPT_DIR/postfix-main.cf"
else
  echo "[3/3] Postfix optional; built-in Node SMTP listener on :${smtpPort} is already active."
fi
`;

  return {
    'pjsip_agents.conf': pjsipLines.join('\n'),
    'extensions_agents.conf': dialplan,
    'dongle.conf': dongleConf,
    'sim-modem-bridge.sh': simBridgeScript,
    'postfix-main.cf': postfixMain,
    'setup-linux-host.sh': setupScript,
  };
}

function writeLinuxConfigs(targetDir, opts) {
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const files = generateLinuxConfigs(opts);
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(targetDir, name);
    const mode = name === 'pjsip_agents.conf' ? 0o600 : name.endsWith('.sh') ? 0o750 : 0o644;
    fs.writeFileSync(filePath, content, { encoding: 'utf8', mode });
  }
  return files;
}

/**
 * Real UDP SIP OPTIONS probe (no faked status).
 * Host must be a bare IPv4/hostname: no scheme, path, or URL characters.
 * Same rule as phone/sip_probe.py validate_host; the HTTP route must not be
 * usable to spray UDP OPTIONS packets at arbitrary user-supplied targets.
 */
const SIP_HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,251}$/;
function validateSipHost(host) {
  if (typeof host !== 'string' || !SIP_HOST_RE.test(host)) {
    throw new Error('Use a numeric IPv4/hostname without a scheme or URL path');
  }
  return host;
}

function probeSip(host = '127.0.0.1', port = 5060, timeoutMs = 1500) {
  validateSipHost(host);
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be between 1 and 65535');
  }
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const callId = crypto.randomBytes(8).toString('hex') + '@agent-phone';
    const branch = 'z9hG4bK' + crypto.randomBytes(6).toString('hex');
    const packet = Buffer.from(
      `OPTIONS sip:${host}:${port} SIP/2.0\r\n` +
      `Via: SIP/2.0/UDP 127.0.0.1:${port};branch=${branch};rport\r\n` +
      `From: <sip:probe@localhost>;tag=probe1\r\n` +
      `To: <sip:${host}:${port}>\r\n` +
      `Call-ID: ${callId}\r\n` +
      `CSeq: 1 OPTIONS\r\n` +
      `Max-Forwards: 70\r\n` +
      `Content-Length: 0\r\n\r\n`
    );

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* ignore */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, reachable: false, host, port, detail: `No SIP response from ${host}:${port} within ${timeoutMs}ms` });
    }, timeoutMs);

    socket.on('error', (err) => {
      finish({ ok: false, reachable: false, host, port, detail: err.message });
    });

    socket.on('message', (msg) => {
      const text = msg.toString('utf8');
      const statusLine = text.split(/\r?\n/)[0] || '';
      const validCallId = text.includes(callId);
      finish({
        ok: validCallId && /^SIP\/2\.0\s+\d{3}/.test(statusLine),
        reachable: true,
        host,
        port,
        statusLine,
        detail: validCallId ? `SIP peer answered: ${statusLine}` : `Unexpected SIP reply: ${statusLine}`,
      });
    });

    socket.send(packet, port, host, (err) => {
      if (err) finish({ ok: false, reachable: false, host, port, detail: err.message });
    });
  });
}

module.exports = {
  generateLinuxConfigs,
  writeLinuxConfigs,
  probeSip,
  validateSipHost,
};
