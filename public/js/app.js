// Cheaprides frontend — talks to the Cloudflare Worker API at /api/*.

// ---------- i18n ----------
let translations = { en: {}, de: {} };
let currentLang = 'en';
function t(key, params = {}) {
  const str = (translations[currentLang] || {})[key] || (translations.en || {})[key] || key;
  return str.replace(/\{(\w+)\}/g, (_, k) => params[k] != null ? params[k] : `{${k}}`);
}
function applyI18n(root = document) {
  if (root === document) document.documentElement.lang = currentLang;
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const attr = el.getAttribute('data-i18n-attr');
    const value = t(key);
    if (attr) el.setAttribute(attr, value);
    else el.textContent = value;
  });
  document.querySelectorAll('.lang-btn').forEach(b => {
    b.classList.toggle('is-active', b.dataset.lang === currentLang);
  });
}
async function loadTranslations() {
  try {
    const res = await fetch('/i18n/translations.json');
    translations = await res.json();
  } catch (e) {
    console.error('Failed to load translations', e);
  }
}
function detectLang() {
  const stored = localStorage.getItem('cr_lang');
  if (stored === 'en' || stored === 'de') return stored;
  return (navigator.language || 'en').toLowerCase().startsWith('de') ? 'de' : 'en';
}
function setLang(lang) {
  if (lang !== 'en' && lang !== 'de') return;
  currentLang = lang;
  localStorage.setItem('cr_lang', lang);
  applyI18n();
  // Re-render all dynamic content so t() calls pick up the new language.
  renderAuthState();
  renderListAuthState();
  renderCompanies();
  renderBookings();
}

// ---------- State ----------
let currentUser = null;      // { id, email, name } when logged in
let companies = [];          // from /api/companies
let myCompanies = [];        // from /api/companies/mine (company accounts only)
let bookings = [];           // from /api/bookings (only when logged in)
let editingCompanyId = null; // null = create mode; id = edit mode
const DEFAULT_DISTANCE_KM = 25;
let currentDistance = DEFAULT_DISTANCE_KM;
let isDefaultDistance = true;  // true until user commits a route/distance
let currentSort = 'price';
let bookingsFilter = 'all';
let pickupCity = null;
let pickupCoord = null;
let dropoffCoord = null;

// Modal state
let modalCompanyId = null;
let modalBookingId = null;
let selectedRating = 0;
let bookingModalCompanyId = null;

// Auth modal state
let authMode = 'login'; // 'login' | 'signup'

// ---------- API client ----------
async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- Formatting ----------
function fmtEuro(v) {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}
function fmtKm(v) {
  return Number(v).toLocaleString('de-DE') + ' km';
}
function fmtPricePerKm(v) {
  return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €/km';
}
function fmtRelativeTime(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('time.justNow');
  if (mins < 60) return t('time.minAgo', { n: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t('time.hAgo', { n: hrs });
  const days = Math.floor(hrs / 24);
  if (days < 30) return t('time.dAgo', { n: days });
  const months = Math.floor(days / 30);
  if (months < 12) return t('time.moAgo', { n: months });
  return t('time.yAgo', { n: Math.floor(months / 12) });
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function stars(rating) {
  const full = Math.round(rating);
  return '★★★★★'.slice(0, full) + '☆☆☆☆☆'.slice(0, 5 - full);
}

// ---------- Business logic ----------
function avgRating(reviews) {
  if (!reviews || reviews.length === 0) return 0;
  return reviews.reduce((a, r) => a + r.rating, 0) / reviews.length;
}
function computeFinalPrice(company, distance) {
  if (!distance || distance <= 0) return null;
  if (distance < company.min_km) {
    return { unavailable: true, reason: t('card.minKm', { km: fmtKm(company.min_km) }) };
  }
  return { unavailable: false, total: distance * company.price_per_km };
}
function matchesCity(company) {
  if (!pickupCity) return true;
  const a = (company.city || '').toLowerCase();
  const b = pickupCity.toLowerCase();
  return a === b || a.includes(b) || b.includes(a);
}
function sortCompanies(list, mode, distance) {
  const copy = [...list];
  if (mode === 'price' && distance) {
    copy.sort((a, b) => {
      const pa = computeFinalPrice(a, distance);
      const pb = computeFinalPrice(b, distance);
      return (pa && !pa.unavailable ? pa.total : Infinity) - (pb && !pb.unavailable ? pb.total : Infinity);
    });
  } else if (mode === 'price') {
    copy.sort((a, b) => a.price_per_km - b.price_per_km);
  } else if (mode === 'rating') {
    copy.sort((a, b) => avgRating(b.reviews) - avgRating(a.reviews));
  } else if (mode === 'newest') {
    copy.sort((a, b) => b.created_at - a.created_at);
  }
  return copy;
}

// ---------- DOM references ----------
const grid = document.getElementById('company-grid');
const emptyState = document.getElementById('empty-state');
const resultCount = document.getElementById('result-count');
const tripSummary = document.getElementById('trip-summary');
const cityChip = document.getElementById('city-chip');
const cityChipName = document.getElementById('city-chip-name');

const bookingsList = document.getElementById('bookings-list');
const bookingsEmpty = document.getElementById('bookings-empty');
const bookingsAuthWarn = document.getElementById('bookings-auth-warn');
const bookingsCount = document.getElementById('bookings-count');

const listAuthWarn = document.getElementById('list-auth-warn');
const companyForm = document.getElementById('company-form');

const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modal-title');
const modalSub = document.getElementById('modal-sub');
const reviewsList = document.getElementById('reviews-list');
const starInput = document.getElementById('star-input');
const reviewForm = document.getElementById('review-form');
const rateSection = document.getElementById('rate-section');

const bookingModal = document.getElementById('booking-modal');
const bookingConfirmBtn = document.getElementById('booking-confirm');

const authModal = document.getElementById('auth-modal');
const authForm = document.getElementById('auth-form');
const authError = document.getElementById('auth-error');

// ---------- Tabs / views ----------
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});
function switchView(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('is-active', t.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('is-active', v.id === 'view-' + name));
  if (name === 'bookings') renderBookings();
  if (name === 'list') renderListAuthState();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.addEventListener('click', (e) => {
  const goto = e.target.closest('[data-goto]');
  if (goto) switchView(goto.dataset.goto);
  const authLink = e.target.closest('[data-auth]');
  if (authLink) openAuth(authLink.dataset.auth);
});

// ---------- Auth UI ----------
const authUserEl = document.getElementById('auth-user');
const btnLogin = document.getElementById('btn-login');
const btnSignup = document.getElementById('btn-signup');
const btnLogout = document.getElementById('btn-logout');

btnLogin.addEventListener('click', () => openAuth('login'));
btnSignup.addEventListener('click', () => openAuth('signup'));
btnLogout.addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  currentUser = null;
  bookings = [];
  myCompanies = [];
  editingCompanyId = null;
  renderAuthState();
  renderBookings();
  renderListAuthState();
  renderCompanies();
});

