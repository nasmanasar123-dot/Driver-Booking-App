import {
  inr,
  createApi,
  dateTime,
  distanceKm,
  duration,
  GoogleLogin,
  statusLabel,
  tripTypeLabel,
  useSocket,
  useToken,
  type Booking,
  type BookingStatus,
  type LedgerEntry,
} from '@app/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

const api = createApi('admin-token');

type Overview = {
  needsDispatch: number;
  active: number;
  driversOnline: number;
  driversPending: number;
  completedToday: number;
  commissionOutstandingPaise: number;
};

type DriverStatus = 'pending' | 'approved' | 'rejected' | 'suspended';
type Driver = {
  id: number;
  name: string | null;
  phone: string;
  status: DriverStatus;
  licenseNumber: string | null;
  licenseExpiry: string | null;
  canDriveManual: boolean;
  isOnline: boolean;
  lat: number | null;
  lng: number | null;
  locationUpdatedAt: string | null;
  adminNotes: string | null;
  balanceOwedPaise: number;
  activeBookingId: number | null;
  rating: number | null;
  tripsCompleted: number;
};

type Pricing = {
  minimumMinutes: number;
  minimumFare: number;
  blockMinutes: number;
  blockFare: number;
  oneWayFee: number;
  nightSurchargePercent: number;
  nightStartHour: number;
  nightEndHour: number;
  commissionPercent: number;
};

type Tab = 'dispatch' | 'bookings' | 'drivers' | 'pricing';

export function App() {
  const token = useToken(api);
  if (!token) return <GoogleLogin api={api} app="admin" title="Ops Dashboard" subtitle="Operations team sign-in." />;
  return <Dashboard />;
}

function Dashboard() {
  const [tab, setTab] = useState<Tab>('dispatch');
  const [overview, setOverview] = useState<Overview | null>(null);
  // Bumped on every live update so the visible tab refetches.
  const [version, setVersion] = useState(0);

  const refresh = useCallback(() => {
    api.get<Overview>('/admin/overview').then(setOverview);
    setVersion((v) => v + 1);
  }, []);
  useEffect(refresh, [refresh]);
  useSocket(api, { 'booking:updated': refresh, connect: refresh });

  return (
    <main className="page wide">
      <header className="topbar">
        <h1>Ops Dashboard</h1>
        <button className="btn btn-ghost btn-sm" onClick={() => api.setToken(null)}>
          Sign out
        </button>
      </header>

      {overview && (
        <div className="stats">
          <Stat label="Needs dispatch" value={overview.needsDispatch} alert={overview.needsDispatch > 0} />
          <Stat label="Active bookings" value={overview.active} />
          <Stat label="Drivers online" value={overview.driversOnline} />
          <Stat label="Pending approval" value={overview.driversPending} alert={overview.driversPending > 0} />
          <Stat label="Completed today" value={overview.completedToday} />
          <Stat label="Commission outstanding" value={inr(overview.commissionOutstandingPaise)} />
        </div>
      )}

      <nav className="tabs">
        {(['dispatch', 'bookings', 'drivers', 'pricing'] as const).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      {tab === 'dispatch' && <Dispatch version={version} onChange={refresh} />}
      {tab === 'bookings' && <Bookings version={version} />}
      {tab === 'drivers' && <Drivers onChange={refresh} />}
      {tab === 'pricing' && <PricingForm />}
    </main>
  );
}

function Stat({ label, value, alert }: { label: string; value: number | string; alert?: boolean }) {
  return (
    <div className="stat" style={alert ? { borderColor: 'var(--warn-text)' } : undefined}>
      <span className="muted small">{label}</span>
      <b>{value}</b>
    </div>
  );
}

function Dispatch({ version, onChange }: { version: number; onChange: () => void }) {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<Booking[]>('/admin/bookings?status=open').then(setBookings);
    api.get<Driver[]>('/admin/drivers?status=approved').then(setDrivers);
  }, [version]);

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (bookings.length === 0) return <p className="muted">No open bookings right now.</p>;

  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}
      {bookings.map((b) => (
        <DispatchCard key={b.id} booking={b} drivers={drivers} act={act} />
      ))}
    </div>
  );
}

