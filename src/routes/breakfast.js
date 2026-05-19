const express = require('express');
const { getBoardForecast, getInHouseReservations, getDepartingReservations } = require('../services/ulysses');

const router = express.Router();

const CACHE_TTL_MS  = Number(process.env.CACHE_TTL_MINUTES ?? 4) * 60 * 1000;
const IS_DEV        = process.env.NODE_ENV === 'development';
const cache         = new Map();

const ACTIVE_STATUSES = new Set(['CI', 'RES', 'IH']);
const BREAKFAST_CODES = new Set(['BB', 'HB', 'FB', 'AI', 'AD']);
// AD = "Alojamiento y Desayuno" — El Palace's primary code for bed+breakfast
// SA = "Sólo Alojamiento" / SB / SO are room-only variants in Ulysses
const ROOM_ONLY_CODES = new Set(['SA', 'SB', 'SO', 'RO']);
const ALLERGY_RE      = /ALERGI|ALLERG|GLUTEN|LACTOSE|DAIRY|NUT|FISH/i;
const COMP_BB_RE      = /COMP\s*BB/i;

function ts() { return new Date().toISOString(); }

// ── Date utilities ────────────────────────────────────────────────────────────

function parseUTCDate(iso) {
  if (!iso) return NaN;
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

// Day 1 = arrival day. Returns 1 if date < checkIn (defensive).
function calcStayDay(checkIn, date) {
  const diff = (parseUTCDate(date) - parseUTCDate(checkIn)) / 86_400_000;
  return isNaN(diff) ? 1 : Math.max(1, Math.floor(diff) + 1);
}

function calcStayNights(checkIn, checkOut) {
  const diff = (parseUTCDate(checkOut) - parseUTCDate(checkIn)) / 86_400_000;
  return isNaN(diff) ? 0 : Math.max(0, Math.floor(diff));
}

// ── Board detection ───────────────────────────────────────────────────────────

function boardFromText(text) {
  if (!text) return null;
  const t = text.toUpperCase();
  if (/\bAI\b|ALL[\s-]?INCLUSIVE/.test(t))               return 'AI';
  if (/\bFB\b|FULL[\s-]?BOARD|PENS[IÓ]N\s+COMPLETA/.test(t)) return 'FB';
  if (/\bHB\b|HALF[\s-]?BOARD|MEDIA\s+PENS[IÓ]N/.test(t))    return 'HB';
  if (/\bBB\b|B&B|BREAKFAST|DESAYUNO/.test(t))           return 'BB';
  return null;
}

// Returns { code, method, mainBoardCode, dailyBoardCode, serviceCodes }
function detectBoard(stay, combinedRemarks) {
  // stay.mainBoard.code — top-level board set on the stay (often null in El Palace)
  const mainBoardCode  = String(stay?.mainBoard?.code  || '').toUpperCase() || null;
  // stay.reservationRoomStayDaily[*].board.code — per-day board (most reliable source)
  const dailyList      = Array.isArray(stay?.reservationRoomStayDaily) ? stay.reservationRoomStayDaily : [];
  const dailyBoardCode = dailyList.map(d => String(d?.board?.code || '').toUpperCase()).find(Boolean) || null;
  // stay.reservationRoomStayServiceList[*].service.code — added services (BRK/DES)
  const serviceList    = Array.isArray(stay?.reservationRoomStayServiceList) ? stay.reservationRoomStayServiceList : [];
  const serviceCodes   = serviceList.map(s => String(s?.service?.code || '').toUpperCase()).filter(Boolean);

  // Cascade 1: free-text remarks
  const fromText = boardFromText(combinedRemarks);
  if (fromText) return { code: fromText, method: 'remarks', mainBoardCode, dailyBoardCode, serviceCodes };

  // Cascade 2: mainBoard field
  if (mainBoardCode && mainBoardCode !== 'RO') {
    return { code: mainBoardCode, method: 'mainBoard', mainBoardCode, dailyBoardCode, serviceCodes };
  }

  // Cascade 3: first daily board entry
  if (dailyBoardCode && dailyBoardCode !== 'RO') {
    return { code: dailyBoardCode, method: 'dailyBoard', mainBoardCode, dailyBoardCode, serviceCodes };
  }

  // Cascade 4: service codes (BRK / BRKF / DES / BREAKFAST)
  if (serviceCodes.some(c => /BRK|BRKF|BREAKFAST|DES/.test(c))) {
    return { code: 'BB', method: 'service', mainBoardCode, dailyBoardCode, serviceCodes };
  }

  return { code: 'RO', method: 'none', mainBoardCode, dailyBoardCode, serviceCodes };
}

// ── Breakfast status classification ──────────────────────────────────────────

// complementary: remarks contain "COMP BB" (case-insensitive)
//   OR mainBooker/mainCentral fields contain "COMPLEMENTARY" (channel-side)
// included: board code resolves to BB/HB/FB/AI/AD via the existing 4-level cascade
// upsell: room-only rate (SA/SB/SO/RO) — breakfast not included, potential add-on
// none: anything else unclassified
function detectBreakfastStatus(stay, combinedRemarks) {
  if (COMP_BB_RE.test(combinedRemarks)) return 'complementary';
  // mainBooker and mainCentral can hold channel/company names; check for COMPLEMENTARY text
  const bookerText = JSON.stringify([stay.mainBooker, stay.mainCentral]).toUpperCase();
  if (/COMPLEMENTARY/.test(bookerText)) return 'complementary';

  const { code: boardCode } = detectBoard(stay, combinedRemarks);
  if (BREAKFAST_CODES.has(boardCode)) return 'included';
  if (ROOM_ONLY_CODES.has(boardCode)) return 'upsell';
  return 'none';
}

// ── Remarks combination ───────────────────────────────────────────────────────

function combineRemarks(...parts) {
  const unique = [...new Set(
    parts.map(s => (s || '').trim()).filter(Boolean)
  )];
  return unique
    .join(' | ')
    .replace(/\s{2,}/g, ' ')
    .replace(/(\|\s*){2,}/g, '| ')
    .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
    .trim();
}

// ── Totals from board/forecast ────────────────────────────────────────────────

function pickTotals(forecast, date) {
  console.log(`[${ts()}] [forecast] raw:`, JSON.stringify(forecast)?.slice(0, 500));
  const zero = { adults: 0, children: 0 };
  if (!forecast) return zero;

  const boards = Array.isArray(forecast?.list) ? forecast.list
               : Array.isArray(forecast)        ? forecast
               : [forecast];

  const acc = { adults: 0, children: 0 };
  for (const board of boards) {
    if (Array.isArray(board?.forecastList)) {
      for (const entry of board.forecastList) {
        if (date && !String(entry.date || '').startsWith(date)) continue;
        acc.adults   += Number(entry.quantityConsumedAdult  || entry.adults   || entry.adult   || 0)
                      + Number(entry.quantityConsumedJunior || entry.juniors  || entry.junior  || 0);
        acc.children += Number(entry.quantityConsumedChild  || entry.children || entry.child   || 0)
                      + Number(entry.quantityConsumedInfant || entry.infants  || entry.infant  || 0);
      }
    } else {
      acc.adults   += Number(board.adults  || board.adult  || 0) + Number(board.juniors || board.junior || 0);
      acc.children += Number(board.children || board.child || 0) + Number(board.infants || board.infant || 0);
    }
  }
  return acc;
}

// ── Extract reservation array from any envelope ───────────────────────────────

function extractReservationList(payload) {
  console.log(`[${ts()}] [debug] payload keys:`, payload ? Object.keys(payload) : 'null');
  console.log(`[${ts()}] [debug] payload.list length:`, payload?.list?.length);
  if (Array.isArray(payload?.list))         return payload.list;
  if (Array.isArray(payload))               return payload;
  if (Array.isArray(payload?.data))         return payload.data;
  if (Array.isArray(payload?.reservations)) return payload.reservations;
  if (Array.isArray(payload?.items))        return payload.items;
  return [];
}

// ── Group reservations → room rows ────────────────────────────────────────────

function groupByRoom(reservations, date) {
  // roomNumber → room object (insertion order = first-seen order, sorted at end)
  const roomMap = new Map();
  const detection = { byRemarks: 0, byMainBoard: 0, byDailyBoard: 0, byService: 0, undetected: 0 };

  for (const reservation of reservations) {
    const holder    = reservation.reservationHolder || {};
    // holder.countryCode — ISO 3166-1 alpha-2/3 code from the Ulysses profile
    const country   = holder.countryCode || null;
    const vipLevel  = Number(holder.chainVIPLevel || holder.vipLevel || 0);

    // Fallback guest in case reservationRoomStayGuests is empty
    const holderGuest = {
      lastName:  holder.surName   || '',
      firstName: holder.givenName || '',
    };

    const stays = Array.isArray(reservation.reservationRoomStayList)
      ? reservation.reservationRoomStayList : [];

    for (const stay of stays) {
      const statusCode     = String(stay?.reservationStatusType?.code ?? '').toUpperCase();
      const isActive       = ACTIVE_STATUSES.has(statusCode);
      const isDepartingToday = (stay.departure === date || stay.checkOut === date);
      if (!isActive && !isDepartingToday) continue;

      // Room number — stay.room.name is the room name/number in El Palace
      const room       = stay.room;
      const roomNumber = room?.name || room?.code
        || (room?.number != null ? String(room.number) : '')
        || 'Sin asignar';

      // PAX breakdown
      const adults   = Number(stay.adult  || 0) + Number(stay.junior || 0);
      const children = Number(stay.child  || 0) + Number(stay.infant || 0);

      // stay.reservationRoomStayGuests — includes the holder as first entry, then companions.
      // If empty (unregistered stay), fall back to the holder alone.
      const rawStayGuests = stay.reservationRoomStayGuests || [];
      const stayGuests = rawStayGuests.length > 0
        ? rawStayGuests
            .map(g => ({ lastName: (g.surName || '').trim(), firstName: (g.givenName || '').trim() }))
            .filter(g => g.lastName || g.firstName)
        : [holderGuest];

      // Remarks from all sources
      const remarks = combineRemarks(stay.remark, reservation.remark, holder.remark);

      // Board detection for logging
      const { code: boardCode, method, mainBoardCode, dailyBoardCode, serviceCodes } =
        detectBoard(stay, remarks);

      if      (method === 'remarks')    detection.byRemarks++;
      else if (method === 'mainBoard')  detection.byMainBoard++;
      else if (method === 'dailyBoard') detection.byDailyBoard++;
      else if (method === 'service')    detection.byService++;
      else                              detection.undetected++;

      const breakfastStatus = detectBreakfastStatus(stay, remarks);
      const hasBreakfast    = BREAKFAST_CODES.has(boardCode); // kept for backward compat

      const checkIn       = stay.arrival   || stay.checkIn  || '';
      const checkOut      = stay.departure || stay.checkOut || '';
      const checkoutToday = stay.departure === date || stay.checkOut === date;

      if (roomMap.has(roomNumber)) {
        // Merge into existing room: add guests, sum PAX, combine remarks
        const r = roomMap.get(roomNumber);
        r.guests.push(...stayGuests);
        r.adults   += adults;
        r.children += children;
        r.remarks   = combineRemarks(r.remarks, remarks);
        // Keep first reservation's checkIn/checkOut/country/breakfastStatus/stayDay/stayNights
      } else {
        const room = {
          roomNumber,
          guests:          stayGuests,
          // country from the reservation holder's profile (ISO country code)
          country,
          checkIn,
          checkOut,
          stayDay:         calcStayDay(checkIn, date),
          stayNights:      calcStayNights(checkIn, checkOut),
          adults,
          children,
          breakfastStatus,
          hasBreakfast,    // TODO: remove once frontend migrates to breakfastStatus
          boardCode,
          statusCode,
          checkoutToday,
          vipLevel,
          reservationId:   String(reservation.id || ''),
          remarks,
        };

        if (IS_DEV) {
          room._debug = {
            boardDetectionMethod: method,
            rawRemarks: [stay.remark, reservation.remark, holder.remark]
              .filter(Boolean).join(' / ') || '',
            mainBoardCode,
            dailyBoardCode,
            services: serviceCodes,
          };
        }

        roomMap.set(roomNumber, room);
      }
    }
  }

  const rooms = [...roomMap.values()].sort((a, b) =>
    a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true })
  );

  return { rooms, detection };
}

