import { expect, test } from "bun:test";
import { api, apiForm, testAuthor } from "#tests/api";
import { FAKE_JPEG, imageForm, JPEG, PNG } from "#tests/images";
import { getObject } from "../../../../infrastructure/storage";
import { authorshipIntegration } from "../../../../integration/authorshipIntegration";
import { ServiceUnavailable } from "../../../../shared/errors";
import { MAX_IMAGE_BYTES } from "../../../../shared/images";
import { photoKey } from "../../infrastructure/photos";
import { removeAuthorPhoto } from "./removeAuthorPhoto";
import { uploadAuthorPhoto } from "./uploadAuthorPhoto";

/*
 * Testes de aceite da atividade. Cada um começa como test.todo: o bun test lista,
 * mas não executa. Quando implementar a parte que um teste cobre, troque
 * test.todo por test e rode a suíte. Não altere o que os testes esperam.
 */

const sendPhoto = (id: number, bytes: Uint8Array, name = "foto.png", type = "image/png") =>
  apiForm("PUT", `/autores/${id}/foto`, imageForm("foto", bytes, name, type));

const authorById = async (id: number) => (await api("GET", `/autores/${id}`)).json();

test("UC26: a chave da foto pertence ao módulo Autoria", () => {
  expect(photoKey(7)).toBe("autoria/autores/7/foto");
});

test("UC26: envia a foto, devolve fotoUrl e serve os mesmos bytes", async () => {
  const author = await testAuthor();
  const response = await sendPhoto(author.id, PNG);
  expect(response.status).toBe(200);
  const { fotoUrl } = await response.json();
  expect(fotoUrl).toMatch(new RegExp(`^/api/autores/${author.id}/foto\\?v=\\d+$`));

  const photo = await api("GET", fotoUrl.replace(/^\/api/, ""));
  expect(photo.status).toBe(200);
  expect(photo.headers.get("Content-Type")).toBe("image/png");
  expect(new Uint8Array(await photo.arrayBuffer())).toEqual(PNG);
  expect((await authorById(author.id)).fotoUrl).toBe(fotoUrl);
  expect(await getObject(photoKey(author.id))).not.toBeNull();
});

test("UC26: trocar a foto substitui o objeto e muda a fotoUrl", async () => {
  const author = await testAuthor();
  const first = (await (await sendPhoto(author.id, PNG)).json()).fotoUrl;
  await Bun.sleep(5);
  const second = (await (await sendPhoto(author.id, JPEG, "foto.jpg", "image/jpeg")).json()).fotoUrl;
  expect(second).not.toBe(first);
  const photo = await api("GET", `/autores/${author.id}/foto`);
  expect(photo.headers.get("Content-Type")).toBe("image/jpeg");
  expect(new Uint8Array(await photo.arrayBuffer())).toEqual(JPEG);
});

test("UC26: recusa o que não é imagem (400), o que passa de 2 MB (413) e autor inexistente (404)", async () => {
  const author = await testAuthor();
  expect((await sendPhoto(author.id, FAKE_JPEG, "foto.jpg", "image/jpeg")).status).toBe(400);
  const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
  big.set(PNG);
  expect((await sendPhoto(author.id, big)).status).toBe(413);
  expect((await sendPhoto(2147483647, PNG)).status).toBe(404);
  // nada disso deixou foto para trás
  expect((await authorById(author.id)).fotoUrl).toBeNull();
  expect((await api("GET", `/autores/${author.id}/foto`)).status).toBe(404);
  expect((await api("GET", "/autores/2147483647/foto")).status).toBe(404);
  expect(await getObject(photoKey(author.id))).toBeNull();
});

test("UC26: remover a foto zera fotoUrl e apaga o objeto do bucket", async () => {
  const author = await testAuthor();
  await sendPhoto(author.id, PNG);
  expect((await api("DELETE", `/autores/${author.id}/foto`)).status).toBe(204);
  expect((await authorById(author.id)).fotoUrl).toBeNull();
  expect((await api("GET", `/autores/${author.id}/foto`)).status).toBe(404);
  expect(await getObject(photoKey(author.id))).toBeNull();
  expect((await api("DELETE", "/autores/2147483647/foto")).status).toBe(404);
});

test("UC26: sem RustFS, 503 e o autor continua como estava", async () => {
  const author = await testAuthor();
  const image = { bytes: PNG, type: "image/png" as const };
  await expect(uploadAuthorPhoto(author.id, image, authorshipIntegration, { client: null })).rejects.toBeInstanceOf(ServiceUnavailable);
  expect((await authorById(author.id)).fotoUrl).toBeNull();

  await sendPhoto(author.id, PNG);
  await expect(removeAuthorPhoto(author.id, null)).rejects.toBeInstanceOf(ServiceUnavailable);
  expect((await authorById(author.id)).fotoUrl).not.toBeNull();
});

