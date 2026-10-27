// API route handlers.

import {
  newId, createPasswordHash, verifyPassword,
  newSessionToken, sessionCookie, clearSessionCookie,
  getSessionUser, SESSION_TTL_MS
} from './auth.js';
import { json, error, readJson, withCookie } from './http.js';

// ---------- Auth ----------

export async function signup(request, env) {
  const body = await readJson(request);
  if (!body) return error(400, 'Invalid JSON');
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const name = body.name ? String(body.name).trim() : null;
  const role = body.role === 'company' ? 'company' : 'passenger';

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return error(400, 'Invalid email');
  if (password.length < 8) return error(400, 'Password must be at least 8 characters');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return error(409, 'Email already registered');

  const { hash, salt } = await createPasswordHash(password);
  const id = newId('u');
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, password_salt, name, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, email, hash, salt, name, role, now).run();

  const token = newSessionToken();
  const expires = now + SESSION_TTL_MS;
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(token, id, expires).run();

  return withCookie(json({ user: { id, email, name, role } }), sessionCookie(token));
}

export async function login(request, env) {
  const body = await readJson(request);
  if (!body) return error(400, 'Invalid JSON');
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  const user = await env.DB.prepare(
    'SELECT id, email, password_hash, password_salt, name, role FROM users WHERE email = ?'
  ).bind(email).first();
  if (!user) return error(401, 'Invalid email or password');

  const ok = await verifyPassword(password, user.password_hash, user.password_salt);
  if (!ok) return error(401, 'Invalid email or password');

  const token = newSessionToken();
  const expires = Date.now() + SESSION_TTL_MS;
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(token, user.id, expires).run();

  return withCookie(
    json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } }),
    sessionCookie(token)
  );
}

export async function logout(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/cr_session=([^;]+)/);
  if (m) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(m[1]).run();
  }
  return withCookie(json({ ok: true }), clearSessionCookie());
}

export async function me(request, env) {
  const user = await getSessionUser(env, request);
  return json({ user });
}

// ---------- Companies ----------

export async function listCompanies(request, env) {
  const url = new URL(request.url);
  const city = url.searchParams.get('city');

  let query, bindings;
  if (city) {
    query = `SELECT * FROM companies WHERE LOWER(city) = LOWER(?) ORDER BY created_at DESC`;
    bindings = [city];
  } else {
    query = `SELECT * FROM companies ORDER BY created_at DESC`;
    bindings = [];
  }
  const { results: companies } = await env.DB.prepare(query).bind(...bindings).all();

  // Attach reviews for each company (fine at prototype scale)
  const ids = companies.map(c => c.id);
  let reviewsByCompany = {};
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const { results: reviews } = await env.DB.prepare(
      `SELECT * FROM reviews WHERE company_id IN (${placeholders}) ORDER BY created_at DESC`
    ).bind(...ids).all();
    for (const r of reviews) {
      (reviewsByCompany[r.company_id] ||= []).push(r);
    }
  }

  // Phone/email are private — only revealed to a passenger after they book.
  return json({
    companies: companies.map(c => {
      const { phone, email, ...pub } = c;
      return { ...pub, reviews: reviewsByCompany[c.id] || [] };
    }),
  });
}

export async function listMyCompanies(request, env) {
  const user = await getSessionUser(env, request);
  if (!user) return error(401, 'Login required');

  const { results } = await env.DB.prepare(
    'SELECT * FROM companies WHERE owner_id = ? ORDER BY created_at DESC'
  ).bind(user.id).all();

  return json({ companies: results });
}

