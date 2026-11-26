import './booking-test.css';
import { supabase } from './supabase.js';
import { loginWithGoogle, logout, onUserChange } from './auth.js';
import { bindStagingBookingForm } from './booking-staging-screen.js';

const form = document.getElementById('booking-test-form');
const signIn = document.getElementById('login');
const signOut = document.getElementById('logout');
const authStatus = document.getElementById('auth-status');
const bookingStatus = document.getElementById('booking-test-status');

bindStagingBookingForm(form, bookingStatus, supabase);
onUserChange(user => {
  form.hidden = !user;
  signOut.hidden = !user;
  signIn.hidden = !!user;
  authStatus.textContent = user ? '로그인되었습니다.' : '';
  bookingStatus.textContent = '';
});

async function runAuth(action, message) {
  try {
    const { error } = await action();
    if (error) throw error;
  } catch {
    authStatus.textContent = message;
  }
}
signIn.addEventListener('click', () => runAuth(loginWithGoogle, '로그인할 수 없습니다.'));
signOut.addEventListener('click', () => runAuth(logout, '로그아웃할 수 없습니다.'));