function openAuth(mode) {
  authMode = mode;
  const title = document.getElementById('auth-modal-title');
  const sub = document.getElementById('auth-modal-sub');
  const submit = document.getElementById('auth-submit');
  const switchText = document.getElementById('auth-switch-text');
  const switchBtn = document.getElementById('auth-switch');
  const nameField = document.getElementById('auth-name-field');
  const roleField = document.getElementById('auth-role-field');

  if (mode === 'signup') {
    title.textContent = t('auth.signupTitle');
    sub.textContent = t('auth.signupSub');
    submit.textContent = t('auth.signup');
    switchText.textContent = t('auth.haveAccount');
    switchBtn.textContent = t('auth.loginInstead');
    nameField.hidden = false;
    roleField.hidden = false;
  } else {
    title.textContent = t('auth.loginTitle');
    sub.textContent = t('auth.loginSub');
    submit.textContent = t('auth.login');
    switchText.textContent = t('auth.newHere');
    switchBtn.textContent = t('auth.createAccount');
    nameField.hidden = true;
    roleField.hidden = true;
  }
  authError.hidden = true;
  authForm.reset();
  const defaultRole = document.querySelector('input[name="a-role"][value="passenger"]');
  if (defaultRole) defaultRole.checked = true;
  syncRolePicker();
  openModalEl(authModal);
}

function syncRolePicker() {
  document.querySelectorAll('.role-opt').forEach(opt => {
    const input = opt.querySelector('input');
    opt.classList.toggle('is-selected', input && input.checked);
  });
}
document.addEventListener('change', (e) => {
  if (e.target.matches && e.target.matches('input[name="a-role"]')) syncRolePicker();
});

document.getElementById('auth-switch').addEventListener('click', () => {
  openAuth(authMode === 'login' ? 'signup' : 'login');
});

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.hidden = true;
  const email = document.getElementById('a-email').value.trim();
  const password = document.getElementById('a-password').value;
  const name = document.getElementById('a-name').value.trim();
  const roleInput = document.querySelector('input[name="a-role"]:checked');
  const role = roleInput ? roleInput.value : 'passenger';

  try {
    const path = authMode === 'signup' ? '/auth/signup' : '/auth/login';
    const body = authMode === 'signup' ? { email, password, name, role } : { email, password };
    const data = await api(path, { method: 'POST', body });
    currentUser = data.user;
    closeAllModals();
    renderAuthState();
    renderCompanies();
    await Promise.all([refreshBookings(), refreshMyCompanies()]);
    renderListAuthState();
  } catch (err) {
    authError.textContent = err.message;
    authError.hidden = false;
  }
});

function renderAuthState() {
  const listTab = document.querySelector('[data-tab="list"]');
  if (currentUser) {
    authUserEl.hidden = false;
    const roleLabel = currentUser.role === 'company' ? t('role.company') : t('role.passenger');
    const roleBadge = `<span class="role-badge role-badge-${currentUser.role}">${roleLabel}</span>`;
    authUserEl.innerHTML = `<span class="auth-user-name">${escapeHtml(currentUser.name || currentUser.email)}</span>${roleBadge}`;
    btnLogout.hidden = false;
    btnLogin.hidden = true;
    btnSignup.hidden = true;
    // Hide "List your company" tab for passengers; relabel to "My listings" for companies.
    if (listTab) {
      listTab.hidden = currentUser.role === 'passenger';
      if (currentUser.role === 'company') listTab.textContent = t('nav.myListings');
      else listTab.textContent = t('nav.list');
    }
  } else {
    authUserEl.hidden = true;
    btnLogout.hidden = true;
    btnLogin.hidden = false;
    btnSignup.hidden = false;
    if (listTab) {
      listTab.hidden = false;
      listTab.textContent = t('nav.list');
    }
  }
}

