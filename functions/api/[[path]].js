// Pages Functions catch-all for /api/*
// Reuses the same handlers as the Workers deployment.

import {
  signup, login, logout, me,
  listCompanies, createCompany,
  listBookings, createBooking, bookingAction,
  createReview,
} from '../../src/routes.js';
import { error } from '../../src/http.js';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method;

  try {
    if (pathname === '/api/auth/signup' && method === 'POST') return signup(request, env);
    if (pathname === '/api/auth/login'  && method === 'POST') return login(request, env);
    if (pathname === '/api/auth/logout' && method === 'POST') return logout(request, env);
    if (pathname === '/api/auth/me'     && method === 'GET')  return me(request, env);

    if (pathname === '/api/companies' && method === 'GET')  return listCompanies(request, env);
    if (pathname === '/api/companies' && method === 'POST') return createCompany(request, env);

    if (pathname === '/api/bookings' && method === 'GET')  return listBookings(request, env);
    if (pathname === '/api/bookings' && method === 'POST') return createBooking(request, env);

    const bkAction = pathname.match(/^\/api\/bookings\/([^/]+)\/action$/);
    if (bkAction && method === 'POST') return bookingAction(request, env, bkAction[1]);

    if (pathname === '/api/reviews' && method === 'POST') return createReview(request, env);

    return error(404, 'Not found');
  } catch (e) {
    console.error('API error:', e);
    return error(500, 'Internal server error');
  }
}
