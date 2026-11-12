import type { RedisClient } from "bun";
import { redis } from "../../../../infrastructure/redis";
import type { ReaderView } from "../../domain/Reader";
import { readCachedReaderSearch, writeCachedReaderSearch, type CacheStatus } from "../../infrastructure/searchReaderCache";
import { searchReaders } from "./searchReaders";

/**
 * Cache-aside: procura no Redis; se não estiver lá, busca no Postgres e guarda.
 * A busca original continua igual, com 1 + N consultas (uma contagem de livros
 * por autor); é esse custo que o cache evita na segunda vez.
 */
export class searchReadersCached {
  constructor(private term: string, private client: RedisClient | null = redis) {}

  async search(): Promise<{ readers: ReaderView[]; cache: CacheStatus }> {
    const cached = await readCachedReaderSearch(this.term, this.client);
    if (cached?.readers) return { readers: cached.readers, cache: "HIT" };
    const readers = await searchReaders(this.term);
    if (!cached) return { readers, cache: "BYPASS" };
    await writeCachedReaderSearch(this.term, cached.generation, readers, this.client);
  return { readers, cache: "MISS" };
}
}