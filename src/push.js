// Notifications on this device: the service worker, the install prompt, and
// the dialog behind the bell, where this phone or browser turns them on,
// picks what it hears about, sends itself a test, or turns them off.
import { api, explain } from './api.js';
import { ago } from './format.js';

export const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
window.addEventListener('appinstalled', () => { installPrompt = null; });

/** Registers the service worker; the page works the same without it. */
export async function startWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch { return null; }
}

const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
const deviceName = () => {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : ios() ? (/iPad/.test(ua) ? 'iPad' : 'iPhone') : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const app = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${os} · ${standalone() ? 'app' : app}`;
};

async function current() {
  const reg = (await navigator.serviceWorker.getRegistration('/')) || (await startWorker());
  return { reg, sub: reg ? await reg.pushManager.getSubscription() : null };
}

/** The dialog, built with the page's own h() and icon(). */
export function openNotifications({ h, icon }) {
  const body = h('div', { class: 'dlg-body' });
  const note = h('p', { class: 'dlg-note', role: 'status', 'aria-live': 'polite' });
  const dlg = h('dialog', { class: 'dlg', 'aria-labelledby': 'dlg-title' },
    h('div', { class: 'dlg-head' }, h('h2', { id: 'dlg-title' }, 'Notifications'),
      h('button', { class: 'ghost small', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('cross'))),
    body, note);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  dlg.showModal();

  const say = (text) => { note.textContent = text || ''; };
  const p = (text) => h('p', null, text);
  const button = (label, onclick, cls = 'ghost') => h('button', { class: cls, type: 'button', onclick: async (e) => {
    const b = e.currentTarget; b.disabled = true; say('');
    try { await onclick(); } catch (err) { say(err?.message && !err.code ? err.message : explain(err)); }
    if (b.isConnected) b.disabled = false;
  } }, label);

  async function paint() {
    const kids = [];
    if (!standalone() && installPrompt) kids.push(h('div', { class: 'dlg-row' }, p('Put Abyssol on the home screen as an app.'), button('Install', async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; paint(); })));
    if (!supported()) {
      kids.push(p(ios() && !standalone()
        ? 'On an iPhone, notifications come to the app on the home screen: tap Share, then Add to Home Screen, and open Abyssol from there.'
        : 'This browser can\'t receive notifications. On Android, open the dashboard in Chrome.'));
      return body.replaceChildren(...kids);
    }
    let info, here;
    try { here = await current(); info = await api.push(here.sub?.endpoint || ''); }
    catch (e) { return body.replaceChildren(...kids, p(explain(e))); }
    if (!info.configured) return body.replaceChildren(...kids, p('Notifications aren\'t set up on the server yet: it needs its VAPID keys (README.md, Notifications).'));

    const on = !!(here.sub && info.device);
    if (Notification.permission === 'denied') kids.push(p('Notifications are blocked for this site. Allow them in the browser\'s site settings, then come back.'));
    else if (!on) {
      kids.push(p('Get a notification on this device when a game gets new players, downloads, sales, ratings, or when a sync breaks.'),
        h('div', { class: 'dlg-actions' }, button('Turn on', async () => {
          if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications weren\'t allowed.');
          say('Turning on…');
          const reg = here.reg || (await startWorker());
          if (!reg) throw new Error('The service worker didn\'t start.');
          await navigator.serviceWorker.ready;
          let sub = await reg.pushManager.getSubscription();
          // A subscription made with another key can't take this server's pushes.
          if (sub && sub.options?.applicationServerKey && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== info.publicKey) { await sub.unsubscribe(); sub = null; }
          sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(info.publicKey) });
          await api.pushOn(sub.toJSON(), null, deviceName());
          await paint(); say('Notifications are on for this device.');
        }, 'primary')));
    } else {
      const kinds = new Set(info.device.kinds || []);
      kids.push(h('fieldset', { class: 'dlg-kinds' }, h('legend', null, 'Tell this device about'),
        info.kinds.map((k) => {
          const box = h('input', { type: 'checkbox', id: `kind-${k.id}`, checked: kinds.has(k.id), onchange: async () => {
            box.disabled = true;
            if (box.checked) kinds.add(k.id); else kinds.delete(k.id);
            try { await api.pushOn(here.sub.toJSON(), [...kinds], deviceName()); say('Saved.'); }
            catch (e) { box.checked = !box.checked; say(explain(e)); }
            box.disabled = false;
          } });
          return h('label', { class: 'dlg-kind', for: `kind-${k.id}` }, box, h('span', null, h('b', null, k.label), h('small', null, k.about)));
        })),
      h('div', { class: 'dlg-actions' },
        button('Send a test', async () => { say('Sending…'); await api.pushTest(here.sub.endpoint); say('Sent. It should arrive in a few seconds.'); }),
        button('Turn off', async () => { await api.pushOff(here.sub.endpoint).catch(() => {}); await here.sub.unsubscribe(); await paint(); say('Notifications are off for this device.'); })));
    }
    if (info.recent?.length) {
      kids.push(h('div', { class: 'dlg-recent' }, h('h3', null, 'Sent lately'),
        info.recent.map((r) => h('div', { class: 'dlg-sent' }, h('div', null, h('b', null, r.title), h('span', { class: 'dlg-when' }, ago(r.at))), h('div', { class: 'dlg-text' }, r.body)))));
    }
    body.replaceChildren(...kids);
  }
  body.append(p('Loading…'));
  paint();
}
