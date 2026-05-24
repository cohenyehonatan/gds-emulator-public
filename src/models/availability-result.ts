/**
 * Cached availability display.
 *
 * After a '1' availability entry, the host returns numbered flight lines.
 * A subsequent '0' sell references those line numbers (e.g. 01Y1 = line 1),
 * so the work area must remember the last display. This is the GDS analog of
 * the printer emulator's mode/resource context that later commands depend on.
 */

export interface AvailabilityLine {
  line: number; // 1-based, as shown to the agent
  carrier: string;
  flightNumber: string;
  /** Classes shown with seat counts, e.g. { Y: 9, B: 4, F: 2 }. */
  classes: Record<string, number>;
  origin: string;
  destination: string;
  departTime: string;
  arriveTime: string;
  equipment: string;
  date: string; // Sabre date token
  dayOfWeek: string;
}

export interface AvailabilityResult {
  date: string;
  origin: string;
  destination: string;
  lines: AvailabilityLine[];
}
