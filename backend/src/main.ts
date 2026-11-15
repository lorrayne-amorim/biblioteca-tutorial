import { loadSlices, prepareDatabase } from "./composition";
import { ready, redis } from "./infrastructure/redis";
import { refreshBookVectors, refreshDerivedDataOnConnect } from "./integration/derivedData";
import { createServer } from "./server";

await prepareDatabase();

const server = createServer(await loadSlices());

console.log(`Servidor executando em http://localhost:${server.port}`);

// o banco pode ter mudado enquanto o servidor estava parado: os vetores ficam no
// Postgres, então a reconciliação roda na subida, com ou sem Redis, em segundo plano
void refreshBookVectors();

// cada conexão ao Redis invalida o cache de autores, que pode ter ficado para trás
refreshDerivedDataOnConnect();
if (redis) void ready(redis).catch(() => console.warn("Redis indisponível: seguindo sem cache de autores"));
