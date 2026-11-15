import type { TransactionSQL } from "bun";
import { embedder as defaultEmbedder } from "../../../infrastructure/embedder";
import { sql } from "../../../infrastructure/postgres";
import type { Embedder } from "../../../shared/Embedder";
import type { CatalogIntegration } from "../domain/CatalogIntegration";

/**
 * Vetores dos livros no próprio Postgres, com o pgvector. Cada livro tem uma
 * linha em `livros_vetores` com o texto indexado, o modelo que gerou o vetor e o
 * vetor; o índice HNSW acha os vizinhos mais próximos de uma consulta. Tudo aqui
 * é derivado de `livros`: a tabela pode ser apagada e reconstruída a qualquer momento.
 */
const TABLE = "livros_vetores";

/** O limite do índice HNSW para o tipo vector. */
const MAX_DIMENSIONS = 2000;

/** Lock próprio da DDL dos vetores: não pode ser o 22001, senão para as escritas. */
const ENSURE_LOCK = 22024;

export type IndexResult = { indexed: number };

/** O formato de texto do pgvector: "[0.9,0.1,0]". */
function toVectorLiteral(vector: Float32Array): string {
  return `[${Array.from(vector).join(",")}]`;
}

/** A dimensão de `embedding` na tabela que existe hoje, ou null se ela não existe. */
async function currentDimensions(db: TransactionSQL): Promise<number | null> {
  const [row] = await db`
    SELECT format_type(atttypid, atttypmod) AS type
    FROM pg_attribute
    WHERE attrelid = to_regclass(${TABLE}) AND attname = 'embedding'
  ` as { type: string }[];
  const match = row?.type.match(/^vector\((\d+)\)$/);
  return match ? Number(match[1]) : null;
}

/**
 * Garante que a tabela existe para este embedder e diz se precisou criá-la.
 * Vetores de outro modelo não se comparam com os deste: trocar de modelo (ou de
 * dimensão) apaga a tabela e começa de novo, como o FT.DROPINDEX … DD do Redis.
 */
export async function ensureBookVectors(embedder: Embedder): Promise<boolean> {
  const n = embedder.dimensions;
  // a dimensão vai crua para a DDL (parâmetro não vale em tipo): só passa número válido
  if (!Number.isInteger(n) || n < 1 || n > MAX_DIMENSIONS) {
    throw new Error(`Dimensão inválida para o pgvector: ${n}`);
  }
  return await sql.begin(async (tx) => {
    // duas requisições ao mesmo tempo não podem apagar e criar a tabela juntas
    await tx`SELECT pg_advisory_xact_lock(${ENSURE_LOCK})`;
    const dimensions = await currentDimensions(tx);
    if (dimensions === n) {
      const [other] = await tx`SELECT 1 FROM livros_vetores WHERE modelo <> ${embedder.id} LIMIT 1`;
      if (!other) return false;
    }
    await tx`DROP TABLE IF EXISTS livros_vetores`;
    await tx.unsafe(`
      CREATE TABLE livros_vetores (
        livro_id INTEGER PRIMARY KEY REFERENCES livros(id) ON DELETE CASCADE,
        modelo TEXT NOT NULL,
        texto TEXT NOT NULL,
        embedding vector(${n}) NOT NULL
      )`);
    await tx`CREATE INDEX livros_vetores_embedding_idx ON livros_vetores USING hnsw (embedding vector_cosine_ops)`;
    return true;
  }) as boolean;
}

/** O que o modelo lê de cada livro: o título e, para dar contexto, o autor. */
function indexText(title: string, authorName: string | undefined): string {
  return authorName ? `${title} — ${authorName}` : title;
}

