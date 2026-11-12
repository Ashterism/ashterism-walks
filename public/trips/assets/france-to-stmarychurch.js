const ferryOptions = {
  1: [{ time: '08:30', arrival: '13:30', label: 'Day · 6h' }, { time: '16:30', arrival: '21:30', label: 'Day · 6h' }, { time: '23:30', arrival: '06:15', next: true, label: 'Overnight · 7h 45m' }],
  2: [{ time: '08:30', arrival: '13:30', label: 'Day · 6h' }, { time: '16:30', arrival: '21:30', label: 'Day · 6h' }, { time: '23:30', arrival: '06:15', next: true, label: 'Overnight · 7h 45m' }],
  3: [{ time: '08:30', arrival: '13:30', label: 'Day · 6h' }, { time: '16:30', arrival: '21:30', label: 'Day · 6h' }, { time: '23:30', arrival: '06:15', next: true, label: 'Overnight · 7h 45m' }],
  4: [{ time: '08:30', arrival: '13:30', label: 'Day · 6h' }, { time: '16:30', arrival: '21:30', label: 'Day · 6h' }, { time: '23:30', arrival: '06:45', next: true, label: 'Overnight · 8h 15m' }],
  5: [{ time: '16:30', arrival: '21:30', label: 'Day · 6h' }, { time: '23:30', arrival: '06:15', next: true, label: 'Overnight · 7h 45m' }],
  6: [{ time: '08:30', arrival: '13:30', label: 'Day · 6h' }, { time: '16:30', arrival: '21:30', label: 'Day · 6h' }, { time: '23:30', arrival: '06:15', next: true, label: 'Overnight · 7h 45m' }],
  0: [{ time: '08:30', arrival: '13:30', label: 'Day · 6h' }, { time: '16:30', arrival: '21:30', label: 'Day · 6h' }, { time: '23:30', arrival: '06:15', next: true, label: 'Overnight · 7h 45m' }],
};

const byId = (id) => document.getElementById(id);
const ferryDate = byId('ferry-date');
const sailing = byId('sailing');

function dateParts(value) { return value.split('-').map(Number); }
function addMinutes(date, time, amount) {
  const [year, month, day] = dateParts(date);
  const [hour, minute] = time.split(':').map(Number);
  const result = new Date(Date.UTC(year, month - 1, day, hour, minute + amount));
  return { date: `${result.getUTCFullYear()}-${String(result.getUTCMonth() + 1).padStart(2, '0')}-${String(result.getUTCDate()).padStart(2, '0')}`, time: `${String(result.getUTCHours()).padStart(2, '0')}:${String(result.getUTCMinutes()).padStart(2, '0')}` };
}
function pretty(date, time, zone) {
  const [year, month, day] = dateParts(date);
  const [hour, minute] = time.split(':').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute) - (zone === 'France' ? 60 : 0) * 60000);
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone === 'France' ? 'Europe/Paris' : 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(utc);
}
function fillSailings() {
  const [year, month, day] = dateParts(ferryDate.value);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const previous = sailing.value;
  sailing.replaceChildren();
  for (const option of ferryOptions[weekday]) {
    const item = document.createElement('option');
    item.value = option.time;
    item.textContent = `${option.time} France → ${option.arrival} UK${option.next ? ' (+1 day)' : ''} · ${option.label}`;
    item.dataset.arrival = option.arrival;
    item.dataset.next = option.next ? 'true' : 'false';
    sailing.append(item);
  }
  if ([...sailing.options].some((option) => option.value === previous)) sailing.value = previous;
  else sailing.value = weekday === 2 ? '16:30' : sailing.options[1]?.value ?? sailing.options[0].value;
}
function render() {
  const startDate = byId('start-date').value;
  const startTime = byId('start-time').value || '07:00';
  const driveFrance = Number(byId('drive-france').value || 0) * 60;
  const driveUk = Number(byId('drive-uk').value || 0) * 60;
  const unload = Number(byId('unload-time').value || 0);
  const depart = sailing.value;
  const sailingDate = ferryDate.value;
  const plannedPort = addMinutes(startDate, startTime, driveFrance);
  const requiredCheckin = addMinutes(sailingDate, depart, -60);
  const targetCheckin = addMinutes(sailingDate, depart, -90);
  const latestStart = addMinutes(sailingDate, depart, -90 - driveFrance);
  const arrivalTime = sailing.selectedOptions[0]?.dataset.arrival || '13:30';
  const arrivalDate = sailing.selectedOptions[0]?.dataset.next === 'true' ? addMinutes(sailingDate, '12:00', 1440).date : sailingDate;
  const onwardStart = addMinutes(arrivalDate, arrivalTime, unload);
  const onwardEnd = addMinutes(onwardStart.date, onwardStart.time, driveUk);
  const plannedTimestamp = Date.UTC(...dateParts(plannedPort.date).map((n, i) => i === 1 ? n - 1 : n), ...plannedPort.time.split(':').map(Number));
  const checkinTimestamp = Date.UTC(...dateParts(requiredCheckin.date).map((n, i) => i === 1 ? n - 1 : n), ...requiredCheckin.time.split(':').map(Number));
  const alert = byId('plan-alert');
  const conflict = startDate !== sailingDate || plannedTimestamp > checkinTimestamp;
  alert.classList.toggle('visible', conflict);
  alert.textContent = startDate !== sailingDate
    ? 'The France drive starts on a different day to this sailing. Change one of the dates to see a same-day plan.'
    : plannedTimestamp > checkinTimestamp
      ? `This estimate reaches Ouistreham after check-in closes at ${pretty(requiredCheckin.date, requiredCheckin.time, 'France')}. For a 90-minute arrival margin, leave by ${pretty(latestStart.date, latestStart.time, 'France')}.`
      : `Your estimate reaches Ouistreham at ${pretty(plannedPort.date, plannedPort.time, 'France')}. Aim to leave by ${pretty(latestStart.date, latestStart.time, 'France')} for a 90-minute check-in margin.`;
  const items = [
    ['Leave Mialet', `${pretty(startDate, startTime, 'France')} · France time`],
    ['Reach Ouistreham', `${pretty(plannedPort.date, plannedPort.time, 'France')} · ${Number(byId('drive-france').value || 0).toLocaleString()}h drive estimate`],
    ['Check-in closes', `${pretty(requiredCheckin.date, requiredCheckin.time, 'France')} · 60 minutes before sailing`],
    ['Ferry departs', `${pretty(sailingDate, depart, 'France')} · local port time`],
    ['Arrive Portsmouth', `${pretty(arrivalDate, arrivalTime, 'UK')} · UK time`],
    ['Drive can start', `${pretty(onwardStart.date, onwardStart.time, 'UK')} · after ${unload} min to unload`],
    ['Reach Torquay', `${pretty(onwardEnd.date, onwardEnd.time, 'UK')} · ${Number(byId('drive-uk').value || 0).toLocaleString()}h drive estimate`],
  ];
  byId('timeline').replaceChildren(...items.map(([title, detail]) => {
    const li = document.createElement('li');
    const strong = document.createElement('b'); strong.textContent = title;
    const span = document.createElement('span'); span.textContent = detail;
    li.append(strong, span); return li;
  }));
}

ferryDate.addEventListener('change', () => { fillSailings(); render(); });
sailing.addEventListener('change', render);
for (const id of ['start-date', 'start-time', 'drive-france', 'drive-uk', 'unload-time']) byId(id).addEventListener('input', render);
fillSailings();
render();
