const { getBasicAuthHeader } = require('../utils/auth');

const BASE_URL     = () => process.env.ULYSSES_BASE_URL;
const CHAIN_ID     = () => process.env.ULYSSES_CHAIN_ID;
const PROPERTY_ID  = () => process.env.ULYSSES_PROPERTY_ID;
const TIMEOUT_MS   = 10_000;
const PAGE_SIZE    = 100; // Ulysses API hard cap — silently truncates beyond this

async function ulyssesGet(path) {
  const url        = `${BASE_URL()}${path}`;
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

  console.log(`[Ulysses] GET ${url}`);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: getBasicAuthHeader(),
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ulysses ${res.status} ${res.statusText} on ${path} — ${body.slice(0, 200)}`);
    }

    return res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Ulysses request timeout after ${TIMEOUT_MS / 1000}s: ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Fetches all pages for a paginated endpoint and returns a flat array of items.
// The Ulysses API silently caps at PAGE_SIZE regardless of the limit param.
async function fetchAllPages(basePath) {
  const all = [];
  let offset = 0;
  while (true) {
    const data = await ulyssesGet(`${basePath}&limit=${PAGE_SIZE}&offset=${offset}`);
    const page = Array.isArray(data?.list) ? data.list : [];
    all.push(...page);
    console.log(`[Ulysses] page offset=${offset} → ${page.length} items (total so far: ${all.length})`);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

function getBoardForecast(date) {
  return ulyssesGet(
    `/public/api/v1/con/chain/${CHAIN_ID()}/property/${PROPERTY_ID()}/board/forecast?date=${date}`
  );
}

function getInHouseReservations(date) {
  return fetchAllPages(
    `/public/api/v1/con/chain/${CHAIN_ID()}/property/${PROPERTY_ID()}/reservation?stayFrom=${date}&stayTo=${date}`
  );
}

function getDepartingReservations(date) {
  return fetchAllPages(
    `/public/api/v1/con/chain/${CHAIN_ID()}/property/${PROPERTY_ID()}/reservation?departureFrom=${date}&departureTo=${date}`
  );
}

function getCustomer(customerId) {
  return ulyssesGet(`/public/api/v1/con/chain/${CHAIN_ID()}/customer/${customerId}`);
}

module.exports = { getBoardForecast, getInHouseReservations, getDepartingReservations, getCustomer };
