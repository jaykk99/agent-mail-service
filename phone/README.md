# Self-hosted Agent Phone — 1,000 internal extensions

**No phone-number provider, external account, cloud API, or Python packages needed.**
This uses **Python 3's standard library** on Linux, **SQLite** for messages and
browser-native **WebRTC** for peer-to-peer voice. Each agent keeps its own
private API token and a stable extension such as **2000** or **2999**.

**Important:** extensions are NOT real public phone numbers. The service cannot
send carrier SMS, receive verification texts or call ordinary mobile phones
without a telecom provider. No one can create 1,000 real free public DIDs just
by running their own Linux server.

## Quick start — Linux on a Chromebook

Clone the repo if it is not already on your Linux machine:

~~~sh
git clone https://github.com/jaykk99/agent-mail-service.git
cd agent-mail-service
~~~

**If this is still a pull request**, check out the feature branch first:

~~~sh
git fetch origin feat/internal-agent-phones
git switch feat/internal-agent-phones
~~~

Start a private phone service with **all 1,000 identities**:

~~~sh
python3 phone/server.py --state-dir "$HOME/agent-phone-private" --count 1000
~~~

It prints \`Agent Phone: http://127.0.0.1:8765\`. On the Chromebook, open
**http://localhost:8765** in Chrome. No signup is required. Stop with Ctrl+C.

To sign in as the first agent, run the following command in a **separate**
Linux terminal to retrieve its existing local API token:

~~~sh
python3 - <<'PY'
import json
from pathlib import Path
file = Path.home() / 'agent-phone-private' / 'identities.json'
agents = json.loads(file.read_text())['extensions']
print('Agent:', agents['2000']['agentId'])
print('Extension: 2000')
print('Private API token:', agents['2000']['apiToken'])
PY
~~~

Copy the token into the local browser page. For the second agent, retrieve the
token under \`agents['2001']\` instead. Do not share or commit either token.

**Your numbers and tokens stay the same after reboot** as long as you keep the
same state directory. The server initializes 1,000 identities once; it does
not require 1,000 separate installations.

## Test agent-to-agent messaging

Open two independent browser windows/tabs and sign in as 2000 and 2001.

1. From 2000, enter **2001**, type a message, and select **Send message**.
2. In the 2001 window, read the incoming internal message.
3. Send a reply in the other direction.

Messages live in \`messages.sqlite3\` in the private state directory and
persist when the server is restarted. Only authenticated recipients can
read their own inbox. Authentication uses the bearer token generated for
each agent. The server also rate-limits message and signaling traffic.

## Browser-to-browser voice calls, completely local

In the agent 2000 window, enter **2001** and select **Call extension above**.
In the 2001 window, accept the incoming call and allow microphone access.
Choose **Hang up** to end it.

Voice uses browser-provided **WebRTC** with **no STUN/TURN vendor service**.
The Python server forwards only offer/answer/ICE signaling; the audio goes
directly between reachable browsers. It is suitable for two browsers on
the same host or a compatible private LAN. It will **not** reliably cross
arbitrary NATs/firewalls and is **not** a replacement for public telephone
service. Agent bots need their own WebRTC audio implementation to handle
a voice stream; the MCP tool alone does not transmit audio.

Browser permissions require a **secure context**. \`http://localhost\` is
allowed for local use. Remote devices need trusted **HTTPS** and reachable
peer-to-peer networking; don't publish unencrypted bearer-token HTTP service
to the internet. A remote HTTPS listener is optionally supported by:

~~~sh
python3 phone/server.py --state-dir "$HOME/agent-phone-private" \
  --host 0.0.0.0 --port 8765 \
  --tls-cert /path/to/trusted-cert.pem --tls-key /path/to/private-key.pem
~~~

ChromeOS Linux port forwarding can expose TCP services to the local network
through ChromeOS Settings → Developers → Linux → Port forwarding, but it is
not a guaranteed internet-facing public URL. For direct WebRTC audio across
networks, hosts must be able to establish a P2P route; self-hosted TURN can
help but is more setup and bandwidth. Do not expose this development server
openly to the internet.

## Connect your agents through local MCP

A no-dependency **stdio MCP server** exposes:

- \`phone_identity\` — your agent's private extension
- \`phone_directory\` — other agents' internal extensions
- \`phone_send_text\` and \`phone_inbox\` — send and receive local texts
- \`phone_send_call_signal\` and \`phone_call_signals\` — coordinate WebRTC
  calls (signaling only; the agent still requires a WebRTC media client)

For an agent process on the same Linux machine, set the **agent's own token**
and launch the MCP bridge:

~~~sh
export PHONE_URL="http://127.0.0.1:8765"
export PHONE_AGENT_TOKEN="paste-this-agents-private-api-token"
python3 phone/mcp.py
~~~

Or configure your MCP client to run \`python3 /absolute/path/to/phone/mcp.py\`
with those two environment variables. Each of the 1,000 agents must get its
**own** token; the master \`identities.json\` stays private. This module
currently manages its own phone identities. Linking them automatically to
\`agent-mail-service\` account IDs is not implemented.

The HTTP API is also available directly at \`http://127.0.0.1:8765\`:

~~~sh
curl -H "Authorization: Bearer $PHONE_AGENT_TOKEN" \
  http://127.0.0.1:8765/api/me
curl -X POST -H "Authorization: Bearer $PHONE_AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"to":"2001","text":"Hello, agent 2"}' \
  http://127.0.0.1:8765/api/messages
curl -H "Authorization: Bearer $PHONE_AGENT_TOKEN" \
  'http://127.0.0.1:8765/api/messages?after=0'
~~~

## Optional: SIP softphones via self-hosted Asterisk

The included \`phone/provision.py\` additionally generates private
\`pjsip_agents.conf\` and \`extensions_agents.conf\`. These can be loaded into
a **locally installed, open-source Asterisk** server to enable traditional SIP
clients to call 2000–2999. Asterisk is **optional**, not a phone number
provider or cloud service. SIP requires configuring a PJSIP transport, network
access, and registering the clients with their \`sipPassword\`. This is
independent of the browser WebRTC interface (the two calling modes are **not**
interconnected).

~~~sh
python3 phone/provision.py --state-dir "$HOME/agent-phone-private" --count 1000
sudo apt update
sudo apt install asterisk
sudo install -o asterisk -g asterisk -m 0600 "$HOME/agent-phone-private/pjsip_agents.conf" /etc/asterisk/pjsip_agents.conf
sudo install -o asterisk -g asterisk -m 0644 "$HOME/agent-phone-private/extensions_agents.conf" /etc/asterisk/extensions_agents.conf
~~~

Add \`#include pjsip_agents.conf\` in \`/etc/asterisk/pjsip.conf\` and
\`#include extensions_agents.conf\` in \`/etc/asterisk/extensions.conf\` and
reload. Protect SIP with a private network/firewall. The generated dialplan
provides **internal extensions only** and deliberately has no route to a
carrier trunk. No public numbers or SMS are created.

## USB storage on Chromebook Linux

You can optionally keep the state directory on an **encrypted** Linux-mounted
USB drive. If ChromeOS shares a removable drive with Linux, it may appear
under \`/mnt/chromeos/removable/\`. **Do not place unencrypted API keys or SIP
passwords on an ordinary FAT/exFAT USB drive.** SQLite also requires reliable
filesystem locking, so prefer a Linux filesystem such as ext4, or keep the
live SQLite database on internal Linux storage and make encrypted backups
to the USB.

## Tests and limits

~~~sh
python3 -m unittest discover -s test -p 'test_phone*.py' -v
python3 -m py_compile phone/server.py phone/provision.py phone/mcp.py
~~~

Local HTTP integration tests exercised 1,000 persistent agents, distinct
tokens, account isolation, text messaging, SQL persistence and WebRTC
signaling, not 1,000 simultaneous calls. A browser audio end-to-end test
was attempted but the test environment blocked localhost browser access;
actual two-way WebRTC audio remains **unverified** until tested on your Linux
host. No outbound SMS/PSTN calls or third-party OTP receipt is included.

**Security notes:** never upload \`identities.json\`, SQLite files, generated
PJSIP configs, or API tokens to GitHub. The service binds to
\`127.0.0.1\` by default and requires TLS configuration to bind externally.
This simple server has no retention policy for message history; review
storage growth and backups for long-lived 1,000-agent deployments.
