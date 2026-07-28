#!/bin/sh
set -eu

SKILL_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CODEX_ROOT=${CODEX_HOME:-"${HOME}/.codex"}
SKILLS_DIR="${CODEX_ROOT}/skills"
FORCE=${FORCE:-0}
SKIP_DEPENDENCIES=${SKIP_DEPENDENCIES:-0}
PARENT="netease-finance-topic-ops"
CHILDREN="mx-finance-search tencent-news wechat-article-search news-aggregator-skill toutiao-news-trends a-stock-analysis"

copy_skill() {
  source_path=$1
  destination=$2
  [ -f "${source_path}/SKILL.md" ] || { echo "Invalid skill source: ${source_path}" >&2; exit 1; }
  if [ -d "${destination}" ]; then
    source_real=$(CDPATH= cd -- "${source_path}" && pwd)
    destination_real=$(CDPATH= cd -- "${destination}" && pwd)
    [ "${source_real}" = "${destination_real}" ] && return 0
    case "${destination_real}" in "${SKILLS_DIR}"/*) ;; *) echo "Refusing to replace path outside skills directory" >&2; exit 1;; esac
    if [ "${FORCE}" = "1" ]; then
      rm -rf -- "${destination}"
      cp -R -- "${source_path}" "${destination}"
    else
      cp -R -- "${source_path}/." "${destination}/"
    fi
    return 0
  fi
  cp -R -- "${source_path}" "${destination}"
}

mkdir -p -- "${SKILLS_DIR}"
copy_skill "${SKILL_ROOT}" "${SKILLS_DIR}/${PARENT}"
BUNDLED="${SKILLS_DIR}/${PARENT}/assets/bundled-skills"
for name in ${CHILDREN}; do copy_skill "${BUNDLED}/${name}" "${SKILLS_DIR}/${name}"; done

if [ "${SKIP_DEPENDENCIES}" != "1" ]; then
  if [ -z "${PYTHON_EXECUTABLE:-}" ]; then
    command -v python3 >/dev/null 2>&1 || { echo "Python 3.10+ is required" >&2; exit 1; }
  fi
  "${PYTHON_EXECUTABLE:-python3}" -m pip install -r "${SKILLS_DIR}/${PARENT}/requirements-portable.txt"
  if [ -z "${NPM_EXECUTABLE:-}" ]; then
    command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 1; }
  fi
  (cd "${SKILLS_DIR}/wechat-article-search" && "${NPM_EXECUTABLE:-npm}" ci --omit=dev)
fi

echo "Installed parent skill and 6 child skills to ${SKILLS_DIR}"
echo "Configure credentials, restart Codex, load workspace dependencies, then run scripts/ensure_ready.py with the loaded runtime paths."
