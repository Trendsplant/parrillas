Exit code: 0
Wall time: 1.3 seconds
Output:
# Trendsplant Shopify Ordering App

Base inicial de una custom app para configurar y simular la estrategia de ordenaciÃ³n de PLP.

## Incluido

- Panel web de configuraciÃ³n.
- ColecciÃ³n objetivo, modo simulaciÃ³n/live y fallback.
- Pesos configurables para temperatura, paÃ­s, ventas recientes, novedad y disponibilidad.
- Exclusiones de stock y conservaciÃ³n de productos fijados manualmente.
- Simulador de ranking por paÃ­s y temperatura.
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

## Siguiente integraciÃ³n

1. Completar OAuth y almacenamiento seguro de sesiones por tienda.
2. Conectar Admin GraphQL para leer colecciones/productos y aplicar reordenaciÃ³n.
3. AÃ±adir theme app extension/app embed para ranking dinÃ¡mico por visitante.
4. AÃ±adir persistencia de snapshots y rollback real.
5. AÃ±adir jobs programados y mÃ©tricas de conversiÃ³n.

