/** Production narration calculator and real disposable SQL; no provider/payment.
 * Serial assertions are not multi-connection, PostgREST or Storage acceptance. */
import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";

const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${literal(JSON.stringify(value))}::jsonb`;
const uuid = n => `a6500000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export async function verifyNarrationFundedFixtures(sql) {
  const { prepareNarrationChapterQuote, reconcileNarrationUsage } = await tsImport("../../services/api/src/lib/narration-pricing.ts", import.meta.url);
  for (const item of [
    { name: "ascii", text: "A".repeat(4_000), instructions: null, speed: 1, model: "gpt-realtime-2.1-mini", budget: 1_024 },
    { name: "unicode", text: "\ufeff\u00a0" + "Café 😀. 帰郷。\n".repeat(190) + "\u202f\ufeff", instructions: "Warm, don't rush.", speed: 0.29, model: "gpt-realtime-2.1-mini", budget: 1_024 },
    { name: "full-profile", text: "帰郷の物語。".repeat(300), instructions: null, speed: 1.5, model: "gpt-realtime-2.1", budget: 4_096 },
  ]) {
    const catalog = { version: "funded-narration-fixture", approved: true, approvalReference: "synthetic, never retail activation",
      effectiveAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), quoteLifetimeSeconds: 600,
      entries: [{ id: "profile", label: "Synthetic narration", maxInputTokens: 128_000, maxOutputTokens: item.budget,
        price: { version: "fixture-price", provider: "openai", model: item.model, rates: [
          { dimension: "text_input", microUsdPerMillionTokens: "600000" }, { dimension: "text_cached_input", microUsdPerMillionTokens: "60000" },
          { dimension: "text_output", microUsdPerMillionTokens: "2400000" }, { dimension: "audio_output", microUsdPerMillionTokens: "20000000" },
        ] }, policy: { version: "fixture-policy", approved: true, microUsdPerCredit: "100", markupBasisPoints: 15_000,
          platformMicroUsd: "0", minimumCredits: "1" } }],
    };
    const prepared = prepareNarrationChapterQuote(JSON.stringify(catalog), { modelId: "profile", idempotencyKey: "funded-chapter-fixture",
      now: new Date().toISOString(), sourceText: item.text, userId: uuid(1), workspaceId: uuid(3), bookId: uuid(4), editionId: uuid(7),
      chapterId: uuid(5), documentVersionId: uuid(6), voice: "marin", speed: item.speed, instructions: item.instructions });
    assert(prepared.offers.length > 1);
    const rawUsage = { input_tokens: 37, output_tokens: 10, total_tokens: 47,
      input_token_details: { text_tokens: 37, audio_tokens: 0, cached_tokens: 11,
        cached_tokens_details: { text_tokens: 11, audio_tokens: 0 } },
      output_token_details: { text_tokens: 2, audio_tokens: 8 } };
    const completions = prepared.offers.map(({ request, quote }) => {
      const source = Array.from(item.text).slice(request.textStart, request.textEnd).join("");
      const settlement = reconcileNarrationUsage(quote, { request, sourceText: source,
        receipt: { jobId: request.jobId, userId: request.userId, workspaceId: request.workspaceId,
          requestSha256: quote.scope.inputSha256, sourceSha256: request.textSha256, provider: "openai",
          model: request.model, responseId: `fixture-response-${request.jobId}`, transcript: source, rawUsage } });
      assert.equal(settlement.status, "settle");
      return { jobId: request.jobId, settlement };
    });
    const total = Number(prepared.reservedCredits);
    assert(prepared.offers.slice(0, -1).reduce((sum, offer) => sum + Number(offer.quote.reservedCredits), 0) < total - 1,
      "insufficient-wallet fixture must reach the final segment");
    const badCatalogs = [
      { ...catalog, approved: false }, { ...catalog, version: "changed-catalog" }, { ...catalog, approvalReference: "" },
      { ...catalog, expiresAt: new Date(Date.now() - 1_000).toISOString() },
      { ...catalog, entries: [...catalog.entries, ...catalog.entries] },
      { ...catalog, entries: [{ ...catalog.entries[0], maxInputTokens: "128000" }] },
      { ...catalog, entries: [{ ...catalog.entries[0], maxOutputTokens: item.budget - 1 }] },
      { ...catalog, entries: [{ ...catalog.entries[0], policy: { ...catalog.entries[0].policy, minimumCredits: "2" } }] },
      { ...catalog, entries: [{ ...catalog.entries[0], price: { ...catalog.entries[0].price, rates: [] } }] },
    ];
    const accept = (catalogSql, credits = total, consent = "true") =>
      `public.accept_narration_chapter_quote(saved.id,'${uuid(1)}',${credits},${consent},${catalogSql})`;
    const negatives = badCatalogs.map(value => `begin perform ${accept(json(value))};
      raise exception 'invalid approved narration catalog accepted';
      exception when invalid_parameter_value or check_violation then null; end;`).join("\n");
    const result = await sql(`begin;
      insert into auth.users(id,email) values('${uuid(1)}','funded-audio@local.test'),('${uuid(9)}','funded-viewer@local.test');
      insert into public.organizations(id,name,slug,owner_user_id) values('${uuid(2)}','Funded audio','funded-audio','${uuid(1)}');
      insert into public.organization_members(organization_id,user_id,role) values('${uuid(2)}','${uuid(1)}','owner');
      insert into public.workspaces(id,organization_id,name,slug,created_by) values('${uuid(3)}','${uuid(2)}','Funded','funded','${uuid(1)}');
      insert into public.workspace_members(workspace_id,user_id,role) values('${uuid(3)}','${uuid(1)}','editor'),('${uuid(3)}','${uuid(9)}','viewer');
      insert into public.books(id,workspace_id,title,author_name,created_by) values('${uuid(4)}','${uuid(3)}','Narration','Author','${uuid(1)}');
      insert into public.chapters(id,book_id,order_index,title) values('${uuid(5)}','${uuid(4)}',0,'Chapter');
      insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
        values('${uuid(6)}','${uuid(5)}',1,'{}',${literal(item.text)},1,'${uuid(1)}'),('${uuid(10)}','${uuid(5)}',2,'{}','Changed.',1,'${uuid(1)}');
      update public.chapters set current_document_version_id='${uuid(6)}' where id='${uuid(5)}';
      insert into public.editions(id,book_id,type,language,edition_metadata_json) values('${uuid(7)}','${uuid(4)}','audiobook','en','{"kind":"audiobook"}');
      insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after) values('${uuid(1)}','${uuid(3)}','purchase',${total - 1},0);
      set local role service_role; set local request.jwt.claims='{"role":"service_role"}';
      do $$ declare saved public.narration_chapter_quote_snapshots; project public.audiobook_projects; replay public.audiobook_projects;
        original_catalog jsonb:=${json(catalog)};
      begin
        assert not has_function_privilege('authenticated','public.queue_audiobook_project(uuid,uuid,text,text,numeric,text,jsonb)','execute');
        assert not has_function_privilege('service_role','public.queue_audiobook_project(uuid,uuid,text,text,numeric,text,jsonb)','execute');
        assert not has_function_privilege('service_role','public.claim_audiobook_job(integer)','execute');
        assert not has_function_privilege('authenticated','public.accept_narration_chapter_quote(uuid,uuid,integer,boolean,jsonb)','execute');
        assert not has_table_privilege('authenticated','public.narration_chapter_quote_acceptances','select');
        assert not has_table_privilege('service_role','public.narration_chapter_quote_acceptances','insert');
        select * into saved from public.save_narration_chapter_quote_snapshot('${uuid(1)}','${uuid(3)}','${uuid(4)}','${uuid(7)}','${uuid(5)}','${uuid(6)}',
          ${literal(prepared.sourceSha256)},'funded-chapter-fixture','funded-narration-fixture','profile',${json(prepared.offers)});
        begin perform ${accept("original_catalog", total - 1)}; raise exception 'different maximum confirmation accepted';
          exception when check_violation then null; end;
        begin perform ${accept("original_catalog", total, "false")}; raise exception 'no AI voice consent accepted';
          exception when check_violation then null; end;
        begin perform ${accept("original_catalog", total, "null")}; raise exception 'null AI voice consent accepted';
          exception when check_violation then null; end;
        begin perform public.accept_narration_chapter_quote(saved.id,'${uuid(9)}',${total},true,original_catalog);
          raise exception 'foreign owner accepted narration'; exception when no_data_found then null; end;
        ${negatives}
        begin perform ${accept("original_catalog")}; raise exception 'insufficient wallet accepted all segments';
          exception when check_violation then assert sqlerrm='insufficient credits', 'unexpected insufficient-balance rejection'; end;
        assert not exists(select 1 from public.audiobook_projects where book_id=saved.book_id), 'late failure left partial project';
        assert not exists(select 1 from public.ai_jobs where book_id=saved.book_id), 'late failure left partial jobs';
        assert not exists(select 1 from public.audiobook_segments), 'late failure left partial segments';
        assert not exists(select 1 from public.funded_usage_quotes), 'late failure left partial holds';
        assert not exists(select 1 from public.narration_chapter_quote_acceptances), 'late failure left acceptance';
        assert (select count(*) from public.credit_ledger where user_id=saved.user_id)=1, 'late failure moved money';
        assert not exists(select 1 from public.usage_events), 'quote acceptance used operational audio credits';
      end $$;
      reset role;
      update public.workspace_members set role='viewer' where workspace_id='${uuid(3)}' and user_id='${uuid(1)}';
      set local role service_role;
      do $$ declare saved public.narration_chapter_quote_snapshots; begin
        select * into strict saved from public.narration_chapter_quote_snapshots;
        begin perform ${accept(json(catalog))}; raise exception 'revoked writer accepted narration';
          exception when insufficient_privilege then null; end;
      end $$;
      reset role;
      update public.workspace_members set role='editor' where workspace_id='${uuid(3)}' and user_id='${uuid(1)}';
      update public.chapters set current_document_version_id='${uuid(10)}' where id='${uuid(5)}';
      set local role service_role;
      do $$ declare saved public.narration_chapter_quote_snapshots; begin
        select * into strict saved from public.narration_chapter_quote_snapshots;
        begin perform ${accept(json(catalog))}; raise exception 'changed chapter accepted narration';
          exception when check_violation then null; end;
      end $$;
      reset role;
      update public.chapters set current_document_version_id='${uuid(6)}' where id='${uuid(5)}';
      insert into public.credit_ledger(user_id,workspace_id,source,amount,balance_after) values('${uuid(1)}','${uuid(3)}','purchase',1,0);
      set local role service_role;
      do $$ declare saved public.narration_chapter_quote_snapshots; project public.audiobook_projects; replay public.audiobook_projects;
      begin
        select * into strict saved from public.narration_chapter_quote_snapshots;
        select * into project from ${accept(json(catalog))};
        assert project.billing_mode='quoted' and project.narration_quote_id=saved.id and project.credit_units=${total};
        assert project.segment_count=${prepared.offers.length} and project.document_version_id=saved.document_version_id;
        assert project.voice=saved.voice and project.speed=saved.speed and project.instructions is not distinct from saved.instructions;
        assert (select count(*) from public.audiobook_segments where project_id=project.id)=${prepared.offers.length};
        assert (select count(*) from public.ai_jobs where book_id=saved.book_id and billing_mode='quoted' and status='queued')=${prepared.offers.length};
        assert (select count(*) from public.funded_usage_quotes where user_id=saved.user_id and status='held')=${prepared.offers.length};
        assert (select sum(reserved_credits) from public.funded_usage_quotes where user_id=saved.user_id)=${total};
        assert (select sum(amount) from public.credit_ledger where user_id=saved.user_id)=0, 'incorrect aggregate wallet hold';
        assert (select count(*) from public.credit_ledger where user_id=saved.user_id and source='generation_reservation')=${prepared.offers.length};
        assert (select count(*) from public.narration_chapter_quote_acceptances where quote_id=saved.id and project_id=project.id
          and expected_credits=${total} and ai_disclosure_accepted)=1;
        assert (select count(*) from public.narration_chapter_quote_segments l join public.narration_quote_snapshots c on c.id=l.quote_id
          join public.ai_jobs j on j.id=c.generation_job_id join public.audiobook_segments s on s.ai_job_id=j.id
          join public.funded_usage_quotes f on f.job_id=j.id where l.chapter_quote_id=saved.id
          and j.input_ref->'generationRequest'=c.request_json and j.input_ref->>'requestSha256'=c.request_sha256
          and j.input_ref->>'narrationQuoteId'=c.id::text and j.input_ref->>'audiobookProjectId'=project.id::text
          and s.segment_index=l.segment_index and s.project_id=project.id and s.billing_mode='quoted'
          and f.quote_json=c.quote_json and s.credit_units=f.reserved_credits)=${prepared.offers.length}, 'segment/hold/job snapshot drift';
        assert not exists(select 1 from public.ai_jobs where input_ref ? 'text'), 'copied narration source into queue';
        select * into replay from ${accept("null")};
        assert replay.id=project.id and (select count(*) from public.credit_ledger where source='generation_reservation')=${prepared.offers.length};
        begin update public.audiobook_projects set credit_units=1 where id=project.id; raise exception 'project budget mutated';
          exception when check_violation then null; end;
        begin update public.audiobook_segments set billing_mode='operational' where project_id=project.id; raise exception 'segment billing mode mutated';
          exception when check_violation then null; end;
      end $$;
      reset role;
      -- Exercise actual quoted leases/dispatch, then restore the exact accepted
      -- project so the independent legacy-isolation assertions below still run.
      savepoint narration_leases;
      set local role service_role;
      do $$ declare first_job public.ai_jobs; next_job public.ai_jobs; reclaimed public.ai_jobs; original_lease uuid;
      begin
        assert not has_function_privilege('authenticated','public.claim_quoted_narration_job(integer)','execute');
        assert not has_function_privilege('authenticated','public.renew_quoted_narration_lease(uuid,uuid,integer)','execute');
        assert not has_function_privilege('authenticated','public.release_quoted_narration_before_dispatch(uuid,uuid,text)','execute');
        assert not has_function_privilege('authenticated','public.hold_quoted_narration_for_review(uuid,uuid,text,text)','execute');
        assert not has_table_privilege('authenticated','public.quoted_narration_receipts','select');
        assert not has_table_privilege('service_role','public.quoted_narration_receipts','insert');
        assert not has_table_privilege('service_role','public.quoted_narration_receipts','update');
        assert not has_function_privilege('authenticated','public.save_quoted_narration_receipt(uuid,uuid,text,jsonb)','execute');
        begin perform public.claim_quoted_narration_job(29); raise exception 'short narration lease accepted';
          exception when invalid_parameter_value then null; end;
        begin perform public.claim_quoted_narration_job(null); raise exception 'null narration lease accepted';
          exception when invalid_parameter_value then null; end;
        select * into strict first_job from public.claim_quoted_narration_job(180);
        original_lease:=first_job.lease_token;
        assert first_job.billing_mode='quoted' and first_job.agent_type='narrator' and first_job.status='running';
        assert first_job.attempts=1 and first_job.lease_expires_at>clock_timestamp();
        assert (select status from public.audiobook_projects)='running';
        loop
          select * into next_job from public.claim_quoted_narration_job(180);
          exit when not found;
          assert next_job.id<>first_job.id, 'live narration lease reclaimed';
        end loop;
        assert (select count(*) from public.ai_jobs where status='running')=${prepared.offers.length};
        assert not public.renew_quoted_narration_lease(first_job.id,'${uuid(99)}',180);
        assert public.renew_quoted_narration_lease(first_job.id,original_lease,180);
        begin perform public.release_quoted_narration_before_dispatch(first_job.id,'${uuid(99)}','source_changed');
          raise exception 'foreign lease released narration'; exception when serialization_failure then null; end;
        begin perform public.hold_quoted_narration_for_review(first_job.id,original_lease,'provider_outcome_unknown','fixture-review');
          raise exception 'undispatched narration entered review'; exception when check_violation then null; end;
        begin perform public.claim_funded_dispatch(first_job.id,original_lease,repeat('0',64),first_job.model);
          raise exception 'wrong narration dispatch hash accepted'; exception when invalid_parameter_value then null; end;
        assert not exists(select 1 from public.funded_usage_quotes where dispatched_at is not null);
        update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=first_job.id;
        select * into strict reclaimed from public.claim_quoted_narration_job(180);
        assert reclaimed.id=first_job.id and reclaimed.lease_token<>original_lease and reclaimed.attempts=2;
        assert not public.renew_quoted_narration_lease(first_job.id,original_lease,180);
        begin perform public.claim_funded_dispatch(first_job.id,original_lease,first_job.input_ref->>'requestSha256',first_job.model);
          raise exception 'old lease dispatched narration'; exception when serialization_failure then null; end;
      end $$;
      reset role;
      update public.workspace_members set role='designer' where workspace_id='${uuid(3)}' and user_id='${uuid(1)}';
      set local role service_role;
      do $$ declare j public.ai_jobs; begin
        select * into j from public.ai_jobs order by created_at,id limit 1;
        begin perform public.claim_funded_dispatch(j.id,j.lease_token,j.input_ref->>'requestSha256',j.model);
          raise exception 'non-writer dispatched narration'; exception when insufficient_privilege then null; end;
        assert not exists(select 1 from public.funded_usage_quotes where dispatched_at is not null);
      end $$;
      reset role;
      update public.workspace_members set role='editor' where workspace_id='${uuid(3)}' and user_id='${uuid(1)}';
      update public.chapters set current_document_version_id='${uuid(10)}' where id='${uuid(5)}';
      set local role service_role;
      do $$ declare j public.ai_jobs; begin
        select * into j from public.ai_jobs order by created_at,id limit 1;
        begin perform public.claim_funded_dispatch(j.id,j.lease_token,j.input_ref->>'requestSha256',j.model);
          raise exception 'changed source dispatched narration'; exception when check_violation then null; end;
        assert not exists(select 1 from public.funded_usage_quotes where dispatched_at is not null);
      end $$;
      reset role;
      update public.chapters set current_document_version_id='${uuid(6)}' where id='${uuid(5)}';
      set local role service_role;
      do $$ declare j public.ai_jobs; receipt jsonb; saved public.quoted_narration_receipts; replay public.quoted_narration_receipts;
      begin
        select * into j from public.ai_jobs order by created_at,id limit 1;
        receipt:=jsonb_build_object('version','bookworm-narration-pcm-v1','provider','openai','model',j.model,'requestId','fixture-response',
          'sourceSha256',j.input_ref#>>'{generationRequest,textSha256}',
          'storagePath',format('private/narration/%s/%s/%s.pcm',j.workspace_id,j.id,j.lease_token),
          'mimeType','audio/pcm','sizeBytes',48000,'checksum',repeat('a',64),'sampleRateHz',24000,'channels',1,'bitDepth',16,
          'durationSeconds',1,'transcript','Private synthetic provider transcript; not verified audio.',
          'rawUsage',jsonb_build_object('new_unsupported_counter',1),'latencyMs',10);
        begin perform public.save_quoted_narration_receipt(j.id,j.lease_token,j.input_ref->>'requestSha256',receipt);
          raise exception 'undispatched PCM receipt accepted'; exception when check_violation then null; end;
        assert public.claim_funded_dispatch(j.id,j.lease_token,j.input_ref->>'requestSha256',j.model);
        assert not public.claim_funded_dispatch(j.id,j.lease_token,j.input_ref->>'requestSha256',j.model);
        assert (select dispatched_lease from public.funded_usage_quotes where job_id=j.id)=j.lease_token;
        begin perform public.save_quoted_narration_receipt(j.id,'${uuid(99)}',j.input_ref->>'requestSha256',receipt);
          raise exception 'foreign PCM receipt lease accepted'; exception when serialization_failure then null; end;
        begin perform public.save_quoted_narration_receipt(j.id,j.lease_token,repeat('0',64),receipt);
          raise exception 'foreign PCM request identity accepted'; exception when check_violation then null; end;
        begin perform public.save_quoted_narration_receipt(j.id,j.lease_token,j.input_ref->>'requestSha256',receipt||'{"sizeBytes":48001}');
          raise exception 'odd-length PCM accepted'; exception when invalid_parameter_value then null; end;
        begin perform public.save_quoted_narration_receipt(j.id,j.lease_token,j.input_ref->>'requestSha256',receipt||'{"durationSeconds":2}');
          raise exception 'invented PCM duration accepted'; exception when invalid_parameter_value then null; end;
        begin perform public.save_quoted_narration_receipt(j.id,j.lease_token,j.input_ref->>'requestSha256',receipt||'{"mimeType":"audio/mpeg"}');
          raise exception 'MP3 substituted for original PCM'; exception when invalid_parameter_value then null; end;
        begin perform public.save_quoted_narration_receipt(j.id,j.lease_token,j.input_ref->>'requestSha256',receipt||'{"model":"changed"}');
          raise exception 'unbound provider model accepted'; exception when invalid_parameter_value then null; end;
        begin perform public.save_quoted_narration_receipt(j.id,j.lease_token,j.input_ref->>'requestSha256',receipt||'{"unknownField":true}');
          raise exception 'unbounded receipt projection accepted'; exception when invalid_parameter_value then null; end;
        begin perform public.save_quoted_narration_receipt(j.id,j.lease_token,j.input_ref->>'requestSha256',receipt||jsonb_build_object(
          'storagePath','workspaces/${uuid(3)}/assets/${uuid(21)}/v1/generated.pcm'));
          raise exception 'public asset path substituted for private PCM'; exception when invalid_parameter_value then null; end;
        select * into saved from public.save_quoted_narration_receipt(j.id,j.lease_token,j.input_ref->>'requestSha256',receipt);
        select * into replay from public.save_quoted_narration_receipt(j.id,j.lease_token,j.input_ref->>'requestSha256',receipt);
        assert replay.job_id=saved.job_id and replay.receipt_sha256=saved.receipt_sha256 and replay.receipt_json=receipt;
        assert saved.receipt_sha256=encode(public.digest(convert_to(receipt::text,'UTF8'),'sha256'),'hex');
        assert saved.receipt_json->'rawUsage'='{"new_unsupported_counter":1}', 'original unsupported usage was discarded';
        assert (select count(*) from public.quoted_narration_receipts)=1;
        begin perform public.save_quoted_narration_receipt(j.id,j.lease_token,j.input_ref->>'requestSha256',receipt||'{"transcript":"changed"}');
          raise exception 'original provider transcript overwritten'; exception when unique_violation then null; end;
        assert not exists(select 1 from public.assets) and not exists(select 1 from public.usage_events);
        assert (select sum(amount) from public.credit_ledger)=0, 'private PCM receipt prematurely settled money';
        begin perform public.release_quoted_narration_before_dispatch(j.id,j.lease_token,'provider_not_configured');
          raise exception 'dispatched narration refunded'; exception when check_violation then null; end;
        update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=j.id;
      end $$;
      reset role;
      insert into storage.objects(bucket_id,name)
        select 'book-assets',receipt_json->>'storagePath' from public.quoted_narration_receipts;
      set local role authenticated; set local request.jwt.claims='{"role":"authenticated","sub":"${uuid(1)}"}';
      do $$ begin
        assert not exists(select 1 from storage.objects where name like 'private/narration/%'), 'private original PCM exposed to author';
        begin perform 1 from public.quoted_narration_receipts;
          raise exception 'private provider receipt exposed to author'; exception when insufficient_privilege then null; end;
      end $$;
      reset role; set local request.jwt.claims='{"role":"service_role"}';
      -- Recovery of dispatched work is not a new generation permission. Source
      -- and access changes must not cause a refund or second provider request.
      update public.workspace_members set role='viewer' where workspace_id='${uuid(3)}' and user_id='${uuid(1)}';
      update public.chapters set current_document_version_id='${uuid(10)}' where id='${uuid(5)}';
      set local role service_role;
      do $$ declare recovered public.ai_jobs; q public.funded_usage_quotes;
      begin
        select * into strict recovered from public.claim_quoted_narration_job(180);
        assert recovered.attempts=3;
        assert (select count(*) from public.quoted_narration_receipts where job_id=recovered.id)=1, 'original PCM receipt lost on reclaim';
        assert (select receipt_json->'rawUsage' from public.quoted_narration_receipts where job_id=recovered.id)='{"new_unsupported_counter":1}';
        perform public.save_quoted_narration_receipt(recovered.id,recovered.lease_token,recovered.input_ref->>'requestSha256',
          (select receipt_json from public.quoted_narration_receipts where job_id=recovered.id));
        assert not public.claim_funded_dispatch(recovered.id,recovered.lease_token,recovered.input_ref->>'requestSha256',recovered.model);
        begin perform public.hold_quoted_narration_for_review(recovered.id,'${uuid(99)}','provider_outcome_unknown','fixture-review');
          raise exception 'foreign lease reviewed narration'; exception when serialization_failure then null; end;
        assert public.hold_quoted_narration_for_review(recovered.id,recovered.lease_token,'provider_outcome_unknown','fixture-review');
        select * into strict q from public.funded_usage_quotes where job_id=recovered.id;
        assert q.status='requires_review' and q.settlement_json->>'heldCredits'=q.reserved_credits::text;
        assert (select sum(amount) from public.credit_ledger)=0, 'dispatched review refunded money';
        assert (select status from public.ai_jobs where id=recovered.id)='failed';
        assert (select status from public.audiobook_projects)='failed';
        update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where status='running';
        assert not exists(select 1 from public.claim_quoted_narration_job(180)), 'failed chapter dispatched another segment';
        assert (select count(*) from public.funded_usage_quotes where status='cancelled')=${prepared.offers.length - 1};
        assert (select sum(amount) from public.credit_ledger)=${total}-q.reserved_credits;
        assert (select count(*) from public.credit_ledger where source='generation_release')=${prepared.offers.length - 1};
        assert not exists(select 1 from public.claim_quoted_narration_job(180));
        assert (select count(*) from public.credit_ledger where source='generation_release')=${prepared.offers.length - 1};
        assert not exists(select 1 from public.assets) and not exists(select 1 from public.usage_events);
      end $$;
      reset role;
      rollback to savepoint narration_leases;
      release savepoint narration_leases;
      savepoint narration_access_release;
      update public.workspace_members set role='viewer' where workspace_id='${uuid(3)}' and user_id='${uuid(1)}';
      set local role service_role;
      do $$ begin
        assert not exists(select 1 from public.claim_quoted_narration_job(180));
        assert (select count(*) from public.funded_usage_quotes where status='cancelled')=${prepared.offers.length};
        assert (select sum(amount) from public.credit_ledger)=${total};
        assert not exists(select 1 from public.claim_quoted_narration_job(180));
        assert (select count(*) from public.credit_ledger where source='generation_release')=${prepared.offers.length};
      end $$;
      reset role;
      rollback to savepoint narration_access_release;
      release savepoint narration_access_release;
      savepoint narration_source_release;
      update public.chapters set current_document_version_id='${uuid(10)}' where id='${uuid(5)}';
      set local role service_role;
      do $$ begin
        assert not exists(select 1 from public.claim_quoted_narration_job(180));
        assert (select count(*) from public.funded_usage_quotes where status='cancelled')=${prepared.offers.length};
        assert (select sum(amount) from public.credit_ledger)=${total};
        assert not exists(select 1 from public.assets) and not exists(select 1 from public.usage_events);
      end $$;
      reset role;
      rollback to savepoint narration_source_release;
      release savepoint narration_source_release;
      savepoint narration_missing_original;
      set local role service_role;
      do $$ declare original public.ai_jobs; reclaimed public.ai_jobs; receipt jsonb;
      begin
        select * into strict original from public.claim_quoted_narration_job(180);
        assert public.claim_funded_dispatch(original.id,original.lease_token,original.input_ref->>'requestSha256',original.model);
        update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=original.id;
        select * into strict reclaimed from public.claim_quoted_narration_job(180);
        assert reclaimed.id=original.id and reclaimed.lease_token<>original.lease_token;
        receipt:=jsonb_build_object('version','bookworm-narration-pcm-v1','provider','openai','model',original.model,'requestId','fixture-response',
          'sourceSha256',original.input_ref#>>'{generationRequest,textSha256}',
          'storagePath',format('private/narration/%s/%s/%s.pcm',original.workspace_id,original.id,original.lease_token),
          'mimeType','audio/pcm','sizeBytes',48000,'checksum',repeat('a',64),'sampleRateHz',24000,'channels',1,'bitDepth',16,
          'durationSeconds',1,'transcript','Synthetic original missing.', 'rawUsage',null,'latencyMs',10);
        begin perform public.save_quoted_narration_receipt(original.id,original.lease_token,original.input_ref->>'requestSha256',receipt);
          raise exception 'expired capture lease saved PCM'; exception when serialization_failure then null; end;
        begin perform public.save_quoted_narration_receipt(reclaimed.id,reclaimed.lease_token,reclaimed.input_ref->>'requestSha256',receipt);
          raise exception 'replacement worker manufactured original provider result'; exception when serialization_failure then null; end;
        assert not exists(select 1 from public.quoted_narration_receipts);
        assert (select sum(amount) from public.credit_ledger)=0;
      end $$;
      reset role;
      rollback to savepoint narration_missing_original;
      release savepoint narration_missing_original;
      savepoint narration_measured_completion;
      -- A fixture-only late failure fires after assets/usage/job/ledger have
      -- already changed. It must roll back the entire completion transaction.
      create function pg_temp.fail_late_narration_completion() returns trigger language plpgsql as $late$
      declare job uuid;
      begin
        if new.event_type='audiobook_segment_generated' and current_setting('bookworm_fixture.fail_late_narration',true)='true' then
          job:=(new.payload_json->>'aiJobId')::uuid;
          assert (select status from public.funded_usage_quotes where job_id=job)='settled', 'late failure ran before settlement';
          assert exists(select 1 from public.assets where id=job), 'late failure ran before asset publication';
          assert exists(select 1 from public.usage_events where ai_job_id=job and meter='token_credits'), 'late failure ran before measured usage';
          assert exists(select 1 from public.credit_ledger where source='generation_release' and reference_id=job), 'late failure ran before hold release';
          raise exception 'fixture late narration failure' using errcode='P0501';
        end if;
        return new;
      end $late$;
      create trigger fixture_late_narration_failure after insert on public.activity_events
        for each row execute function pg_temp.fail_late_narration_completion();
      set local role service_role;
      do $$ declare j public.ai_jobs; pcm jsonb; encoded jsonb; original public.quoted_narration_receipts;
        saved public.quoted_narration_encodings; repeated public.quoted_narration_encodings; completed public.ai_jobs;
        expected jsonb; item jsonb; path text; bad_usage jsonb; previous_lease uuid; balance_before bigint;
      begin
        assert not has_table_privilege('authenticated','public.quoted_narration_encodings','select');
        assert not has_table_privilege('service_role','public.quoted_narration_encodings','insert');
        assert not has_function_privilege('authenticated','public.save_quoted_narration_encoding(uuid,uuid,text,jsonb)','execute');
        assert not has_function_privilege('authenticated','public.complete_quoted_narration_job(uuid,uuid)','execute');
        for item in select value from jsonb_array_elements(${json(completions)}) loop
          select * into strict j from public.claim_quoted_narration_job(180);
          select value->'settlement' into strict expected from jsonb_array_elements(${json(completions)})
            where value->>'jobId'=j.id::text;
          assert public.claim_funded_dispatch(j.id,j.lease_token,j.input_ref->>'requestSha256',j.model);
          select format('workspaces/%s/audiobooks/%s/%s.mp3',j.workspace_id,s.project_id,s.segment_index)
            into path from public.audiobook_segments s where s.ai_job_id=j.id;
          pcm:=jsonb_build_object('version','bookworm-narration-pcm-v1','provider','openai','model',j.model,
            'requestId','fixture-response-'||j.id::text,'sourceSha256',j.input_ref#>>'{generationRequest,textSha256}',
            'storagePath',format('private/narration/%s/%s/%s.pcm',j.workspace_id,j.id,j.lease_token),
            'mimeType','audio/pcm','sizeBytes',48000,'checksum',repeat('a',64),'sampleRateHz',24000,'channels',1,
            'bitDepth',16,'durationSeconds',1,'latencyMs',10,'rawUsage',${json(rawUsage)},
            'transcript',(select substring(d.plain_text from s.text_start+1 for s.text_end-s.text_start)
              from public.document_versions d join public.audiobook_segments s on s.ai_job_id=j.id
              where d.id=(j.input_ref#>>'{generationRequest,documentVersionId}')::uuid));
          -- Unknown, lossy, cached and unbalanced original measurements may be
          -- retained as evidence, but cannot authorize a customer bill.
          for bad_usage in select value from jsonb_array_elements(${json([
            { ...rawUsage, unsupported_new_field: 1 },
            { ...rawUsage, input_token_details: { ...rawUsage.input_token_details, cached_tokens_details: undefined } },
            { ...rawUsage, total_tokens: 48 },
            { ...rawUsage, output_token_details: { text_tokens: 2, audio_tokens: 8, image_tokens: 0 } },
            { ...rawUsage, input_token_details: { ...rawUsage.input_token_details,
              cached_tokens_details: { text_tokens: 11, audio_tokens: 1 } } },
          ])}) loop
            begin
              perform public.save_quoted_narration_receipt(j.id,j.lease_token,j.input_ref->>'requestSha256',pcm||jsonb_build_object('rawUsage',bad_usage));
              perform bookworm_private.narration_receipt_settlement(j.id);
              raise exception 'unsupported original narration usage billed';
            exception when check_violation then null; end;
          end loop;
          begin
            perform public.save_quoted_narration_receipt(j.id,j.lease_token,j.input_ref->>'requestSha256',pcm||'{"transcript":"Changed source."}');
            perform bookworm_private.narration_receipt_settlement(j.id);
            raise exception 'changed narration transcript billed';
          exception when check_violation then null; end;
          begin
            perform public.save_quoted_narration_receipt(j.id,j.lease_token,j.input_ref->>'requestSha256',
              pcm||jsonb_build_object('transcript',U&'\\FEFF'||replace(normalize(pcm->>'transcript',NFD),' ',U&'\\00A0')||U&'\\00A0'));
            assert bookworm_private.narration_receipt_settlement(j.id)=expected, 'supported Unicode transcript normalization changed bill';
            raise exception 'fixture normalization rollback' using errcode='P0502';
          exception when sqlstate 'P0502' then null; end;
          select * into original from public.save_quoted_narration_receipt(j.id,j.lease_token,j.input_ref->>'requestSha256',pcm);
          assert bookworm_private.narration_receipt_settlement(j.id)=expected, 'SQL bill differs from production integer calculator';
          begin perform public.complete_quoted_narration_job(j.id,j.lease_token);
            raise exception 'completion without encoded receipt accepted'; exception when check_violation then null; end;
          begin perform public.settle_funded_usage_quote(j.id,expected);
            raise exception 'direct narration settlement bypassed atomic publication'; exception when check_violation then null; end;
          assert (select status from public.funded_usage_quotes where job_id=j.id)='held';
          encoded:=jsonb_build_object('version','bookworm-narration-mp3-v1','pcmReceiptSha256',original.receipt_sha256,
            'assetId',j.id,'storagePath',path,'mimeType','audio/mpeg','sizeBytes',1024,'checksum',repeat('b',64),
            'durationSeconds',1,'encodingVersion','narration-mp3-1.0.0','sampleRateHz',44100,'channels',1,
            'bitRateKbps',192,'bitRateMode','cbr');
          begin perform public.save_quoted_narration_encoding(j.id,'${uuid(99)}',original.receipt_sha256,encoded);
            raise exception 'foreign encoding lease accepted'; exception when serialization_failure then null; end;
          begin perform public.save_quoted_narration_encoding(j.id,j.lease_token,repeat('0',64),encoded);
            raise exception 'foreign PCM encoding identity accepted'; exception when check_violation then null; end;
          begin perform public.save_quoted_narration_encoding(j.id,j.lease_token,original.receipt_sha256,encoded||'{"durationSeconds":2}');
            raise exception 'invented encoded duration accepted'; exception when invalid_parameter_value then null; end;
          begin perform public.save_quoted_narration_encoding(j.id,j.lease_token,original.receipt_sha256,encoded||'{"bitRateKbps":96}');
            raise exception 'wrong MP3 profile accepted'; exception when invalid_parameter_value then null; end;
          select * into saved from public.save_quoted_narration_encoding(j.id,j.lease_token,original.receipt_sha256,encoded);
          select * into repeated from public.save_quoted_narration_encoding(j.id,j.lease_token,original.receipt_sha256,encoded);
          assert repeated.receipt_sha256=saved.receipt_sha256;
          begin perform public.save_quoted_narration_encoding(j.id,j.lease_token,original.receipt_sha256,encoded||jsonb_build_object('checksum',repeat('c',64)));
            raise exception 'encoded receipt replaced'; exception when unique_violation then null; end;
          begin perform public.complete_quoted_narration_job(j.id,'${uuid(99)}');
            raise exception 'foreign narration completion lease accepted'; exception when serialization_failure then null; end;
          -- Asset collision must roll back every completion side effect.
          begin
            insert into public.assets(id,workspace_id,type,name,storage_path,mime_type,size_bytes,checksum,status,created_by)
              values(j.id,j.workspace_id,'audiobook_segment','Collision',path,'audio/mpeg',1024,repeat('b',64),'draft',j.created_by);
            perform public.complete_quoted_narration_job(j.id,j.lease_token);
            raise exception 'narration asset collision accepted';
          exception when unique_violation then null; end;
          assert (select status from public.ai_jobs where id=j.id)='running';
          assert (select status from public.funded_usage_quotes where job_id=j.id)='held';
          assert not exists(select 1 from public.assets where id=j.id);
          select coalesce(sum(amount),0) into balance_before from public.credit_ledger;
          perform set_config('bookworm_fixture.fail_late_narration','true',true);
          begin
            perform public.complete_quoted_narration_job(j.id,j.lease_token);
            raise exception 'late narration failure did not fire';
          exception when sqlstate 'P0501' then null; end;
          perform set_config('bookworm_fixture.fail_late_narration','false',true);
          assert (select status from public.ai_jobs where id=j.id)='running';
          assert (select status from public.funded_usage_quotes where job_id=j.id)='held';
          assert (select coalesce(sum(amount),0) from public.credit_ledger)=balance_before, 'late rollback changed wallet';
          assert not exists(select 1 from public.assets where id=j.id);
          assert not exists(select 1 from public.asset_versions where asset_id=j.id);
          assert not exists(select 1 from public.ai_runs where ai_job_id=j.id);
          assert not exists(select 1 from public.usage_events where ai_job_id=j.id);
          assert not exists(select 1 from public.activity_events where payload_json->>'aiJobId'=j.id::text);
          assert (select asset_id from public.audiobook_segments where ai_job_id=j.id) is null;
          assert (select count(*) from public.quoted_narration_encodings where job_id=j.id)=1, 'late rollback lost original encoding';
          previous_lease:=j.lease_token;
          update public.ai_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=j.id;
          begin perform public.save_quoted_narration_encoding(j.id,previous_lease,original.receipt_sha256,encoded);
            raise exception 'expired lease replayed encoding'; exception when serialization_failure then null; end;
          begin perform public.complete_quoted_narration_job(j.id,previous_lease);
            raise exception 'expired lease completed narration'; exception when serialization_failure then null; end;
          select * into strict j from public.claim_quoted_narration_job(180);
          assert j.id=original.job_id and j.lease_token<>previous_lease, 'encoding recovery claimed another job';
          select * into repeated from public.save_quoted_narration_encoding(j.id,j.lease_token,original.receipt_sha256,encoded);
          assert repeated.receipt_sha256=saved.receipt_sha256, 'reclaim replaced original encoded receipt';
          assert not public.claim_funded_dispatch(j.id,j.lease_token,j.input_ref->>'requestSha256',j.model), 'encoded recovery redispatched';
          select * into completed from public.complete_quoted_narration_job(j.id,j.lease_token);
          assert completed.status='succeeded' and completed.output_ref->>'assetId'=j.id::text;
          assert (select settlement_json from public.funded_usage_quotes where job_id=j.id)=expected;
          assert (select count(*) from public.asset_versions where asset_id=j.id and scan_status='trusted_generated')=1;
          assert (select count(*) from public.usage_events where ai_job_id=j.id and meter='token_credits'
            and quantity=(expected->>'debitCredits')::numeric)=1;
          assert not exists(select 1 from public.usage_events where ai_job_id=j.id and meter='audio_credits');
          assert (select count(*) from public.ai_runs where ai_job_id=j.id)=1;
          assert completed.usage_json->>'inputTokens'='37' and completed.usage_json->>'outputTokens'='10';
          assert not(completed.usage_json ? 'rawUsage') and not(completed.usage_json ? 'transcript');
          perform public.complete_quoted_narration_job(j.id,'${uuid(99)}');
          assert (select count(*) from public.usage_events where ai_job_id=j.id)=1, 'completion replay billed again';
        end loop;
        assert (select status from public.audiobook_projects)='succeeded';
        assert (select count(*) from public.assets)=${prepared.offers.length};
        assert (select sum(amount) from public.credit_ledger)=${total}-
          (select sum((value#>>'{settlement,debitCredits}')::integer) from jsonb_array_elements(${json(completions)}));
      end $$;
      reset role;
      rollback to savepoint narration_measured_completion;
      release savepoint narration_measured_completion;
      -- Privilege loan tests the dormant legacy implementation as defense in
      -- depth. Revoke before returning; no runtime creation/claim is restored.
      grant execute on function public.claim_audiobook_job(integer) to service_role;
      set local role service_role;
      do $$ declare j public.ai_jobs; begin
        assert not exists(select 1 from public.claim_audiobook_job(600)), 'legacy claim consumed a funded narration';
        select * into strict j from public.ai_jobs order by id limit 1;
        update public.ai_jobs set status='running',lease_token='${uuid(20)}',lease_expires_at=clock_timestamp()+interval '5 minutes' where id=j.id;
        assert not public.renew_audiobook_lease(j.id,'${uuid(20)}',600), 'legacy renew touched quoted narration';
        begin perform public.fail_audiobook_job(j.id,'${uuid(20)}','fixture_failure','Synthetic',false);
          raise exception 'legacy failure mutated quoted narration'; exception when check_violation then null; end;
        begin perform public.complete_audiobook_segment(j.id,'${uuid(20)}','${uuid(21)}','fixture.mp3','audio/mpeg',20,repeat('a',64),
          'openai','fixture-model','fixture-response','{"inputTokens":1,"outputTokens":1,"estimatedCostUsd":0,"latencyMs":1}');
          raise exception 'legacy completion accepted quoted narration'; exception when check_violation then null; end;
        begin insert into public.usage_events(ai_job_id,organization_id,user_id,workspace_id,meter,quantity)
          values(j.id,'${uuid(2)}','${uuid(1)}','${uuid(3)}','audio_credits',1);
          raise exception 'operational charge accepted quoted narration'; exception when check_violation then null; end;
        assert not exists(select 1 from public.assets), 'legacy completion published quoted output';
        assert not exists(select 1 from public.usage_events), 'quoted narration double billed';
        assert (select count(*) from public.funded_usage_quotes where status='held')=${prepared.offers.length};
      end $$;
      reset role;
      revoke all on function public.claim_audiobook_job(integer) from public,anon,authenticated,service_role;
      update public.chapters set current_document_version_id='${uuid(10)}' where id='${uuid(5)}';
      set local role service_role;
      do $$ declare saved public.narration_chapter_quote_snapshots; original uuid; replay public.audiobook_projects;
      begin
        select * into strict saved from public.narration_chapter_quote_snapshots;
        select project_id into strict original from public.narration_chapter_quote_acceptances where quote_id=saved.id;
        select * into replay from ${accept("null")};
        assert replay.id=original, 'original accepted chapter lost after source/catalog change';
        assert (select count(*) from public.audiobook_projects)=1 and (select sum(amount) from public.credit_ledger)=0;
      end $$;
      reset role; set local role authenticated; set local request.jwt.claims='{"role":"authenticated","sub":"${uuid(9)}"}';
      do $$ begin assert (select count(*) from public.audiobook_projects)=1, 'member history lost'; end $$;
      set local request.jwt.claims='{"role":"authenticated","sub":"${uuid(99)}"}';
      do $$ begin assert not exists(select 1 from public.audiobook_projects), 'foreign user saw narration'; end $$;
      reset role; select 'funded-chapter-verified'; rollback;`);
    assert.equal(result, "funded-chapter-verified");
    console.log(`PASS narration funded chapter SQL ${item.name}`);
  }
}
