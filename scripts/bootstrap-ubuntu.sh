#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Ejecuta este script como root: sudo $0 <usuario-deploy>" >&2
  exit 2
fi

deploy_user="${1:-}"
if [[ -z "$deploy_user" ]] || ! id "$deploy_user" >/dev/null 2>&1; then
  echo "Uso: sudo $0 <usuario-deploy-existente>" >&2
  exit 2
fi

apt-get update
apt-get install -y ca-certificates curl fail2ban ufw unattended-upgrades
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

# shellcheck disable=SC1091
source /etc/os-release
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker fail2ban unattended-upgrades
usermod -aG docker "$deploy_user"

install -d -m 0750 -o "$deploy_user" -g "$deploy_user" /opt/parrillas

ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

echo "VPS preparada. Cierra y vuelve a abrir la sesión de $deploy_user para activar el grupo docker."

