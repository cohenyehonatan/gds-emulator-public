/**
 * EMD service guide seed — the service rows are VERBATIM from the
 * Amadeus Service Hub solution 848456 EGSD screens (6X is Amadeus's
 * own test airline; the LH rows come from the RFIC-D sample and the
 * FBAG detail screen). Codes, RFIC/RFISC pairs, booking methods,
 * TA-issuable flags, and descriptions are as published. The fee
 * AMOUNTS are synthetic (no public service-fee tables exist) —
 * round numbers, flagged per the tariff convention.
 */

import type { EmdService } from '../models/emd.js';

export const EMD_SEED: EmdService[] = [
  // --- 6X (Amadeus test airline) — verbatim guide rows ---
  { carrier: '6X', code: 'BULK', rfic: 'A', rfisc: 'C03', bookingMethod: 'SSR', taIssuable: true, description: 'Bulk', amount: 50, currency: 'USD' },
  { carrier: '6X', code: 'AVIH', rfic: 'C', rfisc: '0BS', bookingMethod: 'SSR', taIssuable: true, description: 'Pet carriage - animal in hold', amount: 120, currency: 'USD' },
  { carrier: '6X', code: 'BIKE', rfic: 'C', rfisc: '0EC', bookingMethod: 'SSR', taIssuable: true, description: 'Bicycle', amount: 60, currency: 'USD' },
  { carrier: '6X', code: 'ERBD', rfic: 'C', rfisc: 'ERB', bookingMethod: 'SSR', taIssuable: true, description: 'EARLY BIRD', amount: 25, currency: 'USD' },
  { carrier: '6X', code: 'FBAG', rfic: 'C', rfisc: '0CF', bookingMethod: 'SSR', taIssuable: true, description: 'Fourth Checked Bag', amount: 150, currency: 'USD' },
  { carrier: '6X', code: 'GOLF', rfic: 'C', rfisc: '99O', bookingMethod: 'SSR', taIssuable: true, description: 'Golfing Equipments', amount: 80, currency: 'USD' },
  { carrier: '6X', code: 'OBAG', rfic: 'C', rfisc: '0CC', bookingMethod: 'SSR', taIssuable: true, description: 'First Checked bag', amount: 35, currency: 'USD' },
  { carrier: '6X', code: 'PETC', rfic: 'C', rfisc: '0AZ', bookingMethod: 'SSR', taIssuable: true, description: 'PET IN CABIN', amount: 100, currency: 'USD' },
  { carrier: '6X', code: 'SBAG', rfic: 'C', rfisc: '0CD', bookingMethod: 'SSR', taIssuable: true, description: 'Second Checked Bag', amount: 45, currency: 'USD' },
  { carrier: '6X', code: 'SCUB', rfic: 'C', rfisc: '0EE', bookingMethod: 'SSR', taIssuable: true, description: 'Scuba Equipment', amount: 75, currency: 'USD' },
  { carrier: '6X', code: 'SNOW', rfic: 'C', rfisc: '0EI', bookingMethod: 'SSR', taIssuable: true, description: 'Snowboard', amount: 70, currency: 'USD' },
  { carrier: '6X', code: 'WEAP', rfic: 'C', rfisc: '0ED', bookingMethod: 'SSR', taIssuable: true, description: 'Sporting Firearms', amount: 90, currency: 'USD' },
  { carrier: '6X', code: 'STCR', rfic: 'D', rfisc: '98F', bookingMethod: 'SSR', taIssuable: true, description: 'Stretcher', amount: 400, currency: 'USD' },
  { carrier: '6X', code: 'LOUS', rfic: 'E', rfisc: 'E01', bookingMethod: 'SSR', taIssuable: true, description: 'Lounge', amount: 55, currency: 'USD' },
  { carrier: '6X', code: 'MAAS', rfic: 'E', rfisc: '0BY', bookingMethod: 'SSR', taIssuable: true, description: 'MEET AND ASSIST REQUEST', amount: 30, currency: 'USD' },
  { carrier: '6X', code: 'CBML', rfic: 'G', rfisc: '0AJ', bookingMethod: 'SSR', taIssuable: true, description: 'CONTINENTAL BREAKFAST', amount: 18, currency: 'USD' },
  // --- LH — the RFIC-D sample rows + the FBAG detail screen ---
  {
    carrier: 'LH', code: 'FBAG', rfic: 'C', rfisc: '0CC', bookingMethod: 'SSR', taIssuable: true,
    description: '1ST BAG UPTO50LB23KG 62LI158CM', amount: 40, currency: 'EUR',
    // Detail attributes verbatim from the Service Hub FBAG screen.
    detail: {
      emdType: 'A',
      monocoupon: false,
      consumedAtIssuance: false,
      additionalDocInExchange: false,
      residualValue: false,
      routingMandatory: true,
      issuedInConnectionMandatory: true,
      excessBaggageMandatory: true,
      refundable: false,
      exchangeable: true,
      interlineable: true,
      endorsable: true,
      displayableByTaIfAirlineIssued: true,
      refundExchangeByTaIfAirlineIssued: true,
      taAssociateDisassociate: false,
    },
  },
  { carrier: 'LH', code: 'CANC', rfic: 'D', rfisc: '995', bookingMethod: 'SVC', taIssuable: true, description: 'CANCELLATION FEE', amount: 100, currency: 'EUR' },
  { carrier: 'LH', code: 'DPST', rfic: 'D', rfisc: '997', bookingMethod: 'SVC', taIssuable: true, description: 'DEPOSITS DOWN PAYMENTS', amount: 200, currency: 'EUR' },
  { carrier: 'LH', code: 'PENF', rfic: 'D', rfisc: '993', bookingMethod: 'SVC', taIssuable: true, description: 'REBOOKING FEE', amount: 150, currency: 'EUR' },
  { carrier: 'LH', code: 'RSVR', rfic: 'D', rfisc: '996', bookingMethod: 'SVC', taIssuable: true, description: 'RESIDUAL VALUE FOR REFUNDABLE', amount: 0, currency: 'EUR' },
  // --- AF — the 14 rows of solution 823571's EGSD/VAF screen,
  // verbatim (incl. the blank-code chargeable-seat SEAT row and the
  // TA ISS. NO rows, which TTM must refuse to issue) ---
  { carrier: 'AF', code: '', rfic: 'A', rfisc: '0B5', bookingMethod: 'SEAT', taIssuable: true, description: 'chargeable seat', amount: 30, currency: 'EUR' },
  { carrier: 'AF', code: 'DSKI', rfic: 'A', rfisc: '0BV', bookingMethod: 'SSR', taIssuable: true, description: 'DISCOUNT SKI RENTAL', amount: 55, currency: 'EUR' },
  { carrier: 'AF', code: 'PJET', rfic: 'A', rfisc: 'JET', bookingMethod: 'SVC', taIssuable: true, description: 'Air France Additional Flight S', amount: 250, currency: 'EUR' },
  { carrier: 'AF', code: 'ABAG', rfic: 'C', rfisc: '0CC', bookingMethod: 'SSR', taIssuable: true, description: '1st additional bag', amount: 40, currency: 'EUR' },
  { carrier: 'AF', code: 'AVIH', rfic: 'C', rfisc: '0BS', bookingMethod: 'SSR', taIssuable: true, description: 'PET IN HOLD', amount: 200, currency: 'EUR' },
  { carrier: 'AF', code: 'BBAG', rfic: 'C', rfisc: '0CD', bookingMethod: 'SSR', taIssuable: true, description: '2nd additional bag', amount: 70, currency: 'EUR' },
  { carrier: 'AF', code: 'BIKE', rfic: 'C', rfisc: '0EC', bookingMethod: 'SSR', taIssuable: true, description: 'BICYCLE', amount: 55, currency: 'EUR' },
  { carrier: 'AF', code: 'CBAG', rfic: 'C', rfisc: '0CE', bookingMethod: 'SSR', taIssuable: true, description: '3rd or more additional bag', amount: 100, currency: 'EUR' },
  { carrier: 'AF', code: 'HBAG', rfic: 'C', rfisc: '0IK', bookingMethod: 'SSR', taIssuable: false, description: 'HEAVY DC SOLD BAG', amount: 80, currency: 'EUR' },
  { carrier: 'AF', code: 'PETC', rfic: 'C', rfisc: '0BT', bookingMethod: 'SSR', taIssuable: true, description: 'PET IN CABIN', amount: 125, currency: 'EUR' },
  { carrier: 'AF', code: 'XBAG', rfic: 'C', rfisc: '0C3', bookingMethod: 'SSR', taIssuable: true, description: 'Excess Baggage', amount: 60, currency: 'EUR' },
  { carrier: 'AF', code: 'BBEV', rfic: 'D', rfisc: 'BEV', bookingMethod: 'SVC', taIssuable: false, description: 'BlueBiz Exchange Voucher', amount: 0, currency: 'EUR' },
  { carrier: 'AF', code: 'CNLR', rfic: 'D', rfisc: 'CLR', bookingMethod: 'SVC', taIssuable: false, description: 'IRG-Cancellation Refundable', amount: 0, currency: 'EUR' },
  { carrier: 'AF', code: 'CNLT', rfic: 'D', rfisc: 'CLT', bookingMethod: 'SVC', taIssuable: false, description: 'IRG-Cancellation Non Refundabl', amount: 0, currency: 'EUR' },
];
