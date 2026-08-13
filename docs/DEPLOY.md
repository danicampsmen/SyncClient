# Deploy de SyncClient Backend en Producción

Guía para exponer el backend de SyncClient a internet y usar la app Android/Desktop desde cualquier lugar.

## Requisitos

- Servidor Linux con acceso SSH (VPS, casa, cloud)
- Dominio apuntando al servidor (ej: `sync.tudominio.com`)
- Node.js >= 18
- npm
- (Opcional) Caddy o nginx como proxy reverso con HTTPS

## Opción A: Caddy (recomendado, auto-HTTPS)

### 1) Instalar Caddy
```bash
sudo apt update && sudo apt install -y caddy
```

### 2) Copiar archivos
```bash
sudo mkdir -p /opt/syncclient
sudo chown -R $USER:$USER /opt/syncclient
cp -r dist server.mjs package.json .env.example /opt/syncclient/
cp deploy/Caddyfile /opt/syncclient/Caddyfile
```

### 3) Configurar variables
```bash
cd /opt/syncclient
cp .env.example .env
nano .env
```

Contenido mínimo:
```env
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
CORS_ORIGIN=https://sync.tudominio.com
```

### 4) Instalar dependencias y crear servicio systemd
```bash
cd /opt/syncclient
npm install --production
sudo cp deploy/syncclient.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now syncclient.service
```

### 5) Iniciar Caddy
```bash
sudo systemctl enable --now caddy
```

Caddy detectará el Caddyfile en `/opt/syncclient/Caddyfile` si lo configurás, o podés ponerlo en `/etc/caddy/Caddyfile`.

### 6) Verificar
```bash
curl -k https://sync.tudominio.com/api/health
```

## Opción B: nginx + certbot

### 1) Instalar nginx y certbot
```bash
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
```

### 2) Configurar sitio
```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/syncclient
sudo ln -sf /etc/nginx/sites-available/syncclient /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### 3) Obtener certificado SSL
```bash
sudo certbot --nginx -d sync.tudominio.com
```

### 4) Seguir pasos 2-4 de la Opción A (copiar archivos, configurar .env, crear servicio)

## Configurar la app

### Android
Rebuild apuntando al dominio público:
```bash
VITE_BACKEND_URL=https://sync.tudominio.com npm run android:open
```

### Desktop (Electron)
El backend por defecto usa `127.0.0.1` porque Electron corre en la misma máquina. Si accedés desde otra red, podés setear:
```bash
VITE_BACKEND_URL=https://sync.tudominio.com npm run electron:dev
```

## OAuth Google Cloud Console

Registrá estos redirect URIs en tu proyecto de Google Cloud:

- Desarrollo local:
  - `http://127.0.0.1:3000/api/oauth/callback`

- Producción:
  - `https://sync.tudominio.com/api/oauth/callback`

## Logs

```bash
# Backend
journalctl -u syncclient.service -f

# Caddy
journalctl -u caddy -f

# nginx
journalctl -u nginx -f
```

## Notas

- El backend escucha en `127.0.0.1:3000` internamente. El proxy reverso (Caddy/nginx) expone HTTPS al público.
- No expongas el puerto 3000 directamente a internet sin TLS.
- Los archivos subidos se almacenan en `~/.config/syncclient` por defecto. Para cambiar la ruta, configurá `CONFIG_DIR` en el `.env`.
