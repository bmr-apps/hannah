const grade6Demo = new URLSearchParams(globalThis.location?.search ?? '').get('test') === 'grade6';
const localToday = new Date();
const demoDate = [localToday.getFullYear(), String(localToday.getMonth()+1).padStart(2,'0'),
  String(localToday.getDate()).padStart(2,'0')].join('-');
const key = grade6Demo ? 'hannah:design-test:grade6:' + demoDate : 'hannah:design-test:v1';

function grade6Fixture() {
  const names = ['가온','나래','다온','라온','마루','보람','소담','아람','하늘','이든','초롱'];
  const roster = names.map((name,i) => ({name:'가상'+name,grade:'6',class:'0',number:i+1}));
  const weekday = ['일','월','화','수','목','금','토'][localToday.getDay()];
  const weekly = structuredClone(initialWeeklyAvailability);
  (weekly[weekday] ??= {})['세미나실'] = { ...(weekly[weekday].세미나실 ?? {}), '9교시':true };
  return {
    adminPassword:'design-test-admin',
    previewWeeklySettingsLoaded:true,
    rosterMonWed:roster, rosterTueThu:roster, baseWeeklyAvailability:weekly,
    bookings:{[demoDate+'-세미나실-9교시']:roster.map(student=>({
      name:'6'+student.name, password:'test-student', timestamp:localToday.toISOString(), checked:false
    }))},
    chromebookBookings:{[demoDate]:{'6':Object.fromEntries(roster.map(student=>[
      '6_0_'+student.number,{purpose9:'가상 수업 활동',purpose10:''}
    ]))}}
  };
}
const app = {};
const listeners = new Set();

const initialWeeklyAvailability = {
  "월": {
    "강당": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "과학실": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "도서관": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "미술실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "밴드실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "별관1": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "별관2": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "세미나실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "음악실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    }
  },
  "화": {
    "강당": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "과학실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "도서관": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "미술실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "밴드실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "별관1": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "별관2": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "세미나실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "음악실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    }
  },
  "수": {
    "강당": {
      "9교시": true,
      "10교시": false,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "과학실": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "도서관": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "미술실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "밴드실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "별관1": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "별관2": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "세미나실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "음악실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    }
  },
  "목": {
    "6학년": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": true,
      "저녁2교시": true
    },
    "7-1": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": true,
      "저녁2교시": true
    },
    "7-2": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": true,
      "저녁2교시": true
    },
    "8-1": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": true,
      "저녁2교시": true
    },
    "8-2": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": true,
      "저녁2교시": true
    },
    "강당": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": true,
      "저녁2교시": true
    },
    "과학실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "도서관": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": true,
      "저녁2교시": true
    },
    "미술실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": true,
      "저녁2교시": true
    },
    "밴드실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": true,
      "저녁2교시": false
    },
    "별관1": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": true,
      "저녁2교시": true
    },
    "별관2": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": true,
      "저녁2교시": true
    },
    "세미나실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "음악실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    }
  },
  "금": {
    "강당": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": true,
      "저녁2교시": true
    },
    "과학실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "도서관": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "미술실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "밴드실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "별관1": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "별관2": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "세미나실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": true,
      "저녁2교시": true
    },
    "음악실": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    }
  },
  "토": {
    "강당": {
      "9교시": true,
      "10교시": true,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "과학실": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "도서관": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "미술실": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "밴드실": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "별관1": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "별관2": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "세미나실": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": false,
      "저녁2교시": false
    },
    "음악실": {
      "9교시": false,
      "10교시": false,
      "저녁1교시": false,
      "저녁2교시": false
    }
  }
};

function read() {
  const stored = localStorage.getItem(key);
  const root = stored ? JSON.parse(stored) : grade6Demo ? grade6Fixture() : {adminPassword:'design-test-admin'};
  if (!stored && grade6Demo) localStorage.setItem(key, JSON.stringify(root));
  if (!root.previewWeeklySettingsLoaded) {
    root.baseWeeklyAvailability ??= structuredClone(initialWeeklyAvailability);
    root.previewWeeklySettingsLoaded = true;
    localStorage.setItem(key, JSON.stringify(root));
  }
  return root;
}
function at(root, parts) {
  return parts.reduce((node, part) => node && Object.hasOwn(node, part) ? node[part] : null, root);
}
function snapshot(value) {
  return { val: () => structuredClone(value ?? null), exists: () => value != null };
}
function publish() {
  for (const listener of listeners) queueMicrotask(listener);
}
function write(root, parts, value) {
  if (!parts.length) root = value ?? {};
  else {
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(node, part) || node[part] === null || typeof node[part] !== 'object') {
        Object.defineProperty(node, part, { value: {}, writable: true, configurable: true, enumerable: true });
      }
      node = node[part];
    }
    const last = parts.at(-1);
    if (value == null) delete node[last];
    else Object.defineProperty(node, last, { value, writable: true, configurable: true, enumerable: true });
  }
  localStorage.setItem(key, JSON.stringify(root));
  publish();
}
const locked = operation => navigator.locks.request(key, operation);
window.addEventListener('storage', event => { if (event.key === key) publish(); });

export const initializeApp = () => app;
export const getApps = () => [app];
export const getApp = () => app;
export const getDatabase = () => app;
export const getAuth = () => app;
export const signInAnonymously = async () => ({ user: { uid: 'preview-user' } });
export const ref = (_database, path = '') => String(path).split('/').filter(Boolean);
export const get = async parts => snapshot(at(read(), parts));
export const set = async (parts, value) => locked(() => write(read(), parts, value));
export function onValue(parts, callback) {
  let previous;
  const listener = () => {
    const current = at(read(), parts);
    const encoded = JSON.stringify(current);
    if (encoded === previous) return;
    previous = encoded;
    callback(snapshot(current));
  };
  listeners.add(listener);
  queueMicrotask(listener);
  return () => listeners.delete(listener);
}
export async function runTransaction(parts, update) {
  return locked(() => {
    const root = read();
    const oldValue = at(root, parts);
    const next = update(structuredClone(oldValue));
    if (next === undefined) return { committed: false, snapshot: snapshot(oldValue) };
    write(root, parts, next);
    return { committed: true, snapshot: snapshot(next) };
  });
}