function renderListAuthState() {
  const myListingsEl = document.getElementById('my-listings');
  const listFormActions = document.getElementById('list-form-actions');
  const listHeroTitle = document.getElementById('list-hero-title');
  const listHeroLede = document.getElementById('list-hero-lede');

  if (!currentUser) {
    listAuthWarn.hidden = false;
    const loginLink = `<button class="link-btn" data-auth="login">${t('list.loginLink')}</button>`;
    const signupLink = `<button class="link-btn" data-auth="signup">${t('list.signupLink')}</button>`;
    listAuthWarn.innerHTML = `<p>${t('list.authWarnLoggedOut', { loginLink, signupLink })}</p>`;
    companyForm.hidden = true;
    myListingsEl.hidden = true;
    listFormActions.hidden = true;
    return;
  }
  if (currentUser.role !== 'company') {
    listAuthWarn.hidden = false;
    listAuthWarn.innerHTML = `<p>${t('list.authWarnWrongRole')}</p>`;
    companyForm.hidden = true;
    myListingsEl.hidden = true;
    listFormActions.hidden = true;
    return;
  }
  listAuthWarn.hidden = true;

  // Company account: show listings if they exist, show form by default when none.
  const hasListings = myCompanies.length > 0;
  const inEditMode = editingCompanyId !== null;

  if (inEditMode) {
    // Editing: hide list, show form with "edit" labels
    myListingsEl.hidden = true;
    listFormActions.hidden = true;
    companyForm.hidden = false;
    listHeroTitle.textContent = t('list.editTitle');
    listHeroLede.textContent = t('list.editLede');
    document.getElementById('btn-publish').textContent = t('list.saveChanges');
    document.getElementById('btn-cancel-edit').hidden = false;
  } else if (hasListings) {
    // Has listings, not editing: show listing cards + "List another" button, hide form
    renderMyListings();
    myListingsEl.hidden = false;
    listFormActions.hidden = false;
    companyForm.hidden = true;
    listHeroTitle.textContent = t('list.myListingsTitle');
    listHeroLede.textContent = t('list.myListingsLede');
  } else {
    // No listings yet: show the creation form
    myListingsEl.hidden = true;
    listFormActions.hidden = true;
    companyForm.hidden = false;
    listHeroTitle.textContent = t('list.newListingTitle');
    listHeroLede.textContent = t('list.newListingLede');
    document.getElementById('btn-publish').textContent = t('list.publish');
    document.getElementById('btn-cancel-edit').hidden = true;
  }
}

function renderMyListings() {
  const el = document.getElementById('my-listings');
  el.innerHTML = myCompanies.map(c => {
    const completed = c.stats_completed || 0;
    const cancelled = c.stats_cancelled || 0;
    const noshow = c.stats_noshow || 0;
    const totalFinished = completed + cancelled + noshow;
    const received = c.total_received || 0;
    const declined = c.total_declined || 0;
    const noShowPct = totalFinished > 0 ? Math.round((noshow / totalFinished) * 100) : null;
    const cancelPct = totalFinished > 0 ? Math.round((cancelled / totalFinished) * 100) : null;
    const acceptPct = received > 0 ? Math.round(((received - declined) / received) * 100) : null;
    const fmt = (v) => v === null ? '—' : `${v}%`;
    return `
      <article class="listing-card" data-id="${c.id}">
        <div class="listing-head">
          <div>
            <h3 class="listing-name">${escapeHtml(c.name)}</h3>
            <span class="listing-city">${escapeHtml(c.city)}</span>
          </div>
          <div class="listing-actions">
            <button class="btn btn-ghost btn-sm" data-edit="${c.id}">${t('list.edit')}</button>
          </div>
        </div>
        <div class="listing-meta">
          <span><span class="num">${fmtPricePerKm(c.price_per_km)}</span></span>
          <span>${t('card.min')} <span class="num">${fmtKm(c.min_km)}</span></span>
        </div>
        <div class="listing-stats">
          <div class="listing-stat">
            <span class="listing-stat-label">${t('listing.trips')}</span>
            <span class="listing-stat-value num">${completed}</span>
          </div>
          <div class="listing-stat">
            <span class="listing-stat-label">${t('listing.acceptance')}</span>
            <span class="listing-stat-value num">${fmt(acceptPct)}</span>
          </div>
          <div class="listing-stat ${noShowPct > 0 ? 'is-warn' : ''}">
            <span class="listing-stat-label">${t('listing.noShow')}</span>
            <span class="listing-stat-value num">${fmt(noShowPct)}</span>
          </div>
          <div class="listing-stat ${cancelPct > 0 ? 'is-warn' : ''}">
            <span class="listing-stat-label">${t('listing.cancel')}</span>
            <span class="listing-stat-value num">${fmt(cancelPct)}</span>
          </div>
        </div>
        <div class="listing-contact">
          <span><a href="tel:${escapeHtml(c.phone)}">${escapeHtml(c.phone)}</a></span>
          <span><a href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a></span>
        </div>
      </article>
    `;
  }).join('');
}

async function refreshMyCompanies() {
  if (!currentUser || currentUser.role !== 'company') {
    myCompanies = [];
    return;
  }
  try {
    const data = await api('/companies/mine');
    myCompanies = data.companies;
  } catch (err) {
    console.error('Load my companies failed', err);
    myCompanies = [];
  }
}

