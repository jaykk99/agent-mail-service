"""Stage an HTTPS-only Nginx reverse proxy for the localhost Monico MCP server.

Does not install Nginx, issue TLS certificates, expose network ports, or turn
an un-delegated domain into a publicly reachable address.
"""
from pathlib import Path

try:
    from .generate_config import check_domain
except ImportError:
    from generate_config import check_domain


def render_nginx_mcp(domain, certificate, private_key, requests_per_second=10):
    domain = check_domain(domain)
    for path in (certificate, private_key):
        candidate = Path(path).expanduser().resolve()
        if any(char in str(candidate) for char in ('"', "\n", "\r", "\x00")):
            raise ValueError("Invalid certificate path")
    if (not isinstance(requests_per_second, int)
            or not 1 <= requests_per_second <= 100):
        raise ValueError("Rate must be between 1 and 100 requests per second")
    hostname = f"mcp.{domain}"
    certificate = str(Path(certificate).expanduser().resolve())
    private_key = str(Path(private_key).expanduser().resolve())
    return f"""# Monico: STAGED config, not installed. Add to Nginx http context via sites-enabled.
# Rate limiting is per source IP; adjust carefully for many agents behind shared NAT.
limit_req_zone $binary_remote_addr zone=monico_mcp:10m rate={requests_per_second}r/s;

server {{
    listen 80;
    server_name {hostname};
    return 301 https://$host$request_uri;
}}

server {{
    listen 443 ssl;
    server_name {hostname};
    ssl_certificate {certificate};
    ssl_certificate_key {private_key};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_tickets off;
    add_header Strict-Transport-Security "max-age=86400" always;
    add_header Cache-Control "no-store" always;
    client_max_body_size 1m;

    location /mcp {{
        limit_req zone=monico_mcp burst=30 nodelay;
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host 127.0.0.1;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }}

    location / {{
        return 404;
    }}
}}
"""
