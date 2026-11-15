import { expect, test } from "bun:test";
import { api, testAuthor, testIsbn } from "#tests/api";
import { embedder as defaultEmbedder } from "../../../infrastructure/embedder";
import { createHashEmbedder } from "../../../infrastructure/hashEmbedder";
import { sql } from "../../../infrastructure/postgres";
import { catalogIntegration } from "../../../integration/catalogIntegration";
import type { Embedder } from "../../../shared/Embedder";
import { reconcileBookIndex, syncBookIndex } from "./bookVectors";

// a suíte roda com EMBEDDING_PROVIDER=hash: cada escrita de livro grava um vetor de verdade, sem rede
const base = defaultEmbedder!;

type VectorRow = { text: string; dims: number; embedding: string };

async function storedVector(id: number): Promise<VectorRow | undefined> {
  const [row] = await sql`
    SELECT texto AS text, vector_dims(embedding) AS dims, embedding::text AS embedding
    FROM livros_vetores WHERE livro_id = ${id}
  ` as VectorRow[];
  return row;
}

async function columnType(): Promise<string> {
  const [row] = await sql`
    SELECT format_type(atttypid, atttypmod) AS type
    FROM pg_attribute WHERE attrelid = to_regclass('livros_vetores') AND attname = 'embedding'
  ` as { type: string }[];
  return row!.type;
}

async function createBook(title: string, authorId: number): Promise<{ id: number; isbn: string }> {
  const response = await api("POST", "/livros", { isbn: testIsbn(), titulo: title, autorId: authorId });
  expect(response.status).toBe(201);
  return response.json();
}

function token(): string {
  return crypto.randomUUID().slice(0, 8);
}

test("UC24: livro cadastrado ganha vetor com título, autor e a dimensão do embedder", async () => {
  const author = await testAuthor();
  const title = `Livro ${token()}`;
  const book = await createBook(title, author.id);
  const row = await storedVector(book.id);
  expect(row?.text).toBe(`${title} — ${author.nome}`);
  expect(row?.dims).toBe(base.dimensions);
});

test("UC24: editar o título atualiza o texto e o vetor", async () => {
  const author = await testAuthor();
  const book = await createBook(`Livro ${token()}`, author.id);
  const before = await storedVector(book.id);
  const title = `Novo título ${token()}`;
  expect((await api("PUT", `/livros/${book.id}`, { isbn: book.isbn, titulo: title, autorId: author.id })).status).toBe(200);
  const after = await storedVector(book.id);
  expect(after?.text).toBe(`${title} — ${author.nome}`);
  expect(after?.embedding).not.toBe(before?.embedding);
});

test("UC24: excluir o livro remove a linha do vetor", async () => {
  const author = await testAuthor();
  const book = await createBook(`Livro ${token()}`, author.id);
  expect(await storedVector(book.id)).toBeDefined();
  expect((await api("DELETE", `/livros/${book.id}`)).status).toBe(204);
  expect(await storedVector(book.id)).toBeUndefined();
});

test("UC24: renomear o autor atualiza o texto dos livros dele", async () => {
  const author = await testAuthor();
  const book = await createBook(`Livro ${token()}`, author.id);
  const name = `Autora ${token()}`;
  expect((await api("PUT", `/autores/${author.id}`, { nome: name, tipo: "literatura" })).status).toBe(200);
  expect((await storedVector(book.id))?.text).toEndWith(`— ${name}`);
});

test("UC24: livro inserido direto no banco, como no seed, ganha vetor na reconciliação", async () => {
  const author = await testAuthor();
  const title = `Livro do seed ${token()}`;
  const [row] = await sql`
    INSERT INTO livros (isbn, titulo, autor_id, data_catalogacao)
    VALUES (${testIsbn()}, ${title}, ${author.id}, '2026-01-01')
    RETURNING id
  ` as { id: number }[];
  expect(await storedVector(row!.id)).toBeUndefined();
  await reconcileBookIndex(catalogIntegration, base);
  expect((await storedVector(row!.id))?.text).toBe(`${title} — ${author.nome}`);
});

test("UC24: sincronizar de novo com o texto igual não chama o embedder", async () => {
  const author = await testAuthor();
  const book = await createBook(`Livro ${token()}`, author.id);
  let calls = 0;
  // mesmo id e mesma dimensão do embedder padrão: a tabela não é recriada
  const counter: Embedder = { ...base, embed: (texts, purpose) => { calls++; return base.embed(texts, purpose); } };
  expect(await syncBookIndex([book.id], catalogIntegration, counter)).toEqual({ indexed: 0 });
  expect(calls).toBe(0);
});

test("UC24: com o embedder fora do ar a sincronização não lança e o livro continua salvo", async () => {
  const author = await testAuthor();
  const book = await createBook(`Livro ${token()}`, author.id);
  // o título muda direto no banco, para a sincronização precisar de um vetor novo
  await sql`UPDATE livros SET titulo = ${`Outro título ${token()}`} WHERE id = ${book.id}`;
  const down: Embedder = { ...base, embed: async () => { throw new Error("fora do ar"); } };
  expect(await syncBookIndex([book.id], catalogIntegration, down)).toEqual({ indexed: 0 });
  expect((await api("GET", `/livros/id/${book.id}`)).status).toBe(200);
});

test("UC24: um embedder de outra dimensão refaz a tabela e reindexa os livros", async () => {
  const author = await testAuthor();
  const book = await createBook(`Livro ${token()}`, author.id);
  try {
    await reconcileBookIndex(catalogIntegration, createHashEmbedder(512));
    expect(await columnType()).toBe("vector(512)");
    expect((await storedVector(book.id))?.dims).toBe(512);
  } finally {
    // o banco de testes é compartilhado: devolve a tabela ao embedder padrão
    await reconcileBookIndex(catalogIntegration, base);
  }
  expect(await columnType()).toBe(`vector(${base.dimensions})`);
  expect((await storedVector(book.id))?.dims).toBe(base.dimensions);
});

test("UC24: a tabela tem índice HNSW cosseno e chave estrangeira com CASCADE", async () => {
  const [index] = await sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'livros_vetores' AND indexdef LIKE '%hnsw%'` as { indexdef: string }[];
  expect(index?.indexdef).toContain("vector_cosine_ops");
  const [fk] = await sql`
    SELECT confdeltype AS "onDelete", confrelid::regclass::text AS target
    FROM pg_constraint WHERE conrelid = 'livros_vetores'::regclass AND contype = 'f'
  ` as { onDelete: string; target: string }[];
  expect(fk).toEqual({ onDelete: "c", target: "livros" });
});
