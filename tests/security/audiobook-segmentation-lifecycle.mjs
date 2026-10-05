/** Synthetic inputs only. Runs the production TS segmenter against actual queue SQL. */
import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";

const literal = value => `'${String(value).replaceAll("'", "''")}'`;

export async function verifyAudiobookSegmentationFixtures(sql) {
  const { segmentSpeechText, MAX_TTS_INPUT_BYTES } = await tsImport(
    "../../services/api/src/lib/speech-generation.ts", import.meta.url);
  const cases = [
    { name: "ascii", text: "A".repeat(4_000), instructions: null, limit: 4_096 },
    { name: "unicode-instructions", text: "界".repeat(2_400), instructions: "style ".repeat(120), limit: 4_096 },
    { name: "unicode-whitespace", text: `${"😀 don't narrate ".repeat(210)}\n\n${"終".repeat(200)}`, instructions: "Clear voice", limit: 4_096 },
    { name: "character-limit", text: "A".repeat(4_000), instructions: null, limit: 1_024 },
  ];
  for (const item of cases) {
    const segments = segmentSpeechText(item.text, item.limit, item.instructions);
    const chars = Array.from(item.text);
    for (const segment of segments) {
      assert.equal(chars.slice(segment.start, segment.end).join(""), segment.text);
      assert.ok(Buffer.byteLength(segment.text, "utf8") + Buffer.byteLength(item.instructions ?? "", "utf8") <= MAX_TTS_INPUT_BYTES);
    }
    const payload = segments.map(({ text: _text, ...segment }) => segment);
    const expectedCredits = segments.reduce((total, segment) => total + Math.ceil((segment.end - segment.start) / 1_000), 0);
    // The fixture rolls back, so every case uses a clean account with exactly
    // enough paid operational audio allowance. It does not fund provider calls.
    const result = await sql(`begin;
      insert into auth.users(id,email) values
        ('a6100000-0000-4000-8000-000000000001','audio-segments@local.test'),
        ('a6100000-0000-4000-8000-000000000010','audio-segments-outsider@local.test');
      insert into public.organizations(id,name,slug,owner_user_id)
        values('a6100000-0000-4000-8000-000000000002','Audio segments','audio-segments','a6100000-0000-4000-8000-000000000001');
      insert into public.organization_members(organization_id,user_id,role)
        values('a6100000-0000-4000-8000-000000000002','a6100000-0000-4000-8000-000000000001','owner');
      insert into public.workspaces(id,organization_id,name,slug,created_by)
        values('a6100000-0000-4000-8000-000000000003','a6100000-0000-4000-8000-000000000002','Audio segments','audio-segments','a6100000-0000-4000-8000-000000000001');
      insert into public.workspace_members(workspace_id,user_id,role)
        values('a6100000-0000-4000-8000-000000000003','a6100000-0000-4000-8000-000000000001','editor');
      insert into public.books(id,workspace_id,title,author_name,created_by)
        values('a6100000-0000-4000-8000-000000000004','a6100000-0000-4000-8000-000000000003','Audio segments','Author','a6100000-0000-4000-8000-000000000001');
      insert into public.chapters(id,book_id,order_index,title)
        values('a6100000-0000-4000-8000-000000000005','a6100000-0000-4000-8000-000000000004',0,'Audio');
      insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,word_count,created_by)
        values('a6100000-0000-4000-8000-000000000006','a6100000-0000-4000-8000-000000000005',1,'{}',${literal(item.text)},1,'a6100000-0000-4000-8000-000000000001');
      update public.chapters set current_document_version_id='a6100000-0000-4000-8000-000000000006'
        where id='a6100000-0000-4000-8000-000000000005';
      insert into public.editions(id,book_id,type,language,edition_metadata_json)
        values('a6100000-0000-4000-8000-000000000007','a6100000-0000-4000-8000-000000000004','audiobook','en','{"kind":"audiobook","voice":"marin","speed":1}');
      insert into public.plans(id,name,billing_period,price_cents,entitlements_json)
        values('a6100000-0000-4000-8000-000000000008','Audio segments test','month',1000,'{"audio_credits_monthly":${expectedCredits}}');
      insert into public.subscriptions(organization_id,plan_id,status)
        values('a6100000-0000-4000-8000-000000000002','a6100000-0000-4000-8000-000000000008','active');
      set local role authenticated;
      set local request.jwt.claims='{"sub":"a6100000-0000-4000-8000-000000000001","role":"authenticated"}';
      do $$ declare v_project public.audiobook_projects; v_replay public.audiobook_projects;
        v_segments jsonb := ${literal(JSON.stringify(payload))}::jsonb; v_invalid jsonb;
      begin
        select * into strict v_project from public.queue_audiobook_project(
          'a6100000-0000-4000-8000-000000000007','a6100000-0000-4000-8000-000000000005',
          'marin',${item.instructions === null ? "null" : literal(item.instructions)},1,'audio-segmentation-${item.name}',v_segments);
        assert v_project.segment_count=${segments.length} and v_project.credit_units=${expectedCredits}, 'queue tariff changed';
        assert (select count(*) from public.ai_jobs where workspace_id=v_project.workspace_id)=${segments.length}, 'wrong job count';
        assert not exists(select 1 from public.ai_jobs where workspace_id=v_project.workspace_id
          and input_ref ? 'text'), 'queue leaked manuscript text';
        assert not exists(select 1 from public.audiobook_segments where project_id=v_project.id
          and credit_units<>ceil((text_end-text_start)::numeric/1000)), 'stored segment tariff changed';
        select * into strict v_replay from public.queue_audiobook_project(
          'a6100000-0000-4000-8000-000000000007','a6100000-0000-4000-8000-000000000005',
          'marin',${item.instructions === null ? "null" : literal(item.instructions)},1,'audio-segmentation-${item.name}',v_segments);
        assert v_replay.id=v_project.id, 'replay created another project';
        assert (select count(*) from public.ai_jobs where workspace_id=v_project.workspace_id)=${segments.length}, 'replay reserved twice';
        begin
          perform public.queue_audiobook_project(
            'a6100000-0000-4000-8000-000000000007','a6100000-0000-4000-8000-000000000005',
            'marin',${item.instructions === null ? "null" : literal(item.instructions)},1,'audio-segmentation-exhausted',v_segments);
          raise exception 'exhausted allowance queued more narration';
        exception when check_violation then assert sqlerrm='audio credit capacity exhausted'; end;
        for v_invalid in select jsonb_set(v_segments,'{0,creditUnits}',to_jsonb((v_segments->0->>'creditUnits')::int+v_delta))
          from (values(-1),(1)) deltas(v_delta) loop
          begin
            perform public.queue_audiobook_project(
              'a6100000-0000-4000-8000-000000000007','a6100000-0000-4000-8000-000000000005',
              'marin',${item.instructions === null ? "null" : literal(item.instructions)},1,'audio-segmentation-tampered',v_invalid);
            raise exception 'forged segment tariff accepted';
          exception when invalid_parameter_value then assert sqlerrm='audiobook segment does not match saved text'; end;
        end loop;
        assert (select count(*) from public.audiobook_projects where workspace_id=v_project.workspace_id)=1, 'rejected queue left partial projects';
        assert not exists(select 1 from public.usage_events where workspace_id=v_project.workspace_id), 'queue billed generation before any provider result';
      end $$;
      reset role;
      set local role authenticated;
      set local request.jwt.claims='{"sub":"a6100000-0000-4000-8000-000000000010","role":"authenticated"}';
      do $$ begin
        assert not exists(select 1 from public.audiobook_projects where workspace_id='a6100000-0000-4000-8000-000000000003'), 'non-member read narration';
        begin
          perform public.queue_audiobook_project(
            'a6100000-0000-4000-8000-000000000007','a6100000-0000-4000-8000-000000000005',
            'marin',null,1,'audio-segmentation-foreign',${literal(JSON.stringify(payload))}::jsonb);
          raise exception 'non-member queued narration';
        exception when insufficient_privilege then null; end;
      end $$;
      reset role;
      select 'verified';
      rollback;`);
    assert.equal(result, "verified");
    console.log(`PASS audiobook segmentation SQL ${item.name}`);
  }
}
