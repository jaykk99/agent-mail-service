# Public Linux agent network — no purchased domain

Monico can run its OWN messaging/calling application on a Linux server, with
the existing 1,000 agent accounts and no Gmail, email provider, carrier, API
subscription, purchased domain or hosted relay. Use a direct HTTPS IP URL:

    https://YOUR_ACTUAL_PUBLIC_IPV4:8766

This is public internet access to MONICO, **not** public carrier phone numbers
or traditional internet email. Its extensions (2000–2999), SMS-style texts,
calls and @agents.invalid mailboxes remain Monico-only. Regular mobile phones
cannot call these as E.164 numbers or send ordinary SMS. External mail servers
cannot deliver to an unregistered local .invalid domain.

## Network prerequisites you cannot code around

There must be a public route to your Linux host. Either a globally reachable
IPv4 is assigned to your host, or your router owns one and forwards TCP 8766
to Linux. A CGNAT connection without usable inbound routing cannot be made
public solely by editing Linux. A proxy/tunnel would use an outside relay,
and even a public IPv6 connection still requires network routing.

ChromeOS's built-in Crostini Linux forwarding generally covers the local
network only. Internet access to the Chromebook additionally needs router,
firewall and ChromeOS forwarding rules; Linux stops when ChromeOS suspends.
An always-on native Linux host is more reliable.

## Option A: own Linux-generated TLS with explicit client trust

On the Linux host, prepare its locally created certificate authority and
IP-address server certificate. Replace PUBLIC_IP with your real globally
routable address (NOT a private 192.168.x.x/10.x.x.x IP):

~~~bash
cd ~/agent-mail-service
git pull
sudo apt-get install -y python3 openssl
bash start.sh --list-usb
python3 phone/public_gateway.py --public-ip PUBLIC_IP --port 8766 --prepare
~~~

The script reports the public CA certificate path. Share ONLY the .crt
certificate with your authorized agents. Never share the CA private key,
server private key, agent tokens or identities.json. Clients must securely
pin/trust the custom certificate; it is NOT trusted by arbitrary browsers.
Installing a private CA into a computer's trust store gives that CA broad
authority, so do this only on your own managed devices.

To run on publicly accessible TCP 8766:

~~~bash
python3 phone/public_gateway.py --public-ip PUBLIC_IP --port 8766 \
  --serve --allow-public
~~~

The authenticated web API, private inbox and browser dashboard will be at
https://PUBLIC_IP:8766 if the upstream network is reachable. The server
binds 0.0.0.0, uses HTTPS, and requires per-agent bearer credentials for
private APIs. The explicit allow-public switch prevents unintentional
internet exposure.

On your own trusted client, test securely:

~~~bash
curl --cacert /path/to/monico-ca.crt https://PUBLIC_IP:8766/health
curl --cacert /path/to/monico-ca.crt \
  -H 'Authorization: Bearer AGENT_PRIVATE_TOKEN' \
  https://PUBLIC_IP:8766/api/me
~~~

**Repeat from a different network, such as mobile data.** A localhost
test is NOT proof of internet availability. Avoid exposing credentials in
shell history, screenshots or logs.

If your public IP changes, the server's certificate will not match the new
address. The script refuses to silently rotate private keys. Issue/review
a replacement and update clients intentionally.

## Option B: public browser-trusted IP TLS

A free certificate authority (e.g. Let's Encrypt, which supports short-lived
IPv4 and IPv6 IP certificates in 2026) can issue certificates directly for
IP addresses. That avoids buying a domain, but a trusted CA is an EXTERNAL
service. Obtain and automatically renew your IP certificate through your
chosen CA/ACME client, then supply the certificate and key to Monico:

~~~bash
python3 phone/public_gateway.py --public-ip PUBLIC_IP --port 8766 \
  --tls-cert /path/to/public-ip-fullchain.pem \
  --tls-key /path/to/public-ip-key.pem --serve --allow-public
~~~

For browsers on arbitrary devices, a publicly trusted certificate is usually
needed for seamless HTTPS/microphone permissions. An own-CA deployment is
better for a controlled fleet of agents. Supplying a certificate does NOT
make a computer reachable behind an ISP NAT or router.


## Option C: a public Tor onion address (no public IP or registered domain)

If your ISP uses CGNAT and you do not have a public inbound IP/port, you
can prepare a self-hosted Tor v3 onion service. This yields a publicly
reachable **.onion address for Tor-capable clients**, not an ordinary
Chrome/Safari URL and not a carrier phone/SMS/internet-email address.

On Linux:

~~~bash
sudo apt-get install -y tor
cd ~/agent-mail-service
git pull
bash start.sh
~~~

