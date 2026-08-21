import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import apiApp from "./api/[...path].js";

const server = express();
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(rootDir, "public");
const port = Number(process.env.PORT || 3000);

server.disable("x-powered-by");
server.set("trust proxy", 1);
server.use(
  express.static(publicDir, {
    index: false,
    maxAge: 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "private, no-store, max-age=0");
      }
    },
  }),
);
server.get("/", (_req, res) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.sendFile(path.join(publicDir, "index.html"));
});
server.use(apiApp);

const listener = server.listen(port, "0.0.0.0", () => {
  console.log(`Parrillas escuchando en el puerto ${port}`);
});
const summerDayMaintenance = setInterval(() => {
  fetch(`http://127.0.0.1:${port}/api/discounts/summer-day/storefront`).catch(() => {});
}, 60_000);
summerDayMaintenance.unref();

function shutdown(signal) {
  console.log(`${signal}: cerrando Parrillas`);
  clearInterval(summerDayMaintenance);
  listener.close((error) => {
    process.exit(error ? 1 : 0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
