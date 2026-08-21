# Migración de Parrillas a la VPS

## 1. DNS previo

Crea un registro `A` para `parrillas.trendsplant.com` apuntando a la IP de la
VPS. Durante el corte usa un TTL de 300 segundos. Si Cloudflare actúa como
proxy, Parrillas aprovechará `CF-IPCountry` para conservar la señal de país.

## 2. Preparar Ubuntu 24.04

Desde una cuenta con `sudo`, ejecuta:

```bash
sudo bash ./scripts/bootstrap-ubuntu.sh deploy
```

PostgreSQL no publica ningún puerto. Solo Caddy expone 80/443 y obtiene el
certificado TLS automáticamente.

## 3. Configurar secretos

```bash
cd /opt/parrillas
cp .env.example .env
chmod 600 .env
nano .env
```

Genera `POSTGRES_PASSWORD` y `SESSION_SECRET` con al menos 32 caracteres
aleatorios. Copia desde
Vercel los valores Shopify y GitHub sin imprimirlos en terminal ni guardarlos
en Git. `GITHUB_THEME_APP_PRIVATE_KEY` debe usar saltos de línea escapados como
`\n` para ocupar una sola línea del archivo.

## 4. Primer arranque

```bash
bash ./scripts/deploy.sh
curl --fail --silent https://parrillas.trendsplant.com/api/health
```

## 5. Base de datos local

El primer arranque inicializa PostgreSQL 18 vacío en la VPS. No existe ninguna
conexión ni dependencia de una base de datos externa. Al no importar el estado
anterior, vuelve a autenticar Shopify después del corte para guardar un token
nuevo y reconstruir la configuración de Parrillas.

## 6. Shopify

Actualiza la URL de la aplicación y sus redirecciones permitidas:

- Aplicación: `https://parrillas.trendsplant.com`
- OAuth callback: `https://parrillas.trendsplant.com/api/auth/callback`
- Webhook: `https://parrillas.trendsplant.com/api/webhooks/orders-create`

Publica el contenido actualizado de `public/storefront-snippet.liquid` en el
tema y valida login, lectura de productos, simulación y aplicación real.

## 7. Backups

El timer `parrillas-backup.timer` ejecuta diariamente
`scripts/backup-postgres.sh`. Comprueba su siguiente ejecución con:

```bash
systemctl list-timers parrillas-backup.timer
```

Los dumps locales se conservan 14 días por defecto. Debe existir además una
copia cifrada fuera de la VPS.

## 8. Rollback

Conserva el deployment de Vercel sin modificar durante al menos 72 horas. Si
falla el corte, restaura temporalmente el snippet/dominio anterior y vuelve a
utilizar el deployment de Vercel.