function startEditListing(id) {
  const c = myCompanies.find(x => x.id === id);
  if (!c) return;
  editingCompanyId = id;
  // Pre-fill the form fields
  document.getElementById('c-name').value = c.name;
  document.getElementById('c-director').value = c.managing_director;
  document.getElementById('c-address').value = c.billing_address;
  document.getElementById('c-city').value = c.city;
  document.getElementById('c-vat').value = c.vat_number;
  document.getElementById('c-phone').value = c.phone;
  document.getElementById('c-email').value = c.email;
  document.getElementById('c-desc').value = c.description || '';
  document.getElementById('c-price').value = c.price_per_km;
  document.getElementById('c-min').value = c.min_km;
  renderListAuthState();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function cancelEditListing() {
  editingCompanyId = null;
  companyForm.reset();
  renderListAuthState();
}

function startNewListing() {
  editingCompanyId = null;
  companyForm.reset();
  // Force the form to show even if listings exist
  document.getElementById('my-listings').hidden = true;
  document.getElementById('list-form-actions').hidden = true;
  companyForm.hidden = false;
  document.getElementById('list-hero-title').textContent = t('list.newListingTitle');
  document.getElementById('list-hero-lede').textContent = t('list.newListingLede');
  document.getElementById('btn-publish').textContent = t('list.publish');
  document.getElementById('btn-cancel-edit').hidden = false;
  // Repurpose cancel to go back to listings
  companyForm.dataset.mode = 'new';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Delegated handlers for listing-level buttons
document.addEventListener('click', (e) => {
  const editBtn = e.target.closest('[data-edit]');
  if (editBtn) { startEditListing(editBtn.dataset.edit); return; }
  if (e.target.id === 'btn-new-listing') startNewListing();
  if (e.target.id === 'btn-cancel-edit') cancelEditListing();
});

// ---------- Companies ----------
async function refreshCompanies() {
  try {
    const data = await api('/companies');
    companies = data.companies;
    renderCompanies();
  } catch (err) {
    console.error('Load companies failed', err);
  }
}

function renderCompanies() {
  const filtered = pickupCity ? companies.filter(matchesCity) : companies;
  const sorted = sortCompanies(filtered, currentSort, currentDistance);

  resultCount.innerHTML = `<span class="num">${sorted.length}</span> ${sorted.length === 1 ? t('browse.company') : t('browse.companies')}`;

  if (sorted.length === 0) {
    grid.innerHTML = '';
    emptyState.hidden = false;
    const listLink = `<button class="link-btn" data-goto="list">${t('browse.listYourCompany')}</button>`;
    if (pickupCity) {
      const clearLink = `<button class="link-btn" id="clear-city-inline">${t('browse.clearCityInline')}</button>`;
      const msg = t('browse.emptyNoCity', { city: `<strong>${escapeHtml(pickupCity)}</strong>`, clearLink, listLink });
      emptyState.innerHTML = `<p>${msg}</p>`;
    } else {
      emptyState.innerHTML = `<p>${t('browse.emptyNoCompanies', { listLink })}</p>`;
    }
    const clearInline = document.getElementById('clear-city-inline');
    if (clearInline) clearInline.addEventListener('click', clearCityFilter);
    return;
  }
  emptyState.hidden = true;

  grid.innerHTML = sorted.map(company => cardHtml(company)).join('');
}

function cardHtml(company) {
  const rating = avgRating(company.reviews);
  const final = computeFinalPrice(company, currentDistance);

  const priceLabel = isDefaultDistance
    ? t('card.estAt', { km: `<span class="num">${DEFAULT_DISTANCE_KM} km</span>` })
    : t('card.finalPrice');
  let priceBlock;
  if (final && final.unavailable) {
    priceBlock = `
      <div class="final-price unavailable">
        <span class="label">${t('card.notAvailable')}</span>
        <span class="value num">${final.reason}</span>
      </div>`;
  } else if (final) {
    priceBlock = `
      <div class="final-price">
        <span class="label">${priceLabel}</span>
        <span class="value num">${fmtEuro(final.total)}</span>
      </div>`;
  } else {
    priceBlock = `
      <div class="final-price">
        <span class="label">${t('card.enterTrip')}</span>
        <span class="value num">—</span>
      </div>`;
  }

  const ratingBlock = company.reviews.length > 0
    ? `<span class="rating"><span class="star-icon">★</span><span class="num">${rating.toFixed(1)}</span><span class="count">(<span class="num">${company.reviews.length}</span>)</span></span>`
    : `<span class="rating-new">${t('card.newNoReviews')}</span>`;

  const s = {
    completed: company.stats_completed || 0,
    cancelled: company.stats_cancelled || 0,
    noShow:    company.stats_noshow    || 0,
  };
  const totalFinished = s.completed + s.cancelled + s.noShow;
  const pct = (n) => Math.round((n / totalFinished) * 100);
  const noShowRate = totalFinished > 0 ? pct(s.noShow) : 0;
  const cancelRate = totalFinished > 0 ? pct(s.cancelled) : 0;

  const trustChips = [];
  if (s.completed > 0) trustChips.push(`<span class="num">${s.completed}</span> ${t(s.completed === 1 ? 'card.trip' : 'card.trips')}`);
  if (company.last_completed_at) trustChips.push(t('card.lastRide', { time: `<span class="num">${fmtRelativeTime(company.last_completed_at)}</span>` }));
  const trustRow = trustChips.length > 0
    ? `<div class="card-trust">${trustChips.join(' · ')}</div>`
    : '';

  // Always surface reliability rates when there's at least one terminal booking,
  // so a clean company (0%) looks visibly different from an unknown one (—).
  const reliabilityRow = totalFinished > 0 ? `
    <div class="card-reliability">
      <span class="${noShowRate > 0 ? 'is-warn' : 'is-ok'}"><span class="num">${noShowRate}%</span> ${t('card.noShow')}</span>
      <span class="dot">·</span>
      <span class="${cancelRate > 0 ? 'is-warn' : 'is-ok'}"><span class="num">${cancelRate}%</span> ${t('card.cancel')}</span>
    </div>` : '';

  const statsRow = (trustChips.length || reliabilityRow)
    ? `${trustRow}${reliabilityRow}`
    : `<div class="card-stats"><span class="stat muted">${t('card.noRidesYet')}</span></div>`;

  const isCompanyAccount = currentUser && currentUser.role === 'company';
  const belowMin = currentDistance && currentDistance < company.min_km;
  let bookBtn;
  if (isCompanyAccount) {
    bookBtn = `<span class="card-note">${t('card.companiesCantBook')}</span>`;
  } else if (belowMin) {
    bookBtn = `<span class="card-note">${t('card.minKmRequired', { km: `<span class="num">${fmtKm(company.min_km)}</span>` })}</span>`;
  } else if (!currentDistance) {
    bookBtn = `<button class="btn btn-primary btn-sm" data-action="focus-trip">${t('card.enterRouteToBook')}</button>`;
  } else {
    bookBtn = `<button class="btn btn-primary btn-sm" data-action="book" data-id="${company.id}">${t('card.bookNow')}</button>`;
  }

  return `
    <article class="company-card" data-id="${company.id}">
      <div class="card-head">
        <div>
          <h3 class="card-name">${escapeHtml(company.name)}</h3>
          <span class="card-city">${escapeHtml(company.city)}</span>
        </div>
        ${ratingBlock}
      </div>
      ${company.description ? `<p class="card-desc">${escapeHtml(company.description)}</p>` : ''}
      ${statsRow}
      <div class="price-row">
        <div class="price-meta">
          <span><span class="mono">${fmtPricePerKm(company.price_per_km)}</span></span>
          <span>${t('card.min')} <span class="mono">${fmtKm(company.min_km)}</span></span>
        </div>
        ${priceBlock}
      </div>
      <div class="card-actions">
        <button class="btn btn-ghost btn-sm" data-action="reviews" data-id="${company.id}">${t('card.reviews')}</button>
        ${bookBtn}
      </div>
    </article>
  `;
}

grid.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.action === 'reviews') openReviewsModal(id, { canRate: false });
  if (btn.dataset.action === 'book') onBookClick(id);
  if (btn.dataset.action === 'focus-trip') {
    document.body.classList.remove('has-trip');
    pickupInput.focus();
    pickupInput.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

// ---------- Trip form ----------
const tripForm = document.getElementById('trip-form');
const pickupInput = document.getElementById('pickup');
const dropoffInput = document.getElementById('dropoff');
const distanceInput = document.getElementById('distance');
const sortSelect = document.getElementById('sort');

tripForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const d = parseFloat(distanceInput.value);
  currentDistance = isNaN(d) || d <= 0 ? null : d;
  isDefaultDistance = false;
  updateTripSummary();
  renderCompanies();
});
sortSelect.addEventListener('change', () => {
  currentSort = sortSelect.value;
  renderCompanies();
});