test("UC26: enviar e remover a foto invalidam o cache da busca de autores", async () => {
  const author = await testAuthor();
  const search = async () => {
    const response = await api("GET", `/autores?q=${encodeURIComponent(author.nome)}`);
    return { cache: response.headers.get("X-Cache"), authors: await response.json() as { fotoUrl: string | null }[] };
  };
  await search();
  expect((await search()).cache).toBe("HIT");

  await sendPhoto(author.id, PNG);
  const afterUpload = await search();
  expect(afterUpload.cache).toBe("MISS");
  expect(afterUpload.authors[0]!.fotoUrl).not.toBeNull();

  expect((await search()).cache).toBe("HIT");
  expect((await api("DELETE", `/autores/${author.id}/foto`)).status).toBe(204);
  const afterRemove = await search();
  expect(afterRemove.cache).toBe("MISS");
  expect(afterRemove.authors[0]!.fotoUrl).toBeNull();
});

test("UC08: excluir o autor apaga a foto do bucket", async () => {
  const author = await testAuthor();
  await sendPhoto(author.id, PNG);
  expect(await getObject(photoKey(author.id))).not.toBeNull();
  expect((await api("DELETE", `/autores/${author.id}`)).status).toBe(204);
  expect(await getObject(photoKey(author.id))).toBeNull();
});

/*
 * Passo 07: respostas para a discussão.
 *
 * 1. A ordem das escritas.
 * No envio, se o processo morrer depois do putObject e antes do UPDATE, sobra um
 * objeto no bucket que nenhum autor usa: o autor continua sem foto (ou com a
 * antiga, que foi sobrescrita pela nova na mesma chave). Na ordem inversa, a
 * coluna diria que há foto nova e o objeto não existiria (ou seria o antigo), e
 * o GET daria 404 ou mostraria a foto errada com o ?v= novo, que o navegador
 * guarda por um ano. Na remoção é o mesmo raciocínio: zerando a coluna antes,
 * o pior caso é um objeto órfão; apagando o objeto antes, o autor apontaria para
 * uma foto que não existe. Objeto órfão é aceitável porque ninguém o vê e dá para
 * limpar depois; autor apontando para foto inexistente aparece quebrado na tela.
 *
 * 2. Objetos órfãos.
 * Sobram quando o processo morre entre o putObject e o UPDATE; quando o autor é
 * excluído enquanto a foto sobe e o discardObject falha; quando a remoção da foto
 * ou a exclusão do autor confirmam no Postgres e o RustFS está fora do ar (vi
 * isso no passo 06: com o RustFS parado, o DELETE da foto respondeu 204, a coluna
 * ficou nula e o objeto continuou no bucket). Para limpar, listaria as chaves com
 * list({ prefix: "autoria/autores/" }), tiraria o id de cada uma e veria no
 * Postgres se o autor existe e tem foto_atualizada_em preenchida; se não, apaga.
 * O cuidado é com o envio em andamento: o objeto já está no bucket e a coluna
 * ainda não foi gravada. Por isso só apagaria objetos com lastModified mais antigo
 * que uma margem (alguns minutos, ou uma hora), e conferiria o banco de novo logo
 * antes de apagar.
 *
 * 3. Tudo passa pelo backend.
 * A fotoUrl deixaria de ser /api/autores/:id/foto e passaria a ser uma URL do
 * subdomínio de mídia, com a assinatura e a validade na query string. O
 * Cache-Control não poderia mais ser immutable de um ano, porque a URL expira:
 * o tempo de cache ficaria no máximo igual à validade da assinatura. O ?v=
 * continua útil para trocar a URL quando a foto muda, mas a assinatura já muda a
 * URL a cada vez que é gerada, então o cache do navegador seria reaproveitado bem
 * menos. Quem decide quem vê a foto, e por quanto tempo, passa a ser quem assina
 * a URL (o backend, na hora de montar o JSON); depois de assinada, o
 * armazenamento entrega para qualquer um que tenha o link até ele vencer.
 *
 * 4. Chave fixa ou chave nova.
 * Com chave fixa, a foto antiga é sobrescrita na hora e não sobra nada no bucket;
 * o cache do navegador depende do ?v= para não mostrar a antiga. Em dois envios
 * simultâneos, um sobrescreve o outro, e pode acontecer de o objeto ser de um
 * envio e a coluna (o ?v=) ser do outro. Com chave nova a cada envio, a URL já
 * muda sozinha e o cache funciona sem ?v=, e cada envio grava no seu próprio
 * objeto, então quem grava a coluna por último ganha e sempre aponta para um
 * objeto que existe. Em troca, a foto antiga fica no bucket até alguém apagá-la
 * depois do COMMIT, e cada troca pode gerar um órfão.
 *
 * 5. A foto é um dado pessoal.
 * Mesmo depois de apagar o objeto, a foto continua no cache dos navegadores que a
 * abriram (immutable por um ano), em algum proxy ou CDN no caminho, no volume
 * rustfsdata se o RustFS guardar versões ou ainda não tiver liberado o espaço, e
 * nos backups do volume e do banco. Num sistema de verdade, o pedido de exclusão
 * precisaria apagar o objeto e todas as versões, purgar a CDN, ter um prazo
 * definido para os backups expirarem (ou um jeito de apagar deles), e registrar
 * que o pedido foi atendido.
 */
