-- 0001_extensions.sql
create extension if not exists pgcrypto;
create extension if not exists citext;

create type public.member_role as enum ('owner','admin','editor','writer','illustrator','designer','reviewer','viewer');
create type public.book_status as enum ('draft','in_review','approved','published','archived');
create type public.asset_status as enum ('draft','in_review','approved','rejected','archived');
create type public.job_status as enum ('queued','running','succeeded','failed','cancelled');
create type public.approval_status as enum ('pending','approved','rejected','cancelled');
create type public.task_status as enum ('todo','in_progress','blocked','done','cancelled');
