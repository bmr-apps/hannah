const key = 'hannah:design-test:v1';
const app = {};
const listeners = new Set();

function read() {
  return JSON.parse(localStorage.getItem(key) ?? '{"adminPassword":"design-test-admin"}');
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
