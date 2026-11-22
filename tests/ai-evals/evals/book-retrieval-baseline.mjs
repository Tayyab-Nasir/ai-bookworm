// Run with node tests/ai-evals/evals/book-retrieval-baseline.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const root = new URL("../../../", import.meta.url);
const passages = [
  ["Compass", "Elara hid the silver compass under the lantern."],
  ["Letters", "Cyrus sent a sealed letter to Mira from the observatory."],
  ["Harbor", "Mira escorted the shipkeeper to the harbor museum."],
  ["Carte", "Le cartographe protège la boussole cassée."],
  ["Pasaje", "La llave de cobre abre la puerta del molino."],
];
const queries = [
  ["exact name", "Elara", ["Compass"]],
  ["exact phrase", '"sealed letter"', ["Letters"]],
  ["exact Bible fact", '"mechanical apprentice"', ["Bible"]],
  ["cross-chapter keyword", "Mira", ["Letters", "Harbor"]],
  ["paraphrase", "concealed navigation instrument", ["Compass"]],
  ["paraphrase", "mailed a confidential message", ["Letters"]],
  ["French exact", '"boussole cassée"', ["Carte"]],
  ["Spanish exact", '"llave de cobre"', ["Pasaje"]],
  ["translated query", "copper key", ["Pasaje"]],
  ["accent omitted", "protege", ["Carte"]],
];

const owner = "ac700000-0000-4000-8000-000000000001";
const other = "ac700000-0000-4000-8000-000000000002";
const db = new PGlite({ extensions: { citext, pgcrypto } });
const read = (path) => readFile(new URL(path, root), "utf8");
const sourceHash = (text) => createHash("md5").update(text).digest("hex");
const setActor = async (sub) => {
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub })]);
};
async function makeBook(title, chapters) {
  const workspace = await db.query("select id from public.create_workspace_with_owner($1)", [title]);
  const book = await db.query(
    "insert into public.books(workspace_id,title,author_name,created_by) values($1,$2,'Fixture author',auth.uid()) returning id",
    [workspace.rows[0].id, title],
  );
  const id = book.rows[0].id;
  for (let offset = 0; offset < chapters.length; offset += 20) {
    await db.query("select id from public.create_book_chapters($1,$2::jsonb)", [
      id,
      JSON.stringify(chapters.slice(offset, offset + 20)),
    ]);
  }
  return id;
}

try {
  await db.exec(await read("tests/security/local-supabase-fixture.sql"));
  const migrations = await readdir(new URL("supabase/migrations/", root));
  for (const file of migrations.filter((file) => file.endsWith(".sql")).sort()) {
    await db.exec(await read("supabase/migrations/" + file));
  }
  await db.query("insert into auth.users(id,email) values($1,'a@local.test'),($2,'b@local.test')", [owner, other]);
  await db.exec("set role authenticated");
  await setActor(owner);
  const chapters = passages.map(([title, text]) => ({ title, nodes: [{ id: "fact", type: "paragraph", text }] }));
  for (let index = 1; index <= 95; index++) {
    chapters.push({
      title: "Background " + index,
      nodes: Array.from({ length: 40 }, (_, paragraph) => ({
        id: "p" + paragraph, type: "paragraph",
        text: "During the evening session, the committee copied meeting minutes and counted supplies for the annual exhibition. Section " + index + ".",
      })),
    });
  }
  const sourceNodes = new Map(chapters.map(({ title, nodes }) => [title, new Map(nodes.map(node => [node.id, node.text]))]));
  const bookId = await makeBook("Retrieval fixtures", chapters);
  const bible = await db.query(
    "insert into public.book_bible_items(book_id,type,name,description) values($1,'character','Tova','A mechanical apprentice.') returning id",
    [bookId],
  );
  const rows = [];
  for (const [scenario, query, expected] of queries) {
    const result = await db.query("select * from public.search_book_context($1,$2,8)", [bookId, query]);
    const returned = new Set();
    for (const hit of result.rows) {
      assert.equal(hit.text_hash, sourceHash(hit.excerpt), "citation excerpt hash");
      if (hit.source_type === "bible") {
        assert.equal(hit.bible_item_id, bible.rows[0].id, "exact bible item");
        assert.match(hit.excerpt, /mechanical apprentice/);
        returned.add("Bible");
      } else {
        assert.equal(hit.source_type, "manuscript");
        assert.equal(hit.excerpt, sourceNodes.get(hit.title)?.get(hit.node_id), "verbatim passage");
        const canonical = await db.query("select id,current_document_version_id from public.chapters where id=$1 and book_id=$2", [
          hit.chapter_id, bookId,
        ]);
        assert.equal(canonical.rows[0]?.current_document_version_id, hit.document_version_id, "current document version");
        returned.add(hit.title);
      }
    }
    rows.push({ scenario, query, expected: expected.length, retrieved: expected.filter((source) => returned.has(source)).length });
  }

  await setActor(other);
  const foreignBook = await makeBook("Other workspace", [
    { title: "Private chapter", nodes: [{ id: "fact", type: "paragraph", text: "Elara borrowed the forbidden signature." }] },
  ]);
  await assert.rejects(db.query("select * from public.search_book_context($1,$2,8)", [bookId, "Elara"]),
    (error) => error.code === "P0002");
  await setActor(owner);
  await assert.rejects(db.query("select * from public.search_book_context($1,$2,8)", [foreignBook, "Elara"]),
    (error) => error.code === "P0002");
  const expected = rows.reduce((total, row) => total + row.expected, 0);
  const retrieved = rows.reduce((total, row) => total + row.retrieved, 0);
  console.log(JSON.stringify({
    backend: "postgres-fts", chapters: chapters.length, limit: 8, expected, retrieved,
    rows, citedSourcesAndWorkspaceIsolation: "passed",
  }, null, 2));
} finally {
  await db.close();
}
