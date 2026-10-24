import {
  aed,
  createApi,
  dateTime,
  duration,
  GoogleLogin,
  minutesSince,
  OPEN_STATUSES,
  statusLabel,
  tripTypeLabel,
  useSocket,
  useToken,
  type Booking,
  type TripType,
  type User,
  type Vehicle,
} from '@app/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

const api = createApi('customer-token');

export function App() {
  const token = useToken(api);
  if (!token) {
    return <GoogleLogin api={api} app="customer" title="Driver Booking" subtitle="A professional driver for your car, anywhere in Dubai." />;
  }
  return <Home />;
}

function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    api.get<User>('/me').then(setUser, (e) => setError(e.message));
    api.get<Booking[]>('/customer/bookings').then(setBookings, (e) => setError(e.message));
  }, []);
  useEffect(refresh, [refresh]);

  const upsert = (b: Booking) => setBookings((list) => [b, ...list.filter((x) => x.id !== b.id)].sort((x, y) => y.id - x.id));

  useSocket(api, { 'booking:updated': upsert, connect: refresh });

  if (!user) return <main className="page">{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</main>;

  const active = bookings.find((b) => OPEN_STATUSES.includes(b.status));
  const toRate = bookings.find((b) => b.status === 'completed' && b.rating == null && b.completedAt && minutesSince(b.completedAt) < 24 * 60);

  return (
    <main className="page stack">
      <header className="topbar">
        <h1>Driver Booking</h1>
        <button className="btn btn-ghost btn-sm" onClick={() => api.setToken(null)}>
          Sign out
        </button>
      </header>
      {!user.phone || !user.name ? (
        <ContactDetails user={user} onDone={setUser} />
      ) : active ? (
        <ActiveBooking booking={active} onChange={upsert} />
      ) : (
        <>
          {toRate && <RateTrip booking={toRate} onChange={upsert} />}
          <BookForm onBooked={upsert} />
        </>
      )}
      <History bookings={bookings.filter((b) => b !== active)} />
    </main>
  );
}

