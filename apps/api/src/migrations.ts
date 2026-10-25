// Append-only: never edit a migration that has shipped; add a new entry instead.
// All money columns are integers in paise (1 INR = 100 paise). All timestamps are ISO-8601 UTC strings.
export const migrations: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('customer', 'driver', 'admin')),
    name TEXT,
    phone TEXT UNIQUE,                  -- self-reported contact number (not verified)
    email TEXT UNIQUE,
    google_sub TEXT UNIQUE,             -- set on first Google sign-in
    created_at TEXT NOT NULL
  );

  CREATE TABLE drivers (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
    license_number TEXT,
    license_expiry TEXT,
    can_drive_manual INTEGER NOT NULL DEFAULT 0,
    is_online INTEGER NOT NULL DEFAULT 0,
    lat REAL,
    lng REAL,
    location_updated_at TEXT,
    admin_notes TEXT,
    approved_at TEXT
  );

  CREATE TABLE vehicles (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES users(id),
    make TEXT NOT NULL,
    model TEXT NOT NULL,
    plate TEXT NOT NULL,
    transmission TEXT NOT NULL CHECK (transmission IN ('automatic', 'manual')),
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE bookings (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES users(id),
    driver_id INTEGER REFERENCES users(id),
    vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
    trip_type TEXT NOT NULL CHECK (trip_type IN ('hourly', 'one_way')),
    status TEXT NOT NULL CHECK (status IN ('requested', 'assigned', 'started', 'completed', 'cancelled')),
    pickup_address TEXT NOT NULL,
    pickup_lat REAL NOT NULL,
    pickup_lng REAL NOT NULL,
    dropoff_address TEXT,
    dropoff_lat REAL,
    dropoff_lng REAL,
    estimated_minutes INTEGER NOT NULL,
    estimated_fare INTEGER NOT NULL,
    pricing TEXT NOT NULL,              -- JSON snapshot of pricing settings at booking time
    start_otp TEXT NOT NULL,            -- customer reads this to the driver to start the trip
    needs_dispatch INTEGER NOT NULL DEFAULT 0,
    offered_at TEXT NOT NULL,           -- when the current round of driver offers went out
    actual_minutes INTEGER,
    final_fare INTEGER,
    commission INTEGER,
    driver_earning INTEGER,
    payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'online')),
    payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid')),
    cancelled_by TEXT,
    cancel_reason TEXT,
    customer_rating INTEGER,
    customer_comment TEXT,
    requested_at TEXT NOT NULL,
    assigned_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    cancelled_at TEXT
  );
  CREATE INDEX bookings_status ON bookings(status);
  CREATE INDEX bookings_customer ON bookings(customer_id);
  CREATE INDEX bookings_driver ON bookings(driver_id);

  CREATE TABLE booking_offers (
    booking_id INTEGER NOT NULL REFERENCES bookings(id),
    driver_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL CHECK (status IN ('sent', 'accepted', 'declined', 'expired')),
    created_at TEXT NOT NULL,
    responded_at TEXT,
    PRIMARY KEY (booking_id, driver_id)
  );
  CREATE INDEX booking_offers_driver ON booking_offers(driver_id, status);

  -- Positive amount = driver owes the platform (commission on cash trips, payouts we made);
  -- negative = platform owes the driver (settlements they paid us, their earning on online-paid trips).
  CREATE TABLE ledger_entries (
    id INTEGER PRIMARY KEY,
    driver_id INTEGER NOT NULL REFERENCES users(id),
    booking_id INTEGER REFERENCES bookings(id),
    kind TEXT NOT NULL CHECK (kind IN ('commission', 'settlement', 'earning', 'payout', 'adjustment')),
    amount INTEGER NOT NULL,
    note TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX ledger_driver ON ledger_entries(driver_id);

  -- One row per Razorpay order. A booking can have several if the customer retries after a failed payment.
  CREATE TABLE payments (
    id INTEGER PRIMARY KEY,
    booking_id INTEGER NOT NULL REFERENCES bookings(id),
    razorpay_order_id TEXT NOT NULL UNIQUE,
    razorpay_payment_id TEXT,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('created', 'paid')),
    created_at TEXT NOT NULL,
    paid_at TEXT
  );
  CREATE INDEX payments_booking ON payments(booking_id);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];