function DispatchCard({ booking: b, drivers, act }: { booking: Booking; drivers: Driver[]; act: (fn: () => Promise<unknown>) => void }) {
  const [driverId, setDriverId] = useState('');
  const pickup = b.pickup.lat != null && b.pickup.lng != null ? { lat: b.pickup.lat, lng: b.pickup.lng } : null;
  const candidates = drivers
    .filter((d) => !d.activeBookingId && (b.vehicle.transmission === 'automatic' || d.canDriveManual))
    .map((d) => ({ ...d, km: pickup && d.lat != null && d.lng != null ? distanceKm(pickup, { lat: d.lat, lng: d.lng }) : null }))
    .sort((x, y) => Number(y.isOnline) - Number(x.isOnline) || (x.km ?? 1e9) - (y.km ?? 1e9));

  return (
    <div className={`card stack ${b.needsDispatch ? 'highlight' : ''}`}>
      <div className="row between">
        <div className="row">
          <h3>#{b.id}</h3>
          <span className={`badge ${b.status}`}>{statusLabel[b.status]}</span>
          {b.needsDispatch && <span className="badge dispatch">Needs manual dispatch</span>}
        </div>
        <span className="muted small">Requested {dateTime(b.requestedAt)}</span>
      </div>
      <dl className="kv">
        <dt>Customer</dt>
        <dd>
          {b.customer?.name ?? '—'} · <a href={`tel:${b.customer?.phone}`}>{b.customer?.phone}</a>
        </dd>
        <dt>Pickup</dt>
        <dd>{b.pickup.address}</dd>
        {b.dropoff && (
          <>
            <dt>Drop-off</dt>
            <dd>{b.dropoff.address}</dd>
          </>
        )}
        <dt>Trip</dt>
        <dd>
          {tripTypeLabel[b.tripType]} · ~{duration(b.estimatedMinutes)} · est. {inr(b.estimatedFarePaise)}
        </dd>
        <dt>Car</dt>
        <dd>
          {b.vehicle.make} {b.vehicle.model} · {b.vehicle.plate} · {b.vehicle.transmission}
        </dd>
        {b.driver && (
          <>
            <dt>Driver</dt>
            <dd>
              {b.driver.name} · <a href={`tel:${b.driver.phone}`}>{b.driver.phone}</a>
            </dd>
          </>
        )}
        <dt>Start code</dt>
        <dd>{b.startOtp}</dd>
      </dl>
      <div className="row">
        {b.status !== 'started' && (
          <>
            <select className="grow" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
              <option value="">{b.driver ? 'Reassign to…' : 'Assign a driver…'}</option>
              {candidates.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name ?? d.phone} · {d.isOnline ? 'online' : 'offline'}
                  {d.km != null ? ` · ${d.km.toFixed(1)} km` : ''}
                </option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              disabled={!driverId}
              onClick={() => act(() => api.post(`/admin/bookings/${b.id}/assign`, { driverId: Number(driverId) }))}
            >
              Assign
            </button>
          </>
        )}
        <button
          className="btn btn-danger"
          onClick={() => {
            const reason = prompt('Reason for cancelling?');
            if (reason !== null) act(() => api.post(`/admin/bookings/${b.id}/cancel`, { reason }));
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function Bookings({ version }: { version: number }) {
  const [status, setStatus] = useState<'' | BookingStatus>('');
  const [bookings, setBookings] = useState<Booking[]>([]);

  const reload = useCallback(() => {
    api.get<Booking[]>(`/admin/bookings${status ? `?status=${status}` : ''}`).then(setBookings);
  }, [status]);
  useEffect(reload, [reload, version]);

  return (
    <div className="stack">
      <select value={status} onChange={(e) => setStatus(e.target.value as BookingStatus | '')} style={{ maxWidth: 240 }}>
        <option value="">All statuses</option>
        {(Object.keys(statusLabel) as BookingStatus[]).map((s) => (
          <option key={s} value={s}>
            {statusLabel[s]}
          </option>
        ))}
      </select>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Requested</th>
              <th>Status</th>
              <th>Customer</th>
              <th>Driver</th>
              <th>Trip</th>
              <th>Time</th>
              <th>Fare</th>
              <th>Commission</th>
              <th>Payment</th>
              <th>Rating</th>
            </tr>
          </thead>
          <tbody>
            {bookings.map((b) => (
              <tr key={b.id}>
                <td>{b.id}</td>
                <td>{dateTime(b.requestedAt)}</td>
                <td>
                  <span className={`badge ${b.status}`}>{statusLabel[b.status]}</span>
                  {b.cancelReason && <div className="small muted">{b.cancelReason}</div>}
                </td>
                <td>
                  {b.customer?.name ?? '—'}
                  <div className="small muted">{b.customer?.phone}</div>
                </td>
                <td>{b.driver?.name ?? '—'}</td>
                <td>{tripTypeLabel[b.tripType]}</td>
                <td>{duration(b.actualMinutes ?? b.estimatedMinutes)}</td>
                <td>{inr(b.finalFarePaise ?? b.estimatedFarePaise)}</td>
                <td>{inr(b.commissionPaise)}</td>
                <td>
                  {b.paymentMethod}
                  {b.status === 'completed' && (
                    <div className="small">
                      {b.paymentStatus === 'paid' ? (
                        'paid'
                      ) : (
                        <>
                          <span className="error">unpaid</span>{' '}
                          <button
                            className="btn btn-sm"
                            onClick={() =>
                              confirm('Customer paid the driver in cash instead? The driver will owe the commission.') &&
                              api.post(`/admin/bookings/${b.id}/mark-paid-cash`).then(reload, (e) => alert(e.message))
                            }
                          >
                            Paid in cash
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </td>
                <td>
                  {b.rating ? `${b.rating}★` : '—'}
                  {b.customerComment && <div className="small muted">{b.customerComment}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Drivers({ onChange }: { onChange: () => void }) {
  const [status, setStatus] = useState<'' | DriverStatus>('');
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [selected, setSelected] = useState<Driver | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.get<Driver[]>(`/admin/drivers${status ? `?status=${status}` : ''}`).then((list) => {
      setDrivers(list);
      setSelected((s) => (s ? (list.find((d) => d.id === s.id) ?? null) : null));
    });
  }, [status]);
  useEffect(load, [load]);

  const setDriverStatus = async (d: Driver, next: DriverStatus) => {
    const notes = next === 'approved' ? undefined : (prompt(`Note for the driver (why ${next})?`) ?? undefined);
    setError('');
    try {
      await api.post(`/admin/drivers/${d.id}/status`, { status: next, notes });
      load();
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="stack">
      <select value={status} onChange={(e) => setStatus(e.target.value as DriverStatus | '')} style={{ maxWidth: 240 }}>
        <option value="">All drivers</option>
        <option value="pending">Pending</option>
        <option value="approved">Approved</option>
        <option value="rejected">Rejected</option>
        <option value="suspended">Suspended</option>
      </select>
      {error && <p className="error">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Driver</th>
              <th>Status</th>
              <th>Licence</th>
              <th>Manual</th>
              <th>Trips</th>
              <th>Rating</th>
              <th>Owes (− = we owe)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {drivers.map((d) => (
              <tr key={d.id}>
                <td>
                  {d.name ?? '—'}
                  <div className="small muted">{d.phone}</div>
                </td>
                <td>
                  <span className={`badge ${d.status}`}>{d.status}</span>{' '}
                  {d.isOnline && <span className="badge online">online</span>}
                </td>
                <td>
                  {d.licenseNumber ?? '—'}
                  {d.licenseExpiry && <div className="small muted">exp. {d.licenseExpiry}</div>}
                </td>
                <td>{d.canDriveManual ? 'Yes' : 'No'}</td>
                <td>{d.tripsCompleted}</td>
                <td>{d.rating ? `${d.rating}★` : '—'}</td>
                <td>{inr(d.balanceOwedPaise)}</td>
                <td>
                  <div className="row">
                    {d.status !== 'approved' && d.licenseNumber && (
                      <button className="btn btn-sm btn-primary" onClick={() => setDriverStatus(d, 'approved')}>
                        Approve
                      </button>
                    )}
                    {d.status === 'pending' && (
                      <button className="btn btn-sm" onClick={() => setDriverStatus(d, 'rejected')}>
                        Reject
                      </button>
                    )}
                    {d.status === 'approved' && (
                      <button className="btn btn-sm btn-danger" onClick={() => setDriverStatus(d, 'suspended')}>
                        Suspend
                      </button>
                    )}
                    <button className="btn btn-sm" onClick={() => setSelected(d)}>
                      Account
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected && <DriverAccount driver={selected} onChange={() => (load(), onChange())} onClose={() => setSelected(null)} />}
    </div>
  );
}

function DriverAccount({ driver, onChange, onClose }: { driver: Driver; onChange: () => void; onClose: () => void }) {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [direction, setDirection] = useState<'from_driver' | 'to_driver'>('from_driver');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.get<LedgerEntry[]>(`/admin/drivers/${driver.id}/ledger`).then(setEntries);
  }, [driver.id]);
  useEffect(load, [load, driver.balanceOwedPaise]);

  const settle = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.post(`/admin/drivers/${driver.id}/settlements`, { amountPaise: Math.round(Number(amount) * 100), note: note || undefined, direction });
      setAmount('');
      setNote('');
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="card stack">
      <div className="row between">
        <h2>
          {driver.name ?? driver.phone} —{' '}
          {driver.balanceOwedPaise < 0 ? `we owe them ${inr(-driver.balanceOwedPaise)}` : `owes ${inr(driver.balanceOwedPaise)}`}
        </h2>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
      <form className="row" onSubmit={settle}>
        <select value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)} style={{ maxWidth: 200 }}>
          <option value="from_driver">Received from driver</option>
          <option value="to_driver">Paid to driver</option>
        </select>
        <input type="number" min="1" step="0.01" placeholder="Amount (₹)" value={amount} onChange={(e) => setAmount(e.target.value)} required style={{ maxWidth: 220 }} />
        <input className="grow" placeholder="Note (e.g. cash at office, bank transfer ref)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn btn-primary">Record</button>
      </form>
      {error && <p className="error">{error}</p>}
      <div className="table-wrap">
        <table>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{dateTime(e.createdAt)}</td>
                <td>{e.kind}</td>
                <td>{e.note}</td>
                <td style={{ textAlign: 'right' }}>
                  {e.amountPaise > 0 ? '+' : '−'}
                  {inr(Math.abs(e.amountPaise))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Edited in rupees / hours here; the API stores paise / minutes.
function PricingForm() {
  const [p, setP] = useState<Pricing | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<Pricing>('/admin/settings/pricing').then(setP);
  }, []);
  if (!p) return <p className="muted">Loading…</p>;

  const money = (k: keyof Pricing) => ({
    value: p[k] / 100,
    onChange: (e: { target: { value: string } }) => setP({ ...p, [k]: Math.round(Number(e.target.value) * 100) }),
  });
  const plain = (k: keyof Pricing) => ({
    value: p[k],
    onChange: (e: { target: { value: string } }) => setP({ ...p, [k]: Number(e.target.value) }),
  });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSaved(false);
    try {
      setP(await api.put<Pricing>('/admin/settings/pricing', p));
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const hourly = (p.blockFare * 60) / p.blockMinutes;

  return (
    <form className="card stack" onSubmit={save} style={{ maxWidth: 560 }}>
      <h2>Pricing</h2>
      <p className="muted small">Changes apply to new bookings only.</p>
      <div className="row">
        <label className="field grow">
          <span>Minimum fare (₹)</span>
          <input type="number" min="0" step="0.5" {...money('minimumFare')} />
        </label>
        <label className="field grow">
          <span>Covers first (minutes)</span>
          <input type="number" min="15" step="15" {...plain('minimumMinutes')} />
        </label>
      </div>
      <div className="row">
        <label className="field grow">
          <span>Then per block (₹)</span>
          <input type="number" min="0" step="0.25" {...money('blockFare')} />
        </label>
        <label className="field grow">
          <span>Block length (minutes)</span>
          <input type="number" min="5" step="5" {...plain('blockMinutes')} />
        </label>
      </div>
      <p className="muted small">= {inr(hourly)} per hour after the minimum.</p>
      <label className="field">
        <span>One-way trip fee (₹)</span>
        <input type="number" min="0" step="1" {...money('oneWayFee')} />
      </label>
      <div className="row">
        <label className="field grow">
          <span>Night surcharge (%)</span>
          <input type="number" min="0" max="200" {...plain('nightSurchargePercent')} />
        </label>
        <label className="field grow">
          <span>Night from (hour)</span>
          <input type="number" min="0" max="23" {...plain('nightStartHour')} />
        </label>
        <label className="field grow">
          <span>Until (hour)</span>
          <input type="number" min="0" max="23" {...plain('nightEndHour')} />
        </label>
      </div>
      <label className="field">
        <span>Platform commission (%)</span>
        <input type="number" min="0" max="100" {...plain('commissionPercent')} />
      </label>
      {error && <p className="error">{error}</p>}
      {saved && <p className="small" style={{ color: 'var(--ok-text)' }}>Saved.</p>}
      <button className="btn btn-primary">Save pricing</button>
    </form>
  );
}