// ── Date validation helper ────────────────────────────────────────────────────

function validateDate(date) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return 'Missing or invalid date (YYYY-MM-DD)';
  }
  const d   = new Date(date);
  const now = new Date();
  const msPerDay = 86_400_000;
  if (d < new Date(now - 7 * msPerDay))               return 'Date too far in the past (max 7 days)';
  if (d > new Date(now.getTime() + 30 * msPerDay))    return 'Date too far in the future (max 30 days)';
  return null;
}

// ── Upstream error response helper ────────────────────────────────────────────

function upstreamError(res, err) {
  console.error(`[${ts()}] [error] ${err.message}`);
  const detail = IS_DEV ? err.message : 'Contact the system administrator';
  res.status(502).json({ error: 'Ulysses PMS upstream error', detail });
}

// ── Shared fetch + merge helper ───────────────────────────────────────────────

async function fetchAndMergeReservations(date) {
  const [forecast, reservationsRaw, departingRaw] = await Promise.all([
    getBoardForecast(date),
    getInHouseReservations(date),
    getDepartingReservations(date),
  ]);

  const inHouseList   = Array.isArray(reservationsRaw?.list) ? reservationsRaw.list : extractReservationList(reservationsRaw);
  const departingList = Array.isArray(departingRaw?.list)    ? departingRaw.list    : extractReservationList(departingRaw);
  const seenIds       = new Set(inHouseList.map(r => r.id));
  const mergedList    = [...inHouseList, ...departingList.filter(r => !seenIds.has(r.id))];

  return { forecast, mergedList };
}

