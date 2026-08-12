-- Banco de Ejercicios — esquema de Supabase.
-- Pegar y ejecutar completo en el SQL Editor del proyecto de Supabase.

create table if not exists public.subjects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.exercises (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.subjects(id) on delete cascade,
  code text default '',
  topic text default '',
  statement jsonb not null default '[]',
  resolution jsonb not null default '[]',
  my_attempt jsonb not null default '[]',
  created_at timestamptz not null default now()
);

alter table public.subjects enable row level security;
alter table public.exercises enable row level security;

-- Lectura pública (cualquier sesión, incluso sin login, puede ver materias y ejercicios).
create policy "subjects_public_read" on public.subjects
  for select to anon, authenticated using (true);
create policy "exercises_public_read" on public.exercises
  for select to anon, authenticated using (true);

-- Escritura solo para sesiones autenticadas (la cuenta compartida).
create policy "subjects_auth_write" on public.subjects
  for all to authenticated using (true) with check (true);
create policy "exercises_auth_write" on public.exercises
  for all to authenticated using (true) with check (true);

-- Sincronización en tiempo real entre sesiones.
alter publication supabase_realtime add table public.subjects;
alter publication supabase_realtime add table public.exercises;

-- Bucket de storage para imágenes y PDFs adjuntos a los ejercicios.
insert into storage.buckets (id, name, public)
values ('exercise-files', 'exercise-files', true)
on conflict (id) do nothing;

create policy "exercise_files_public_read" on storage.objects
  for select to anon, authenticated using (bucket_id = 'exercise-files');
create policy "exercise_files_auth_insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'exercise-files');
create policy "exercise_files_auth_delete" on storage.objects
  for delete to authenticated using (bucket_id = 'exercise-files');