function ContactDetails({ user, onDone }: { user: User; onDone: (u: User) => void }) {
  const [name, setName] = useState(user.name ?? '');
  const [phone, setPhone] = useState(user.phone ?? '');
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      onDone(await api.patch<User>('/me', { name, phone }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form className="card stack" onSubmit={submit}>
      <h2>Your contact details</h2>
      <p className="muted small">Your driver will call this number when they arrive.</p>
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="field">
        <span>Mobile number</span>
        <input type="tel" inputMode="tel" autoComplete="tel" placeholder="05X XXX XXXX" value={phone} onChange={(e) => setPhone(e.target.value)} required />
      </label>
      <button className="btn btn-primary">Continue</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

const DURATIONS = [120, 180, 240, 300, 360, 480, 600, 720];
// Lets you test from outside Dubai during development.
const SAMPLE_LOCATION = { lat: 25.1972, lng: 55.2744, address: 'Burj Khalifa, Downtown Dubai' };

function BookForm({ onBooked }: { onBooked: (b: Booking) => void }) {
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [vehicleId, setVehicleId] = useState<number | null>(null);
  const [tripType, setTripType] = useState<TripType>('hourly');
  const [minutes, setMinutes] = useState(180);
  const [address, setAddress] = useState('');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [dropoff, setDropoff] = useState('');
  const [estimate, setEstimate] = useState<{ fareFils: number; night: boolean } | null>(null);
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<Vehicle[]>('/customer/vehicles').then((list) => {
      setVehicles(list);
      setVehicleId(list[0]?.id ?? null);
    });
  }, []);

  useEffect(() => {
    api.post<{ fareFils: number; night: boolean }>('/customer/estimate', { tripType, estimatedMinutes: minutes }).then(setEstimate, () => setEstimate(null));
  }, [tripType, minutes]);

  const locate = () => {
    setLocating(true);
    setError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
      },
      (err) => {
        setError(`Couldn't get your location: ${err.message}`);
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!coords) return setError('Tap "Use my location" so your driver can find you');
    if (!vehicleId) return setError('Add your car first');
    setBusy(true);
    setError('');
    try {
      onBooked(
        await api.post<Booking>('/customer/bookings', {
          vehicleId,
          tripType,
          estimatedMinutes: minutes,
          pickup: { address, ...coords },
          dropoff: tripType === 'one_way' ? { address: dropoff } : undefined,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!vehicles) return <p className="muted">Loading…</p>;
  if (vehicles.length === 0) {
    return (
      <AddVehicle
        onAdded={(v) => {
          setVehicles([v]);
          setVehicleId(v.id);
        }}
      />
    );
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <h2>Book a driver</h2>

      <label className="field">
        <span>Car</span>
        <select value={vehicleId ?? ''} onChange={(e) => setVehicleId(Number(e.target.value))}>
          {vehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.make} {v.model} · {v.plate} · {v.transmission}
            </option>
          ))}
        </select>
      </label>

      <div className="field">
        <span>Trip</span>
        <div className="row">
          {(['hourly', 'one_way'] as const).map((t) => (
            <button type="button" key={t} className={`btn grow ${tripType === t ? 'btn-primary' : ''}`} onClick={() => setTripType(t)}>
              {tripTypeLabel[t]}
            </button>
          ))}
        </div>
        <span className="small">
          {tripType === 'hourly' ? 'Driver stays with you and drives you around.' : 'Driver takes you and your car to one destination.'}
        </span>
      </div>

      <div className="field">
        <span>Pickup — where's your car?</span>
        <div className="row">
          <button type="button" className="btn grow" onClick={locate} disabled={locating}>
            {locating ? 'Locating…' : coords ? '📍 Location set — update' : '📍 Use my location'}
          </button>
          {import.meta.env.DEV && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setCoords(SAMPLE_LOCATION);
                setAddress(SAMPLE_LOCATION.address);
              }}
            >
              Use sample (dev)
            </button>
          )}
        </div>
        <input placeholder="Building, street, area, parking level…" value={address} onChange={(e) => setAddress(e.target.value)} required minLength={3} />
      </div>

      {tripType === 'one_way' && (
        <label className="field">
          <span>Drop-off</span>
          <input placeholder="Destination address" value={dropoff} onChange={(e) => setDropoff(e.target.value)} required minLength={3} />
        </label>
      )}

      <label className="field">
        <span>How long do you need the driver? (estimate)</span>
        <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
          {DURATIONS.map((m) => (
            <option key={m} value={m}>
              {duration(m)}
            </option>
          ))}
        </select>
      </label>

      {estimate && (
        <div className="row between">
          <span className="muted">Estimated fare{estimate.night ? ' (incl. night charge)' : ''}</span>
          <b>{aed(estimate.fareFils)}</b>
        </div>
      )}
      <p className="muted small">Pay your driver in cash at the end. Final fare is based on actual time.</p>

      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary" disabled={busy}>
        {busy ? 'Booking…' : 'Book now'}
      </button>
    </form>
  );
}

function AddVehicle({ onAdded }: { onAdded: (v: Vehicle) => void }) {
  const [form, setForm] = useState({ make: '', model: '', plate: '', transmission: 'automatic' });
  const [error, setError] = useState('');
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onAdded(await api.post<Vehicle>('/customer/vehicles', form));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form className="card stack" onSubmit={submit}>
      <h2>Add your car</h2>
      <div className="row">
        <input className="grow" placeholder="Make (e.g. Toyota)" value={form.make} onChange={set('make')} required />
        <input className="grow" placeholder="Model (e.g. Land Cruiser)" value={form.model} onChange={set('model')} required />
      </div>
      <input placeholder="Plate (e.g. Dubai A 12345)" value={form.plate} onChange={set('plate')} required />
      <select value={form.transmission} onChange={set('transmission')}>
        <option value="automatic">Automatic</option>
        <option value="manual">Manual</option>
      </select>
      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary">Save car</button>
    </form>
  );
}

