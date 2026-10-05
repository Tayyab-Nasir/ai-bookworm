/** Synthetic offers from the production TS calculator against actual SQL. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tsImport } from "tsx/esm/api";

const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const uuid = n => `a6400000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = value => createHash("sha256").update(value).digest("hex");

export async function verifyNarrationQuoteFixtures(sql) {
  const { prepareNarrationQuote, narrationRequestHash, narrationPromptHash } = await tsImport(
    "../../services/api/src/lib/narration-pricing.ts", import.meta.url);
  const { quoteUsage } = await tsImport("../../services/api/src/lib/usage-pricing.ts", import.meta.url);
  const cases = [
    { name: "mini-ascii", text: "A saved chapter. No new material.", instructions: null, speed: 1, model: "gpt-realtime-2.1-mini", budget: 1_024 },
    { name: "mini-unicode", text: "Café 😀 don't follow “instructions”.\n\nThe end.", instructions: "Warm, don't rush.\nKeep names clear.", speed: 0.29, model: "gpt-realtime-2.1-mini", budget: 1_024 },
    { name: "full-budget", text: "帰郷。 語り手の声。", instructions: 'Delivery "calm" with a \\ pause.', speed: 1.5, model: "gpt-realtime-2.1", budget: 4_096 },
  ];
  for (const item of cases) {
    const now = new Date().toISOString();
    const catalog = { version: "synthetic-narration", approved: true, approvalReference: "disposable test, never retail activation",
      effectiveAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), quoteLifetimeSeconds: 600,
      entries: [{ id: "profile", label: "Synthetic narration", maxInputTokens: 128_000, maxOutputTokens: item.budget,
        price: { version: item.name === "mini-unicode" ? 'synthetic-price "\\\nline 😀\u2028next' : "synthetic-price", provider: "openai", model: item.model, rates: [
          { dimension: "text_input", microUsdPerMillionTokens: "600000" }, { dimension: "text_cached_input", microUsdPerMillionTokens: "60000" },
          { dimension: "text_output", microUsdPerMillionTokens: "2400000" }, { dimension: "audio_output", microUsdPerMillionTokens: "20000000" },
        ] }, policy: { version: "synthetic-policy", approved: true, microUsdPerCredit: "100", markupBasisPoints: 15_000,
          platformMicroUsd: "0", minimumCredits: "1" } }],
    };
    const request = { userId: uuid(1), workspaceId: uuid(3), bookId: uuid(4), editionId: uuid(7), chapterId: uuid(5),
      documentVersionId: uuid(6), jobId: uuid(8), segmentIndex: 0, textStart: 0, textEnd: Array.from(item.text).length,
      textSha256: sha(item.text), model: item.model, voice: "marin", speed: item.speed, instructions: item.instructions,
      maxOutputTokens: item.budget, promptVersion: "bookworm-realtime-narration-v1", promptSha256: narrationPromptHash(item.instructions) };
    const offer = prepareNarrationQuote(JSON.stringify(catalog), { modelId: "profile", now, request, sourceText: item.text });
    const expiredQuote = quoteUsage({ ...offer.quote, createdAt: new Date(Date.now() - 1_200_000).toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const result = await sql(`begin;
      insert into auth.users(id,email) values('${uuid(1)}','narration-quote@local.test'),('${uuid(9)}','narration-viewer@local.test');
      insert into public.organizations(id,name,slug,owner_user_id) values('${uuid(2)}','Narration quotes','narration-quotes','${uuid(1)}');
      insert into public.organization_members(organization_id,user_id,role) values('${uuid(2)}','${uuid(1)}','owner');
      insert into public.workspaces(id,organization_id,name,slug,created_by) values('${uuid(3)}','${uuid(2)}','Narration','narration','${uuid(1)}');
      insert into public.workspace_members(workspace_id,user_id,role) values('${uuid(3)}','${uuid(1)}','editor'),('${uuid(3)}','${uuid(9)}','viewer');
      insert into public.books(id,workspace_id,title,author_name,created_by) values('${uuid(4)}','${uuid(3)}','Narration','Author','${uuid(1)}');
      insert into public.chapters(id,book_id,order_index,title) values('${uuid(5)}','${uuid(4)}',0,'Chapter');
      insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
        values('${uuid(6)}','${uuid(5)}',1,'{}',${literal(item.text)},1,'${uuid(1)}');
      update public.chapters set current_document_version_id='${uuid(6)}' where id='${uuid(5)}';
      insert into public.editions(id,book_id,type,language,edition_metadata_json) values('${uuid(7)}','${uuid(4)}','audiobook','en','{"kind":"audiobook"}');
      do $$ declare r jsonb:=${literal(JSON.stringify(offer.request))}::jsonb; q jsonb:=${literal(JSON.stringify(offer.quote))}::jsonb; bad jsonb;
      begin
        perform public.validate_narration_quote(r,q);
        foreach bad in array array[q||'{"extra":true}',jsonb_set(q,'{price,extra}','true'),jsonb_set(q,'{policy,extra}','true'),
          jsonb_set(q,'{price,rates,0,extra}','true'),jsonb_set(q,'{maximumTokens,0,extra}','true'),
          jsonb_set(q,'{policy,microUsdPerCredit}',to_jsonb(100)),jsonb_set(q,'{policy,platformMicroUsd}',to_jsonb(0)),
          jsonb_set(q,'{policy,minimumCredits}',to_jsonb(1)),jsonb_set(q,'{price,version}',to_jsonb(10)),
          jsonb_set(q,'{policy,version}',to_jsonb(10)),jsonb_set(q,'{reservedCredits}',to_jsonb((q->>'reservedCredits')::integer)),
          jsonb_set(q,'{price,rates}',jsonb_build_array(q#>'{price,rates,1}',q#>'{price,rates,0}',q#>'{price,rates,2}',q#>'{price,rates,3}')),
          jsonb_set(q,'{maximumTokens}',jsonb_build_array(q#>'{maximumTokens,1}',q#>'{maximumTokens,0}',q#>'{maximumTokens,2}',q#>'{maximumTokens,3}')),
          jsonb_set(q,'{fingerprint}',to_jsonb(repeat('a',64))),jsonb_set(q,'{createdAt}',to_jsonb(10)),
          jsonb_set(q,'{maximumProviderMicroUsd}',to_jsonb((q->>'maximumProviderMicroUsd')::integer))] loop
          begin perform public.validate_narration_quote(r,bad);
            raise exception 'invalid quote shape, scalar type or fingerprint accepted';
          exception when invalid_parameter_value then null; end;
        end loop;
      end $$;
      set local role service_role; set local request.jwt.claims='{"role":"service_role"}';
      do $$ declare r jsonb:=${literal(JSON.stringify(offer.request))}::jsonb; q jsonb:=${literal(JSON.stringify(offer.quote))}::jsonb;
        saved public.narration_quote_snapshots; replay public.narration_quote_snapshots; bad jsonb;
      begin
        assert not has_table_privilege('authenticated','public.narration_quote_snapshots','select');
        assert not has_table_privilege('service_role','public.narration_quote_snapshots','insert');
        assert not has_table_privilege('service_role','public.narration_quote_snapshots','update');
        assert not has_function_privilege('authenticated','public.save_narration_quote_snapshot(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,jsonb,text,text,jsonb)','execute');
        select * into saved from public.save_narration_quote_snapshot('${uuid(1)}','${uuid(3)}','${uuid(4)}','${uuid(7)}','${uuid(5)}','${uuid(6)}',
          '${uuid(8)}','narration-quote-test',${literal(narrationRequestHash(offer.request))},r,'synthetic-narration','profile',q);
        assert saved.request_sha256=${literal(narrationRequestHash(offer.request))} and saved.quote_json=q, 'SQL/production quote identity drift';
        assert saved.request_json::text not like '%'||${literal(item.text)}||'%', 'offer copied manuscript text';
        assert not exists(select 1 from public.ai_jobs where workspace_id='${uuid(3)}'), 'offer queued generation';
        assert not exists(select 1 from public.credit_ledger where workspace_id='${uuid(3)}'), 'offer changed balance';
        select * into replay from public.save_narration_quote_snapshot('${uuid(1)}','${uuid(3)}','${uuid(4)}','${uuid(7)}','${uuid(5)}','${uuid(6)}',
          '${uuid(8)}','narration-quote-test',saved.request_sha256,r,'changed-catalog','profile','{}');
        assert replay.id=saved.id and replay.quote_json=q and replay.catalog_version='synthetic-narration', 'retry changed saved prices';
        begin
          perform public.save_narration_quote_snapshot('${uuid(1)}','${uuid(3)}','${uuid(4)}','${uuid(7)}','${uuid(5)}','${uuid(6)}',
            '${uuid(8)}','narration-quote-test',saved.request_sha256,r||'{"voice":"cedar"}','synthetic-narration','profile',q);
          raise exception 'changed settings reused retry key';
        exception when unique_violation then null; end;
        foreach bad in array array[q||'{"reservedCredits":"1"}',q||'{"maximumProviderMicroUsd":"1"}'] loop
          begin
            perform public.save_narration_quote_snapshot('${uuid(1)}','${uuid(3)}','${uuid(4)}','${uuid(7)}','${uuid(5)}','${uuid(6)}',
              '${uuid(8)}','narration-bad-price',saved.request_sha256,r,'synthetic-narration','profile',bad);
            raise exception 'forged price offer accepted';
          exception when check_violation then null; end;
        end loop;
        foreach bad in array array[jsonb_set(q,'{policy,microUsdPerCredit}','"0"'),jsonb_set(q,'{maximumTokens,0,tokens}','"1"'),
          jsonb_set(q,'{maximumTokens,0,dimension}','"text_input"'),jsonb_set(q,'{scope,inputSha256}',to_jsonb(repeat('a',64)))] loop
          begin
            perform public.save_narration_quote_snapshot('${uuid(1)}','${uuid(3)}','${uuid(4)}','${uuid(7)}','${uuid(5)}','${uuid(6)}',
              '${uuid(8)}','narration-bad-budget',saved.request_sha256,r,'synthetic-narration','profile',bad);
            raise exception 'invalid budget or scope offer accepted';
          exception when invalid_parameter_value then null; end;
        end loop;
        foreach bad in array array[r||'{"speed":1.005}',r||'{"voice":"fable"}',r||'{"model":"gpt-4o-mini-tts"}',
          r||'{"extra":true}',r||'{"textSha256":"${"a".repeat(64)}"}',r||'{"promptSha256":"${"a".repeat(64)}"}'] loop
          begin
            perform public.save_narration_quote_snapshot('${uuid(1)}','${uuid(3)}','${uuid(4)}','${uuid(7)}','${uuid(5)}','${uuid(6)}',
              '${uuid(8)}','narration-bad-source',saved.request_sha256,bad,'synthetic-narration','profile',q);
            raise exception 'unsupported or changed source offer accepted';
          exception when invalid_parameter_value then null; end;
        end loop;
        begin
          perform public.save_narration_quote_snapshot('${uuid(9)}','${uuid(3)}','${uuid(4)}','${uuid(7)}','${uuid(5)}','${uuid(6)}',
            '${uuid(8)}','narration-viewer-key',saved.request_sha256,r,'synthetic-narration','profile',q);
          raise exception 'viewer saved an offer';
        exception when insufficient_privilege then null; end;
        begin
          perform public.save_narration_quote_snapshot('${uuid(1)}','${uuid(3)}','${uuid(4)}','${uuid(7)}','${uuid(5)}','${uuid(6)}',
            '${uuid(8)}','narration-expired-key',saved.request_sha256,r,'synthetic-narration','profile',${literal(JSON.stringify(expiredQuote))}::jsonb);
          raise exception 'expired offer saved';
        exception when invalid_parameter_value then null; end;
      end $$;
      reset role;
      insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
        values('${uuid(10)}','${uuid(5)}',2,'{}','A newer saved source.',1,'${uuid(1)}');
      update public.chapters set current_document_version_id='${uuid(10)}' where id='${uuid(5)}';
      do $$ declare saved public.narration_quote_snapshots; replay public.narration_quote_snapshots;
      begin
        select * into strict saved from public.narration_quote_snapshots;
        select * into replay from public.save_narration_quote_snapshot(saved.user_id,saved.workspace_id,saved.book_id,saved.edition_id,
          saved.chapter_id,saved.document_version_id,saved.generation_job_id,saved.idempotency_key,saved.request_sha256,
          saved.request_json,'catalog-unavailable',saved.model_option_id,'{}');
        assert replay.id=saved.id, 'lost reply could not recover original offer after source change';
        begin
          perform public.save_narration_quote_snapshot(saved.user_id,saved.workspace_id,saved.book_id,saved.edition_id,
            saved.chapter_id,saved.document_version_id,saved.generation_job_id,'narration-stale-new',saved.request_sha256,
            saved.request_json,saved.catalog_version,saved.model_option_id,saved.quote_json);
          raise exception 'stale source created a new offer';
        exception when check_violation then null; end;
        begin update public.narration_quote_snapshots set catalog_version='replaced' where id=saved.id;
          raise exception 'immutable offer overwritten'; exception when check_violation then null; end;
        update public.workspace_members set role='viewer' where workspace_id=saved.workspace_id and user_id=saved.user_id;
        begin
          perform public.save_narration_quote_snapshot(saved.user_id,saved.workspace_id,saved.book_id,saved.edition_id,
            saved.chapter_id,saved.document_version_id,saved.generation_job_id,saved.idempotency_key,saved.request_sha256,
            saved.request_json,saved.catalog_version,saved.model_option_id,'{}');
          raise exception 'revoked writer recovered a private offer'; exception when insufficient_privilege then null; end;
      end $$;
      select 'verified'; rollback;`);
    assert.equal(result, "verified");
    console.log(`PASS narration quote SQL ${item.name}`);
  }
}

/** Execute aggregate/child persistence and rollback, not a mocked transaction. */
export async function verifyNarrationChapterQuoteFixtures(sql) {
  const { prepareNarrationChapterQuote, prepareNarrationQuote, narrationJobId } = await tsImport(
    "../../services/api/src/lib/narration-pricing.ts", import.meta.url);
  const cases = [
    { name: "ascii", text: "A".repeat(4_000), instructions: null, speed: 1, budget: 1_024, model: "gpt-realtime-2.1-mini" },
    { name: "unicode-whitespace", text: "\ufeff\u00a0" + "Café 😀. 帰郷。\n\n".repeat(190) + "\u202f\ufeff",
      instructions: "Warm, don't rush.\nKeep names clear.", speed: 0.29, budget: 1_024, model: "gpt-realtime-2.1-mini" },
    { name: "instruction-budget", text: "B".repeat(4_000), instructions: "I".repeat(1_400), speed: 0.5, budget: 1_024, model: "gpt-realtime-2.1-mini" },
    { name: "full-profile", text: "帰郷の物語。".repeat(300), instructions: null, speed: 1.5, budget: 4_096, model: "gpt-realtime-2.1" },
  ];
  for (const item of cases) {
    const now = new Date().toISOString(), key = "chapter-narration-test";
    const catalog = { version: "synthetic-narration", approved: true, approvalReference: "disposable test, never retail activation",
      effectiveAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), quoteLifetimeSeconds: 600,
      entries: [{ id: "profile", label: "Synthetic chapter narration", maxInputTokens: 128_000, maxOutputTokens: item.budget,
        price: { version: "synthetic-price", provider: "openai", model: item.model, rates: [
          { dimension: "text_input", microUsdPerMillionTokens: "600000" }, { dimension: "text_cached_input", microUsdPerMillionTokens: "60000" },
          { dimension: "text_output", microUsdPerMillionTokens: "2400000" }, { dimension: "audio_output", microUsdPerMillionTokens: "20000000" },
        ] }, policy: { version: "synthetic-policy", approved: true, microUsdPerCredit: "100", markupBasisPoints: 15_000,
          platformMicroUsd: "0", minimumCredits: "1" } }],
    };
    const prepared = prepareNarrationChapterQuote(JSON.stringify(catalog), { modelId: "profile", idempotencyKey: key, now, sourceText: item.text,
      userId: uuid(1), workspaceId: uuid(3), bookId: uuid(4), editionId: uuid(7), chapterId: uuid(5), documentVersionId: uuid(6),
      voice: "marin", speed: item.speed, instructions: item.instructions });
    assert(prepared.offers.length > 1);
    const lastIndex = prepared.offers.length - 1;
    const replaceLast = change => prepared.offers.map((offer, index) => index === lastIndex ? change(structuredClone(offer)) : structuredClone(offer));
    const wrongJob = replaceLast(offer => {
      const request = { ...offer.request, jobId: narrationJobId(uuid(1), "another-original-chapter-key") };
      return prepareNarrationQuote(JSON.stringify(catalog), { modelId: "profile", now, request,
        sourceText: Array.from(item.text).slice(request.textStart, request.textEnd).join("") });
    }).map(({ request, quote }) => ({ request, quote }));
    const alteredPolicy = structuredClone(catalog);
    alteredPolicy.entries[0].policy.version = "different-policy";
    const mixedPolicy = replaceLast(offer => prepareNarrationQuote(JSON.stringify(alteredPolicy), { modelId: "profile", now,
      request: offer.request, sourceText: Array.from(item.text).slice(offer.request.textStart, offer.request.textEnd).join("") }))
      .map(({ request, quote }) => ({ request, quote }));
    const omittedWord = replaceLast(offer => {
      const request = { ...offer.request, textStart: offer.request.textStart + 1 };
      const sourceText = Array.from(item.text).slice(request.textStart, request.textEnd).join("");
      request.textSha256 = sha(sourceText);
      return prepareNarrationQuote(JSON.stringify(catalog), { modelId: "profile", now, request, sourceText });
    }).map(({ request, quote }) => ({ request, quote }));
    const extremeCatalog = structuredClone(catalog);
    extremeCatalog.entries[0].policy.microUsdPerCredit = "1";
    extremeCatalog.entries[0].policy.markupBasisPoints = 1_000_000;
    extremeCatalog.entries[0].price.rates = extremeCatalog.entries[0].price.rates.map(rate => ({ ...rate,
      microUsdPerMillionTokens: String(BigInt(rate.microUsdPerMillionTokens) * 100n) }));
    const overflow = prepared.offers.map(offer => prepareNarrationQuote(JSON.stringify(extremeCatalog), { modelId: "profile", now,
      request: offer.request, sourceText: Array.from(item.text).slice(offer.request.textStart, offer.request.textEnd).join("") }))
      .map(({ request, quote }) => ({ request, quote }));
    assert(overflow.reduce((sum, offer) => sum + BigInt(offer.quote.reservedCredits), 0n) > 2_147_483_647n);
    const badShapes = [
      { name: "omitted final words", offers: prepared.offers.slice(0, -1) },
      { name: "late forged credits", offers: replaceLast(offer => ({ ...offer, quote: { ...offer.quote, reservedCredits: "1" } })) },
      { name: "reordered source", offers: [...prepared.offers].reverse() },
      { name: "borrowed job identity", offers: wrongJob },
      { name: "mixed approved policies", offers: mixedPolicy },
      { name: "omitted source word", offers: omittedWord },
      { name: "aggregate ledger overflow", offers: overflow },
      { name: "unknown envelope", offers: replaceLast(offer => ({ ...offer, extra: true })) },
      { name: "too many segments", offers: Array.from({ length: 251 }, () => prepared.offers[0]) },
    ];
    const offerJson = literal(JSON.stringify(prepared.offers));
    const save = offers => `public.save_narration_chapter_quote_snapshot('${uuid(1)}','${uuid(3)}','${uuid(4)}','${uuid(7)}','${uuid(5)}','${uuid(6)}',
      ${literal(prepared.sourceSha256)},${literal(key)},'synthetic-narration','profile',${offers})`;
    const negatives = badShapes.map(item => `begin
      perform ${save(literal(JSON.stringify(item.offers)) + "::jsonb")};
      raise exception ${literal("invalid whole-chapter offer accepted: " + item.name)};
    exception when invalid_parameter_value or check_violation or unique_violation then null; end;
    assert not exists(select 1 from public.narration_quote_snapshots), 'failed chapter save left partial child offers';
    assert not exists(select 1 from public.narration_chapter_quote_snapshots), 'failed chapter save left an aggregate';
    assert not exists(select 1 from public.narration_chapter_quote_segments), 'failed chapter save left partial links';`).join("\n");
    const result = await sql(`begin;
      insert into auth.users(id,email) values('${uuid(1)}','chapter-quote@local.test'),('${uuid(9)}','chapter-viewer@local.test');
      insert into public.organizations(id,name,slug,owner_user_id) values('${uuid(2)}','Chapter quotes','chapter-quotes','${uuid(1)}');
      insert into public.organization_members(organization_id,user_id,role) values('${uuid(2)}','${uuid(1)}','owner');
      insert into public.workspaces(id,organization_id,name,slug,created_by) values('${uuid(3)}','${uuid(2)}','Chapter','chapter','${uuid(1)}');
      insert into public.workspace_members(workspace_id,user_id,role) values('${uuid(3)}','${uuid(1)}','editor'),('${uuid(3)}','${uuid(9)}','viewer');
      insert into public.books(id,workspace_id,title,author_name,created_by) values('${uuid(4)}','${uuid(3)}','Narration','Author','${uuid(1)}');
      insert into public.chapters(id,book_id,order_index,title) values('${uuid(5)}','${uuid(4)}',0,'Chapter');
      insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
        values('${uuid(6)}','${uuid(5)}',1,'{}',${literal(item.text)},1,'${uuid(1)}');
      update public.chapters set current_document_version_id='${uuid(6)}' where id='${uuid(5)}';
      insert into public.editions(id,book_id,type,language,edition_metadata_json) values('${uuid(7)}','${uuid(4)}','audiobook','en','{"kind":"audiobook"}');
      set local role service_role; set local request.jwt.claims='{"role":"service_role"}';
      do $$ declare saved public.narration_chapter_quote_snapshots; replay public.narration_chapter_quote_snapshots;
        offers jsonb:=${offerJson}::jsonb; child_count integer;
      begin
        assert not has_table_privilege('authenticated','public.narration_chapter_quote_snapshots','select');
        assert not has_table_privilege('authenticated','public.narration_chapter_quote_segments','select');
        assert not has_table_privilege('service_role','public.narration_chapter_quote_snapshots','insert');
        assert not has_table_privilege('service_role','public.narration_chapter_quote_segments','update');
        assert not has_function_privilege('authenticated','public.save_narration_chapter_quote_snapshot(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,jsonb)','execute');
        ${negatives}
        select * into saved from ${save("offers")};
        assert saved.reserved_credits=${literal(prepared.reservedCredits)}::integer and saved.segment_count=${prepared.offers.length}, 'aggregate budget/count drift';
        assert saved.source_sha256=${literal(sha(item.text))} and saved.document_version_id='${uuid(6)}', 'aggregate source identity drift';
        assert saved.voice='marin' and saved.speed=${item.speed} and saved.instructions is not distinct from ${item.instructions === null ? "null" : literal(item.instructions)}, 'delivery settings drift';
        select count(*) into child_count from public.narration_chapter_quote_segments l join public.narration_quote_snapshots c on c.id=l.quote_id
          where l.chapter_quote_id=saved.id and c.request_json=offers->l.segment_index->'request' and c.quote_json=offers->l.segment_index->'quote'
          and l.segment_index=(c.request_json->>'segmentIndex')::integer;
        assert child_count=saved.segment_count, 'atomic child identity or order drift';
        select * into replay from ${save("offers")};
        assert replay.id=saved.id and replay.reserved_credits=saved.reserved_credits, 'chapter retry duplicated its offer';
        assert (select count(*) from public.narration_quote_snapshots)=saved.segment_count, 'chapter retry duplicated children';
        assert not exists(select 1 from public.ai_jobs where workspace_id='${uuid(3)}'), 'chapter quote queued generation';
        assert not exists(select 1 from public.credit_ledger where workspace_id='${uuid(3)}'), 'chapter quote moved credits';
        begin perform public.save_narration_chapter_quote_snapshot('${uuid(9)}','${uuid(3)}','${uuid(4)}','${uuid(7)}','${uuid(5)}','${uuid(6)}',
          saved.source_sha256,'viewer-chapter-key','synthetic-narration','profile',offers);
          raise exception 'viewer saved a chapter offer'; exception when insufficient_privilege then null; end;
        begin perform public.save_narration_chapter_quote_snapshot(saved.user_id,saved.workspace_id,saved.book_id,saved.edition_id,saved.chapter_id,
          saved.document_version_id,saved.source_sha256,saved.idempotency_key,'changed-catalog','changed-option',offers);
          raise exception 'chapter key accepted changed settings'; exception when unique_violation then null; end;
      end $$;
      reset role;
      insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
        values('${uuid(10)}','${uuid(5)}',2,'{}','Changed saved chapter.',1,'${uuid(1)}');
      update public.chapters set current_document_version_id='${uuid(10)}' where id='${uuid(5)}';
      do $$ declare saved public.narration_chapter_quote_snapshots; replay public.narration_chapter_quote_snapshots;
        offers jsonb:=${offerJson}::jsonb;
      begin
        select * into strict saved from public.narration_chapter_quote_snapshots;
        select jsonb_agg(jsonb_build_object('request',value->'request','quote','{}'::jsonb)) into offers from jsonb_array_elements(offers);
        select * into replay from public.save_narration_chapter_quote_snapshot(saved.user_id,saved.workspace_id,saved.book_id,saved.edition_id,
          saved.chapter_id,saved.document_version_id,saved.source_sha256,saved.idempotency_key,'unavailable-catalog',saved.model_option_id,offers);
        assert replay.id=saved.id and replay.catalog_version='synthetic-narration', 'original chapter offer lost after catalog/source change';
        begin update public.narration_chapter_quote_snapshots set reserved_credits=1 where id=saved.id;
          raise exception 'aggregate was mutable'; exception when check_violation then null; end;
        begin update public.narration_chapter_quote_segments set segment_index=249 where chapter_quote_id=saved.id and segment_index=0;
          raise exception 'chapter links were mutable'; exception when check_violation then null; end;
        update public.workspace_members set role='viewer' where workspace_id=saved.workspace_id and user_id=saved.user_id;
        begin perform public.save_narration_chapter_quote_snapshot(saved.user_id,saved.workspace_id,saved.book_id,saved.edition_id,saved.chapter_id,
          saved.document_version_id,saved.source_sha256,saved.idempotency_key,saved.catalog_version,saved.model_option_id,offers);
          raise exception 'revoked writer saved a chapter offer'; exception when insufficient_privilege then null; end;
      end $$;
      select 'chapter-verified'; rollback;`);
    assert.equal(result, "chapter-verified");
    console.log(`PASS narration chapter quote SQL ${item.name}`);
  }
}
