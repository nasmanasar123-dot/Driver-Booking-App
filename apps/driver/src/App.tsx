import {
  inr,
  createApi,
  dateTime,
  duration,
  GoogleLogin,
  mapsLink,
  minutesSince,
  statusLabel,
  tripTypeLabel,
  useSocket,
  useToken,
  type Booking,
  type LedgerEntry,
  type Offer,
  type User,
} from '@app/shared';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

const api = createApi('driver-token');

type DriverMe = {
  status: 'pending' | 'approved' | 'rejected' | 'suspended';
  licenseNumber: string | null;
  licenseExpiry: string | null;
  canDriveManual: boolean;
  isOnline: boolean;
  adminNotes: string | null;
  balanceOwedPaise: number;
  maxCashOwedPaise: number;
};

type Coords = { lat: number; lng: number };
// Development only: pretend to be in Edappally, Kochi so you can test from anywhere.
const SIMULATED: Coords = { lat: 10.0258, lng: 76.3075 };

export function App() {
  const token = useToken(api);
  if (!token) return <GoogleLogin api={api} app="driver" title="Driver Partner" subtitle="Sign in to start receiving bookings." />;
  return <Home />;
}

function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [me, setMe] = useState<DriverMe | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    api.get<User>('/me').then(setUser, (e) => setError(e.message));
    api.get<DriverMe>('/driver/me').then(setMe, (e) => setError(e.message));
  }, []);
  useEffect(refresh, [refresh]);

  if (!me || !user) return <main className="page">{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</main>;

  return (
    <main className="page stack">
      <header className="topbar">
        <div>
          <h1>Driver Partner</h1>
          {user.name && <p className="muted small">{user.name}</p>}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => api.setToken(null)}>
          Sign out
        </button>
      </header>
      {me.status === 'approved' ? <Dashboard me={me} refreshMe={refresh} /> : <Onboarding me={me} user={user} onSubmitted={refresh} />}
    </main>
  );
}

function Onboarding({ me, user, onSubmitted }: { me: DriverMe; user: User; onSubmitted: () => void }) {
  const [form, setForm] = useState({
    name: user.name ?? '',
    phone: user.phone ?? '',
    licenseNumber: me.licenseNumber ?? '',
    licenseExpiry: me.licenseExpiry ?? '',
    canDriveManual: me.canDriveManual,
  });
  const [error, setError] = useState('');
  const submitted = me.status === 'pending' && me.licenseNumber;

  if (me.status === 'suspended') {
    return (
      <div className="card warn stack">
        <h2>Account suspended</h2>
        <p>{me.adminNotes ?? 'Please contact support.'}</p>
      </div>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.put('/driver/profile', form);
      onSubmitted();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="stack">
      {submitted && (
        <div className="card warn stack">
          <h2>Application under review</h2>
          <p>We'll verify your documents and contact you. You can still correct your details below.</p>
        </div>
      )}
      {me.status === 'rejected' && (
        <div className="card warn stack">
          <h2>Application not approved</h2>
          <p>{me.adminNotes ?? 'Please check your details and resubmit.'}</p>
        </div>
      )}
      <form className="card stack" onSubmit={submit}>
        <h2>Your details</h2>
        <label className="field">
          <span>Full name (as on driving licence)</span>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </label>
        <label className="field">
          <span>Mobile number (customers will call you on this)</span>
          <input type="tel" inputMode="tel" placeholder="98XXX XXXXX" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required />
        </label>
        <label className="field">
          <span>Driving licence number</span>
          <input placeholder="KL07 20190012345" value={form.licenseNumber} onChange={(e) => setForm({ ...form, licenseNumber: e.target.value })} required />
        </label>
        <label className="field">
          <span>Licence expiry</span>
          <input type="date" value={form.licenseExpiry} onChange={(e) => setForm({ ...form, licenseExpiry: e.target.value })} required />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={form.canDriveManual} onChange={(e) => setForm({ ...form, canDriveManual: e.target.checked })} />
          I can drive manual transmission
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary">{submitted ? 'Update details' : 'Submit for approval'}</button>
      </form>
    </div>
  );
}

// Sends the driver's position while online or on a trip. Re-sends the last fix every minute
// even when stationary, so the server doesn't consider the driver stale.
function useLocationReporting(enabled: boolean, simulate: boolean) {
  const lastPos = useRef<Coords | null>(null);
  const lastSent = useRef(0);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!enabled) return;
    const send = (force = false) => {
      if (!lastPos.current || (!force && Date.now() - lastSent.current < 15000)) return;
      lastSent.current = Date.now();
      api.post('/driver/location', lastPos.current).catch(() => {});
    };
    let watchId: number | undefined;
    if (simulate) {
      lastPos.current = SIMULATED;
      send(true);
    } else {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          lastPos.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          setError('');
          send();
        },
        (err) => setError(`Location unavailable: ${err.message}`),
        { enableHighAccuracy: true, maximumAge: 10000 },
      );
    }
    const timer = setInterval(() => send(true), 60000);
    return () => {
      if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
      clearInterval(timer);
    };
  }, [enabled, simulate]);

  return error;
}

