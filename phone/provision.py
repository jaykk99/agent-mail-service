#!/usr/bin/env python3
"""Provision persistent, INTERNAL SIP extensions for up to 1000 AI agents.

This does not provision public telephone numbers, PSTN calling, or SMS.
"""
import argparse
import json
import os
import secrets
import tempfile
from pathlib import Path

BASE_EXTENSION = 2000
MAX_AGENTS = 1000


def atomic_write(path, data, mode=0o600):
    """Write a complete config atomically without exposing partial secrets."""
    fd, temporary = tempfile.mkstemp(prefix='.tmp-phone-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def provision(state_dir, count=1000):
    """Allocate stable 2000..2999 extension identities in a private directory."""
    if not isinstance(count, int) or not (1 <= count <= MAX_AGENTS):
        raise ValueError('count must be between 1 and 1000')
    state_dir = Path(state_dir).resolve()
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        os.chmod(state_dir, 0o700)
    except OSError as exc:
        raise RuntimeError('State directory must support private Unix permissions; use encrypted Linux storage') from exc

    identities_path = state_dir / 'identities.json'
    if identities_path.exists():
        data = json.loads(identities_path.read_text(encoding='utf-8'))
        if data.get('schema') != 1 or not isinstance(data.get('extensions'), dict):
            raise ValueError('Unrecognized identities.json; refusing to overwrite credentials')
        identities = data['extensions']
    else:
        identities = {}

    if len(identities) > count:
        raise ValueError('Refusing to reduce agent count and drop provisioned extensions')
    for index in range(count):
        extension = str(BASE_EXTENSION + index)
        if extension not in identities:
            identities[extension] = {
                'agentId': f'agent-{index + 1:04d}',
                'sipPassword': secrets.token_urlsafe(32),
            }
        item = identities[extension]
        if not isinstance(item, dict) or not item.get('agentId') or not item.get('sipPassword'):
            raise ValueError(f'Incomplete identity at extension {extension}; refusing to rotate it')
    if any(int(ext) < BASE_EXTENSION or int(ext) >= BASE_EXTENSION + count for ext in identities):
        raise ValueError('Identity store contains extensions outside the selected range')

    # Keep credentials only on the chosen private storage volume, never in git.
    atomic_write(identities_path, json.dumps({'schema': 1, 'extensions': identities}, indent=2) + '\n')

    pjsip = [
        '; Generated INTERNAL extensions. NOT real telephone numbers.\n',
        '; Include with #include /absolute/private/path/pjsip_agents.conf\n',
        '; Keep this file private: it contains SIP authentication secrets.\n\n',
    ]
    for ext, item in sorted(identities.items(), key=lambda pair: int(pair[0])):
        pjsip.extend([
            f'[{ext}]\n',
            'type=endpoint\n',
            'context=agents-internal\n',
            'disallow=all\n',
            'allow=ulaw,alaw\n',
            f'auth=auth-{ext}\n',
            f'aors=aor-{ext}\n',
            'direct_media=no\n',
            'force_rport=yes\n',
            'rewrite_contact=yes\n',
            'rtp_symmetric=yes\n\n',
            f'[auth-{ext}]\n',
            'type=auth\n',
            'auth_type=userpass\n',
            f'username={ext}\n',
            f'password={item["sipPassword"]}\n\n',
            f'[aor-{ext}]\n',
            'type=aor\n',
            'max_contacts=2\n',
            'remove_existing=yes\n\n',
        ])
    atomic_write(state_dir / 'pjsip_agents.conf', ''.join(pjsip))
    dialplan = (
        '; INTERNAL calls only. There is no dial-out route to the PSTN.\n'
        '[agents-internal]\n'
        'exten => _2XXX,1,NoOp(Internal AI-agent call ${CALLERID(num)} -> ${EXTEN})\n'
        ' same => n,Dial(PJSIP/${EXTEN},30)\n'
        ' same => n,Hangup()\n'
    )
    atomic_write(state_dir / 'extensions_agents.conf', dialplan, mode=0o644)
    return {'count': len(identities), 'state_dir': str(state_dir)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', default=os.environ.get('PHONE_STATE_DIR', './phone-data'),
                        help='Private data directory, optionally on mounted USB')
    parser.add_argument('--count', type=int, default=1000)
    args = parser.parse_args()
    result = provision(args.state_dir, args.count)
    print(f'Provisioned {result["count"]} private SIP extensions (2000-'
          f'{BASE_EXTENSION + result["count"] - 1}) in {result["state_dir"]}')
    print('These are INTERNAL numbers only; public calls/SMS need a carrier.')


if __name__ == '__main__':
    main()
