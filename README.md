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
