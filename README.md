# Trendsplant Shopify Ordering App

Base inicial de una custom app para configurar y simular la estrategia de ordenación de PLP.

## Incluido

- Panel web de configuración.
- Colección objetivo, modo simulación/live y fallback.
- Pesos configurables para temperatura, país, ventas recientes, novedad y disponibilidad.
- Exclusiones de stock y conservación de productos fijados manualmente.
- Simulador de ranking por país y temperatura.
- Persistencia local en `data/strategy.json`.
- Endpoints preparados para conectar Shopify Admin GraphQL.
- Rutas iniciales de OAuth (`/auth/shopify` y `/auth/callback`).

## Ejecutar

```powershell
npm install
Copy-Item .env.example .env
npm start
```

Abrir `http://localhost:3000`.

## Siguiente integración

1. Completar OAuth y almacenamiento seguro de sesiones por tienda.
2. Conectar Admin GraphQL para leer colecciones/productos y aplicar reordenación.
3. Añadir theme app extension/app embed para ranking dinámico por visitante.
4. Añadir persistencia de snapshots y rollback real.
5. Añadir jobs programados y métricas de conversión.

## Deployment

La configuración está preparada para desplegarse como función Node.js en Vercel.

### Publicación del tema desde Shopify Admin

El panel incluye un control fijo para integrar `preview` en `main` del repositorio
`Trendsplant/tpshopify`. La credencial nunca se envía al navegador.

La opción recomendada es instalar una GitHub App privada solo en ese repositorio
y configurar en Vercel `GITHUB_THEME_APP_ID`,
`GITHUB_THEME_INSTALLATION_ID` y `GITHUB_THEME_APP_PRIVATE_KEY`. La app necesita
permisos `Contents: read/write` y `Pull requests: read/write`; sus tokens de
instalación caducan automáticamente.

El endpoint exige un ID token reciente de Shopify App Bridge y una lista
cerrada de usuarios. Configura `SHOPIFY_THEME_RELEASE_USER_IDS` con los IDs
numéricos permitidos, separados por comas. Opcionalmente,
`SHOPIFY_THEME_RELEASE_USERS_JSON` puede mapear esos IDs a nombres para la
auditoría, por ejemplo `{"72920924238":"Iván"}`. Si la lista no existe, la
publicación queda bloqueada para todos.

Como alternativa temporal, `GITHUB_THEME_RELEASE_TOKEN` acepta un token de
alcance fino con esos mismos permisos. El backend crea o reutiliza un pull
request, comprueba conflictos y solo entonces realiza un merge commit; nunca
hace force push.
