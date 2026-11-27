import './booking-test.css';
import { supabase } from './supabase.js';
import { loginWithPassword, logout, onUserChange } from './auth.js';
import { bindStagingBookingForm } from './booking-staging-screen.js';

const form = document.getElementById('booking-test-form');
const signIn = document.getElementById('test-login');
const signOut = document.getElementById('logout');
const authStatus = document.getElementById('auth-status');
const bookingStatus = document.getElementById('booking-test-status');

const requests = document.getElementById('test-requests');
const list = document.getElementById('request-list');
const requestStatus = document.getElementById('request-status');
let activeUser;
let readVersion = 0;

async function loadRequests() {
  if (!activeUser) return;
  const version = ++readVersion;
  try {
    const { data, error } = await supabase.schema('hannah').from('booking_test_requests')
      .select('room,period').eq('user_id', activeUser.id).order('id');
    if (error) throw error;
    if (version !== readVersion) return;
    list.replaceChildren(...data.map(({ room, period }) => {
      const item = document.createElement('li');
      item.textContent = `${room} · ${period}`;
      return item;
    }));
    requestStatus.textContent = data.length ? '' : '저장된 테스트 신청이 없습니다.';
  } catch {
    if (version === readVersion) requestStatus.textContent = '테스트 신청을 불러오지 못했습니다.';
  }
}

bindStagingBookingForm(form, bookingStatus, supabase, loadRequests);
onUserChange(user => {
  activeUser = user;
  ++readVersion;
  list.replaceChildren();
  requestStatus.textContent = '';
  requests.hidden = !user;
  form.hidden = !user;
  signOut.hidden = !user;
  signIn.hidden = !!user;
  authStatus.textContent = user ? '로그인되었습니다.' : '';
  bookingStatus.textContent = '';
  if (user) setTimeout(loadRequests, 0);
});

async function runAuth(action, message) {
  try {
    const { error } = await action();
    if (error) throw error;
  } catch {
    authStatus.textContent = message;
  }
}
signIn.addEventListener('submit', async event => {
  event.preventDefault();
  const { email, password } = signIn.elements;
  await runAuth(() => loginWithPassword(email.value.trim(), password.value), '로그인할 수 없습니다.');
  password.value = '';
});
signOut.addEventListener('click', () => runAuth(logout, '로그아웃할 수 없습니다.'));

