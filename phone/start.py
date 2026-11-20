#!/usr/bin/env python3
"""Launch the self-hosted agent network with no Python dependencies.

Usage:
  python3 phone/start.py                 # runs local inbox/calls API
  python3 phone/start.py --mcp 2000      # MCP bridge for trusted local agent
  python3 phone/start.py --mcp agent-0002
"""
import argparse
import json
import os
from pathlib import Path
import sys
import threading
from urllib.error import URLError, HTTPError
from urllib.request import urlopen

from server import create_server

DEFAULT_DIR = Path.home() / '.local' / 'share' / 'agent-comms'
DEFAULT_URL = 'http://127.0.0.1:8765'


def read_token(state_dir, agent):
    identities = json.loads((state_dir / 'identities.json').read_text(encoding='utf-8'))['extensions']
    number = agent
    if agent.startswith('agent-'):
        number = next((ext for ext, info in identities.items() if info['agentId'] == agent), '')
    if number not in identities:
        raise ValueError('Unknown agent identity; use 2000 to 2999 or agent-0001 to agent-1000')
    return identities[number]['apiToken'], number


def running_service(url):
    try:
        with urlopen(url + '/health', timeout=1.5) as res:
            payload = json.load(res)
            return bool(payload.get('ok') and payload.get('internalOnly') and payload.get('agents') == 1000)
    except (OSError, URLError, HTTPError, ValueError):
        return False


def start():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', default=str(DEFAULT_DIR))
    parser.add_argument('--mcp', metavar='AGENT', help='Run MCP stdio tools for trusted local agent')
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    state = Path(args.state_dir).expanduser().resolve()
    url = 'http://127.0.0.1:' + str(args.port)
    server = None
    if not running_service(url):
        try:
            server = create_server(state, count=1000, host='127.0.0.1', port=args.port)
        except OSError as exc:
            parser.error('Cannot bind local server (port in use or Linux networking unavailable): ' + str(exc))
        if args.mcp:
            threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.2},
                             daemon=True).start()
        else:
            print(f'Agent Network ready: {url}', flush=True)
            print('1,000 internal phone extensions: 2000 to 2999', flush=True)
            print('1,000 internal inboxes: agent-0001@agents.invalid to agent-1000@agents.invalid', flush=True)
            print('Private agent tokens and local messages:', state, flush=True)
            print('Connect MCP for agent 2000 with: python3 phone/start.py --mcp 2000', flush=True)
            print('No real mobile numbers, carrier SMS, or public internet email routes.', flush=True)
            try:
                server.serve_forever(poll_interval=0.2)
            except KeyboardInterrupt:
                pass
            finally:
                server.server_close()
            return
    elif not args.mcp:
        print('Agent Network already listening at ' + url, flush=True)
        return

    try:
        # If another service is listening and we didn't start it ourselves,
        # provisioning must already have created this identities.json.
        # Avoid rotating keys or leaking secrets to MCP stdout.
        token, number = read_token(state, args.mcp)
        os.environ['PHONE_URL'] = url
        os.environ['PHONE_AGENT_TOKEN'] = token
        # MCP messages require stdout to contain only JSON protocol frames.
        import mcp
        mcp.API = url
        mcp.TOKEN = token
        mcp.main()
    except (ValueError, FileNotFoundError, KeyError) as exc:
        print('MCP initialization failed: ' + str(exc), file=sys.stderr)
        raise SystemExit(2)
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    start()
