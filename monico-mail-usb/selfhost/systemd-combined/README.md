# Combined systemd units for the wired stack (templates, review before use)
#
# Copy to /etc/systemd/system/, edit the User=, WorkingDirectory= and
# EnvironmentFile= lines in each file, then:
#   sudo systemctl daemon-reload
#   sudo systemctl enable --now agent-mail-phone agent-mail-api calling-linux
#
# Files:
#   agent-mail-phone.service  internal extensions 2000-2999, :8765
#   agent-mail-api.service    mail API + SMTP, :3000 / :2525
#   calling-linux.service     dashboard + SIP + SMTP, :3001 / :5060 / :2526
#
# Secrets (AGENT_MAIL_TOKEN, TURN secret, MAIL_DOMAIN) live in the
# EnvironmentFile of each checkout (mode 0600), never in these units.
# Services run as an unprivileged user, never root.
