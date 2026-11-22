import assert from "node:assert/strict";
import { createHash } from "node:crypto";

function passageHint(bookId, excerpt) {
  const digest = createHash("sha256").update(bookId).update("\0").update(excerpt).digest("hex");
  return { filename: `${digest}.txt`, excerpt };
}

// This query is exercised only in the disposable evaluation. Search hints are
// data. The invoker's RLS and canonical current version decide what is returned.
const resolveSql = `
  select c.chapter_id, c.document_version_id, c.node_id, c.chunk_index,
    c.title, c.text_content as excerpt, c.text_hash
  from unnest($2::text[], $3::text[]) with ordinality as hint(filename, excerpt, rank)
  join public.book_search_chunks c
    on c.book_id = $1 and c.text_content = hint.excerpt
    and hint.filename = encode(sha256(
      convert_to(c.book_id::text, 'UTF8') || decode('00', 'hex') || convert_to(c.text_content, 'UTF8')
    ), 'hex') || '.txt'
  join public.chapters ch
    on ch.id = c.chapter_id and ch.book_id = c.book_id
    and ch.current_document_version_id = c.document_version_id
  group by c.id
  order by min(hint.rank), c.chapter_id, c.chunk_index, c.id
  limit $4
`;

const indexedResolveSql = `
  with matches as materialized (
    select c.id, min(hint.rank) as rank
    from unnest($2::text[], $3::text[]) with ordinality as hint(filename, excerpt, rank)
    join public.book_search_chunks c
      on c.book_id = $1 and c.text_hash = md5(hint.excerpt)
      and c.text_content = hint.excerpt
      and hint.filename = encode(sha256(
        convert_to(c.book_id::text, 'UTF8') || decode('00', 'hex') || convert_to(c.text_content, 'UTF8')
      ), 'hex') || '.txt'
    group by c.id
  )
  select c.chapter_id, c.document_version_id, c.node_id, c.chunk_index,
    c.title, c.text_content as excerpt, c.text_hash
  from matches
  join public.book_search_chunks c on c.id = matches.id
  join public.chapters ch
    on ch.id = c.chapter_id and ch.book_id = c.book_id
    and ch.current_document_version_id = c.document_version_id
  order by matches.rank, c.chapter_id, c.chunk_index, c.id
  limit $4
`;

export async function verifyCitationBinding({ db, owner, other, makeBook, setActor, foreignBook }) {
  const repeated = "Elara carried an amethyst compass to the café. 🌙";
  const revised = "Elara carried a jade lantern.";
  const chapter = (title) => ({ title, nodes: [{ id: "fact", type: "paragraph", text: repeated }] });
  const bookId = await makeBook("Citation binding fixture", [chapter("Chapter A"), chapter("Chapter B")]);
  const hint = passageHint(bookId, repeated);
  const resolve = async (book, hints = [hint], limit = 8) => {
    const { rows } = await db.query(indexedResolveSql, [
      book, hints.map(hit => hit.filename), hints.map(hit => hit.excerpt), limit,
    ]);
    return rows;
  };
  const first = await resolve(bookId, [hint, hint]);
  assert.deepEqual(first.map(row => row.title).sort(), ["Chapter A", "Chapter B"]);
  assert.equal(new Set(first.map(row => row.document_version_id)).size, 2);
  assert(first.every(row => row.excerpt === repeated && row.node_id === "fact"));
  assert.equal((await resolve(bookId, [hint], 1)).length, 1);
  assert.deepEqual(await resolve(bookId, [{ ...hint, excerpt: revised }]), []);
  assert.deepEqual(await resolve(bookId, [passageHint(foreignBook, repeated)]), []);
  assert.deepEqual(await resolve(foreignBook, [hint]), []);

  const { rows: [book] } = await db.query("select workspace_id from public.books where id=$1", [bookId]);
  await setActor(other);
  assert.deepEqual(await resolve(bookId), []);
  await db.exec("reset role");
  await db.query("insert into public.workspace_members(workspace_id,user_id,role) values($1,$2,'viewer')",
    [book.workspace_id, other]);
  await db.exec("set role authenticated");
  assert.equal((await resolve(bookId)).length, 2, "an active viewer can resolve both occurrences");
  await db.exec("reset role");
  await db.query("delete from public.workspace_members where workspace_id=$1 and user_id=$2",
    [book.workspace_id, other]);
  await db.exec("set role authenticated");
  assert.deepEqual(await resolve(bookId), [], "a revoked member cannot resolve a previously retrieved hint");
  await setActor(owner);

  const append = async (row, operation) => {
    const document = { schemaVersion: "1.0", nodes: [{ id: "fact", type: "paragraph", text: revised }] };
    const { rows: [version] } = await db.query(
      "select id from public.append_chapter_version($1,1,$2::jsonb,$3,5,'Citation binding fixture',$4)",
      [row.chapter_id, JSON.stringify(document), revised, operation],
    );
    return version.id;
  };
  const [left, right] = first;
  const revision = await append(left, "citation-binding-a");
  assert.deepEqual(await resolve(bookId), [right], "the other current occurrence remains");
  const newMatch = await resolve(bookId, [passageHint(bookId, revised)]);
  assert.equal(newMatch.length, 1);
  assert.equal(newMatch[0].document_version_id, revision);
  await append(right, "citation-binding-b");
  assert.deepEqual(await resolve(bookId), [], "a delayed hint cannot cite a superseded passage");

  // Model a stale derived row even though the normal chapter trigger removes it.
  await db.exec("reset role");
  await db.query(`
    insert into public.book_search_chunks(
      book_id, chapter_id, document_version_id, node_id, chunk_index, title, text_content, text_hash
    ) values ($1,$2,$3,$4,$5,$6,$7,$8)
  `, [bookId, right.chapter_id, right.document_version_id, right.node_id, right.chunk_index,
    right.title, right.excerpt, right.text_hash]);
  await db.query(`
    insert into public.book_search_chunks(
      book_id, chapter_id, document_version_id, node_id, chunk_index, title, text_content, text_hash
    ) values ($1,$2,$3,$4,$5,$6,$7,$8)
  `, [bookId, left.chapter_id, revision, left.node_id, 1, left.title,
    "A different excerpt with the same stored prefilter hash.", left.text_hash]);
  await db.exec("set role authenticated");
  assert.deepEqual(await resolve(bookId), [], "a stale version or a matching prefilter hash cannot restore a former citation");
  return "passed";
}

