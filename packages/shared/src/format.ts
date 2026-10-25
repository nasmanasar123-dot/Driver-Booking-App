import type { BookingStatus, PaymentMethod, TripType } from './types.ts';

export const inr = (paise: number | null | undefined) =>
  paise == null ? '—' : `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0 })}`;

export function duration(minutes: number | null | undefined) {
  if (minutes == null) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
}

const local = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
export const dateTime = (iso: string | null | undefined) => (iso ? local.format(new Date(iso)) : '—');

export const minutesSince = (iso: string) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));

export const statusLabel: Record<BookingStatus, string> = {
  requested: 'Finding driver',
  assigned: 'Driver assigned',
  started: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const tripTypeLabel: Record<TripType, string> = { hourly: 'Hourly', one_way: 'One-way' };

export const paymentLabel: Record<PaymentMethod, string> = { cash: 'cash', online: 'pay online' };

export const mapsLink = (lat: number | null, lng: number | null, address: string) =>
  lat != null && lng != null
    ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