// ── GET /breakfast-list ───────────────────────────────────────────────────────

router.get('/breakfast-list', async (req, res) => {
  const { date } = req.query;
  const dateErr = validateDate(date);
  if (dateErr) return res.status(400).json({ error: dateErr });

  const cached = cache.get(date);
  if (CACHE_TTL_MS > 0 && cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    console.log(`[${ts()}] [cache] hit ${date} (${cached.data.rooms.length} rooms)`);
    return res.json(cached.data);
  }

  const t0 = Date.now();

  try {
    const { forecast, mergedList } = await fetchAndMergeReservations(date);
    const totals                   = pickTotals(forecast, date);
    const { rooms, detection }     = groupByRoom(mergedList, date);

    const withBreakfast    = rooms.filter(r => r.hasBreakfast).length;
    const withoutBreakfast = rooms.length - withBreakfast;
    const withAllergies    = rooms.filter(r => ALLERGY_RE.test(r.remarks)).length;
    const elapsed          = Date.now() - t0;

    console.log(
      `[${ts()}] [breakfast-list] ${date} → ${rooms.length} rooms` +
      ` (${withBreakfast} con desayuno, ${withoutBreakfast} sin)` +
      ` | ${withAllergies} alergias | ${elapsed}ms`
    );
    console.log(
      `[${ts()}] [breakfast-list] Detección desayuno:` +
      ` ${detection.byRemarks} por remarks,` +
      ` ${detection.byMainBoard} por mainBoard,` +
      ` ${detection.byDailyBoard} por daily board,` +
      ` ${detection.byService} por servicio BRK,` +
      ` ${detection.undetected} sin desayuno`
    );

    const payload = { date, totals, rooms };
    if (CACHE_TTL_MS > 0) cache.set(date, { ts: Date.now(), data: payload });
    res.json(payload);
  } catch (err) {
    return upstreamError(res, err);
  }
});