export async function measureCitationLookup(db, bookId) {
  const { rows: samples } = await db.query(`
    select text_content from public.book_search_chunks
    where book_id=$1 and chapter_id is not null and title not like 'Background %'
    order by title, chunk_index limit 8
  `, [bookId]);
  const hints = samples.map(sample => passageHint(bookId, sample.text_content));
  hints.push(passageHint(bookId, "A synthetic fact absent from this book."));
  const parameters = [bookId, hints.map(hit => hit.filename), hints.map(hit => hit.excerpt), 20];
  const { rows: [{ count }] } = await db.query(
    "select count(*)::int as count from public.book_search_chunks where book_id=$1", [bookId],
  );

  async function profile(query) {
    // Warm both the execution plan and the in-process storage before measuring.
    await db.query(query, parameters);
    const executionMs = [];
    let chunkAccess = [];
    function walk(node) {
      if (node["Relation Name"] === "book_search_chunks" ||
          node["Index Name"]?.startsWith("book_search_chunks_")) {
        chunkAccess.push({
          node: node["Node Type"], index: node["Index Name"] ?? null,
          actualRows: node["Actual Rows"], loops: node["Actual Loops"],
          rowsFiltered: node["Rows Removed by Filter"] ?? 0,
          indexCondition: node["Index Cond"] ?? null,
        });
      }
      for (const child of node.Plans ?? []) walk(child);
    }
    for (let iteration = 0; iteration < 9; iteration++) {
      const { rows } = await db.query("explain (analyze, format json) " + query, parameters);
      const [sample] = rows[0]["QUERY PLAN"];
      executionMs.push(sample["Execution Time"]);
      chunkAccess = [];
      walk(sample.Plan);
    }
    const sorted = executionMs.toSorted((a, b) => a - b);
    return { medianMs: sorted[4], minMs: sorted[0], maxMs: sorted.at(-1), chunkAccess };
  }

  await db.exec("reset role; analyze public.book_search_chunks; set role authenticated");
  const expected = await db.query(resolveSql, parameters);
  const baseline = await profile(resolveSql);
  await db.exec(`
    reset role;
    create index book_search_chunks_citation_eval on public.book_search_chunks (book_id, text_hash);
    analyze public.book_search_chunks;
    set role authenticated
  `);
  try {
    assert.deepEqual((await db.query(indexedResolveSql, parameters)).rows, expected.rows);
    const indexed = await profile(indexedResolveSql);
    return { bookChunks: count, hints: hints.length, citations: expected.rows.length, baseline, indexed };
  } finally {
    await db.exec("reset role; drop index public.book_search_chunks_citation_eval; set role authenticated");
  }
}
