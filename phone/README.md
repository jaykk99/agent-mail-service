# Internal phones for 1,000 AI agents — feasibility prototype

**Supported:** 1,000 stable, private SIP extensions (2000–2999) for calling
between registered SIP clients on **your own Asterisk server**. The provisioning
script works offline, uses Python's standard library, and costs nothing to
license. Credentials and generated configs can live on USB storage.

**Not supported:** 1,000 public Canadian phone numbers, carrier SMS, receiving
third-party verification texts, PSTN calls, voicemail, or an MCP API. These
need additional providers, software, or integrations. Do **not** use the
internal extensions as signup/verification numbers.

## 1. Provision on Chromebook Linux or another Linux machine

From the repository root:

```bash
python3 phone/provision.py --state-dir "$HOME/agent-phone-private" --count 1000
python3 -m unittest discover -s test -p 'test_phone.py' -v
```

To use a USB drive **with private Unix filesystem permissions**, replace the
state directory with the actual mounted path shared with Chromebook Linux
(e.g. a suitable path under `/mnt/chromeos/removable/`). Protect the USB:
it will hold reusable SIP passwords. FAT/exFAT and unencrypted removable
drives may not protect secrets adequately. An encrypted Linux volume is
preferable.

The command creates:

- `identities.json`: each `agent-0001` … `agent-1000`, extension,
  and random SIP password. This file must remain private.
- `pjsip_agents.conf`: Asterisk PJSIP endpoints, auth, and contacts.
- `extensions_agents.conf`: local extension-to-extension call routing.

Re-running with the same state directory **preserves** existing numbers and
passwords; do not delete it. The default sequence allocates 2000 to
`2000 + count - 1`. Provisioning `count=1000` creates 1,000 credentials,
**not** a test of 1,000 concurrent phone calls.

## 2. Install Asterisk and load the internal dialplan

Install Asterisk on a compatible Debian Linux host:

```bash
sudo apt update
sudo apt install asterisk
```

After provisioning, make copies accessible only to Asterisk's service user
(adjust the service user/group if your distribution uses different ones):

```bash
PRIVATE_DIR="$HOME/agent-phone-private"
sudo install -o asterisk -g asterisk -m 0600 "$PRIVATE_DIR/pjsip_agents.conf" /etc/asterisk/pjsip_agents.conf
sudo install -o asterisk -g asterisk -m 0644 "$PRIVATE_DIR/extensions_agents.conf" /etc/asterisk/extensions_agents.conf
```

Add these two lines once to the **respective** main Asterisk config files:

```text
# /etc/asterisk/pjsip.conf
#include pjsip_agents.conf
# /etc/asterisk/extensions.conf
#include extensions_agents.conf
```

Then reload Asterisk if it is running:

```bash
sudo asterisk -rx "pjsip reload"
sudo asterisk -rx "dialplan reload"
sudo asterisk -rx "pjsip show endpoints"
```

An existing PJSIP transport must be configured separately. For any remote
clients, use an access-controlled VPN and review firewall, NAT, RTP, TLS,
registration limits, and rate limits. **Do not publicly expose SIP on
Chromebook Linux by opening 5060/UDP** without a hardened telephony setup.
ChromeOS Linux may require additional network forwarding; a USB drive does
not provide public network reachability.

## 3. How an agent uses its extension

A SIP softphone/agent voice gateway registers to your Asterisk server using:

- **Username:** e.g. `2000`
- **Password:** the `sipPassword` for extension `2000` in `identities.json`
- **Server:** your private Asterisk server reachable by the SIP client

The agent at `2000` can dial `2001`, and so on. Asterisk handles **voice
calls**, not text-message inboxes. Agent text messaging would require a
separate authenticated API/MCP service and storage. The generated `agentId`
identities are placeholders; integrating with the existing Agent Mail Service
account IDs and API keys is a separate follow-up task.

The dialplan intentionally has **no external calling route**. Do not add an
unrestricted public SIP trunk: that creates expensive toll-fraud risk.

## 4. If real public phone numbers are required

Public PSTN numbers and carrier SMS cannot be minted by self-hosting an
Asterisk server. A provider must lease/route them. You can connect **one**
purchased DID to the PBX and forward calls internally to many agents, or
purchase separate DIDs where each agent truly needs an externally reachable
number. With SMS, carriers and websites may restrict automated traffic,
verification delivery and virtual-number support.

For an initial proof-of-concept, **test two internal extensions** using a
softphone. Only after successful registration, two-way audio, restart
persistence and firewall verification should you scale to 1,000 accounts.

## Prototype boundaries

- Tested automatically: 1,000 unique, persistent SIP passwords, generated
  PJSIP/dialplan configuration, permissions, and count validation.
- **Not** tested here: live Asterisk deployment, Chromebook inbound network
  forwarding, two-way audio, 1,000 simultaneous calls, or real SMS delivery.
- No third-party account verification bypass or bulk signup features are
  provided.
