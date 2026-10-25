// Mirrors the API's response shapes (apps/api/src/bookings.ts views).
export type Role = 'customer' | 'driver' | 'admin';
export type BookingStatus = 'requested' | 'assigned' | 'started' | 'completed' | 'cancelled';
export type TripType = 'hourly' | 'one_way';
export type Transmission = 'automatic' | 'manual';
export type PaymentMethod = 'cash' | 'online';

export type User = { id: number; role: Role; name: string | null; phone: string | null; email: string | null };
export type Party = { id: number; name: string | null; phone: string | null };
export type Place = { address: string; lat: number | null; lng: number | null };
export type Vehicle = { id: number; make: string; model: string; plate: string; transmission: Transmission };

export type Booking = {
  id: number;
  status: BookingStatus;
  tripType: TripType;
  pickup: Place;
  dropoff: Place | null;
  vehicle: Vehicle;
  estimatedMinutes: number;
  estimatedFarePaise: number;
  actualMinutes: number | null;
  finalFarePaise: number | null;
  paymentMethod: PaymentMethod;
  paymentStatus: 'unpaid' | 'paid';
  cancelledBy: 'customer' | 'admin' | null;
  cancelReason: string | null;
  rating: number | null;
  requestedAt: string;
  assignedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  // Present depending on who's asking:
  startOtp?: string | null;
  driver?: Party | null;
  customer?: Party | null;
  commissionPaise?: number | null;
  driverEarningPaise?: number | null;
  needsDispatch?: boolean;
  customerComment?: string | null;
};

export type Offer = {
  bookingId: number;
  tripType: TripType;
  pickup: Place;
  dropoffAddress: string | null;
  vehicle: { make: string; model: string; transmission: Transmission };
  estimatedMinutes: number;
  estimatedFarePaise: number;
  estimatedEarningPaise: number;
  paymentMethod: PaymentMethod;
  requestedAt: string;
};

export type LedgerEntry = {
  id: number;
  bookingId: number | null;
  kind: 'commission' | 'settlement' | 'earning' | 'payout' | 'adjustment';
  amountPaise: number;
  note: string | null;
  createdAt: string;
};

export const OPEN_STATUSES: BookingStatus[] = ['requested', 'assigned', 'started'];