async function syncIds(ids: number[], integration: CatalogIntegration, embedder: Embedder | null): Promise<IndexResult & { created: boolean }> {
  const result = { indexed: 0, created: false };
  const unique = [...new Set(ids)];
  // livro excluído não precisa de nada: o ON DELETE CASCADE levou o vetor junto
  if (!embedder || unique.length === 0) return result;

  result.created = await ensureBookVectors(embedder);
  const rows = await sql`SELECT id, titulo AS title, autor_id AS "authorId" FROM livros WHERE id IN ${sql(unique)}` as { id: number; title: string; authorId: number }[];
  if (rows.length === 0) return result;

  const stored = await sql`SELECT livro_id AS id, texto AS text FROM livros_vetores WHERE livro_id IN ${sql(rows.map((row) => row.id))}` as { id: number; text: string }[];
  const storedText = new Map(stored.map((row) => [row.id, row.text]));
  const pending: { id: number; text: string }[] = [];
  for (const row of rows) {
    const text = indexText(row.title, (await integration.author(sql, row.authorId))?.name);
    // só paga o embedding quando o texto mudou; a dimensão o próprio pgvector garante
    if (storedText.get(row.id) !== text) pending.push({ id: row.id, text });
  }
  if (pending.length === 0) return result;

  const vectors = await embedder.embed(pending.map((item) => item.text), "document");
  for (const [i, item] of pending.entries()) {
    await sql`
      INSERT INTO livros_vetores (livro_id, modelo, texto, embedding)
      VALUES (${item.id}, ${embedder.id}, ${item.text}, ${toVectorLiteral(vectors[i]!)}::vector)
      ON CONFLICT (livro_id) DO UPDATE
        SET modelo = EXCLUDED.modelo, texto = EXCLUDED.texto, embedding = EXCLUDED.embedding
    `;
  }
  result.indexed = pending.length;
  return result;
}

/**
 * Atualiza os vetores destes livros, depois do COMMIT. Nunca lança: sem Gemini o
 * livro fica sem vetor até a próxima reconciliação, e a escrita do livro, que é
 * o que importa, já aconteceu.
 */
export async function syncBookIndex(ids: number[], integration: CatalogIntegration, embedder: Embedder | null = defaultEmbedder): Promise<IndexResult> {
  try {
    const { created, ...result } = await syncIds(ids, integration, embedder);
    // tabela nova (modelo trocado): os outros livros também precisam de vetor
    if (created) void reconcileBookIndex(integration, embedder);
    return result;
  } catch (error) {
    console.warn("Índice semântico indisponível:", (error as Error).message);
    return { indexed: 0 };
  }
}

/**
 * Passa todos os livros pela sincronização: ganham vetor os que não têm (o seed
 * escreve direto em `livros`) e os de texto desatualizado. Órfãos não existem,
 * a chave estrangeira não deixa.
 */
export async function reconcileBookIndex(integration: CatalogIntegration, embedder: Embedder | null = defaultEmbedder): Promise<IndexResult> {
  try {
    const ids = (await sql`SELECT id FROM livros` as { id: number }[]).map((row) => row.id);
    const { created, ...result } = await syncIds(ids, integration, embedder);
    return result;
  } catch (error) {
    console.warn("Índice semântico indisponível:", (error as Error).message);
    return { indexed: 0 };
  }
}

/** O nome do autor faz parte do texto indexado: renomeá-lo reindexa os livros dele. */
export async function syncAuthorBookIndex(authorId: number, integration: CatalogIntegration): Promise<void> {
  try {
    const rows = await sql`SELECT id FROM livros WHERE autor_id = ${authorId}` as { id: number }[];
    await syncBookIndex(rows.map((row) => row.id), integration);
  } catch (error) {
    console.warn("Índice semântico indisponível:", (error as Error).message);
  }
}

export type KnnHit = { id: number; distance: number };

/**
 * Os `limit` livros mais próximos do vetor, do mais perto para o mais longe.
 * O par ORDER BY embedding <=> … LIMIT é o que o índice HNSW sabe acelerar, e o
 * <=> devolve 1 − cos(θ), a mesma distância que o Redis devolvia.
 */
export async function knnSearch(vector: Float32Array, limit: number): Promise<KnnHit[]> {
  const query = toVectorLiteral(vector);
  return await sql`
    SELECT livro_id AS id, embedding <=> ${query}::vector AS distance
    FROM livros_vetores
    ORDER BY embedding <=> ${query}::vector
    LIMIT ${limit}
  ` as KnnHit[];
}