const currentPosition = () =>
  new Promise<Coords>((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(`Location needed to go online: ${err.message}`)),
      { enableHighAccuracy: true, timeout: 15000 },
    ),
  );

function alertNewOffer(offer: Offer) {
  navigator.vibrate?.([300, 150, 300]);
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    new Notification('New booking request', { body: `${offer.pickup.address} · ${inr(offer.estimatedEarningPaise)}` });
  }
}

function Dashboard({ me, refreshMe }: { me: DriverMe; refreshMe: () => void }) {
  const [tab, setTab] = useState<'work' | 'earnings'>('work');
  const [online, setOnline] = useState(me.isOnline);
  const [simulate, setSimulate] = useState(import.meta.env.DEV);
  const [current, setCurrent] = useState<Booking | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [finished, setFinished] = useState<Booking | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    api.get<Booking | null>('/driver/bookings/current').then(setCurrent);
    api.get<Offer[]>('/driver/offers').then(setOffers);
  }, []);
  useEffect(refresh, [refresh]);

  useSocket(api, {
    connect: refresh,
    'offer:new': (offer: Offer) => {
      setOffers((list) => [...list.filter((o) => o.bookingId !== offer.bookingId), offer]);
      alertNewOffer(offer);
    },
    'offer:revoked': ({ bookingId }: { bookingId: number }) => setOffers((list) => list.filter((o) => o.bookingId !== bookingId)),
    'booking:removed': ({ bookingId }: { bookingId: number }) => {
      setCurrent((c) => (c?.id === bookingId ? null : c));
      setNotice(`Booking #${bookingId} was reassigned by operations.`);
    },
    'booking:updated': (b: Booking) => {
      setFinished((f) => (f?.id === b.id ? b : f));
      if (b.status === 'assigned' || b.status === 'started') setCurrent(b);
      else
        setCurrent((c) => {
          if (c?.id === b.id && b.status === 'cancelled') setNotice(`Booking #${b.id} was cancelled.`);
          return c?.id === b.id ? null : c;
        });
    },
  });

  const locationError = useLocationReporting(online || !!current, simulate);

  const toggleOnline = async () => {
    setError('');
    try {
      if (!online) {
        const location = simulate ? SIMULATED : await currentPosition();
        if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        await api.post('/driver/online', { online: true, location });
        setOnline(true);
        refresh();
      } else {
        await api.post('/driver/online', { online: false });
        setOnline(false);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const act = async (fn: () => Promise<void>) => {
    setError('');
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
      refresh();
    }
  };

  return (
    <div className="stack">
      <div className="card row between">
        <label className="switch">
          <input type="checkbox" checked={online} onChange={toggleOnline} />
          {online ? 'Online' : 'Offline'}
        </label>
        <div style={{ textAlign: 'right' }}>
          <p className="small muted">{me.balanceOwedPaise < 0 ? 'Owed to you' : 'Commission owed'}</p>
          <b style={{ color: me.balanceOwedPaise > me.maxCashOwedPaise * 0.8 ? 'var(--danger)' : undefined }}>{inr(Math.abs(me.balanceOwedPaise))}</b>
        </div>
      </div>
      {import.meta.env.DEV && (
        <label className="checkbox small muted">
          <input type="checkbox" checked={simulate} onChange={(e) => setSimulate(e.target.checked)} />
          Simulate location in Edappally, Kochi (dev only)
        </label>
      )}
      {locationError && <p className="error">{locationError}</p>}
      {error && <p className="error">{error}</p>}
      {notice && (
        <div className="card warn row between">
          <span>{notice}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setNotice('')}>
            OK
          </button>
        </div>
      )}

      <nav className="tabs">
        <button className={tab === 'work' ? 'active' : ''} onClick={() => setTab('work')}>
          Bookings
        </button>
        <button className={tab === 'earnings' ? 'active' : ''} onClick={() => setTab('earnings')}>
          Earnings
        </button>
      </nav>

      {tab === 'earnings' ? (
        <Earnings />
      ) : finished ? (
        <CollectCash
          booking={finished}
          onDone={() => {
            setFinished(null);
            refreshMe();
          }}
        />
      ) : current ? (
        <CurrentTrip booking={current} act={act} onChange={setCurrent} onFinished={setFinished} />
      ) : !online ? (
        <p className="muted">Go online to receive booking requests.</p>
      ) : offers.length === 0 ? (
        <p className="muted">Waiting for booking requests nearby…</p>
      ) : (
        <div className="list">
          {offers.map((o) => (
            <OfferCard
              key={o.bookingId}
              offer={o}
              onAccept={() =>
                act(async () => {
                  setCurrent(await api.post<Booking>(`/driver/offers/${o.bookingId}/accept`));
                  setOffers([]);
                })
              }
              onDecline={() =>
                act(async () => {
                  await api.post(`/driver/offers/${o.bookingId}/decline`);
                  setOffers((list) => list.filter((x) => x.bookingId !== o.bookingId));
                })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OfferCard({ offer: o, onAccept, onDecline }: { offer: Offer; onAccept: () => void; onDecline: () => void }) {
  return (
    <div className="card highlight stack">
      <div className="row between">
        <h2>New request</h2>
        <b>{inr(o.estimatedEarningPaise)}</b>
      </div>
      <dl className="kv">
        <dt>Pickup</dt>
        <dd>{o.pickup.address}</dd>
        {o.dropoffAddress && (
          <>
            <dt>Drop-off</dt>
            <dd>{o.dropoffAddress}</dd>
          </>
        )}
        <dt>Trip</dt>
        <dd>
          {tripTypeLabel[o.tripType]} · ~{duration(o.estimatedMinutes)}
        </dd>
        <dt>Payment</dt>
        <dd>{o.paymentMethod === 'cash' ? 'Cash' : 'Customer pays online'}</dd>
        <dt>Car</dt>
        <dd>
          {o.vehicle.make} {o.vehicle.model} · {o.vehicle.transmission}
        </dd>
      </dl>
      <p className="muted small">Estimated earning after commission. Final amount depends on actual time.</p>
      <div className="row">
        <button className="btn grow" onClick={onDecline}>
          Decline
        </button>
        <button className="btn btn-primary grow" onClick={onAccept}>
          Accept
        </button>
      </div>
    </div>
  );
}

function CurrentTrip({
  booking: b,
  act,
  onChange,
  onFinished,
}: {
  booking: Booking;
  act: (fn: () => Promise<void>) => void;
  onChange: (b: Booking | null) => void;
  onFinished: (b: Booking) => void;
}) {
  const [otp, setOtp] = useState('');
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="card highlight stack">
      <div className="row between">
        <h2>{statusLabel[b.status]}</h2>
        <span className={`badge ${b.status}`}>#{b.id}</span>
      </div>

      {b.customer && (
        <div className="row between">
          <b>{b.customer.name ?? 'Customer'}</b>
          {b.customer.phone && (
            <a className="btn" href={`tel:${b.customer.phone}`}>
              📞 Call
            </a>
          )}
        </div>
      )}

      <dl className="kv">
        <dt>Pickup</dt>
        <dd>
          {b.pickup.address}{' '}
          <a href={mapsLink(b.pickup.lat, b.pickup.lng, b.pickup.address)} target="_blank" rel="noreferrer">
            Navigate
          </a>
        </dd>
        {b.dropoff && (
          <>
            <dt>Drop-off</dt>
            <dd>
              {b.dropoff.address}{' '}
              <a href={mapsLink(b.dropoff.lat, b.dropoff.lng, b.dropoff.address)} target="_blank" rel="noreferrer">
                Navigate
              </a>
            </dd>
          </>
        )}
        <dt>Car</dt>
        <dd>
          {b.vehicle.make} {b.vehicle.model} · {b.vehicle.plate} · {b.vehicle.transmission}
        </dd>
        <dt>Trip</dt>
        <dd>
          {tripTypeLabel[b.tripType]} · ~{duration(b.estimatedMinutes)} · est. {inr(b.estimatedFarePaise)} · {b.paymentMethod === 'cash' ? 'cash' : 'customer pays online'}
        </dd>
      </dl>

      {b.status === 'assigned' && (
        <>
          <p className="muted small">At the car? Check it with the customer, then ask for their 4-digit start code.</p>
          <div className="row">
            <input className="grow" inputMode="numeric" maxLength={4} placeholder="Start code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} />
            <button
              className="btn btn-primary"
              disabled={otp.length !== 4}
              onClick={() => act(async () => onChange(await api.post<Booking>(`/driver/bookings/${b.id}/start`, { otp })))}
            >
              Start trip
            </button>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() =>
              confirm("Release this booking? It will be offered to other drivers.") &&
              act(async () => {
                await api.post(`/driver/bookings/${b.id}/release`);
                onChange(null);
              })
            }
          >
            I can't make it — release booking
          </button>
        </>
      )}

      {b.status === 'started' && b.startedAt && (
        <>
          <p>
            Started {dateTime(b.startedAt)} · <b>{duration(minutesSince(b.startedAt))}</b> elapsed
          </p>
          <button
            className="btn btn-primary"
            onClick={() =>
              confirm('End the trip now?') &&
              act(async () => {
                const done = await api.post<Booking>(`/driver/bookings/${b.id}/complete`);
                onChange(null);
                onFinished(done);
              })
            }
          >
            End trip
          </button>
        </>
      )}
    </div>
  );
}

function CollectCash({ booking: b, onDone }: { booking: Booking; onDone: () => void }) {
  const online = b.paymentMethod === 'online';
  const paid = b.paymentStatus === 'paid';
  return (
    <div className="card highlight stack" style={{ textAlign: 'center' }}>
      <p className="muted">{online ? 'Customer pays in their app' : 'Collect from customer'}</p>
      <p className="big">{inr(b.finalFarePaise)}</p>
      <p className="small muted">
        {duration(b.actualMinutes)} · your earning {inr(b.driverEarningPaise)} · commission {inr(b.commissionPaise)}
      </p>
      {online && <p>{paid ? '✅ Paid online — your earning is added to your account.' : '⏳ Waiting for the customer to pay…'}</p>}
      <button className="btn btn-primary" onClick={onDone}>
        {online ? 'Done' : 'Cash collected'}
      </button>
    </div>
  );
}

function Earnings() {
  const [trips, setTrips] = useState<Booking[]>([]);
  const [ledger, setLedger] = useState<{ balanceOwedPaise: number; entries: LedgerEntry[] } | null>(null);

  useEffect(() => {
    api.get<Booking[]>('/driver/bookings').then(setTrips);
    api.get<{ balanceOwedPaise: number; entries: LedgerEntry[] }>('/driver/ledger').then(setLedger);
  }, []);

  const completed = trips.filter((t) => t.status === 'completed');
  const earned = completed.reduce((sum, t) => sum + (t.driverEarningPaise ?? 0), 0);

  return (
    <div className="stack">
      <div className="stats">
        <div className="stat">
          <span className="muted small">Trips</span>
          <b>{completed.length}</b>
        </div>
        <div className="stat">
          <span className="muted small">Earned</span>
          <b>{inr(earned)}</b>
        </div>
        <div className="stat">
          <span className="muted small">{(ledger?.balanceOwedPaise ?? 0) < 0 ? 'Owed to you' : 'Commission owed'}</span>
          <b>{ledger && inr(Math.abs(ledger.balanceOwedPaise))}</b>
        </div>
      </div>

      <h3>Recent trips</h3>
      <div className="list">
        {completed.length === 0 && <p className="muted">No completed trips yet.</p>}
        {completed.map((t) => (
          <div key={t.id} className="card row between">
            <div>
              <b>{dateTime(t.completedAt)}</b>
              <p className="small muted">
                {duration(t.actualMinutes)} · fare {inr(t.finalFarePaise)}
              </p>
            </div>
            <b>{inr(t.driverEarningPaise)}</b>
          </div>
        ))}
      </div>

      <h3>Account</h3>
      <div className="list">
        {ledger?.entries.map((e) => (
          <div key={e.id} className="card row between small">
            <span>
              {e.note} <span className="muted">· {dateTime(e.createdAt)}</span>
            </span>
            <b>{e.amountPaise > 0 ? '+' : '−'}{inr(Math.abs(e.amountPaise))}</b>
          </div>
        ))}
      </div>
    </div>
  );
}