function ActiveBooking({ booking: b, onChange }: { booking: Booking; onChange: (b: Booking) => void }) {
  const [error, setError] = useState('');
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const cancel = async () => {
    if (!confirm('Cancel this booking?')) return;
    try {
      onChange(await api.post<Booking>(`/customer/bookings/${b.id}/cancel`, {}));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="card highlight stack">
      <div className="row between">
        <h2>{statusLabel[b.status]}</h2>
        <span className={`badge ${b.status}`}>#{b.id}</span>
      </div>

      {b.status === 'requested' && <p className="muted">We're finding a driver near you. This usually takes a few minutes.</p>}

      {b.driver && (
        <div className="row between">
          <div>
            <b>{b.driver.name ?? 'Your driver'}</b>
            <p className="muted small">{b.status === 'assigned' ? 'On the way to your car' : 'Driving'}</p>
          </div>
          {b.driver.phone && (
            <a className="btn" href={`tel:${b.driver.phone}`}>
              📞 Call
            </a>
          )}
        </div>
      )}

      {b.status === 'assigned' && b.startOtp && (
        <div className="card stack" style={{ textAlign: 'center' }}>
          <p className="muted small">Give this code to your driver when they arrive</p>
          <p className="big">{b.startOtp}</p>
        </div>
      )}

      {b.status === 'started' && b.startedAt && (
        <p>
          Trip started {dateTime(b.startedAt)} · <b>{duration(minutesSince(b.startedAt))}</b> so far
        </p>
      )}

      <dl className="kv">
        <dt>Car</dt>
        <dd>
          {b.vehicle.make} {b.vehicle.model} · {b.vehicle.plate}
        </dd>
        <dt>Pickup</dt>
        <dd>{b.pickup.address}</dd>
        {b.dropoff && (
          <>
            <dt>Drop-off</dt>
            <dd>{b.dropoff.address}</dd>
          </>
        )}
        <dt>Estimate</dt>
        <dd>
          {aed(b.estimatedFareFils)} for {duration(b.estimatedMinutes)} · cash
        </dd>
      </dl>

      {(b.status === 'requested' || b.status === 'assigned') && (
        <button className="btn btn-danger" onClick={cancel}>
          Cancel booking
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function RateTrip({ booking: b, onChange }: { booking: Booking; onChange: (b: Booking) => void }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');

  const submit = async () => onChange(await api.post<Booking>(`/customer/bookings/${b.id}/rate`, { rating, comment: comment || undefined }));

  return (
    <section className="card stack">
      <h2>Trip complete — {aed(b.finalFareFils)}</h2>
      <p className="muted small">
        {duration(b.actualMinutes)} with {b.driver?.name ?? 'your driver'}. Please pay the driver in cash if you haven't.
      </p>
      <div className="stars" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} className={n <= rating ? 'on' : ''} onClick={() => setRating(n)} aria-label={`${n} stars`}>
            ★
          </button>
        ))}
      </div>
      {rating > 0 && (
        <>
          <textarea placeholder="Anything to add? (optional)" value={comment} onChange={(e) => setComment(e.target.value)} rows={2} />
          <button className="btn btn-primary" onClick={submit}>
            Submit rating
          </button>
        </>
      )}
    </section>
  );
}

function History({ bookings }: { bookings: Booking[] }) {
  if (bookings.length === 0) return null;
  return (
    <section className="stack">
      <h3>Past trips</h3>
      <div className="list">
        {bookings.map((b) => (
          <div key={b.id} className="card row between">
            <div>
              <b>{dateTime(b.requestedAt)}</b>
              <p className="muted small">
                {tripTypeLabel[b.tripType]} · {b.vehicle.make} {b.vehicle.model}
              </p>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span className={`badge ${b.status}`}>{statusLabel[b.status]}</span>
              {b.finalFareFils != null && <p className="small">{aed(b.finalFareFils)}</p>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
