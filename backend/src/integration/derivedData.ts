import type { RedisClient } from "bun";
import { redis } from "../infrastructure/redis";
import { invalidateAuthorSearch } from "../modules/authorship";
import { reconcileBookIndex } from "../modules/catalog";
import { catalogIntegration } from "./catalogIntegration";

/**
 * Os vetores dos livros moram no Postgres, mas podem ter ficado para trás: o seed
 * escreve direto nas tabelas, ou o Gemini estava fora quando um livro foi salvo.
 * Não depende do Redis: roda na subida do servidor e depois de cada seed.
 */
export async function refreshBookVectors(): Promise<void> {
  const { indexed } = await reconcileBookIndex(catalogIntegration);
  console.log(`Índice semântico: ${indexed} livro(s) indexado(s)`);
}

/**
 * Recalcula tudo o que é derivado do Postgres, a fonte da verdade: o cache de
 * autores, no Redis, e os vetores dos livros, no próprio Postgres.
 */
export async function refreshDerivedData(): Promise<void> {
  await invalidateAuthorSearch();
  await refreshBookVectors();
}

/**
 * Enquanto o Redis esteve fora, as escritas no Postgres continuaram, mas não
 * conseguiram invalidar o cache de autores. Por isso cada conexão (a primeira e
 * cada reconexão automática) invalida esse cache. Os vetores não entram aqui:
 * eles não estão no Redis, então uma reconexão não os deixa desatualizados.
 */
export function refreshDerivedDataOnConnect(client: RedisClient | null = redis, refresh = () => invalidateAuthorSearch(client)): void {
  if (!client) return;
  client.onconnect = () => { void refresh(); };
}
