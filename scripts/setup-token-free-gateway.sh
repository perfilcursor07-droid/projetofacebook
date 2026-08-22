#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOL_DIR="${TOKEN_FREE_GATEWAY_SOURCE_DIR:-${PROJECT_ROOT}/.tools/token-free-gateway}"
PATCH_FILE="${PROJECT_ROOT}/patches/token-free-gateway-production.patch"
SESSION_PATCH_FILE="${PROJECT_ROOT}/patches/token-free-gateway-session-portability.patch"
PINNED_REVISION="769399b720f2826038d91df4cb6b5236735c220c"
REPOSITORY="https://github.com/andeya/token-free-gateway.git"
MARKER_FILE="${TOOL_DIR}/.viralizeai-production-patch"
SESSION_MARKER_FILE="${TOOL_DIR}/.viralizeai-session-portability-v1"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Este instalador foi preparado para o servidor Linux/CloudPanel."
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "Git não encontrado. Instale-o antes de continuar."
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun não encontrado. Instalando no usuário atual com npm..."
  npm install --global bun
fi

BUN_BIN="$(command -v bun)"
echo "Bun: ${BUN_BIN} ($(${BUN_BIN} --version))"

if ! command -v google-chrome >/dev/null 2>&1 \
  && ! command -v google-chrome-stable >/dev/null 2>&1 \
  && ! command -v chromium >/dev/null 2>&1 \
  && ! command -v chromium-browser >/dev/null 2>&1; then
  echo "Google Chrome/Chromium não encontrado."
  echo "Instale o pacote .deb do Chrome como root e execute este comando novamente."
  exit 1
fi

if [[ ! -d "${TOOL_DIR}/.git" ]]; then
  mkdir -p "$(dirname "${TOOL_DIR}")"
  git clone "${REPOSITORY}" "${TOOL_DIR}"
  git -C "${TOOL_DIR}" checkout --detach "${PINNED_REVISION}"
elif [[ ! -f "${MARKER_FILE}" ]]; then
  if [[ -n "$(git -C "${TOOL_DIR}" status --porcelain)" ]]; then
    echo "A instalação existente possui alterações. Revise ${TOOL_DIR} antes de continuar."
    exit 1
  fi
  git -C "${TOOL_DIR}" fetch origin "${PINNED_REVISION}"
  git -C "${TOOL_DIR}" checkout --detach "${PINNED_REVISION}"
fi

if [[ ! -f "${MARKER_FILE}" ]]; then
  if git -C "${TOOL_DIR}" apply --check "${PATCH_FILE}"; then
    git -C "${TOOL_DIR}" apply "${PATCH_FILE}"
  elif ! git -C "${TOOL_DIR}" apply --reverse --check "${PATCH_FILE}"; then
    echo "Não foi possível aplicar o patch de produção do ViralizeAI."
    exit 1
  fi
  printf '%s\n' "${PINNED_REVISION}" > "${MARKER_FILE}"
fi

if [[ ! -f "${SESSION_MARKER_FILE}" ]]; then
  if git -C "${TOOL_DIR}" apply --check "${SESSION_PATCH_FILE}"; then
    git -C "${TOOL_DIR}" apply "${SESSION_PATCH_FILE}"
  elif ! git -C "${TOOL_DIR}" apply --reverse --check "${SESSION_PATCH_FILE}"; then
    echo "Não foi possível aplicar o patch de portabilidade da sessão do Claude."
    exit 1
  fi
  printf '%s\n' "applied" > "${SESSION_MARKER_FILE}"
fi

"${BUN_BIN}" install --cwd "${TOOL_DIR}" --frozen-lockfile
mkdir -p "${HOME}/.token-free-gateway"
chmod 700 "${HOME}/.token-free-gateway"

echo
echo "Gateway preparado em ${TOOL_DIR}."
echo "Agora importe auth-profiles.json em /claude e clique em Iniciar gateway."
