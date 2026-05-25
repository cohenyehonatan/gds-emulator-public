/**
 * Entry dispatch: route a ParsedEntry to its handler, applying FSM
 * transitions and translating an illegal transition into a host response.
 */

import type { ParsedEntry } from '../../protocol/entry.js';
import type { WorkArea } from '../work-area.js';
import { SessionEvent } from '../session-state.js';
import { InvalidTransitionError } from '../session-machine.js';
import { Response } from '../../protocol/constants.js';
import { renderSignInResponse } from '../../protocol/serializer.js';
import type { HandlerContext } from './context.js';
import { handleAvailability } from './availability-handler.js';
import {
  handleSell,
  handleName,
  handlePhone,
  handleTicketing,
  handleReceivedFrom,
  handleRemark,
  handleTimeLimit,
} from './pnr-build-handler.js';
import { handleEndTransaction } from './end-tx-handler.js';
import { handleRetrieve } from './retrieve-handler.js';
import { handleCancel, handleSegmentStatus, handleModify } from './modify-handler.js';
import { handleSsr, handleOsi } from './service-handler.js';
import { handlePricing } from './pricing-handler.js';

export type { HandlerContext };

export function dispatch(entry: ParsedEntry, wa: WorkArea, ctx: HandlerContext): string {
  try {
    switch (entry.kind) {
      case 'sign_in':
        wa.machine.transition(SessionEvent.SIGN_IN);
        wa.agent = entry.argument || undefined;
        return renderSignInResponse({ pcc: ctx.pcc, agent: wa.agent });

      case 'sign_out': {
        wa.machine.transition(SessionEvent.SIGN_OFF);
        const msg = entry.allAreas ? 'A.B.C.D.E.F..SIGNED OUT' : `${wa.area} SIGNED OUT`;
        wa.reset();
        return msg;
      }

      case 'ignore':
        wa.machine.transition(SessionEvent.IGNORE);
        wa.reset();
        return Response.IGNORED;

      case 'availability':
        return handleAvailability(entry, wa, ctx);
      case 'sell':
        return handleSell(entry, wa, ctx);
      case 'name':
        return handleName(entry, wa);
      case 'phone':
        return handlePhone(entry, wa);
      case 'ticketing':
        return handleTicketing(entry, wa);
      case 'received_from':
        return handleReceivedFrom(entry, wa);
      case 'remark':
        return handleRemark(entry, wa);
      case 'time_limit':
        return handleTimeLimit(entry, wa);
      case 'ssr':
        return handleSsr(entry, wa);
      case 'osi':
        return handleOsi(entry, wa);
      case 'display':
        return handleRetrieve(entry, wa, ctx);
      case 'cancel':
        return handleCancel(entry, wa);
      case 'segment_status':
        return handleSegmentStatus(entry, wa);
      case 'modify':
        return handleModify(entry, wa);
      case 'pricing':
        return handlePricing(entry, wa, ctx);
      case 'end_transaction':
        return handleEndTransaction(entry, wa, ctx);

      case 'unsupported':
        return Response.FORMAT;
    }
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      return 'OUT OF SEQUENCE'; // TODO: confirm exact wording vs PDF
    }
    throw err;
  }
}