function updateTripSummary() {
  const pickup = pickupInput.value.trim();
  const dropoff = dropoffInput.value.trim();
  if (!currentDistance || isDefaultDistance) {
    tripSummary.textContent = '';
    document.body.classList.remove('has-trip');
    document.body.classList.remove('editing-trip');
    return;
  }
  const route = pickup && dropoff ? `${pickup} → ${dropoff} · ` : '';
  const summary = `${route}${fmtKm(Math.round(currentDistance))}`;
  tripSummary.textContent = summary;
  const compactRoute = document.getElementById('trip-compact-route');
  if (compactRoute) {
    const short = (s) => s.length > 24 ? s.slice(0, 22) + '…' : s;
    compactRoute.textContent = (pickup && dropoff)
      ? `${short(pickup)} → ${short(dropoff)} · ${fmtKm(Math.round(currentDistance))}`
      : `${fmtKm(Math.round(currentDistance))}`;
  }
  document.body.classList.add('has-trip');
  document.body.classList.remove('editing-trip');
}

const tripCompactBtn = document.getElementById('trip-compact');
if (tripCompactBtn) {
  tripCompactBtn.addEventListener('click', () => {
    document.body.classList.add('editing-trip');
    pickupInput.focus();
    pickupInput.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function clearCityFilter() {
  pickupCity = null;
  renderCityChip();
  renderCompanies();
}
document.getElementById('city-chip-clear').addEventListener('click', clearCityFilter);
function renderCityChip() {
  if (pickupCity) {
    cityChip.hidden = false;
    cityChipName.textContent = pickupCity;
  } else {
    cityChip.hidden = true;
  }
}

// ---------- Nominatim + OSRM ----------
const pickupAc = document.getElementById('pickup-ac');
const dropoffAc = document.getElementById('dropoff-ac');

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
async function searchNominatim(q, signal) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5&addressdetails=1`;
  const res = await fetch(url, { signal, headers: { 'Accept-Language': 'en' } });
  if (!res.ok) throw new Error('geocoding failed');
  return res.json();
}
async function fetchRouteDistance(a, b) {
  const url = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('routing failed');
  const data = await res.json();
  if (!data.routes || !data.routes[0]) throw new Error('no route');
  return data.routes[0].distance / 1000;
}
function extractCity(r) {
  const a = r.address || {};
  return a.city || a.town || a.village || a.municipality || a.county || null;
}

function attachAutocomplete(input, dropdown, onPick) {
  let currentCtrl = null;
  let results = [];
  let activeIndex = -1;

  const setActive = (idx) => {
    const items = dropdown.querySelectorAll('li[data-index]');
    if (items.length === 0) { activeIndex = -1; return; }
    activeIndex = Math.max(0, Math.min(idx, items.length - 1));
    items.forEach((li, i) => li.classList.toggle('is-active', i === activeIndex));
    items[activeIndex].scrollIntoView({ block: 'nearest' });
  };

  const pick = (r) => {
    input.value = r.display_name;
    dropdown.hidden = true;
    activeIndex = -1;
    onPick({ lat: parseFloat(r.lat), lon: parseFloat(r.lon), label: r.display_name, city: extractCity(r) });
  };

  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 3) { dropdown.hidden = true; return; }
    if (currentCtrl) currentCtrl.abort();
    currentCtrl = new AbortController();
    dropdown.innerHTML = `<li class="ac-info">${t('ac.searching')}</li>`;
    dropdown.hidden = false;
    try {
      results = await searchNominatim(q, currentCtrl.signal);
      if (results.length === 0) {
        dropdown.innerHTML = `<li class="ac-info">${t('ac.noMatches')}</li>`;
        return;
      }
      dropdown.innerHTML = results.map((r, i) => {
        const parts = r.display_name.split(',');
        return `
          <li data-index="${i}">
            <span class="ac-main">${escapeHtml(parts[0].trim())}</span>
            <span class="ac-sub">${escapeHtml(parts.slice(1).join(',').trim())}</span>
          </li>`;
      }).join('');
      activeIndex = -1;
    } catch (e) {
      if (e.name === 'AbortError') return;
      dropdown.innerHTML = `<li class="ac-info">${t('ac.lookupFailed')}</li>`;
    }
  }, 400);

  input.addEventListener('input', () => { onPick(null); run(); });
  input.addEventListener('focus', () => {
    if (dropdown.children.length > 0 && input.value.trim().length >= 3) dropdown.hidden = false;
  });
  input.addEventListener('blur', () => setTimeout(() => { dropdown.hidden = true; }, 150));
  input.addEventListener('keydown', (e) => {
    if (dropdown.hidden || results.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIndex + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIndex - 1); }
    else if (e.key === 'Enter') {
      const idx = activeIndex >= 0 ? activeIndex : 0;
      if (results[idx]) { e.preventDefault(); pick(results[idx]); }
    } else if (e.key === 'Escape') { dropdown.hidden = true; }
  });
  dropdown.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-index]');
    if (!li) return;
    const r = results[parseInt(li.dataset.index, 10)];
    if (r) pick(r);
  });
}

attachAutocomplete(pickupInput, pickupAc, (coord) => {
  pickupCoord = coord;
  pickupCity = coord ? coord.city : null;
  renderCityChip();
  renderCompanies();
  if (coord) maybeCalculateRoute();
});
attachAutocomplete(dropoffInput, dropoffAc, (coord) => {
  dropoffCoord = coord;
  if (coord) maybeCalculateRoute();
});

async function maybeCalculateRoute() {
  if (!pickupCoord || !dropoffCoord) return;
  distanceInput.value = '';
  distanceInput.placeholder = '…';
  try {
    const km = await fetchRouteDistance(pickupCoord, dropoffCoord);
    distanceInput.value = Math.round(km);
    distanceInput.placeholder = '25';
    currentDistance = km;
    isDefaultDistance = false;
    updateTripSummary();
    renderCompanies();
  } catch {
    distanceInput.placeholder = t('ac.routeFailed');
  }
}

// ---------- Company form ----------
companyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: document.getElementById('c-name').value.trim(),
    managing_director: document.getElementById('c-director').value.trim(),
    billing_address: document.getElementById('c-address').value.trim(),
    city: document.getElementById('c-city').value.trim(),
    vat_number: document.getElementById('c-vat').value.trim(),
    phone: document.getElementById('c-phone').value.trim(),
    email: document.getElementById('c-email').value.trim(),
    description: document.getElementById('c-desc').value.trim(),
    price_per_km: parseFloat(document.getElementById('c-price').value),
    min_km: parseFloat(document.getElementById('c-min').value),
  };
  const isEdit = editingCompanyId !== null;
  try {
    if (isEdit) {
      await api(`/companies/${editingCompanyId}`, { method: 'PUT', body });
    } else {
      await api('/companies', { method: 'POST', body });
    }
    companyForm.reset();
    editingCompanyId = null;
    await Promise.all([refreshCompanies(), refreshMyCompanies()]);
    renderListAuthState();
    if (!isEdit) switchView('browse');
  } catch (err) {
    const key = isEdit ? 'alert.couldNotSave' : 'alert.couldNotPublish';
    alert(t(key, { msg: err.message }));
  }
});

// ---------- Booking ----------
function onBookClick(companyId) {
  if (!currentUser) { openAuth('login'); return; }
  if (currentUser.role !== 'passenger') { alert(t('alert.onlyPassengers')); return; }
  const company = companies.find(c => c.id === companyId);
  if (!company) return;
  if (!currentDistance) { alert(t('alert.enterRouteFirst')); return; }
  if (currentDistance < company.min_km) {
    alert(t('alert.minForCompany', { km: fmtKm(company.min_km) }));
    return;
  }

  bookingModalCompanyId = companyId;
  const route = `${pickupInput.value.trim() || '?'} → ${dropoffInput.value.trim() || '?'}`;
  const total = currentDistance * company.price_per_km;
  document.getElementById('booking-modal-title').textContent = `${t('booking.title')} — ${company.name}`;
  document.getElementById('booking-modal-sub').textContent = company.city;
  document.getElementById('bk-route').textContent = route;
  document.getElementById('bk-distance').textContent = fmtKm(Math.round(currentDistance));
  document.getElementById('bk-rate').textContent = fmtPricePerKm(company.price_per_km);
  document.getElementById('bk-total').textContent = fmtEuro(total);
  openModalEl(bookingModal);
}

bookingConfirmBtn.addEventListener('click', async () => {
  if (!bookingModalCompanyId) return;
  try {
    await api('/bookings', { method: 'POST', body: {
      company_id: bookingModalCompanyId,
      pickup: pickupInput.value.trim() || '—',
      dropoff: dropoffInput.value.trim() || '—',
      distance: currentDistance,
    }});
    closeAllModals();
    await refreshBookings();
    switchView('bookings');
  } catch (err) {
    alert(t('alert.couldNotBook', { msg: err.message }));
  }
});

// ---------- Bookings view ----------
async function refreshBookings() {
  if (!currentUser) { bookings = []; renderBookings(); return; }
  try {
    const data = await api('/bookings');
    bookings = data.bookings;
    renderBookings();
  } catch (err) {
    console.error('Load bookings failed', err);
  }
}

document.querySelectorAll('#booking-filters .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#booking-filters .chip').forEach(c => c.classList.toggle('is-active', c === chip));
    bookingsFilter = chip.dataset.filter;
    renderBookings();
  });
});

function renderBookings() {
  if (!currentUser) {
    const loginLink = `<button class="link-btn" data-auth="login">${t('auth.login').toLowerCase()}</button>`;
    bookingsAuthWarn.innerHTML = `<p>${t('bookings.authWarn', { loginLink })}</p>`;
    bookingsAuthWarn.hidden = false;
    bookingsList.innerHTML = '';
    bookingsEmpty.hidden = true;
    bookingsCount.hidden = true;
    document.getElementById('booking-filters').style.display = 'none';
    return;
  }
  bookingsAuthWarn.hidden = true;
  document.getElementById('booking-filters').style.display = '';

  let filtered = bookings;
  if (bookingsFilter === 'cancelled') {
    filtered = bookings.filter(b => b.status === 'cancelled' || b.status === 'noshow' || b.status === 'declined');
  } else if (bookingsFilter !== 'all') {
    filtered = bookings.filter(b => b.status === bookingsFilter);
  }

  const activeCount = bookings.filter(b => b.status === 'pending' || b.status === 'accepted' || (b.status === 'completed' && !b.reviewed && b.is_rider)).length;
  bookingsCount.hidden = activeCount === 0;
  bookingsCount.textContent = activeCount;

  if (filtered.length === 0) {
    bookingsList.innerHTML = '';
    const browseLink = `<button class="link-btn" data-goto="browse">${t('bookings.browseLink')}</button>`;
    bookingsEmpty.innerHTML = `<p>${t('bookings.empty', { browseLink })}</p>`;
    bookingsEmpty.hidden = false;
    return;
  }
  bookingsEmpty.hidden = true;
  bookingsList.innerHTML = filtered.map(bookingCardHtml).join('');
}

function bookingCardHtml(b) {
  const statuses = {
    pending:   { key: 'status.pending',   cls: 'status-pending' },
    accepted:  { key: 'status.accepted',  cls: 'status-accepted' },
    completed: { key: 'status.completed', cls: 'status-completed' },
    cancelled: { key: 'status.cancelled', cls: 'status-cancelled' },
    noshow:    { key: 'status.noshow',    cls: 'status-noshow' },
    declined:  { key: 'status.declined',  cls: 'status-declined' },
  };
  const st = statuses[b.status] || statuses.pending;

  let actions = '';
  if (b.is_owner && b.status === 'pending') {
    actions = `
      <button class="btn btn-primary btn-sm" data-booking-action="accept" data-id="${b.id}">${t('bookings.accept')}</button>
      <button class="btn btn-ghost btn-sm" data-booking-action="decline" data-id="${b.id}">${t('bookings.decline')}</button>
    `;
  } else if (b.is_owner && b.status === 'accepted') {
    actions = `
      <button class="btn btn-primary btn-sm" data-booking-action="complete" data-id="${b.id}">${t('bookings.complete')}</button>
      <button class="btn btn-ghost btn-sm" data-booking-action="noshow" data-id="${b.id}">${t('bookings.noshow')}</button>
      <button class="btn btn-ghost btn-sm" data-booking-action="cancel" data-id="${b.id}">${t('bookings.cancel')}</button>
    `;
  } else if (b.is_rider && b.status === 'completed' && !b.reviewed) {
    actions = `<button class="btn btn-primary btn-sm" data-booking-action="rate" data-id="${b.id}">${t('bookings.rate')}</button>`;
  }

  const roleTag = b.is_owner
    ? `<span class="muted">${t('bookings.asCompany')}</span>`
    : `<span class="muted">${t('bookings.asRider')}</span>`;
  const timeTag = `<span class="num">${fmtRelativeTime(b.created_at)}</span>`;

  // Rider sees company contact details as soon as the booking exists.
  const contactBlock = (b.is_rider && (b.company_phone || b.company_email)) ? `
    <div class="booking-contact">
      ${b.company_phone ? `<span><span class="contact-label">${t('bookings.phone')}</span><a href="tel:${escapeHtml(b.company_phone)}" class="mono">${escapeHtml(b.company_phone)}</a></span>` : ''}
      ${b.company_email ? `<span><span class="contact-label">${t('bookings.email')}</span><a href="mailto:${escapeHtml(b.company_email)}">${escapeHtml(b.company_email)}</a></span>` : ''}
    </div>` : '';

  return `
    <article class="booking-card">
      <div class="booking-head">
        <div>
          <h3 class="booking-company">${escapeHtml(b.company_name)}</h3>
          <span class="booking-meta">${roleTag} · ${timeTag}</span>
        </div>
        <span class="status-badge ${st.cls}">${t(st.key)}</span>
      </div>
      <div class="booking-route">${escapeHtml(b.pickup)} → ${escapeHtml(b.dropoff)}</div>
      <div class="booking-numbers num">
        <span>${fmtKm(Math.round(b.distance))}</span>
        <span class="dot">·</span>
        <span>${fmtPricePerKm(b.price_per_km)}</span>
        <span class="dot">·</span>
        <span class="booking-total">${fmtEuro(b.total)}</span>
      </div>
      ${contactBlock}
      ${actions ? `<div class="booking-actions">${actions}</div>` : ''}
    </article>
  `;
}

bookingsList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-booking-action]');
  if (!btn) return;
  const action = btn.dataset.bookingAction;
  const id = btn.dataset.id;
  const b = bookings.find(x => x.id === id);
  if (!b) return;

  if (action === 'rate') {
    openReviewsModal(b.company_id, { canRate: true, bookingId: id });
    return;
  }

  btn.disabled = true;
  try {
    await api(`/bookings/${id}/action`, { method: 'POST', body: { action } });
    await Promise.all([refreshBookings(), refreshCompanies()]);
  } catch (err) {
    alert(t('alert.couldNotUpdate', { msg: err.message }));
    btn.disabled = false;
  }
});

// ---------- Reviews modal ----------
function openReviewsModal(companyId, { canRate = false, bookingId = null } = {}) {
  const company = companies.find(c => c.id === companyId);
  if (!company) return;
  modalCompanyId = companyId;
  modalBookingId = bookingId;
  selectedRating = 0;
  updateStarUI();
  modalTitle.textContent = company.name;
  const avg = avgRating(company.reviews);
  if (company.reviews.length) {
    const summaryKey = company.reviews.length === 1 ? 'reviews.summary' : 'reviews.summaryPlural';
    modalSub.textContent = `${avg.toFixed(1)} ★ · ${t(summaryKey, { count: company.reviews.length })}`;
  } else {
    modalSub.textContent = t('reviews.summaryNone');
  }
  renderReviews(company);
  reviewForm.reset();
  rateSection.hidden = !canRate;
  openModalEl(modal);
}

function renderReviews(company) {
  if (!company.reviews || company.reviews.length === 0) {
    reviewsList.innerHTML = `<p class="no-reviews">${t('reviews.summaryNone')}.</p>`;
    return;
  }
  reviewsList.innerHTML = company.reviews.map(r => `
    <div class="review">
      <div class="review-head">
        <div>
          <span class="review-author">${escapeHtml(r.author || t('reviews.anonymous'))}</span>
          <span class="review-stars"> ${stars(r.rating)}</span>
        </div>
        <span class="review-time">${fmtRelativeTime(r.created_at)}</span>
      </div>
      ${r.comment ? `<p class="review-comment">${escapeHtml(r.comment)}</p>` : ''}
    </div>
  `).join('');
}

starInput.addEventListener('click', (e) => {
  const star = e.target.closest('.star');
  if (!star) return;
  selectedRating = parseInt(star.dataset.value, 10);
  updateStarUI();
});
starInput.addEventListener('mouseover', (e) => {
  const star = e.target.closest('.star');
  if (!star) return;
  const val = parseInt(star.dataset.value, 10);
  [...starInput.children].forEach((s, i) => s.classList.toggle('is-hover', i < val));
});
starInput.addEventListener('mouseleave', () => {
  [...starInput.children].forEach(s => s.classList.remove('is-hover'));
});
function updateStarUI() {
  [...starInput.children].forEach((s, i) => s.classList.toggle('is-selected', i < selectedRating));
}

reviewForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!modalBookingId || selectedRating < 1) {
    alert(t('alert.pickRating'));
    return;
  }
  const comment = document.getElementById('r-comment').value.trim();
  try {
    await api('/reviews', { method: 'POST', body: {
      booking_id: modalBookingId,
      rating: selectedRating,
      comment,
    }});
    closeAllModals();
    await Promise.all([refreshCompanies(), refreshBookings()]);
  } catch (err) {
    alert(t('alert.couldNotPostReview', { msg: err.message }));
  }
});

// ---------- Generic modal plumbing ----------
function openModalEl(el) {
  el.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeAllModals() {
  [modal, bookingModal, authModal].forEach(m => { if (!m.hidden) m.hidden = true; });
  document.body.style.overflow = '';
  modalCompanyId = null;
  modalBookingId = null;
  bookingModalCompanyId = null;
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeAllModals();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllModals();
});

// Language toggle
document.querySelectorAll('.lang-btn').forEach(btn => {
  btn.addEventListener('click', () => setLang(btn.dataset.lang));
});

// ---------- Init ----------
async function init() {
  // Language first so every subsequent render uses t().
  currentLang = detectLang();
  await loadTranslations();
  applyI18n();

  // Seed the distance input so cards show an estimated price on first paint.
  distanceInput.value = DEFAULT_DISTANCE_KM;

  renderAuthState();
  renderListAuthState();
  try {
    const { user } = await api('/auth/me');
    currentUser = user;
    renderAuthState();
    renderListAuthState();
  } catch {}
  await refreshCompanies();
  if (currentUser) {
    await Promise.all([refreshBookings(), refreshMyCompanies()]);
    renderListAuthState();
  }
}
init();
