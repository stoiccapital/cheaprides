// Cheaprides Worker entry.
// Routes /api/* to handlers, serves everything else from the static assets binding.

import {
  signup, login, logout, me,
  listCompanies, createCompany,
  listBookings, createBooking, bookingAction,
  createReview,
} from './routes.js';
import { error } from './http.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (pathname.startsWith('/api/')) {
      try {
        return await route(request, env, pathname, method);
      } catch (e) {
        console.error('API error:', e);
        return error(500, 'Internal server error');
      }
    }

    // Static assets (SPA fallback handled by wrangler.toml)
    return env.ASSETS.fetch(request);
  },
};

async function route(request, env, pathname, method) {
  // Auth
  if (pathname === '/api/auth/signup' && method === 'POST') return signup(request, env);
  if (pathname === '/api/auth/login'  && method === 'POST') return login(request, env);
  if (pathname === '/api/auth/logout' && method === 'POST') return logout(request, env);
  if (pathname === '/api/auth/me'     && method === 'GET')  return me(request, env);

  // Companies
  if (pathname === '/api/companies' && method === 'GET')  return listCompanies(request, env);
  if (pathname === '/api/companies' && method === 'POST') return createCompany(request, env);

  // Bookings
  if (pathname === '/api/bookings' && method === 'GET')  return listBookings(request, env);
  if (pathname === '/api/bookings' && method === 'POST') return createBooking(request, env);

  const bkAction = pathname.match(/^\/api\/bookings\/([^/]+)\/action$/);
  if (bkAction && method === 'POST') return bookingAction(request, env, bkAction[1]);

  // Reviews
  if (pathname === '/api/reviews' && method === 'POST') return createReview(request, env);

  return error(404, 'Not found');
}