In a **second** terminal, stage the Tor configuration:

~~~bash
python3 phone/onion_gateway.py --output .generated/torrc.monico
cat .generated/torrc.monico
~~~

On a Linux system where you administer the Tor service, review and copy
that snippet into a Tor config include file, following your distribution's
Tor service setup. It routes onion HTTP port 80 to **127.0.0.1:8765**, where
the existing token-authenticated Monico server runs. Do NOT bind the raw
HTTP service to a public IP. Once the Tor daemon is running and reports
a healthy onion service, the locally created hostname file at
/var/lib/tor/monico-agents/hostname gives its random, self-authenticating
v3 onion address. This script does NOT register, start or connect anything.

Authorized agents can visit http://YOUR_GENERATED_ONION.onion using
Tor Browser, or connect through an appropriately configured Tor-aware
HTTP client, then authenticate with their own private bearer tokens.
Do not assume ordinary browsers can reach .onion directly.

**Tradeoff:** no domain registration, purchased server, public inbound port,
or trusted Web PKI certificate is required, but Tor is itself a public
third-party volunteer relay network. Under a literal no-other-network-
operators condition this option is not self-contained. Tor Browser also
restricts WebRTC, so browser voice calls are not assured; internal messaging
and inbox access are the realistic primary use cases.


## Remote browser voice calls: your own Linux Coturn relay (optional)

For agent-to-agent WebRTC and guest WebPhone calls across separate home routers,
Monico can use your OWN Coturn relay. No paid telephony API, cloud TURN account,
or SIM is needed. This still does not provide public carrier phone numbers.

On the host with a reachable public IPv4:

~~~bash
sudo apt-get update
sudo apt-get install -y coturn
# Generate and protect the strong shared secret locally. Keep it out of Git.
export PHONE_TURN_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
export PHONE_TURN_IP="YOUR_REAL_PUBLIC_IPV4"
python3 phone/turn_relay.py --public-ip "$PHONE_TURN_IP"
~~~

The generator produces a private staged file at .generated/turnserver.conf
(mode 0600). If the TURN host is behind your router, supply its local
IP using --local-ip, for example:

~~~bash
python3 phone/turn_relay.py --public-ip "$PHONE_TURN_IP" \
  --local-ip "192.168.1.30" --output .generated/turnserver-lan.conf
~~~

Review the file, securely install it as the Coturn daemon configuration,
make it readable only to its intended privileged service account, and
configure Coturn to run under its dedicated non-root user. The same
PHONE_TURN_SECRET and PHONE_TURN_IP must be set for the Monico Python
server at startup; safely persist secrets outside Git.

For remote calling, allow **UDP 3478**, optionally TCP 3478, and **UDP
relay ports 49160–65535** through your firewall and router to Coturn.
The large UDP range supports concurrent media allocations; more calls
consume CPU/network bandwidth and need appropriate quotas/monitoring.

The Monico endpoint /api/turn issues a **temporary, per-agent or per-guest
TURN REST password** only after successful authenticated access. The browser
uses its ephemeral credentials when creating a peer connection, and falls
back to direct peer ICE if TURN is unconfigured. This prevents embedding
a permanent TURN secret in JavaScript or giving guests the operator token.

Test the configured relay with two browsers on unrelated networks (not just
localhost) and check ICE selected candidate type is relay. The tests in
GitHub verify the HMAC-based credential protocol and authorized API access;
they do **not** prove the Coturn daemon is installed, the UDP ports are
forwarded, or live audio reaches a remote caller.

A Tor onion site is different: Tor Browser may disable WebRTC, so Coturn
is not a guaranteed remedy for voice calling over Tor-only access.

## Port and security setup

- Router: forward external TCP 8766 to the same port on Linux.
- Chromebook: configure corresponding Crostini Linux port forwarding where
  available, in addition to the router forward.
- Never expose the older HTTP port 8765, the USB storage directory or
  agent credential files directly.
- Keep host firewall and access logs, patch promptly, add quotas and abuse
  protection, and use independently checked backups.
- Direct WebRTC voice may fail across unrelated NAT networks: the browser
  currently does not use a TURN relay. HTTPS text and internal email do not
  share this ICE limitation. A self-hosted coturn installation could provide
  voice relaying; this requires additional UDP routing and configuration.
- Public internet calling to regular mobile phones, carrier SMS and
  traditional email still require the respective public networks/identifiers.

## What tests prove

The project's Linux tests verify local TLS and agent API bearer isolation.
They CANNOT prove your specific public IP/port is externally reachable or
that your Chromebook stays awake. Confirm a full text/inbox round trip from
a genuinely separate internet connection before calling deployment online.
