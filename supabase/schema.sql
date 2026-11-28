-- Disom Baha admin database for Supabase.
-- Paste this whole file into Supabase → SQL Editor → New query, then click Run.
-- It is safe to run again after an update: it creates what is missing and
-- replaces functions and policies.
--
-- Security model
--   • Visitors (the "anon" role) can only READ live products, published
--     journal posts, SEO text and site settings.
--   • Visitors can only WRITE through the place_order, submit_contact_message
--     and track_page_view functions, which validate every field and recompute
--     prices from the products table.
--   • Everything else (orders, customers, messages, analytics) is readable and
--     editable only by signed-in users listed in admin_users.

-- ─── Admins ────────────────────────────────────────────────────────────────

create table if not exists public.admin_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  created_at timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.admin_users where user_id = auth.uid());
$$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ─── Products ──────────────────────────────────────────────────────────────

create table if not exists public.products (
  id           text primary key check (id ~ '^[a-z0-9-]{1,60}$'),
  name         text not null check (char_length(name) between 1 and 120),
  botanical    text not null default '',
  price        integer not null check (price >= 0),
  image        text not null default '',
  tag          text not null default '',
  is_demo      boolean not null default false,
  light        text not null default '',
  light_filter text not null default '' check (light_filter in ('', 'low', 'medium', 'bright')),
  water        text not null default '',
  water_filter text not null default '' check (water_filter in ('', 'infrequent', 'medium', 'frequent')),
  humidity     text not null default '',
  size_options jsonb not null default '[]'::jsonb check (jsonb_typeof(size_options) = 'array'),
  pot_colors   text[] not null default array['Sage green', 'Warm white', 'Terracotta'],
  height       text not null default '',
  pot_diameter text not null default '',
  includes     text not null default '',
  stock        integer check (stock is null or stock >= 0),
  categories   text[] not null default '{}',
  description  text not null default '',
  review       text not null default '',
  review_by    text not null default '',
  is_active    boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

-- ─── Orders ────────────────────────────────────────────────────────────────

create table if not exists public.orders (
  id                 uuid primary key default gen_random_uuid(),
  reference          text not null unique check (reference ~ '^DBH-[0-9]{8}-[A-Z0-9]{1,8}$'),
  status             text not null default 'new'
                     check (status in ('new', 'confirmed', 'paid', 'shipped', 'delivered', 'cancelled')),
  customer_name      text not null,
  phone              text not null,
  phone_digits       text not null,
  address            text not null,
  city               text not null,
  state              text not null,
  pincode            text not null,
  payment_preference text not null default '',
  items              jsonb not null,
  subtotal           integer not null,
  admin_note         text not null default '',
  tracking           text not null default '',
  stock_deducted     boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists orders_created_at_idx on public.orders (created_at desc);
create index if not exists orders_phone_digits_idx on public.orders (phone_digits);

-- Online payments (Razorpay). payment_status: unpaid = WhatsApp-era order,
-- pending = checkout started, paid, failed, refunded.
alter table public.orders add column if not exists email text not null default '';
alter table public.orders add column if not exists payment_status text not null default 'unpaid';
alter table public.orders add column if not exists razorpay_order_id text;
alter table public.orders add column if not exists razorpay_payment_id text;
alter table public.orders add column if not exists paid_at timestamptz;
do $$ begin
  alter table public.orders add constraint orders_payment_status_check
    check (payment_status in ('unpaid', 'pending', 'paid', 'failed', 'refunded'));
exception when duplicate_object then null; end $$;
create unique index if not exists orders_razorpay_order_id_idx on public.orders (razorpay_order_id)
  where razorpay_order_id is not null;

drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

-- Customers are worked out from orders, grouped by phone number.
create or replace view public.customer_summary with (security_invoker = true) as
select
  phone_digits,
  (array_agg(customer_name order by created_at desc))[1] as name,
  (array_agg(phone order by created_at desc))[1]         as phone,
  (array_agg(city order by created_at desc))[1]          as city,
  (array_agg(state order by created_at desc))[1]         as state,
  count(*)                                               as order_count,
  coalesce(sum(subtotal) filter (where payment_status = 'paid'
    or (payment_status = 'unpaid' and status in ('confirmed', 'paid', 'shipped', 'delivered'))), 0) as total_spent,
  min(created_at)                                        as first_order_at,
  max(created_at)                                        as last_order_at,
  (array_agg(email order by created_at desc) filter (where email <> ''))[1] as email
from public.orders
where payment_status <> 'pending' and payment_status <> 'failed'
group by phone_digits;

-- ─── Contact messages ──────────────────────────────────────────────────────

create table if not exists public.contact_messages (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  contact    text not null,
  message    text not null,
  status     text not null default 'new' check (status in ('new', 'read', 'archived')),
  created_at timestamptz not null default now()
);

create index if not exists contact_messages_created_at_idx on public.contact_messages (created_at desc);

-- ─── Content: journal posts, site settings, SEO ────────────────────────────

create table if not exists public.posts (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique check (slug ~ '^[a-z0-9-]{1,80}$'),
  title        text not null check (char_length(title) between 1 and 160),
  meta_line    text not null default '',
  image        text not null default '',
  excerpt      text not null default '',
  body         text not null default '',
  is_published boolean not null default false,
  sort_order   integer not null default 0,
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

drop trigger if exists posts_touch on public.posts;
create trigger posts_touch before update on public.posts
  for each row execute function public.touch_updated_at();

create table if not exists public.site_settings (
  key        text primary key check (key ~ '^[a-z0-9_]{1,60}$'),
  value      text not null default '',
  updated_at timestamptz not null default now()
);

drop trigger if exists site_settings_touch on public.site_settings;
create trigger site_settings_touch before update on public.site_settings
  for each row execute function public.touch_updated_at();

create table if not exists public.page_seo (
  path        text primary key check (path ~ '^[a-z0-9-]{1,40}\.html$'),
  title       text not null default '',
  description text not null default '',
  updated_at  timestamptz not null default now()
);

drop trigger if exists page_seo_touch on public.page_seo;
create trigger page_seo_touch before update on public.page_seo
  for each row execute function public.touch_updated_at();

insert into public.site_settings (key, value) values
  ('announcement', 'Free delivery across India|Orders & payments coordinated by our WhatsApp concierge'),
  ('catalog_note', ''),
  ('checkout_mode', 'whatsapp')
on conflict (key) do nothing;

insert into public.page_seo (path, title, description) values
  ('index.html', 'Disom Baha — Bring nature home',
   'Bring home happy plants with Disom Baha. Shop thoughtful indoor plants, woven planters, and gardening essentials, delivered across India.'),
  ('product.html', 'Shop plants — Disom Baha',
   'Find your next leafy friend at Disom Baha, with free delivery across India.'),
  ('policies.html', 'Delivery & plant promise — Disom Baha',
   'Free delivery across India, PIN-code confirmation, and the Disom Baha 7-day plant replacement promise.'),
  ('journal.html', 'Plant care journal — Disom Baha',
   'Friendly plant care guides from Disom Baha: light, watering, and styling tips for every home.')
on conflict (path) do nothing;

-- ─── Analytics (daily counts only; no personal data, no IP addresses) ──────

create table if not exists public.page_views_daily (
  day      date not null,
  path     text not null,
  referrer text not null default '',
  views    integer not null default 0,
  primary key (day, path, referrer)
);

-- ─── Row-level security ────────────────────────────────────────────────────

alter table public.admin_users      enable row level security;
alter table public.products         enable row level security;
alter table public.orders           enable row level security;
alter table public.contact_messages enable row level security;
alter table public.posts            enable row level security;
alter table public.site_settings    enable row level security;
alter table public.page_seo         enable row level security;
alter table public.page_views_daily enable row level security;

drop policy if exists "Admins read admins" on public.admin_users;
create policy "Admins read admins" on public.admin_users
  for select to authenticated using (public.is_admin());

drop policy if exists "Anyone reads live products" on public.products;
create policy "Anyone reads live products" on public.products
  for select using (is_active or public.is_admin());
drop policy if exists "Admins manage products" on public.products;
create policy "Admins manage products" on public.products
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins read orders" on public.orders;
create policy "Admins read orders" on public.orders
  for select to authenticated using (public.is_admin());
drop policy if exists "Admins edit order notes" on public.orders;
create policy "Admins edit order notes" on public.orders
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Admins delete orders" on public.orders;
create policy "Admins delete orders" on public.orders
  for delete to authenticated using (public.is_admin());

drop policy if exists "Admins read messages" on public.contact_messages;
create policy "Admins read messages" on public.contact_messages
  for select to authenticated using (public.is_admin());
drop policy if exists "Admins update messages" on public.contact_messages;
create policy "Admins update messages" on public.contact_messages
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Admins delete messages" on public.contact_messages;
create policy "Admins delete messages" on public.contact_messages
  for delete to authenticated using (public.is_admin());

drop policy if exists "Anyone reads published posts" on public.posts;
create policy "Anyone reads published posts" on public.posts
  for select using (is_published or public.is_admin());
drop policy if exists "Admins manage posts" on public.posts;
create policy "Admins manage posts" on public.posts
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Anyone reads settings" on public.site_settings;
create policy "Anyone reads settings" on public.site_settings for select using (true);
drop policy if exists "Admins manage settings" on public.site_settings;
create policy "Admins manage settings" on public.site_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Anyone reads SEO" on public.page_seo;
create policy "Anyone reads SEO" on public.page_seo for select using (true);
drop policy if exists "Admins manage SEO" on public.page_seo;
create policy "Admins manage SEO" on public.page_seo
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins read analytics" on public.page_views_daily;
create policy "Admins read analytics" on public.page_views_daily
  for select to authenticated using (public.is_admin());

-- Order status and stock go through set_order_status, so admins may only edit
-- the note and tracking columns directly. Visitors get no table writes at all.
revoke insert, update, delete on public.orders from anon, authenticated;
grant update (admin_note, tracking) on public.orders to authenticated;
grant delete on public.orders to authenticated;
revoke insert, update, delete on public.contact_messages from anon, authenticated;
grant update (status) on public.contact_messages to authenticated;
grant delete on public.contact_messages to authenticated;
revoke insert, update, delete on public.admin_users from anon, authenticated;
revoke insert, update, delete on public.page_views_daily from anon, authenticated;
revoke all on public.customer_summary from anon;
grant select on public.customer_summary to authenticated;

-- ─── Visitor functions ─────────────────────────────────────────────────────

-- public.place_order(…) is defined in the "Stock holds, order events, reviews
-- and search" section at the end of this file.

create or replace function public.submit_contact_message(p_name text, p_contact text, p_message text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_name    text := btrim(coalesce(p_name, ''));
  v_contact text := btrim(coalesce(p_contact, ''));
  v_message text := btrim(coalesce(p_message, ''));
begin
  if char_length(v_name) not between 1 and 120
     or char_length(v_contact) not between 5 and 120
     or char_length(v_message) not between 1 and 2000 then
    raise exception 'Please fill in your name, phone or email, and a message';
  end if;
  if (select count(*) from public.contact_messages
      where lower(contact) = lower(v_contact) and created_at > now() - interval '1 hour') >= 3
     or (select count(*) from public.contact_messages where created_at > now() - interval '1 minute') >= 20 then
    raise exception 'Too many messages right now. Please message us on WhatsApp.';
  end if;
  insert into public.contact_messages (name, contact, message) values (v_name, v_contact, v_message);
end $$;

create or replace function public.track_page_view(p_path text, p_referrer text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_ref text := lower(btrim(coalesce(p_referrer, '')));
begin
  if p_path is null or p_path !~ '^(index|policies|journal|product)(/[a-z0-9-]{1,80})?$' then
    return;
  end if;
  if v_ref !~ '^[a-z0-9.-]{0,100}$' then
    v_ref := 'other';
  end if;
  insert into public.page_views_daily as v (day, path, referrer, views)
  values ((now() at time zone 'Asia/Kolkata')::date, p_path, v_ref, 1)
  on conflict (day, path, referrer) do update set views = v.views + 1;
end $$;

-- Lets a customer see their order's progress with its reference and phone
-- number. Returns no address, phone or email.
-- public.track_order(…) is defined in the "Stock holds, order events, reviews
-- and search" section at the end of this file.

-- ─── Payment functions (called only by the 'shop' server function) ─────────

-- Marks a Razorpay order as paid. Safe to call more than once. Takes the
-- items off stock; if stock ran short, the order is kept for the admin with
-- a note instead of failing a payment the customer has already made.
-- public.mark_order_paid(…) is defined in the "Stock holds, order events, reviews
-- and search" section at the end of this file.

-- Records a failed or refunded Razorpay payment. A refund cancels the order
-- and puts its items back in stock.
create or replace function public.set_order_payment_state(p_razorpay_order_id text, p_payment_status text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_line  jsonb;
begin
  if p_payment_status not in ('failed', 'refunded') then
    raise exception 'Unsupported payment state %', p_payment_status;
  end if;
  select * into v_order from public.orders where razorpay_order_id = p_razorpay_order_id for update;
  if not found then
    raise exception 'Unknown payment order';
  end if;
  if p_payment_status = 'failed' then
    if v_order.payment_status = 'pending' then
      update public.orders set payment_status = 'failed' where id = v_order.id;
    end if;
  elsif v_order.payment_status <> 'refunded' then
    if v_order.stock_deducted then
      for v_line in select value from jsonb_array_elements(v_order.items) loop
        update public.products set stock = stock + (v_line ->> 'quantity')::integer
        where id = v_line ->> 'product_id' and stock is not null;
      end loop;
    end if;
    update public.orders set payment_status = 'refunded', status = 'cancelled', stock_deducted = false
    where id = v_order.id;
  end if;
  return jsonb_build_object('reference', v_order.reference);
end $$;

-- ─── Admin functions ───────────────────────────────────────────────────────

-- Changes an order's status. Stock is taken off when an order is first
-- confirmed (or moved straight to paid/shipped/delivered) and put back if it
-- is cancelled or reopened.
-- public.set_order_status(…) is defined in the "Stock holds, order events, reviews
-- and search" section at the end of this file.

create or replace function public.add_admin_by_email(p_email text)
returns void
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Not authorised';
  end if;
  select id into v_id from auth.users where lower(email) = lower(btrim(p_email));
  if v_id is null then
    raise exception 'No account uses that email yet. Create the user in Supabase → Authentication → Users first.';
  end if;
  insert into public.admin_users (user_id, email) values (v_id, lower(btrim(p_email)))
  on conflict (user_id) do nothing;
end $$;

create or replace function public.remove_admin(p_user_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Not authorised';
  end if;
  if (select count(*) from public.admin_users) <= 1 then
    raise exception 'You cannot remove the last admin';
  end if;
  delete from public.admin_users where user_id = p_user_id;
end $$;

revoke execute on function public.add_admin_by_email(text) from public, anon;
revoke execute on function public.remove_admin(uuid) from public, anon;
grant execute on function public.add_admin_by_email(text) to authenticated;
grant execute on function public.remove_admin(uuid) to authenticated;
grant execute on function public.submit_contact_message(text, text, text) to anon, authenticated;
grant execute on function public.track_page_view(text, text) to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;
revoke execute on function public.set_order_payment_state(text, text) from public, anon, authenticated;
grant execute on function public.set_order_payment_state(text, text) to service_role;

-- ─── Customer chat (customers sign in with Google) ─────────────────────────
-- One conversation per signed-in customer. Customers can only read their own
-- conversation and can only post through chat_send; admins read and reply to
-- all of them. Messages are delivered live with Supabase Realtime.

create table if not exists public.chat_threads (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null unique references auth.users (id) on delete cascade,
  customer_name   text not null default '',
  customer_email  text not null default '',
  status          text not null default 'open' check (status in ('open', 'closed')),
  blocked         boolean not null default false,
  admin_unread    boolean not null default false,
  customer_unread boolean not null default false,
  last_sender     text not null default 'customer' check (last_sender in ('customer', 'admin')),
  last_message_at timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create table if not exists public.chat_messages (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references public.chat_threads (id) on delete cascade,
  sender     text not null check (sender in ('customer', 'admin')),
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_thread_idx on public.chat_messages (thread_id, created_at);
create index if not exists chat_threads_last_message_idx on public.chat_threads (last_message_at desc);

alter table public.chat_threads  enable row level security;
alter table public.chat_messages enable row level security;

drop policy if exists "Customers read their conversation" on public.chat_threads;
create policy "Customers read their conversation" on public.chat_threads
  for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists "Admins update conversations" on public.chat_threads;
create policy "Admins update conversations" on public.chat_threads
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Admins delete conversations" on public.chat_threads;
create policy "Admins delete conversations" on public.chat_threads
  for delete to authenticated using (public.is_admin());

drop policy if exists "Customers read their messages" on public.chat_messages;
create policy "Customers read their messages" on public.chat_messages
  for select to authenticated using (
    public.is_admin()
    or exists (select 1 from public.chat_threads t where t.id = thread_id and t.user_id = auth.uid()));

revoke insert, update, delete on public.chat_messages from anon, authenticated;
revoke insert, update, delete on public.chat_threads from anon, authenticated;
revoke select on public.chat_threads, public.chat_messages from anon;
grant update (status, blocked, admin_unread) on public.chat_threads to authenticated;
grant delete on public.chat_threads to authenticated;

insert into public.site_settings (key, value) values ('chat_enabled', 'false') on conflict (key) do nothing;

-- A signed-in customer sends a message. Creates their conversation the first
-- time. notify_owner is true only for the first message the admin hasn't read.
create or replace function public.chat_send(p_body text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_body   text := btrim(coalesce(p_body, ''));
  v_email  text;
  v_meta   jsonb;
  v_thread public.chat_threads%rowtype;
  v_msg    public.chat_messages%rowtype;
  v_notify boolean;
begin
  if v_uid is null then
    raise exception 'Please sign in to chat';
  end if;
  if char_length(v_body) not between 1 and 2000 then
    raise exception 'Please write a message (up to 2000 characters)';
  end if;
  select email, coalesce(raw_user_meta_data, '{}'::jsonb) into v_email, v_meta from auth.users where id = v_uid;

  select * into v_thread from public.chat_threads where user_id = v_uid for update;
  if not found then
    insert into public.chat_threads (user_id, customer_name, customer_email)
    values (v_uid, left(coalesce(v_meta ->> 'full_name', v_meta ->> 'name', ''), 120), coalesce(v_email, ''))
    returning * into v_thread;
  end if;
  if v_thread.blocked then
    raise exception 'Chat isn''t available for this account. Please contact us on WhatsApp.';
  end if;
  if (select count(*) from public.chat_messages
      where thread_id = v_thread.id and sender = 'customer' and created_at > now() - interval '10 minutes') >= 20 then
    raise exception 'You''re sending messages very quickly. Please wait a few minutes.';
  end if;

  v_notify := not v_thread.admin_unread;
  insert into public.chat_messages (thread_id, sender, body) values (v_thread.id, 'customer', v_body)
  returning * into v_msg;
  update public.chat_threads set admin_unread = true, customer_unread = false, status = 'open',
    last_sender = 'customer', last_message_at = v_msg.created_at
  where id = v_thread.id;
  return jsonb_build_object('message', to_jsonb(v_msg), 'notify_owner', v_notify,
    'customer_name', v_thread.customer_name, 'customer_email', v_thread.customer_email);
end $$;

-- The customer has seen the admin's replies.
create or replace function public.chat_mark_read()
returns void
language sql security definer set search_path = public
as $$
  update public.chat_threads set customer_unread = false where user_id = auth.uid();
$$;

-- An admin replies. notify_customer is true only for the first reply the
-- customer hasn't read, so a burst of replies sends one email.
create or replace function public.admin_chat_reply(p_thread_id uuid, p_body text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_body   text := btrim(coalesce(p_body, ''));
  v_thread public.chat_threads%rowtype;
  v_msg    public.chat_messages%rowtype;
  v_notify boolean;
begin
  if not public.is_admin() then
    raise exception 'Not authorised';
  end if;
  if char_length(v_body) not between 1 and 2000 then
    raise exception 'Please write a reply (up to 2000 characters)';
  end if;
  select * into v_thread from public.chat_threads where id = p_thread_id for update;
  if not found then
    raise exception 'Conversation not found';
  end if;
  v_notify := not v_thread.customer_unread;
  insert into public.chat_messages (thread_id, sender, body) values (v_thread.id, 'admin', v_body)
  returning * into v_msg;
  update public.chat_threads set customer_unread = true, admin_unread = false,
    last_sender = 'admin', last_message_at = v_msg.created_at
  where id = v_thread.id;
  return jsonb_build_object('message', to_jsonb(v_msg), 'notify_customer', v_notify,
    'customer_name', v_thread.customer_name, 'customer_email', v_thread.customer_email);
end $$;

revoke execute on function public.chat_send(text) from public, anon;
revoke execute on function public.chat_mark_read() from public, anon;
revoke execute on function public.admin_chat_reply(uuid, text) from public, anon;
grant execute on function public.chat_send(text) to authenticated;
grant execute on function public.chat_mark_read() to authenticated;
grant execute on function public.admin_chat_reply(uuid, text) to authenticated;

-- Live updates for the chat box and the admin panel (Realtime respects the
-- row-level security above).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.chat_messages;
    exception when duplicate_object then null; end;
    begin
      alter publication supabase_realtime add table public.chat_threads;
    exception when duplicate_object then null; end;
  end if;
end $$;

-- ─── Image storage ─────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('site-images', 'site-images', true)
on conflict (id) do nothing;

drop policy if exists "Admins list site images" on storage.objects;
create policy "Admins list site images" on storage.objects
  for select to authenticated using (bucket_id = 'site-images' and public.is_admin());
drop policy if exists "Admins upload site images" on storage.objects;
create policy "Admins upload site images" on storage.objects
  for insert to authenticated with check (bucket_id = 'site-images' and public.is_admin());
drop policy if exists "Admins replace site images" on storage.objects;
create policy "Admins replace site images" on storage.objects
  for update to authenticated using (bucket_id = 'site-images' and public.is_admin());
drop policy if exists "Admins delete site images" on storage.objects;
create policy "Admins delete site images" on storage.objects
  for delete to authenticated using (bucket_id = 'site-images' and public.is_admin());

-- ═══ Stock holds, order events, reviews and search (November 2026) ═══════
--
-- The scheduled email job below calls this project's own server function URL;
-- change the address if you set the site up on a different Supabase project.

-- ─── Extensions ────────────────────────────────────────────────────────────

create extension if not exists pg_trgm with schema extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ─── Stock holds ───────────────────────────────────────────────────────────
-- Stock is taken off as soon as an order is placed, so two people can never
-- buy the last plant. Unpaid online orders hold it for 30 minutes and
-- WhatsApp orders for 24 hours; after that release_expired_reservations()
-- puts it back. products.stock is therefore always "available to buy".

alter table public.orders add column if not exists reserved_until timestamptz;
create index if not exists orders_reserved_until_idx on public.orders (reserved_until)
  where reserved_until is not null;

-- A Razorpay payment can only ever be attached to one order.
create unique index if not exists orders_razorpay_payment_id_idx on public.orders (razorpay_payment_id)
  where razorpay_payment_id is not null;

create or replace function public.place_order(p_reference text, p_customer jsonb, p_items jsonb)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_name     text := btrim(coalesce(p_customer ->> 'name', ''));
  v_phone    text := btrim(coalesce(p_customer ->> 'phone', ''));
  v_address  text := btrim(coalesce(p_customer ->> 'address', ''));
  v_city     text := btrim(coalesce(p_customer ->> 'city', ''));
  v_state    text := btrim(coalesce(p_customer ->> 'state', ''));
  v_pincode  text := btrim(coalesce(p_customer ->> 'pincode', ''));
  v_payment  text := btrim(coalesce(p_customer ->> 'payment', ''));
  v_email    text := lower(btrim(coalesce(p_customer ->> 'email', '')));
  v_digits   text;
  v_item     jsonb;
  v_product  public.products%rowtype;
  v_qty      integer;
  v_size     text;
  v_color    text;
  v_extra    integer;
  v_unit     integer;
  v_lines    jsonb := '[]'::jsonb;
  v_subtotal integer := 0;
  v_taken    jsonb := '{}'::jsonb;
  v_left     integer;
begin
  if p_reference is null or p_reference !~ '^DBH-[0-9]{8}-[A-Z0-9]{1,8}$' then
    raise exception 'Invalid order reference';
  end if;
  v_digits := regexp_replace(v_phone, '\D', '', 'g');
  if char_length(v_name) not between 1 and 120
     or char_length(v_phone) > 30 or char_length(v_digits) not between 8 and 15
     or char_length(v_address) not between 1 and 300
     or char_length(v_city) not between 1 and 80
     or char_length(v_state) not between 1 and 80
     or v_pincode !~ '^[0-9]{6}$'
     or char_length(v_payment) > 60
     or (v_email <> '' and (char_length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')) then
    raise exception 'Please check your delivery details';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 30 then
    raise exception 'Your bag is empty or too large';
  end if;

  -- Basic flood protection.
  if (select count(*) from public.orders
      where phone_digits = v_digits and created_at > now() - interval '1 hour') >= 5
     or (select count(*) from public.orders where created_at > now() - interval '1 minute') >= 30 then
    raise exception 'Too many order requests right now. Please message us on WhatsApp.';
  end if;

  -- Lines are handled in product order so that two checkouts lock the same
  -- products in the same order and can never deadlock.
  for v_item in select value from jsonb_array_elements(p_items)
                order by value ->> 'id', value ->> 'size', value ->> 'color' loop
    select * into v_product from public.products where id = v_item ->> 'id' and is_active for update;
    if not found then
      raise exception 'A product in your bag is no longer available';
    end if;

    v_qty := (v_item ->> 'quantity')::integer;
    if v_qty is null or v_qty not between 1 and 50 then
      raise exception 'Invalid quantity for %', v_product.name;
    end if;
    -- v_product.stock already reflects earlier lines of this bag (same plant,
    -- another size), because each line is taken off below.
    if v_product.stock is not null and v_qty > v_product.stock then
      -- Report what was available before this bag's earlier lines.
      v_left := v_product.stock + coalesce((v_taken ->> v_product.id)::integer, 0);
      if v_left = 0 then
        raise exception '% just sold out', v_product.name;
      end if;
      raise exception 'Only % of % left', v_left, v_product.name;
    end if;

    v_size := btrim(coalesce(v_item ->> 'size', ''));
    v_extra := 0;
    if jsonb_array_length(v_product.size_options) > 0 then
      select coalesce((opt ->> 'extra')::numeric, 0)::integer into v_extra
      from jsonb_array_elements(v_product.size_options) as opt
      where opt ->> 'label' = v_size
      limit 1;
      if not found then
        raise exception 'Unknown size for %', v_product.name;
      end if;
    end if;

    v_color := btrim(coalesce(v_item ->> 'color', ''));
    if cardinality(v_product.pot_colors) > 0 and not (v_color = any (v_product.pot_colors)) then
      raise exception 'Unknown pot colour for %', v_product.name;
    end if;

    update public.products set stock = stock - v_qty where id = v_product.id and stock is not null;
    v_taken := v_taken || jsonb_build_object(v_product.id, coalesce((v_taken ->> v_product.id)::integer, 0) + v_qty);

    v_unit := v_product.price + v_extra;
    v_subtotal := v_subtotal + v_unit * v_qty;
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_product.id, 'name', v_product.name, 'size', v_size, 'color', v_color,
      'quantity', v_qty, 'unit_price', v_unit, 'line_total', v_unit * v_qty);
  end loop;

  insert into public.orders (reference, customer_name, phone, phone_digits, email, address, city, state,
                             pincode, payment_preference, items, subtotal, stock_deducted, reserved_until)
  values (p_reference, v_name, v_phone, v_digits, v_email, v_address, v_city, v_state,
          v_pincode, v_payment, v_lines, v_subtotal, true,
          now() + case when v_payment ilike 'online%' then interval '30 minutes' else interval '24 hours' end);
  return p_reference;
end $$;

-- Puts stock back for orders nobody paid for or confirmed in time. Runs every
-- five minutes (see the cron jobs at the end). Returns how many it released.
create or replace function public.release_expired_reservations()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_line  jsonb;
  v_count integer := 0;
begin
  for v_order in
    select * from public.orders
    where stock_deducted and status = 'new' and payment_status in ('unpaid', 'pending', 'failed')
      and reserved_until < now()
    order by created_at
    for update skip locked
  loop
    for v_line in select value from jsonb_array_elements(v_order.items) order by value ->> 'product_id' loop
      update public.products set stock = stock + (v_line ->> 'quantity')::integer
      where id = v_line ->> 'product_id' and stock is not null;
    end loop;
    update public.orders set
      stock_deducted = false,
      reserved_until = null,
      admin_note = concat_ws(E'\n', nullif(admin_note, ''),
        format('Stock hold released %s: not paid or confirmed in time.', to_char(now() at time zone 'Asia/Kolkata', 'DD Mon HH24:MI')))
    where id = v_order.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- Marks a Razorpay order as paid. Safe to call more than once. Stock is
-- normally already held; if the hold had expired, it is taken off again, and
-- if stock ran short the order is kept for the admin with a note instead of
-- failing a payment the customer has already made.
create or replace function public.mark_order_paid(p_razorpay_order_id text, p_payment_id text, p_amount_paise bigint)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_line  jsonb;
  v_left  integer;
  v_short text := '';
begin
  select * into v_order from public.orders where razorpay_order_id = p_razorpay_order_id for update;
  if not found then
    raise exception 'Unknown payment order';
  end if;
  if v_order.payment_status in ('paid', 'refunded') then
    return jsonb_build_object('reference', v_order.reference, 'newly_paid', false);
  end if;
  if p_amount_paise is distinct from v_order.subtotal::bigint * 100 then
    raise exception 'Paid amount does not match the order';
  end if;

  if not v_order.stock_deducted then
    for v_line in select value from jsonb_array_elements(v_order.items) order by value ->> 'product_id' loop
      select stock into v_left from public.products where id = v_line ->> 'product_id' for update;
      if v_left is not null and v_left < (v_line ->> 'quantity')::integer then
        v_short := v_short || format('%s (%s left); ', v_line ->> 'name', v_left);
      end if;
    end loop;
    if v_short = '' then
      for v_line in select value from jsonb_array_elements(v_order.items) order by value ->> 'product_id' loop
        update public.products set stock = stock - (v_line ->> 'quantity')::integer
        where id = v_line ->> 'product_id' and stock is not null;
      end loop;
    end if;
  end if;

  update public.orders set
    payment_status      = 'paid',
    razorpay_payment_id = p_payment_id,
    paid_at             = now(),
    reserved_until      = null,
    status              = case when status = 'new' then 'paid' else status end,
    stock_deducted      = stock_deducted or v_short = '',
    admin_note          = case when v_short = '' then admin_note
                          when admin_note = '' then 'Paid online, but stock was short: ' || v_short || 'restock or refund.'
                          else admin_note || E'\n' || 'Paid online, but stock was short: ' || v_short || 'restock or refund.' end
  where id = v_order.id;
  return jsonb_build_object('reference', v_order.reference, 'newly_paid', true, 'stock_ok', v_short = '');
end $$;

-- Changes an order's status. New orders already hold their stock; if the hold
-- expired, confirming takes the stock off again (or refuses if it ran out).
-- Cancelling or reopening puts the stock back.
create or replace function public.set_order_status(p_order_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_line  jsonb;
  v_left  integer;
begin
  if not public.is_admin() then
    raise exception 'Not authorised';
  end if;
  if p_status not in ('new', 'confirmed', 'paid', 'shipped', 'delivered', 'cancelled') then
    raise exception 'Unknown status %', p_status;
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found';
  end if;

  if p_status in ('confirmed', 'paid', 'shipped', 'delivered') and not v_order.stock_deducted then
    for v_line in select value from jsonb_array_elements(v_order.items) order by value ->> 'product_id' loop
      select stock into v_left from public.products where id = v_line ->> 'product_id' for update;
      if v_left is not null and v_left < (v_line ->> 'quantity')::integer then
        raise exception 'Not enough stock for % (% left). Update the stock first.', v_line ->> 'name', v_left;
      end if;
      update public.products set stock = stock - (v_line ->> 'quantity')::integer
      where id = v_line ->> 'product_id' and stock is not null;
    end loop;
    update public.orders set stock_deducted = true where id = p_order_id;
  elsif p_status in ('new', 'cancelled') and v_order.stock_deducted then
    for v_line in select value from jsonb_array_elements(v_order.items) order by value ->> 'product_id' loop
      update public.products set stock = stock + (v_line ->> 'quantity')::integer
      where id = v_line ->> 'product_id' and stock is not null;
    end loop;
    update public.orders set stock_deducted = false where id = p_order_id;
  end if;

  -- Reopening an order does not start a new hold; confirm it to take stock off.
  update public.orders set status = p_status, reserved_until = null where id = p_order_id;
end $$;

-- ─── Order events and status emails ────────────────────────────────────────
-- Every status change is recorded. Changes the customer should hear about are
-- queued; the 'shop' server function's notify route sends them a minute later
-- (so the admin has time to add the courier tracking number).

create table if not exists public.order_events (
  id              bigint generated always as identity primary key,
  order_id        uuid not null references public.orders (id) on delete cascade,
  status          text not null,
  created_at      timestamptz not null default now(),
  notify_state    text not null default 'none'
                  check (notify_state in ('none', 'queued', 'sending', 'sent', 'skipped', 'failed')),
  notify_attempts integer not null default 0,
  claimed_at      timestamptz,
  notified_at     timestamptz
);
create index if not exists order_events_order_idx on public.order_events (order_id, id);
create index if not exists order_events_queue_idx on public.order_events (id)
  where notify_state in ('queued', 'sending');

create or replace function public.record_order_event()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.order_events (order_id, status) values (new.id, new.status);
  elsif new.status is distinct from old.status then
    insert into public.order_events (order_id, status, notify_state)
    values (new.id, new.status,
            case when new.status in ('confirmed', 'shipped', 'delivered', 'cancelled') and new.email <> ''
                 then 'queued' else 'none' end);
  end if;
  return null;
end $$;

drop trigger if exists orders_record_event on public.orders;
create trigger orders_record_event after insert or update of status on public.orders
  for each row execute function public.record_order_event();

-- One-time backfill for orders placed before events existed.
insert into public.order_events (order_id, status, created_at)
select o.id, 'new', o.created_at from public.orders o
where not exists (select 1 from public.order_events e where e.order_id = o.id);
insert into public.order_events (order_id, status, created_at)
select o.id, o.status, o.updated_at from public.orders o
where o.status <> 'new'
  and not exists (select 1 from public.order_events e where e.order_id = o.id and e.status = o.status);

-- Hands the server function a batch of emails to send. Superseded events
-- (e.g. "shipped" when the order is already "delivered") are skipped, and
-- sends that crashed part-way are retried up to three times.
create or replace function public.claim_order_notifications(p_limit integer default 20)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_result jsonb;
begin
  update public.order_events e set notify_state = 'skipped'
  where e.notify_state = 'queued'
    and exists (select 1 from public.order_events later
                where later.order_id = e.order_id and later.id > e.id and later.status <> 'new');

  update public.order_events set notify_state = case when notify_attempts >= 3 then 'failed' else 'queued' end
  where notify_state = 'sending' and claimed_at < now() - interval '10 minutes';

  with picked as (
    select e.id from public.order_events e
    where e.notify_state = 'queued' and e.created_at < now() - interval '1 minute'
    order by e.id
    limit greatest(1, least(coalesce(p_limit, 20), 50))
    for update skip locked
  ), claimed as (
    update public.order_events e
    set notify_state = 'sending', notify_attempts = e.notify_attempts + 1, claimed_at = now()
    from picked where e.id = picked.id
    returning e.id, e.order_id, e.status
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'event_id', c.id, 'status', c.status,
    'reference', o.reference, 'customer_name', o.customer_name, 'email', o.email,
    'tracking', o.tracking, 'items', o.items, 'subtotal', o.subtotal,
    'payment_status', o.payment_status) order by c.id), '[]'::jsonb)
  into v_result
  from claimed c join public.orders o on o.id = c.order_id;
  return v_result;
end $$;

create or replace function public.finish_order_notification(p_event_id bigint, p_sent boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.order_events set
    notify_state = case when p_sent then 'sent' when notify_attempts >= 3 then 'failed' else 'queued' end,
    notified_at  = case when p_sent then now() else notified_at end
  where id = p_event_id and notify_state = 'sending';
end $$;

-- ─── Reviews ───────────────────────────────────────────────────────────────
-- Only someone who ordered a plant (order number + phone) can review it, once
-- it has shipped. Reviews show on the site after an admin approves them.

create table if not exists public.reviews (
  id          uuid primary key default gen_random_uuid(),
  product_id  text not null references public.products (id) on update cascade on delete cascade,
  order_id    uuid not null references public.orders (id) on delete cascade,
  author_name text not null check (char_length(author_name) between 1 and 60),
  city        text not null default '',
  rating      smallint not null check (rating between 1 and 5),
  body        text not null check (char_length(body) between 10 and 1000),
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (order_id, product_id)
);
create index if not exists reviews_product_idx on public.reviews (product_id, created_at desc) where status = 'approved';
create index if not exists reviews_status_idx on public.reviews (status, created_at desc);

drop trigger if exists reviews_touch on public.reviews;
create trigger reviews_touch before update on public.reviews
  for each row execute function public.touch_updated_at();

create or replace view public.product_ratings with (security_invoker = true) as
select product_id, round(avg(rating)::numeric, 1) as average_rating, count(*)::integer as review_count
from public.reviews
where status = 'approved'
group by product_id;

create or replace function public.submit_review(p_reference text, p_phone text, p_product_id text,
                                                p_rating integer, p_body text, p_name text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_order  public.orders%rowtype;
  v_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_body   text := btrim(coalesce(p_body, ''));
  v_name   text := btrim(coalesce(p_name, ''));
  v_status text;
begin
  if char_length(v_digits) < 8 or p_reference is null then
    raise exception 'We couldn''t find that order';
  end if;
  select * into v_order from public.orders
  where reference = upper(btrim(p_reference)) and right(phone_digits, 10) = right(v_digits, 10);
  if not found then
    raise exception 'We couldn''t find that order';
  end if;
  if v_order.status not in ('shipped', 'delivered') then
    raise exception 'You can review your plants once your order has shipped';
  end if;
  if not exists (select 1 from jsonb_array_elements(v_order.items) l where l ->> 'product_id' = p_product_id) then
    raise exception 'That plant isn''t part of this order';
  end if;
  if p_rating is null or p_rating not between 1 and 5 then
    raise exception 'Please choose a rating from 1 to 5';
  end if;
  if char_length(v_body) not between 10 and 1000 then
    raise exception 'Please write between 10 and 1000 characters';
  end if;
  if v_name = '' then
    v_name := split_part(btrim(v_order.customer_name), ' ', 1);
  end if;
  if char_length(v_name) > 60 then
    raise exception 'Please use a shorter name';
  end if;

  select status into v_status from public.reviews where order_id = v_order.id and product_id = p_product_id;
  if v_status is not null and v_status <> 'pending' then
    raise exception 'You''ve already reviewed this plant. Thank you!';
  end if;

  insert into public.reviews (product_id, order_id, author_name, city, rating, body)
  values (p_product_id, v_order.id, v_name, v_order.city, p_rating, v_body)
  on conflict (order_id, product_id) do update
    set author_name = excluded.author_name, rating = excluded.rating, body = excluded.body;
  return jsonb_build_object('ok', true);
end $$;

-- ─── Order tracking (adds the timeline and which plants can be reviewed) ───

create or replace function public.track_order(p_reference text, p_phone text)
returns jsonb
language plpgsql
stable security definer set search_path = public
as $$
declare
  v_order  public.orders%rowtype;
  v_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  if char_length(v_digits) < 8 or p_reference is null then
    return null;
  end if;
  select * into v_order from public.orders
  where reference = upper(btrim(p_reference))
    and right(phone_digits, 10) = right(v_digits, 10)
    and payment_status <> 'pending';
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'reference', v_order.reference, 'status', v_order.status, 'payment_status', v_order.payment_status,
    'subtotal', v_order.subtotal, 'tracking', v_order.tracking, 'city', v_order.city,
    'created_at', v_order.created_at, 'paid_at', v_order.paid_at,
    'items', (select jsonb_agg(jsonb_build_object('product_id', l ->> 'product_id', 'name', l ->> 'name',
                                                  'size', l ->> 'size', 'color', l ->> 'color',
                                                  'quantity', (l ->> 'quantity')::integer, 'line_total', (l ->> 'line_total')::integer))
              from jsonb_array_elements(v_order.items) as l),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('status', e.status, 'at', e.created_at) order by e.id), '[]'::jsonb)
               from public.order_events e where e.order_id = v_order.id),
    'can_review', v_order.status in ('shipped', 'delivered'),
    'reviewed', (select coalesce(jsonb_agg(r.product_id), '[]'::jsonb)
                 from public.reviews r where r.order_id = v_order.id and r.status <> 'pending'));
end $$;

-- ─── Product search ────────────────────────────────────────────────────────
-- The storefront filters in the browser while the catalog is small. This is
-- the server-side search for when it grows past a few hundred plants.

create index if not exists products_search_idx on public.products
  using gin (to_tsvector('simple', name || ' ' || botanical || ' ' || tag || ' ' || description));
create index if not exists products_name_trgm_idx on public.products
  using gin ((name || ' ' || botanical) extensions.gin_trgm_ops);

create or replace function public.search_products(p_query text, p_limit integer default 24, p_offset integer default 0)
returns setof public.products
language sql stable security invoker set search_path = public, extensions
as $$
  select p.* from public.products p
  where p.is_active
    and (coalesce(btrim(p_query), '') = ''
         or to_tsvector('simple', p.name || ' ' || p.botanical || ' ' || p.tag || ' ' || p.description)
            @@ websearch_to_tsquery('simple', p_query)
         or p_query <% (p.name || ' ' || p.botanical)
         or (p.name || ' ' || p.botanical) ilike '%' || p_query || '%')
  order by
    ts_rank(to_tsvector('simple', p.name || ' ' || p.botanical || ' ' || p.tag || ' ' || p.description),
            websearch_to_tsquery('simple', coalesce(p_query, ''))) desc,
    word_similarity(coalesce(p_query, ''), p.name || ' ' || p.botanical) desc,
    p.sort_order, p.name
  limit least(greatest(coalesce(p_limit, 24), 1), 100) offset greatest(coalesce(p_offset, 0), 0);
$$;

-- ─── Security for the new tables and functions ─────────────────────────────

alter table public.order_events enable row level security;
alter table public.reviews      enable row level security;

drop policy if exists "Admins read order events" on public.order_events;
create policy "Admins read order events" on public.order_events
  for select to authenticated using (public.is_admin());
revoke insert, update, delete on public.order_events from anon, authenticated;

drop policy if exists "Anyone reads approved reviews" on public.reviews;
create policy "Anyone reads approved reviews" on public.reviews
  for select using (status = 'approved' or public.is_admin());
drop policy if exists "Admins moderate reviews" on public.reviews;
create policy "Admins moderate reviews" on public.reviews
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "Admins delete reviews" on public.reviews;
create policy "Admins delete reviews" on public.reviews
  for delete to authenticated using (public.is_admin());
-- Visitors see reviews without the order they came from.
revoke all on public.reviews from anon;
grant select (id, product_id, author_name, city, rating, body, status, created_at) on public.reviews to anon;
revoke insert, update, delete on public.reviews from anon, authenticated;
grant update (status) on public.reviews to authenticated;
grant delete on public.reviews to authenticated;
grant select on public.product_ratings to anon, authenticated;

grant execute on function public.submit_review(text, text, text, integer, text, text) to anon, authenticated;
grant execute on function public.search_products(text, integer, integer) to anon, authenticated;
revoke execute on function public.release_expired_reservations() from public, anon, authenticated;
revoke execute on function public.claim_order_notifications(integer) from public, anon, authenticated;
revoke execute on function public.finish_order_notification(bigint, boolean) from public, anon, authenticated;
revoke execute on function public.record_order_event() from public, anon, authenticated;
grant execute on function public.claim_order_notifications(integer) to service_role;
grant execute on function public.finish_order_notification(bigint, boolean) to service_role;

-- ─── Scheduled jobs ────────────────────────────────────────────────────────

select cron.schedule('release-stock-holds', '*/5 * * * *', 'select public.release_expired_reservations()');
select cron.schedule('send-order-emails', '*/2 * * * *', $job$
  select net.http_post(
    url := 'https://prpnlxxplddmarxnugsw.supabase.co/functions/v1/shop/notify',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 30000)
$job$);

-- Access to the order functions defined above.
revoke execute on function public.set_order_status(uuid, text) from public, anon;
grant execute on function public.set_order_status(uuid, text) to authenticated;
grant execute on function public.place_order(text, jsonb, jsonb) to anon, authenticated;
grant execute on function public.track_order(text, text) to anon, authenticated;
revoke execute on function public.mark_order_paid(text, text, bigint) from public, anon, authenticated;
grant execute on function public.mark_order_paid(text, text, bigint) to service_role;
