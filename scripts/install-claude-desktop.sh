#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Este instalador deve ser executado no servidor Linux."
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Execute como root: sudo bash scripts/install-claude-desktop.sh"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y xvfb x11vnc novnc websockify openbox dbus-x11

for binary in /usr/bin/Xvfb /usr/bin/x11vnc /usr/bin/websockify /usr/bin/openbox; do
  if [[ ! -x "${binary}" ]]; then
    echo "Instalação incompleta: ${binary} não foi encontrado."
    exit 1
  fi
done

echo
echo "Desktop do Claude instalado."
echo "Agora volte ao usuário viralizeai e execute:"
echo "  cd /home/viralizeai/htdocs/www.viralizeai.online"
echo "  npm run claude-desktop:start"
echo "  pm2 startOrReload ecosystem.config.cjs --only viralizeai --update-env"
echo "  pm2 save"
