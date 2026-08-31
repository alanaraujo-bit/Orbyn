/**
 * Time helpers. Everything persisted is UTC ISO-8601; operating-hour math is
 * done in the operator's configured timezone.
 */

export type Iso = string;

export function nowIso(): Iso {
  return new Date().toISOString();
}

export function toIso(date: Date): Iso {
  return date.toISOString();
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function addMinutes(date: Date, minutes: number): Date {
  return addSeconds(date, minutes * 60);
}

export function addHours(date: Date, hours: number): Date {
  return addSeconds(date, hours * 3600);
}

export function addDays(date: Date, days: number): Date {
  return addSeconds(date, days * 86_400);
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = partsCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  partsCache.set(timeZone, formatter);
  return formatter;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };
  const hour = read('hour');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: hour === 24 ? 0 : hour,
    minute: read('minute'),
    second: read('second'),
  };
}

/** Local calendar day in the operating timezone, e.g. `2026-08-30`. */
export function zonedDayKey(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function minutesOfDay(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  return parts.hour * 60 + parts.minute;
}

export interface OperatingHours {
  startMinute: number;
  endMinute: number;
}

export function parseOperatingHours(raw: string): OperatingHours {
  const match = /^(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!match) {
    throw new Error(`OPERATING_HOURS must look like "09:00-20:00", received "${raw}"`);
  }
  const [, startHour, startMinute, endHour, endMinute] = match;
  const start = Number(startHour) * 60 + Number(startMinute);
  const end = Number(endHour) * 60 + Number(endMinute);
  if (start >= end) {
    throw new Error(`OPERATING_HOURS start must be before end, received "${raw}"`);
  }
  return { startMinute: start, endMinute: end };
}

export function isWithinOperatingHours(date: Date, hours: OperatingHours, timeZone: string): boolean {
  const current = minutesOfDay(date, timeZone);
  return current >= hours.startMinute && current < hours.endMinute;
}

/**
 * Next instant inside the operating window. Returns `date` itself when already
 * inside the window.
 */
export function nextOperatingSlot(date: Date, hours: OperatingHours, timeZone: string): Date {
  if (isWithinOperatingHours(date, hours, timeZone)) return date;
  const current = minutesOfDay(date, timeZone);
  const parts = zonedParts(date, timeZone);
  const secondsIntoMinute = parts.second;
  if (current < hours.startMinute) {
    return addSeconds(date, (hours.startMinute - current) * 60 - secondsIntoMinute);
  }
  const minutesUntilMidnight = 24 * 60 - current;
  return addSeconds(date, (minutesUntilMidnight + hours.startMinute) * 60 - secondsIntoMinute);
}

export function randomIntBetween(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}
