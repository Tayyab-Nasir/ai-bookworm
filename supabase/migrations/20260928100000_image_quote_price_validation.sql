-- Validate server-created image offers independently before any future funding.
-- Does not enable quoted image jobs or change operational allowance triggers.
create function public.validate_image_quote_price(p_quote jsonb) returns void
language plpgsql set search_path=public,pg_temp as $$
declare d text; rate jsonb; quantity jsonb; cost numeric:=0; credits numeric;
begin
  if jsonb_typeof(p_quote) is distinct from 'object'
    or p_quote#>>'{price,provider}' is distinct from 'openai'
    or p_quote#>'{policy,approved}' is distinct from 'true'::jsonb
    or jsonb_typeof(p_quote#>'{price,rates}') is distinct from 'array'
    or jsonb_typeof(p_quote->'maximumTokens') is distinct from 'array' then
    raise exception 'invalid image quote pricing shape' using errcode='22023'; end if;
  if jsonb_array_length(p_quote#>'{price,rates}')<>4 or jsonb_array_length(p_quote->'maximumTokens')<>4
    or coalesce(p_quote#>>'{price,version}','')='' or coalesce(p_quote#>>'{policy,version}','')=''
    or coalesce(p_quote#>>'{policy,microUsdPerCredit}','') !~ '^[1-9][0-9]{0,20}$'
    or coalesce(p_quote#>>'{policy,markupBasisPoints}','') !~ '^[1-9][0-9]{0,6}$'
    or coalesce(p_quote#>>'{policy,platformMicroUsd}','') !~ '^(0|[1-9][0-9]{0,20})$'
    or coalesce(p_quote#>>'{policy,minimumCredits}','') !~ '^[1-9][0-9]{0,20}$'
    or coalesce(p_quote->>'maximumProviderMicroUsd','') !~ '^(0|[1-9][0-9]{0,20})$'
    or coalesce(p_quote->>'reservedCredits','') !~ '^[1-9][0-9]{0,9}$' then
    raise exception 'invalid image quote pricing values' using errcode='22023'; end if;
  if (p_quote#>>'{policy,markupBasisPoints}')::numeric not between 10000 and 1000000 then
    raise exception 'invalid image quote markup' using errcode='22023'; end if;
  foreach d in array array['text_input','image_input','text_output','image_output'] loop
    if (select count(*) from jsonb_array_elements(p_quote#>'{price,rates}') r where r->>'dimension'=d)<>1
      or (select count(*) from jsonb_array_elements(p_quote->'maximumTokens') q where q->>'dimension'=d)<>1 then
      raise exception 'image quote dimensions must be unique and complete' using errcode='22023'; end if;
    select value into rate from jsonb_array_elements(p_quote#>'{price,rates}') where value->>'dimension'=d;
    select value into quantity from jsonb_array_elements(p_quote->'maximumTokens') where value->>'dimension'=d;
    if coalesce(rate->>'microUsdPerMillionTokens','') !~ '^(0|[1-9][0-9]{0,20})$'
      or coalesce(quantity->>'tokens','') !~ '^(0|[1-9][0-9]{0,15})$'
      or (quantity->>'tokens')::numeric>9007199254740991 then
      raise exception 'invalid image token rate or quantity' using errcode='22023'; end if;
    cost:=cost+(rate->>'microUsdPerMillionTokens')::numeric*(quantity->>'tokens')::numeric;
  end loop;
  credits:=greatest((p_quote#>>'{policy,minimumCredits}')::numeric,
    ceil((cost+(p_quote#>>'{policy,platformMicroUsd}')::numeric*1000000)
      *(p_quote#>>'{policy,markupBasisPoints}')::numeric
      /(1000000::numeric*10000*(p_quote#>>'{policy,microUsdPerCredit}')::numeric)));
  if credits>2147483647 or (p_quote->>'reservedCredits')::numeric is distinct from credits
    or (p_quote->>'maximumProviderMicroUsd')::numeric is distinct from ceil(cost/1000000) then
    raise exception 'image quote credit arithmetic mismatch' using errcode='23514'; end if;
end $$;
revoke all on function public.validate_image_quote_price(jsonb) from public,anon,authenticated;
grant execute on function public.validate_image_quote_price(jsonb) to service_role;

create function public.guard_image_quote_price() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  perform public.validate_image_quote_price(new.quote_json);
  return new;
end $$;
revoke all on function public.guard_image_quote_price() from public,anon,authenticated,service_role;
create trigger image_quote_price_check before insert on public.image_quote_snapshots
  for each row execute function public.guard_image_quote_price();
