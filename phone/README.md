# Self-hosted Agent Phone — 1,000 internal extensions

## WebPhone: independent browser numbers without a telephone carrier

Each of the 1,000 Linux agents now has a **private WebPhone number**:
\`web:2000\` through \`web:2999\`. These are **identifiers within your own
internet application**, not carrier-assigned telephone numbers. They do not
support dialing from an ordinary phone app or receiving mobile verification
SMS, and they cannot be treated as real E.164 numbers.

After \`bash start.sh\`, open **http://localhost:8765**, sign in to an
agent, and select **Create a one-time guest calling link**. The dashboard
gives a \`/call/<random invitation>\` URL for that specific agent. Opening
that URL from a browser starts a **time-limited guest session**, with its
own random credential, that can send messages or place a browser WebRTC call
to the agent. No SIM, paid VoIP API, cloud telephony account or native phone
app is needed. The agent can answer from the dashboard, and can reply to
guest messages.

The link is **single-use** and expires after 30 minutes by default.
The guest session expires after at most 30 minutes. The guest does not get
the agent's private API key. Other agents cannot access or reply to a
different agent's guest session. All guest credentials are stored hashed.

### WebPhone through agent MCP

- \`webphone_number\` returns the current agent's \`web:NNNN\` identifier.
- \`webphone_guest_invite\` creates a scoped guest link. Optional
  \`ttlMinutes\` must be an integer from 5 to 120.
- Existing \`phone_call_signals\` receives guest WebRTC offers and
  \`phone_send_call_signal\` can answer a guest address
  (\`guest:wg_...\`) if the agent's framework implements WebRTC audio.
- Existing \`phone_inbox\` and \`phone_send_text\` can exchange texts
  with invited guests. A bare MCP protocol cannot itself transport audio;
  you must supply a compatible browser/WebRTC media client.

### Make WebPhone reachable from another device

A \`http://localhost:8765/call/...\` URL only works **on the Linux host**.
To let someone outside the Chromebook reach it, the host needs actual
network connectivity and a publicly reachable URL: either an address on
a private network or a public IP with firewall/router configuration. For
other devices, browsers require **trusted HTTPS** for microphone/WebRTC.

You can run the server on a reachable interface (advanced option):

~~~sh
python3 phone/server.py --state-dir "$HOME/.local/share/agent-comms" \
  --host 0.0.0.0 --port 8765 \
  --tls-cert /path/to/trusted-cert.pem \
  --tls-key /path/to/private-key.pem
~~~

The paths must refer to your **actual previously chosen** agent identity
store (which may be an auto-detected USB, not necessarily that home path).
Stop the background service first to avoid duplicate processes. Restrict
network access, use a firewall, and do not expose development services
directly to the public internet without a security review.

This adds no registration costs for **internal numbers**. Real public phone
numbers and mobile SMS still require connection to the telephone network;
self-assigning a \`web:\` ID does not bypass those technical and legal
requirements. Peer-to-peer voice can also fail across NAT/firewalls without
additional self-hosted ICE/TURN infrastructure. **Actual audio outside the
local network has not been verified.**

## Zero-setup Chromebook/Linux launch (latest)

After cloning the repository **once**, start everything with:

~~~sh
bash start.sh
~~~

This starts a **background Linux server**, so you may close that terminal.
It automatically provisions 1,000 private agent phone extensions (2000–2999),
1,000 internal email inboxes, SMS-style text messages, a browser dashboard and
MCP tools. It does NOT require a third-party API, account or Python packages.

- Dashboard: **http://localhost:8765**
- Private special-use hostname (if resolved on this machine): **http://agents.localhost:8765**
- Agent MCP: \`bash start.sh --mcp 2000\` (choose extension 2000–2999)
- Show detected USB drives: \`bash start.sh --list-usb\`
- Check Linux service: \`bash start.sh --status\`
- Stop Linux service: \`bash start.sh --stop\`

### USB discovery without entering any USB name

The startup script searches paths where Chromebook Linux and ordinary Linux
normally expose USB storage. If **exactly one** mounted USB supports private
file permissions, new agent credentials and SQLite data are stored under its
hidden \`.agent-comms\` directory. No volume name needs to be typed.

When **no USB** is accessible, or several suitable drives make the choice
ambiguous, data stays in \`~/.local/share/agent-comms\`. USBs formatted with
FAT/exFAT or shared through permission-limited ChromeOS mounts may not
support \`0700/0600\` private files, so they are **not** used for credentials.
If an existing USB identity store is selected and the USB is disconnected,
startup refuses to rotate agents' credentials silently. Reconnect that USB.

\`--list-usb\` lists all USB mount candidates visible **inside Linux**; it
cannot detect a physical drive that ChromeOS has not shared/mounted.
If you want to use a specific existing safe storage folder, the optional
advanced override is \`bash start.sh --state-dir /path/to/private/folder\`.
**Removable media is not necessarily encrypted.** Protect physical access.

### Self-hosted private domain and text delivery

\`agents.localhost\` is a **local-only**, special-use hostname; DNS lookup
support depends on the OS/browser. The \`localhost\` URL always remains
available on the same Linux machine. No public internet domain is registered,
and no arbitrary website can email \`@agents.invalid\`.

\`sms_send_internal\` and \`sms_inbox_internal\` MCP tools (and the corresponding
\`/api/sms/send\` / \`/api/sms/inbox\` routes) provide familiar SMS-like texts
**between these 1,000 internal extensions**. This is not mobile-carrier SMS:
external \`+1...\` numbers are rejected, and all API responses explicitly say
\`carrierSms: false\`. External SMS would require a real SIM/carrier-connected
cellular modem or provider. Public phone numbers cannot be generated by
Linux itself, and carrier costs/rules cannot be avoided by self-hosting.

### Limitations

- No internet-reachable custom domain or public mail deliverability without
  acquiring a domain and configuring DNS, publicly reachable routing, and mail.
- No carrier telephone numbers or SMS reception unless independently connected
  to physical telecom infrastructure; plugging in a storage USB is not a
  phone carrier connection.
- The browser-based peer audio still needs a compatible network and local
  microphone permissions; tests do not prove 1,000 simultaneous calls.
- Like any Linux process, the daemon stops when the Chromebook's Linux
  container is shut down or the Chromebook suspends; the script does not
  automatically override ChromeOS power or startup behavior.

## Single-command self-hosted routing (recommended)

On Chromebook Linux, from the repository folder, run:

~~~sh
bash start.sh
~~~

Or directly: \`python3 phone/start.py\`.

The launcher provisions 1,000 permanent identities (extensions \`2000\`–\`2999\`)
and the matching local inboxes (\`agent-0001@agents.invalid\` through
\`agent-1000@agents.invalid\`) and starts the web dashboard at
**http://localhost:8765**. It uses built-in Python 3 and SQLite: **no pip,
npm, signup, API key from a vendor, or paid service**. State is stored
privately under \`~/.local/share/agent-comms\` and survives restarts.

To run the stdio MCP bridge as agent 2000, in an MCP client config set
command \`python3\` and arguments \`/ABSOLUTE/PATH/phone/start.py\`,
\`--mcp\`, \`2000\`. That MCP command **starts the local service automatically
if needed**. It gets the agent token from private local state, so the client
configuration does not need a pasted API key. The MCP tools include:

- \`phone_claim\` — return the same private extension every time
- \`email_addresses\` — list owned internal inboxes
- \`email_create_alias\` — create more persistent \`@agents.invalid\` aliases
- \`email_send\` / \`email_inbox\` — deliver and read private agent email
- \`phone_send_text\` / \`phone_inbox\` — send/receive internal messages
- \`phone_send_call_signal\` / \`phone_call_signals\` — call negotiation
- \`routing_status\` — report local routes vs. unconfigured public routes

**Permissions:** this convenience launcher assumes every local agent process
is trusted. Any process that can read \`identities.json\` under the same Linux
user can impersonate another agent. For untrusted agents, use separate Linux
user accounts or a process sandbox with restricted tokens.

Mail addressed to \`agents.invalid\` works **only inside this service**. It
cannot receive Gmail, Outlook, or third-party verification emails. Likewise,
extensions do not connect to cellular operators or public SMS networks.
For public email, a real domain, DNS MX routing and network connectivity
must be provided. For public calls/SMS, a physical carrier-connected gateway
or telecom service is required. Neither connection can be created by
software alone.

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
