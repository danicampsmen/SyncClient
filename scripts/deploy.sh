#!/usr/bin/env bash
set -euo pipefail

APP_NAME="syncclient"
APP_DIR="/opt/${APP_NAME}"
SERVICE_NAME="${APP_NAME}.service"
USER="www-data"
GROUP="www-data"

echo "==> Instalando SyncClient backend en ${APP_DIR}..."

# Crear directorio
sudo mkdir -p "${APP_DIR}"
sudo chown -R "${USER}:${GROUP}" "${APP_DIR}"

# Copiar archivos de deploy
sudo cp deploy/${SERVICE_NAME} /etc/systemd/system/
sudo cp deploy/Caddyfile /opt/${APP_NAME}/Caddyfile
# Si usas nginx en vez de Caddy:
# sudo cp deploy/nginx.conf /etc/nginx/sites-available/${APP_NAME}
# sudo ln -sf /etc/nginx/sites-available/${APP_NAME} /etc/nginx/sites-enabled/
# sudo rm -f /etc/nginx/sites-enabled/default

echo "==> Construyendo frontend y backend..."
npm run build

echo "==> Moviendo artefactos..."
sudo cp -r dist/* "${APP_DIR}/"
sudo cp server.mjs "${APP_DIR}/" 2>/dev/null || true
sudo cp package.json "${APP_DIR}/" 2>/dev/null || true
sudo cp .env.example "${APP_DIR}/" 2>/dev/null || true

# Permisos
sudo chown -R "${USER}:${GROUP}" "${APP_DIR}"
sudo chmod -R 755 "${APP_DIR}"

echo "==> Instalando dependencias de producción..."
cd "${APP_DIR}"
sudo -u "${USER}" npm install --production

echo "==> Configurando firewall..."
sudo ufw allow 80/tcp || true
sudo ufw allow 443/tcp || true

echo "==> Habilitando y arrancando servicios..."
sudo systemctl daemon-reload
sudo systemctl enable --now ${SERVICE_NAME}

# Si usas nginx:
# sudo systemctl enable --now nginx
# sudo nginx -t && sudo systemctl reload nginx

# Si usas Caddy:
sudo systemctl enable --now caddy

echo "==> Instalación completada."
echo "Backend corriendo en http://127.0.0.1:3000 (interno)"
echo "Acceso público: https://sync.tudominio.com"
echo ""
echo "Edita ${APP_DIR}/.env antes de usar:"
echo "  CORS_ORIGIN=https://sync.tudominio.com"
echo "  HOST=127.0.0.1"
echo ""