// ── GET /debug/breakfast ──────────────────────────────────────────────────────

router.get('/debug/breakfast', async (req, res) => {
  if (!IS_DEV) return res.status(404).json({ error: 'Not found' });

  const { date } = req.query;
  const dateErr = validateDate(date);
  if (dateErr) return res.status(400).json({ error: dateErr });

  try {
    const { forecast, mergedList } = await fetchAndMergeReservations(date);
    const totals               = pickTotals(forecast, date);
    const { rooms, detection } = groupByRoom(mergedList, date);

    const withBreakfast    = rooms.filter(r => r.hasBreakfast);
    const withoutBreakfast = rooms.filter(r => !r.hasBreakfast);

    res.json({
      date,
      totals,
      totalRooms:      rooms.length,
      withBreakfast:   withBreakfast.length,
      withoutBreakfast: withoutBreakfast.length,
      detectionBreakdown: {
        byRemarks:    detection.byRemarks,
        byMainBoard:  detection.byMainBoard,
        byDailyBoard: detection.byDailyBoard,
        byService:    detection.byService,
        undetected:   detection.undetected,
      },
      roomsWithBreakfast: withBreakfast.map(r => ({
        roomNumber:       r.roomNumber,
        lastName:         r.guests[0]?.lastName ?? '',
        boardCode:        r.boardCode,
        breakfastStatus:  r.breakfastStatus,
        method:           r._debug?.boardDetectionMethod ?? '(cache/no-dev)',
        remarks:          r.remarks,
        mainBoard:        r._debug?.mainBoardCode  ?? '?',
        dailyBoard:       r._debug?.dailyBoardCode ?? '?',
        services:         r._debug?.services ?? [],
      })),
      roomsWithoutBreakfast: withoutBreakfast.map(r => ({
        roomNumber:      r.roomNumber,
        lastName:        r.guests[0]?.lastName ?? '',
        boardCode:       r.boardCode,
        breakfastStatus: r.breakfastStatus,
        remarks:         r.remarks,
        mainBoard:       r._debug?.mainBoardCode  ?? '?',
        dailyBoard:      r._debug?.dailyBoardCode ?? '?',
        services:        r._debug?.services ?? [],
      })),
    });
  } catch (err) {
    return upstreamError(res, err);
  }
});

// ── DELETE /cache ─────────────────────────────────────────────────────────────

router.delete('/cache', (_req, res) => {
  const count = cache.size;
  cache.clear();
  console.log(`[${ts()}] [cache] cleared ${count} entries`);
  res.json({ ok: true, cleared: count });
});

module.exports = { router, cache };
