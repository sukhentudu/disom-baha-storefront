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

  for v_item in select value from jsonb_array_elements(p_items) loop
    select * into v_product from public.products where id = v_item ->> 'id' and is_active;
    if not found then
      raise exception 'A product in your bag is no longer available';
    end if;

    v_qty := (v_item ->> 'quantity')::integer;
    if v_qty is null or v_qty not between 1 and 50 then
      raise exception 'Invalid quantity for %', v_product.name;
    end if;
    if v_product.stock is not null and v_qty > v_product.stock then
      raise exception 'Only % of % left', v_product.stock, v_product.name;
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

    v_unit := v_product.price + v_extra;
    v_subtotal := v_subtotal + v_unit * v_qty;
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_product.id, 'name', v_product.name, 'size', v_size, 'color', v_color,
      'quantity', v_qty, 'unit_price', v_unit, 'line_total', v_unit * v_qty);
  end loop;

  insert into public.orders (reference, customer_name, phone, phone_digits, email, address, city, state,
                             pincode, payment_preference, items, subtotal)
  values (p_reference, v_name, v_phone, v_digits, v_email, v_address, v_city, v_state,
          v_pincode, v_payment, v_lines, v_subtotal);
  return p_reference;
end $$;

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
create or replace function public.track_order(p_reference text, p_phone text)
returns jsonb
language plpgsql stable security definer set search_path = public
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
    'items', (select jsonb_agg(jsonb_build_object('name', l ->> 'name', 'size', l ->> 'size', 'color', l ->> 'color',
                                                  'quantity', (l ->> 'quantity')::integer, 'line_total', (l ->> 'line_total')::integer))
              from jsonb_array_elements(v_order.items) as l));
end $$;

-- ─── Payment functions (called only by the 'shop' server function) ─────────

-- Marks a Razorpay order as paid. Safe to call more than once. Takes the
-- items off stock; if stock ran short, the order is kept for the admin with
-- a note instead of failing a payment the customer has already made.
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
    for v_line in select value from jsonb_array_elements(v_order.items) loop
      select stock into v_left from public.products where id = v_line ->> 'product_id' for update;
      if v_left is not null and v_left < (v_line ->> 'quantity')::integer then
        v_short := v_short || format('%s (%s left); ', v_line ->> 'name', v_left);
      end if;
    end loop;
    if v_short = '' then
      for v_line in select value from jsonb_array_elements(v_order.items) loop
        update public.products set stock = stock - (v_line ->> 'quantity')::integer
        where id = v_line ->> 'product_id' and stock is not null;
      end loop;
    end if;
  end if;

  update public.orders set
    payment_status      = 'paid',
    razorpay_payment_id = p_payment_id,
    paid_at             = now(),
    status              = case when status = 'new' then 'paid' else status end,
    stock_deducted      = stock_deducted or v_short = '',
    admin_note          = case when v_short = '' then admin_note
                          when admin_note = '' then 'Paid online, but stock was short: ' || v_short || 'restock or refund.'
                          else admin_note || E'\n' || 'Paid online, but stock was short: ' || v_short || 'restock or refund.' end
  where id = v_order.id;
  return jsonb_build_object('reference', v_order.reference, 'newly_paid', true, 'stock_ok', v_short = '');
end $$;

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
    for v_line in select value from jsonb_array_elements(v_order.items) loop
      select stock into v_left from public.products where id = v_line ->> 'product_id' for update;
      if v_left is not null and v_left < (v_line ->> 'quantity')::integer then
        raise exception 'Not enough stock for % (% left). Update the stock first.', v_line ->> 'name', v_left;
      end if;
      update public.products set stock = stock - (v_line ->> 'quantity')::integer
      where id = v_line ->> 'product_id' and stock is not null;
    end loop;
    update public.orders set stock_deducted = true where id = p_order_id;
  elsif p_status in ('new', 'cancelled') and v_order.stock_deducted then
    for v_line in select value from jsonb_array_elements(v_order.items) loop
      update public.products set stock = stock + (v_line ->> 'quantity')::integer
      where id = v_line ->> 'product_id' and stock is not null;
    end loop;
    update public.orders set stock_deducted = false where id = p_order_id;
  end if;

  update public.orders set status = p_status where id = p_order_id;
end $$;

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

revoke execute on function public.set_order_status(uuid, text) from public, anon;
revoke execute on function public.add_admin_by_email(text) from public, anon;
revoke execute on function public.remove_admin(uuid) from public, anon;
grant execute on function public.set_order_status(uuid, text) to authenticated;
grant execute on function public.add_admin_by_email(text) to authenticated;
grant execute on function public.remove_admin(uuid) to authenticated;
grant execute on function public.place_order(text, jsonb, jsonb) to anon, authenticated;
grant execute on function public.submit_contact_message(text, text, text) to anon, authenticated;
grant execute on function public.track_page_view(text, text) to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.track_order(text, text) to anon, authenticated;
revoke execute on function public.mark_order_paid(text, text, bigint) from public, anon, authenticated;
revoke execute on function public.set_order_payment_state(text, text) from public, anon, authenticated;
grant execute on function public.mark_order_paid(text, text, bigint) to service_role;
grant execute on function public.set_order_payment_state(text, text) to service_role;

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
