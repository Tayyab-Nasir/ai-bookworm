// Authoritative fixed read-only catalog query. Embedded so emitted JS contains the complete SQL.
export const customerAiCatalogSnapshotSql = `-- Read-only catalog inventory; this query does NOT establish DB identity, ACL
-- safety, migration provenance, function semantics, or runtime readiness.
--
-- Run as a separately trusted catalog reader in one REPEATABLE READ READ ONLY
-- transaction with a statement timeout and SET LOCAL search_path=pg_catalog,
-- TIME ZONE 'UTC', DateStyle='ISO, YMD', and quote_all_identifiers=off.
-- The caller must authenticate the DB
-- endpoint independently, and reject zero/multiple rows or unsupported major
-- versions. Catalog metadata (names and grants) can itself be sensitive.
-- This deliberately captures all non-system schemas, relations and functions:
-- a manifest must detect unexpected owners and new privileged objects.
--
-- PostgreSQL 16 introduced per-membership INHERIT and SET options. Earlier
-- versions return no rows; their different membership model is not attested.
WITH environment AS (
  SELECT current_setting('server_version_num')::integer / 10000 AS major
  WHERE current_setting('server_version_num')::integer >= 160000
),
application_schemas AS (
  SELECT n.oid,n.nspname,n.nspowner,n.nspacl
  FROM pg_catalog.pg_namespace n
  WHERE n.nspname <> 'information_schema'
    AND n.nspname !~ '^pg_'
),
catalog_roles AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name',r.rolname,'superuser',r.rolsuper,'inherit',r.rolinherit,
    'createRole',r.rolcreaterole,'createDb',r.rolcreatedb,'canLogin',r.rolcanlogin,
    'replication',r.rolreplication,'bypassRls',r.rolbypassrls,
    'connectionLimit',r.rolconnlimit,'validUntil',r.rolvaliduntil,
    'defaultPrivileges',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'schema',n.nspname,'kind',d.defaclobjtype,
        'acl',COALESCE((SELECT jsonb_agg(x.acl ORDER BY x.acl COLLATE "C")
          FROM (SELECT entry::text AS acl FROM unnest(d.defaclacl) entry) x),'[]'::jsonb)
      ) ORDER BY n.nspname COLLATE "C" NULLS FIRST,d.defaclobjtype)
      FROM pg_catalog.pg_default_acl d
      LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace
      WHERE d.defaclrole=r.oid
    ),'[]'::jsonb),
    'settings',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'database',db.datname,
        'settingsSha256',encode(sha256(convert_to(to_jsonb(s.setconfig)::text,'UTF8')),'hex')
      ) ORDER BY db.datname COLLATE "C" NULLS FIRST)
      FROM pg_catalog.pg_db_role_setting s
      LEFT JOIN pg_catalog.pg_database db ON db.oid=s.setdatabase
      WHERE s.setrole=r.oid
    ),'[]'::jsonb)
  ) ORDER BY r.rolname COLLATE "C"), '[]'::jsonb) AS value
  FROM pg_catalog.pg_roles r
),
catalog_memberships AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'role',role.rolname,'member',member.rolname,'grantor',grantor.rolname,
    'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option
  ) ORDER BY role.rolname COLLATE "C",member.rolname COLLATE "C",grantor.rolname COLLATE "C"), '[]'::jsonb) AS value
  FROM pg_catalog.pg_auth_members m
  JOIN pg_catalog.pg_roles role ON role.oid=m.roleid
  JOIN pg_catalog.pg_roles member ON member.oid=m.member
  JOIN pg_catalog.pg_roles grantor ON grantor.oid=m.grantor
),
catalog_databases AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name',db.datname,'owner',pg_catalog.pg_get_userbyid(db.datdba),
    'encoding',pg_catalog.pg_encoding_to_char(db.encoding),
    'collation',db.datcollate,'ctype',db.datctype,'localeProvider',db.datlocprovider,
    'template',db.datistemplate,'allowConnections',db.datallowconn,'connectionLimit',db.datconnlimit,
    'acl',CASE WHEN db.datacl IS NULL THEN NULL ELSE
      COALESCE((SELECT jsonb_agg(x.acl ORDER BY x.acl COLLATE "C")
        FROM (SELECT entry::text AS acl FROM unnest(db.datacl) entry) x),'[]'::jsonb) END,
    'allRolesSettingsSha256',(
      SELECT encode(sha256(convert_to(to_jsonb(s.setconfig)::text,'UTF8')),'hex')
      FROM pg_catalog.pg_db_role_setting s WHERE s.setrole=0 AND s.setdatabase=db.oid
    ),
    'globalAllRolesSettingsSha256',(
      SELECT encode(sha256(convert_to(to_jsonb(s.setconfig)::text,'UTF8')),'hex')
      FROM pg_catalog.pg_db_role_setting s WHERE s.setrole=0 AND s.setdatabase=0
    )
  ) ORDER BY db.datname COLLATE "C"),'[]'::jsonb) AS value
  FROM pg_catalog.pg_database db
),
catalog_extensions AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name',e.extname,'owner',pg_catalog.pg_get_userbyid(e.extowner),
    'schema',n.nspname,'version',e.extversion,'relocatable',e.extrelocatable,
    'configurationRelations',COALESCE((
      SELECT jsonb_agg(x.name ORDER BY x.name COLLATE "C") FROM (
        SELECT cn.nspname||'.'||c.relname AS name
        FROM unnest(e.extconfig) AS config(relation_oid)
        JOIN pg_catalog.pg_class c ON c.oid=config.relation_oid
        JOIN pg_catalog.pg_namespace cn ON cn.oid=c.relnamespace
      ) x
    ),'[]'::jsonb),
    'conditionSha256',CASE WHEN e.extcondition IS NULL THEN NULL ELSE
      encode(sha256(convert_to(to_jsonb(e.extcondition)::text,'UTF8')),'hex') END
  ) ORDER BY e.extname COLLATE "C"),'[]'::jsonb) AS value
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
),
catalog_schemas AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name',n.nspname,'owner',pg_catalog.pg_get_userbyid(n.nspowner),
    'acl',CASE WHEN n.nspacl IS NULL THEN NULL ELSE
      COALESCE((SELECT jsonb_agg(x.acl ORDER BY x.acl COLLATE "C")
        FROM (SELECT entry::text AS acl FROM unnest(n.nspacl) entry) x), '[]'::jsonb) END
  ) ORDER BY n.nspname COLLATE "C"), '[]'::jsonb) AS value
  FROM application_schemas n
),
catalog_types AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema',n.nspname,'name',t.typname,'owner',pg_catalog.pg_get_userbyid(t.typowner),
    'kind',t.typtype,'category',t.typcategory,'notNull',t.typnotnull,
    'acl',CASE WHEN t.typacl IS NULL THEN NULL ELSE
      COALESCE((SELECT jsonb_agg(x.acl ORDER BY x.acl COLLATE "C")
        FROM (SELECT entry::text AS acl FROM unnest(t.typacl) entry) x),'[]'::jsonb) END,
    'baseType',CASE WHEN t.typbasetype=0 THEN NULL ELSE pg_catalog.format_type(t.typbasetype,t.typtypmod) END,
    'elementType',CASE WHEN t.typelem=0 THEN NULL ELSE pg_catalog.format_type(t.typelem,NULL) END,
    'compositeRelation',CASE WHEN t.typrelid=0 THEN NULL ELSE rn.nspname||'.'||c.relname END,
    'collation',CASE WHEN t.typcollation=0 THEN NULL ELSE cn.nspname||'.'||col.collname END,
    'defaultSha256',CASE WHEN t.typdefault IS NULL THEN NULL ELSE
      encode(sha256(convert_to(t.typdefault,'UTF8')),'hex') END,
    'enumLabelsSha256',CASE WHEN t.typtype<>'e' THEN NULL ELSE (
      SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(e.enumlabel ORDER BY e.enumsortorder),'[]'::jsonb)::text,'UTF8')),'hex')
      FROM pg_catalog.pg_enum e WHERE e.enumtypid=t.oid
    ) END,
    'domainConstraints',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name',k.conname,'validated',k.convalidated,
        'definitionSha256',encode(sha256(convert_to(pg_catalog.pg_get_constraintdef(k.oid,false),'UTF8')),'hex')
      ) ORDER BY k.conname COLLATE "C")
      FROM pg_catalog.pg_constraint k WHERE k.contypid=t.oid
    ),'[]'::jsonb)
  ) ORDER BY n.nspname COLLATE "C",t.typname COLLATE "C"),'[]'::jsonb) AS value
  FROM pg_catalog.pg_type t
  JOIN application_schemas n ON n.oid=t.typnamespace
  LEFT JOIN pg_catalog.pg_class c ON c.oid=t.typrelid
  LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid=c.relnamespace
  LEFT JOIN pg_catalog.pg_collation col ON col.oid=t.typcollation
  LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=col.collnamespace
),
catalog_relations AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema',n.nspname,'name',c.relname,'kind',c.relkind,
    'owner',pg_catalog.pg_get_userbyid(c.relowner),'rowSecurity',c.relrowsecurity,
    'forceRowSecurity',c.relforcerowsecurity,'options',to_jsonb(c.reloptions),
    'viewSha256',CASE WHEN c.relkind IN ('v','m') THEN
      encode(sha256(convert_to(pg_catalog.pg_get_viewdef(c.oid,false),'UTF8')),'hex') ELSE NULL END,
    'acl',CASE WHEN c.relacl IS NULL THEN NULL ELSE
      COALESCE((SELECT jsonb_agg(x.acl ORDER BY x.acl COLLATE "C")
        FROM (SELECT entry::text AS acl FROM unnest(c.relacl) entry) x), '[]'::jsonb) END,
    'columns',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name',a.attname,'position',a.attnum,
        'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
        'notNull',a.attnotnull,'dropped',a.attisdropped,
        'identity',a.attidentity,'generated',a.attgenerated,
        'acl',CASE WHEN a.attacl IS NULL THEN NULL ELSE
          COALESCE((SELECT jsonb_agg(x.acl ORDER BY x.acl COLLATE "C")
            FROM (SELECT entry::text AS acl FROM unnest(a.attacl) entry) x), '[]'::jsonb) END,
        'defaultSha256',CASE WHEN d.oid IS NULL THEN NULL ELSE
          encode(sha256(convert_to(pg_catalog.pg_get_expr(d.adbin,d.adrelid),'UTF8')),'hex') END
      ) ORDER BY a.attnum)
      FROM pg_catalog.pg_attribute a
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0
    ),'[]'::jsonb),
    'policies',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
        'roles',COALESCE((SELECT jsonb_agg(x.name ORDER BY x.name COLLATE "C") FROM
          (SELECT CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(role_oid) END AS name
           FROM unnest(p.polroles) role_oid) x),'[]'::jsonb),
        'usingSha256',CASE WHEN p.polqual IS NULL THEN NULL ELSE
          encode(sha256(convert_to(pg_catalog.pg_get_expr(p.polqual,p.polrelid),'UTF8')),'hex') END,
        'checkSha256',CASE WHEN p.polwithcheck IS NULL THEN NULL ELSE
          encode(sha256(convert_to(pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid),'UTF8')),'hex') END
      ) ORDER BY p.polname COLLATE "C")
      FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid
    ),'[]'::jsonb),
    'constraints',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name',k.conname,'type',k.contype,'validated',k.convalidated,
        'definitionSha256',encode(sha256(convert_to(pg_catalog.pg_get_constraintdef(k.oid,false),'UTF8')),'hex')
      ) ORDER BY k.conname COLLATE "C")
      FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid
    ),'[]'::jsonb),
    'indexes',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name',i.relname,'valid',ix.indisvalid,'ready',ix.indisready,'unique',ix.indisunique,
        'definitionSha256',encode(sha256(convert_to(pg_catalog.pg_get_indexdef(i.oid),'UTF8')),'hex')
      ) ORDER BY i.relname COLLATE "C")
      FROM pg_catalog.pg_index ix JOIN pg_catalog.pg_class i ON i.oid=ix.indexrelid
      WHERE ix.indrelid=c.oid
    ),'[]'::jsonb),
    'triggers',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name',t.tgname,'enabled',t.tgenabled,'internal',t.tgisinternal,
        'function',pn.nspname||'.'||p.proname||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')',
        'definitionSha256',encode(sha256(convert_to(pg_catalog.pg_get_triggerdef(t.oid,false),'UTF8')),'hex')
      ) ORDER BY t.tgname COLLATE "C")
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
      WHERE t.tgrelid=c.oid
    ),'[]'::jsonb)
  ) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",c.relkind), '[]'::jsonb) AS value
  FROM pg_catalog.pg_class c
  JOIN application_schemas n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','f','S')
),
catalog_functions AS (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schema',n.nspname,
    'identity',p.proname||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')',
    'kind',p.prokind,'owner',pg_catalog.pg_get_userbyid(p.proowner),
    'securityDefiner',p.prosecdef,'language',l.lanname,'volatility',p.provolatile,
    'parallel',p.proparallel,'strict',p.proisstrict,'leakproof',p.proleakproof,
    'configSha256',CASE WHEN p.proconfig IS NULL THEN NULL ELSE
      COALESCE((SELECT jsonb_agg(encode(sha256(convert_to(entry.value,'UTF8')),'hex') ORDER BY entry.ordinal)
        FROM unnest(p.proconfig) WITH ORDINALITY AS entry(value,ordinal)),'[]'::jsonb) END,
    'acl',CASE WHEN p.proacl IS NULL THEN NULL ELSE
      COALESCE((SELECT jsonb_agg(x.acl ORDER BY x.acl COLLATE "C")
        FROM (SELECT entry::text AS acl FROM unnest(p.proacl) entry) x),'[]'::jsonb) END,
    'definitionSha256',encode(sha256(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex')
  ) ORDER BY n.nspname COLLATE "C",p.proname COLLATE "C",pg_catalog.pg_get_function_identity_arguments(p.oid) COLLATE "C"), '[]'::jsonb) AS value
  FROM pg_catalog.pg_proc p
  JOIN application_schemas n ON n.oid=p.pronamespace
  JOIN pg_catalog.pg_language l ON l.oid=p.prolang
  WHERE p.prokind IN ('f','p')
)
SELECT jsonb_build_object(
  'catalogFormat','customer-ai-catalog-v1','postgresMajor',environment.major,
  'roles',catalog_roles.value,'memberships',catalog_memberships.value,
  'databases',catalog_databases.value,'extensions',catalog_extensions.value,
  'schemas',catalog_schemas.value,'types',catalog_types.value,
  'relations',catalog_relations.value,'functions',catalog_functions.value
) AS catalog
FROM environment CROSS JOIN catalog_roles CROSS JOIN catalog_memberships
CROSS JOIN catalog_databases CROSS JOIN catalog_extensions
CROSS JOIN catalog_schemas CROSS JOIN catalog_types CROSS JOIN catalog_relations CROSS JOIN catalog_functions;
`;
