const { getBasicAuthHeader } = require('../utils/auth');

const BASE_URL     = () => process.env.ULYSSES_BASE_URL;
const CHAIN_ID     = () => process.env.ULYSSES_CHAIN_ID;
const PROPERTY_ID  = () => process.env.ULYSSES_PROPERTY_ID;
const TIMEOUT_MS   = 8_000;

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

function getBoardForecast(date) {
  return ulyssesGet(
    `/public/api/v1/con/chain/${CHAIN_ID()}/property/${PROPERTY_ID()}/board/forecast?date=${date}`
  );
}

function getInHouseReservations(date) {
  return ulyssesGet(
    `/public/api/v1/con/chain/${CHAIN_ID()}/property/${PROPERTY_ID()}/reservation?stayFrom=${date}&stayTo=${date}&limit=500`
  );
}

function getDepartingReservations(date) {
  return ulyssesGet(
    `/public/api/v1/con/chain/${CHAIN_ID()}/property/${PROPERTY_ID()}/reservation?departureFrom=${date}&departureTo=${date}&limit=500`
  );
}

function getCustomer(customerId) {
  return ulyssesGet(`/public/api/v1/con/chain/${CHAIN_ID()}/customer/${customerId}`);
}

module.exports = { getBoardForecast, getInHouseReservations, getDepartingReservations, getCustomer };