export async function updateCompany(request, env, id) {
  const user = await getSessionUser(env, request);
  if (!user) return error(401, 'Login required');

  const existing = await env.DB.prepare('SELECT * FROM companies WHERE id = ?').bind(id).first();
  if (!existing) return error(404, 'Company not found');
  if (existing.owner_id !== user.id) return error(403, 'Only the owner can edit this listing');

  const body = await readJson(request);
  if (!body) return error(400, 'Invalid JSON');

  const name = String(body.name || '').trim();
  const billing_address = String(body.billing_address || '').trim();
  const city = String(body.city || '').trim();
  const vat_number = String(body.vat_number || '').trim();
  const managing_director = String(body.managing_director || '').trim();
  const phone = String(body.phone || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const description = body.description ? String(body.description).trim() : null;
  const price_per_km = parseFloat(body.price_per_km);
  const min_km = parseFloat(body.min_km);

  if (!name || !billing_address || !city || !vat_number || !managing_director || !phone || !email) {
    return error(400, 'Missing required fields');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return error(400, 'Invalid contact email');
  if (isNaN(price_per_km) || price_per_km <= 0) return error(400, 'Invalid price per km');
  if (isNaN(min_km) || min_km <= 0) return error(400, 'Invalid minimum km');

  await env.DB.prepare(
    `UPDATE companies SET
       name = ?, billing_address = ?, city = ?, vat_number = ?, managing_director = ?,
       phone = ?, email = ?, description = ?, price_per_km = ?, min_km = ?
     WHERE id = ?`
  ).bind(name, billing_address, city, vat_number, managing_director,
         phone, email, description, price_per_km, min_km, id).run();

  const row = await env.DB.prepare('SELECT * FROM companies WHERE id = ?').bind(id).first();
  return json({ company: row });
}

export async function createCompany(request, env) {
  const user = await getSessionUser(env, request);
  if (!user) return error(401, 'Login required');
  if (user.role !== 'company') return error(403, 'Only company accounts can list a company');

  const body = await readJson(request);
  if (!body) return error(400, 'Invalid JSON');

  const name = String(body.name || '').trim();
  const billing_address = String(body.billing_address || '').trim();
  const city = String(body.city || '').trim();
  const vat_number = String(body.vat_number || '').trim();
  const managing_director = String(body.managing_director || '').trim();
  const phone = String(body.phone || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const description = body.description ? String(body.description).trim() : null;
  const price_per_km = parseFloat(body.price_per_km);
  const min_km = parseFloat(body.min_km);

  if (!name || !billing_address || !city || !vat_number || !managing_director || !phone || !email) {
    return error(400, 'Missing required fields');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return error(400, 'Invalid contact email');
  if (isNaN(price_per_km) || price_per_km <= 0) return error(400, 'Invalid price per km');
  if (isNaN(min_km) || min_km <= 0) return error(400, 'Invalid minimum km');

  const id = newId('c');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO companies (id, owner_id, name, billing_address, city, vat_number, managing_director,
                            phone, email, description, price_per_km, min_km, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, user.id, name, billing_address, city, vat_number, managing_director,
         phone, email, description, price_per_km, min_km, now).run();

  const row = await env.DB.prepare('SELECT * FROM companies WHERE id = ?').bind(id).first();
  return json({ company: { ...row, reviews: [] } }, { status: 201 });
}

// ---------- Bookings ----------

export async function listBookings(request, env) {
  const user = await getSessionUser(env, request);
  if (!user) return error(401, 'Login required');

  // Return bookings where user is the rider OR the owner of the company
  const { results } = await env.DB.prepare(
    `SELECT b.*, c.name AS company_name, c.city AS company_city, c.owner_id,
            c.phone AS company_phone, c.email AS company_email
       FROM bookings b
       JOIN companies c ON c.id = b.company_id
      WHERE b.rider_id = ? OR c.owner_id = ?
      ORDER BY b.created_at DESC`
  ).bind(user.id, user.id).all();

  const bookings = results.map(r => {
    const isRider = r.rider_id === user.id;
    const isOwner = r.owner_id === user.id;
    // Only the rider on this booking sees the company's contact info.
    if (!isRider) {
      r.company_phone = null;
      r.company_email = null;
    }
    return { ...r, is_rider: isRider, is_owner: isOwner };
  });
  return json({ bookings });
}

export async function createBooking(request, env) {
  const user = await getSessionUser(env, request);
  if (!user) return error(401, 'Login required');
  if (user.role !== 'passenger') return error(403, 'Only passengers can book rides');

  const body = await readJson(request);
  if (!body) return error(400, 'Invalid JSON');

  const companyId = String(body.company_id || '');
  const pickup = String(body.pickup || '').trim();
  const dropoff = String(body.dropoff || '').trim();
  const distance = parseFloat(body.distance);

  if (!companyId || !pickup || !dropoff || isNaN(distance) || distance <= 0) {
    return error(400, 'Missing or invalid fields');
  }

  const company = await env.DB.prepare('SELECT * FROM companies WHERE id = ?').bind(companyId).first();
  if (!company) return error(404, 'Company not found');
  if (distance < company.min_km) {
    return error(400, `Minimum distance for this company is ${company.min_km} km`);
  }

  const id = newId('bk');
  const total = distance * company.price_per_km;
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO bookings (id, company_id, rider_id, pickup, dropoff, distance, price_per_km, total,
                           status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).bind(id, companyId, user.id, pickup, dropoff, distance, company.price_per_km, total, now).run();

  const booking = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
  return json({ booking: {
    ...booking,
    company_name: company.name,
    company_city: company.city,
    company_phone: company.phone,
    company_email: company.email,
    is_rider: true,
    is_owner: false,
  } }, { status: 201 });
}

// Owner actions: accept/decline/complete/cancel/noshow
export async function bookingAction(request, env, id) {
  const user = await getSessionUser(env, request);
  if (!user) return error(401, 'Login required');

  const body = await readJson(request);
  const action = String(body?.action || '');
  const allowed = ['accept', 'decline', 'complete', 'cancel', 'noshow'];
  if (!allowed.includes(action)) return error(400, 'Invalid action');

  const booking = await env.DB.prepare(
    `SELECT b.*, c.owner_id FROM bookings b JOIN companies c ON c.id = b.company_id WHERE b.id = ?`
  ).bind(id).first();
  if (!booking) return error(404, 'Booking not found');
  if (booking.owner_id !== user.id) return error(403, 'Only the company owner can act on this booking');

  // Validate state transitions
  const s = booking.status;
  const now = Date.now();
  let newStatus, timestampCol = null, statCol = null;

  if (action === 'accept') {
    if (s !== 'pending') return error(409, `Cannot accept a ${s} booking`);
    newStatus = 'accepted'; timestampCol = 'accepted_at';
  } else if (action === 'decline') {
    if (s !== 'pending') return error(409, `Cannot decline a ${s} booking`);
    newStatus = 'declined'; timestampCol = 'cancelled_at';
  } else if (action === 'complete') {
    if (s !== 'accepted') return error(409, `Cannot complete a ${s} booking`);
    newStatus = 'completed'; timestampCol = 'completed_at'; statCol = 'stats_completed';
  } else if (action === 'cancel') {
    if (s !== 'accepted') return error(409, `Cannot cancel a ${s} booking`);
    newStatus = 'cancelled'; timestampCol = 'cancelled_at'; statCol = 'stats_cancelled';
  } else if (action === 'noshow') {
    if (s !== 'accepted') return error(409, `Cannot no-show a ${s} booking`);
    newStatus = 'noshow'; timestampCol = 'cancelled_at'; statCol = 'stats_noshow';
  }

  await env.DB.prepare(
    `UPDATE bookings SET status = ?, ${timestampCol} = ? WHERE id = ?`
  ).bind(newStatus, now, id).run();

  if (statCol) {
    const extraSet = action === 'complete' ? ', last_completed_at = ?' : '';
    const stmt = env.DB.prepare(
      `UPDATE companies SET ${statCol} = ${statCol} + 1${extraSet} WHERE id = ?`
    );
    await (action === 'complete'
      ? stmt.bind(now, booking.company_id)
      : stmt.bind(booking.company_id)
    ).run();
  }

  return json({ ok: true, status: newStatus });
}

// Rider rates a completed booking
export async function createReview(request, env) {
  const user = await getSessionUser(env, request);
  if (!user) return error(401, 'Login required');
  if (user.role !== 'passenger') return error(403, 'Only passengers can leave reviews');

  const body = await readJson(request);
  const bookingId = String(body?.booking_id || '');
  const rating = parseInt(body?.rating, 10);
  const comment = body?.comment ? String(body.comment).trim() : null;

  if (!bookingId || !rating || rating < 1 || rating > 5) return error(400, 'Invalid rating');

  const booking = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(bookingId).first();
  if (!booking) return error(404, 'Booking not found');
  if (booking.rider_id !== user.id) return error(403, 'Only the rider can review');
  if (booking.status !== 'completed') return error(409, 'Can only review completed trips');
  if (booking.reviewed) return error(409, 'Already reviewed');

  const id = newId('r');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO reviews (id, company_id, rider_id, booking_id, rating, comment, author, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, booking.company_id, user.id, bookingId, rating, comment, user.name || user.email.split('@')[0], now).run();

  await env.DB.prepare('UPDATE bookings SET reviewed = 1 WHERE id = ?').bind(bookingId).run();

  return json({ ok: true });
}
